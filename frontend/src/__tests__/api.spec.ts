import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, buildListQuery } from '../api';

const jsonResponse = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('buildListQuery', () => {
  it('omits empty filters and splits sort into sort + order', () => {
    const qs = new URLSearchParams(buildListQuery({ q: '', tag: 'VIP', company: undefined, sort: 'name:asc', limit: 25 }));
    expect(Object.fromEntries(qs)).toEqual({ tags: 'VIP', sort: 'name', order: 'asc', limit: '25' });
  });
  it('passes the cursor through', () => {
    expect(buildListQuery({ sort: 'createdAt:desc', limit: 10, cursor: 'abc' })).toContain('cursor=abc');
  });
});

describe('request error handling', () => {
  it('sends the version as If-Match and the API key', async () => {
    const fetchMock = vi.fn(() => jsonResponse(200, { id: '1' }));
    vi.stubGlobal('fetch', fetchMock);
    await api.updateContact('1', 7, { company: 'X' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['If-Match']).toBe('"7"');
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(init.method).toBe('PATCH');
  });

  it('maps a 409 VERSION_CONFLICT to an ApiError carrying the server copy', async () => {
    const current = { id: '1', version: 3, company: 'Theirs' };
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(409, { code: 'VERSION_CONFLICT', message: 'changed', current })));
    const err = await api.updateContact('1', 1, {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.isConflict).toBe(true);
    expect(err.current).toEqual(current);
  });

  it('exposes field-level validation details', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(400, { code: 'VALIDATION_ERROR', message: 'bad', details: [{ field: 'email', message: 'invalid' }] })));
    const err = await api.updateContact('1', 1, { email: 'x' }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.details).toEqual([{ field: 'email', message: 'invalid' }]);
    expect(err.isConflict).toBe(false);
  });

  it('turns a network failure into status 0 with a friendly message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const err = await api.getContact('1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/cannot reach the server/i);
  });

  it('survives a non-JSON error body (e.g. proxy 502)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('Bad Gateway', { status: 502 }))));
    const err = await api.getContact('1').catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toContain('502');
  });
});

describe('CRUD calls', () => {
  const ok = (body: unknown = {}) => vi.fn(() => jsonResponse(200, body));
  const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];

  it('createContact POSTs the payload', async () => {
    const fetchMock = ok({ id: 'n' });
    vi.stubGlobal('fetch', fetchMock);
    await api.createContact({ firstName: 'A', lastName: 'B', tags: ['VIP'] });
    const [url, init] = lastCall(fetchMock);
    expect(url).toMatch(/\/contacts$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ firstName: 'A', lastName: 'B', tags: ['VIP'] });
  });

  it('deleteContact is a DELETE with If-Match and no body', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    await api.deleteContact('c1', 4);
    const [url, init] = lastCall(fetchMock);
    expect(url).toMatch(/\/contacts\/c1$/);
    expect(init.method).toBe('DELETE');
    expect(init.headers['If-Match']).toBe('"4"');
    expect(init.body).toBeUndefined();
  });

  it('restoreContact POSTs to /restore with If-Match', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    await api.restoreContact('c1', 2);
    const [url, init] = lastCall(fetchMock);
    expect(url).toMatch(/\/contacts\/c1\/restore$/);
    expect(init.method).toBe('POST');
    expect(init.headers['If-Match']).toBe('"2"');
  });

  it('bulkDelete posts the ids', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    await api.bulkDelete(['a', 'b']);
    const [url, init] = lastCall(fetchMock);
    expect(url).toMatch(/\/contacts\/bulk\/delete$/);
    expect(JSON.parse(init.body as string)).toEqual({ contactIds: ['a', 'b'] });
  });

  it('exposes the existing owner on an EMAIL_TAKEN error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(409, { code: 'EMAIL_TAKEN', message: 'x', details: [{ field: 'email', message: 'm' }], existing: { id: 'o', name: 'Ada' } })));
    const err = await api.createContact({ firstName: 'A', lastName: 'B' }).catch((e) => e);
    expect(err.existing).toEqual({ id: 'o', name: 'Ada' });
  });

  it('lists the trash with status=deleted and omits status for active contacts', () => {
    expect(buildListQuery({ status: 'deleted', sort: 'deletedAt:desc', limit: 25 })).toContain('status=deleted');
    expect(buildListQuery({ status: 'active', sort: 'createdAt:desc', limit: 25 })).not.toContain('status');
  });
});


describe('downloads and uploads', () => {
  it('uploadImport sends multipart FormData without a JSON content type', async () => {
    const fetchMock = vi.fn(() => jsonResponse(202, { id: 'j' }));
    vi.stubGlobal('fetch', fetchMock);
    await api.uploadImport('update', new File(['a,b'], 'x.csv', { type: 'text/csv' }));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toMatch(/\/imports$/);
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('mode')).toBe('update');
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers.Authorization).toMatch(/^Bearer /);
  });

  it('exportContacts drops the cursor and page size and passes the filters', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('x', { headers: { 'Content-Disposition': 'attachment; filename="contacts.csv"' } })));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await api.exportContacts({ attention: 'stale', tag: 'VIP', sort: 'name:asc', status: 'active' });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/contacts/export.csv?');
    expect(url).toContain('attention=stale');
    expect(url).toContain('tags=VIP');
    expect(url).not.toContain('cursor');
    click.mockRestore();
  });

  it('a failed download becomes a normal ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(400, { code: 'VALIDATION_ERROR', message: 'bad filter' })));
    const err = await api.downloadImportErrors('j1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
  });

  it('metrics requests the chosen period', async () => {
    const fetchMock = vi.fn(() => jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await api.metrics(90);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/\/metrics\?range=90$/);
  });
});
