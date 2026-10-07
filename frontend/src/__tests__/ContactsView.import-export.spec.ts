import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../composables/useToasts';
import ContactsView from '../views/ContactsView.vue';
import { callsTo, csvResponse, json, makeContact, mockFetch, mountWithApp, page } from './helpers';

const tags = { 'GET /tags': () => json(200, { data: [] }) };

beforeEach(() => useToasts().toasts.splice(0));
afterEach(() => vi.unstubAllGlobals());

const listCalls = (fn: ReturnType<typeof vi.fn>) => callsTo(fn, 'GET', /^\/contacts$/).map(([u]) => new URL(u as string, 'http://t').searchParams);

describe('ContactsView - import, export and attention filters', () => {
  it('links to the CSV import wizard from the header', async () => {
    mockFetch({ ...tags, 'GET /contacts': () => json(200, page([makeContact()])) });
    const { wrapper: w } = await mountWithApp(ContactsView);
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    expect(w.find('a[href="/imports/new"]').text()).toBe('Import CSV');
  });

  it('applies the attention filter from the URL, shows it as a removable chip, and sends it to the API', async () => {
    const fetchMock = mockFetch({ ...tags, 'GET /contacts': () => json(200, page([makeContact()])) });
    const { wrapper: w } = await mountWithApp(ContactsView, {}, '/?attention=untagged');
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    expect(listCalls(fetchMock)[0].get('attention')).toBe('untagged');
    expect(w.find('.filter-chip').text()).toContain('Needs attention: Untagged');

    await w.find('.filter-chip button').trigger('click');
    await vi.waitFor(() => expect(listCalls(fetchMock).some((p) => !p.has('attention'))).toBe(true));
    expect(w.find('.filter-chip').exists()).toBe(false);
  });

  it('ignores an unknown attention value in the URL instead of sending it', async () => {
    const fetchMock = mockFetch({ ...tags, 'GET /contacts': () => json(200, page([makeContact()])) });
    const { wrapper: w } = await mountWithApp(ContactsView, {}, '/?attention=bogus');
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    expect(listCalls(fetchMock)[0].has('attention')).toBe(false);
  });

  it('"Clear filters" also clears the attention filter', async () => {
    mockFetch({ ...tags, 'GET /contacts': () => json(200, page([makeContact()])) });
    const { wrapper: w } = await mountWithApp(ContactsView, {}, '/?attention=stale');
    await vi.waitFor(() => expect(w.find('.filter-chip').exists()).toBe(true));
    await w.findAll('button').find((b) => b.text() === 'Clear filters')!.trigger('click');
    expect(w.find('.filter-chip').exists()).toBe(false);
  });

  it('is not offered in the trash', async () => {
    const fetchMock = mockFetch({ ...tags, 'GET /contacts': () => json(200, page([makeContact({ deletedAt: '2026-10-01T00:00:00Z' })])) });
    const { wrapper: w } = await mountWithApp(ContactsView, { mode: 'trash' }, '/?attention=untagged');
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    expect(listCalls(fetchMock)[0].has('attention')).toBe(false);
    expect(w.find('.filter-chip').exists()).toBe(false);
    expect(w.text()).not.toContain('Export CSV');
  });

  it('exports with the current search and filters (no cursor), and downloads the file', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const fetchMock = mockFetch({ ...tags, 'GET /contacts': () => json(200, page([makeContact()])), 'GET /contacts/export.csv': () => csvResponse('first_name\r\nAda\r\n', 'contacts.csv') });
    const { wrapper: w } = await mountWithApp(ContactsView, {}, '/?attention=untagged&company=acme&sort=name:asc');
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    await w.findAll('button').find((b) => b.text() === 'Export CSV')!.trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalled());

    const [call] = callsTo(fetchMock, 'GET', /export\.csv$/);
    const qs = new URL(call[0] as string, 'http://t').searchParams;
    expect(qs.get('attention')).toBe('untagged');
    expect(qs.get('company')).toBe('acme');
    expect(qs.get('sort')).toBe('name');
    expect(qs.has('cursor')).toBe(false);
    click.mockRestore();
  });

  it('tells you when an export fails', async () => {
    mockFetch({ ...tags, 'GET /contacts': () => json(200, page([makeContact()])), 'GET /contacts/export.csv': () => json(500, { code: 'INTERNAL_ERROR', message: 'Something went wrong' }) });
    const { wrapper: w } = await mountWithApp(ContactsView);
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    await w.findAll('button').find((b) => b.text() === 'Export CSV')!.trigger('click');
    await vi.waitFor(() => expect(useToasts().toasts[0]?.message).toMatch(/Couldn't export/));
    expect(useToasts().toasts[0].kind).toBe('error');
  });
});
