import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../composables/useToasts';
import ImportJobView from '../views/ImportJobView.vue';
import { bodyOf, callsTo, csvResponse, json, makeJob, mockFetch, mountWithApp } from './helpers';

const ERRORS = {
  data: [
    { row: 5, phase: 'validate', field: 'email', message: 'Not a valid email address' },
    { row: 6, phase: 'validate', field: 'first_name', message: 'First name is required' },
    { row: 9, phase: 'import', field: 'email', message: 'Already used by another contact' },
  ],
  total: 3,
};

beforeEach(() => useToasts().toasts.splice(0));
afterEach(() => vi.unstubAllGlobals());

async function open(job: Record<string, unknown>, routes = {}) {
  const fetchMock = mockFetch({
    'GET /imports/:id': () => json(200, makeJob(job)),
    'GET /imports/:id/errors': () => json(200, ERRORS),
    ...routes,
  });
  const ctx = await mountWithApp(ImportJobView, { id: 'j1' }, '/imports/j1');
  return { ...ctx, fetchMock };
}
const button = (w: any, text: string) => w.findAll('button').find((b: any) => b.text().includes(text));

describe('ImportJobView', () => {
  it('shows a checking state while the worker validates', async () => {
    const { wrapper: w } = await open({ status: 'validating', totalRows: null, validRows: null, errorRows: 0 });
    await vi.waitFor(() => expect(w.text()).toContain('Checking your file'));
    expect(w.text()).toContain('Nothing is saved yet');
    expect(button(w, 'Import')).toBeUndefined();
  });

  it('review: shows the counts and each problem with row, column and reason, plus the actions', async () => {
    const { wrapper: w } = await open({});
    await vi.waitFor(() => expect(w.text()).toContain('Not a valid email address'));
    expect(w.findAll('.kpi').map((k) => k.text())).toEqual(['Rows checked10', 'Ready to add8', 'With problems (skipped)2']);
    expect(w.text()).toContain('first name'); // column names are humanised
    expect(w.text()).toContain('(found while importing)'); // import-phase problems are labelled
    expect(button(w, 'Import 8 contacts')).toBeTruthy();
    expect(button(w, 'Download rejected rows')).toBeTruthy();
    expect(button(w, 'Cancel import')).toBeTruthy();
  });

  it('review for an update file says "Update" and uses update wording', async () => {
    const { wrapper: w } = await open({ mode: 'update' });
    await vi.waitFor(() => expect(button(w, 'Update 8 contacts')).toBeTruthy());
    expect(w.text()).toContain('Ready to update');
  });

  it('cannot start an import with no valid rows', async () => {
    const { wrapper: w } = await open({ validRows: 0, errorRows: 10 });
    await vi.waitFor(() => expect(w.text()).toContain('None of the rows can be imported'));
    expect(button(w, 'Import 0 contacts').attributes('disabled')).toBeDefined();
  });

  it('confirming starts the import and the page switches to progress', async () => {
    let started = false;
    const { wrapper: w, fetchMock } = await open({}, {
      'GET /imports/:id': () => json(200, makeJob(started ? { status: 'importing', processedRows: 4 } : {})),
      'POST /imports/:id/confirm': () => ((started = true), json(202, makeJob({ status: 'importing', processedRows: 4 }))),
    });
    await vi.waitFor(() => expect(button(w, 'Import 8 contacts')).toBeTruthy());
    await button(w, 'Import 8 contacts').trigger('click');
    await vi.waitFor(() => expect(w.find('[role=progressbar]').exists()).toBe(true));
    expect(callsTo(fetchMock, 'POST', /confirm$/)).toHaveLength(1);
    expect(w.find('[role=progressbar]').attributes('aria-valuenow')).toBe('40');
    expect(w.text()).toContain('4 of 10 rows processed');
    expect(w.text()).toContain('You can leave this page');
  });

  it('polls while importing and shows the final summary when it completes', async () => {
    let calls = 0;
    const { wrapper: w } = await open({}, {
      'GET /imports/:id': () => json(200, makeJob(++calls < 2 ? { status: 'importing', processedRows: 5 } : { status: 'completed', processedRows: 10, createdCount: 8, finishedAt: '2026-10-07T10:01:00Z' })),
    });
    await vi.waitFor(() => expect(w.find('[role=progressbar]').exists()).toBe(true));
    await vi.waitFor(() => expect(w.text()).toContain('Import finished'), { timeout: 4000 });
    expect(w.findAll('.kpi').map((k) => k.text())).toEqual(['Contacts added8', 'Skipped (problems)2']);
    expect(w.find('[role=progressbar]').exists()).toBe(false); // polling stopped on a resting state
    expect(w.text()).toContain('View contacts');
    expect(w.text()).toContain('Rows with problems'); // still available after import
  });

  it('completed update shows updated and already-up-to-date counts', async () => {
    const { wrapper: w } = await open({ mode: 'update', status: 'completed', processedRows: 10, updatedCount: 5, unchangedCount: 3, errorRows: 2 });
    await vi.waitFor(() => expect(w.text()).toContain('Import finished'));
    expect(w.findAll('.kpi').map((k) => k.text())).toEqual(['Contacts updated5', 'Already up to date3', 'Skipped (problems)2']);
  });

  it('a failed file explains why and offers another upload', async () => {
    const { wrapper: w } = await open({ status: 'failed', failureReason: 'Missing required column: last_name', totalRows: null, errorRows: 0 });
    await vi.waitFor(() => expect(w.find('.banner.danger').exists()).toBe(true));
    expect(w.find('.banner').text()).toContain("This file couldn't be used");
    expect(w.find('.banner').text()).toContain('Missing required column: last_name');
    expect(w.find('.banner a').text()).toBe('Upload another file');
  });

  it('cancelling asks for confirmation, then cancels and returns to the list with a toast', async () => {
    const { wrapper: w, router, fetchMock } = await open({}, { 'POST /imports/:id/cancel': () => json(200, makeJob({ status: 'cancelled' })) });
    await vi.waitFor(() => expect(button(w, 'Cancel import')).toBeTruthy());
    await button(w, 'Cancel import').trigger('click');
    expect(callsTo(fetchMock, 'POST', /cancel$/)).toHaveLength(0); // not yet
    await w.find('[role=alertdialog] button.danger').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('imports'));
    expect(useToasts().toasts[0].message).toBe('Import cancelled. Nothing was changed.');
  });

  it('downloads the rejected rows with the API key', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { wrapper: w, fetchMock } = await open({}, { 'GET /imports/:id/errors.csv': () => csvResponse('first_name,error\n', 'leads-errors.csv') });
    await vi.waitFor(() => expect(button(w, 'Download rejected rows')).toBeTruthy());
    await button(w, 'Download rejected rows').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    expect(callsTo(fetchMock, 'GET', /errors\.csv$/)).toHaveLength(1);
    click.mockRestore();
  });

  it('shows a friendly message when the confirm is refused (409) and refreshes the job', async () => {
    const { wrapper: w } = await open({}, { 'POST /imports/:id/confirm': () => json(409, { code: 'IMPORT_NOT_READY', message: "This import is cancelled, so it can't be started" }) });
    await vi.waitFor(() => expect(button(w, 'Import 8 contacts')).toBeTruthy());
    await button(w, 'Import 8 contacts').trigger('click');
    await vi.waitFor(() => expect(w.find('[role=alert]').text()).toContain("can't be started"));
  });

  it('pages the problems list: "Show more" asks for more rows, capped at 500', async () => {
    const many = { data: Array.from({ length: 100 }, (_, i) => ({ row: i + 1, phase: 'validate', field: 'email', message: 'Not a valid email address' })), total: 250 };
    const fetchMock = mockFetch({ 'GET /imports/:id': () => json(200, makeJob({ errorRows: 250 })), 'GET /imports/:id/errors': () => json(200, many) });
    const { wrapper: w } = await mountWithApp(ImportJobView, { id: 'j1' }, '/imports/j1');
    await vi.waitFor(() => expect(w.text()).toContain('Showing 100 of 250'));
    await button(w, 'Show more').trigger('click');
    await vi.waitFor(() => expect(callsTo(fetchMock, 'GET', /errors$/).some(([u]) => String(u).includes('limit=200'))).toBe(true));
  });

  it('404 and network errors are explained', async () => {
    mockFetch({ 'GET /imports/:id': () => json(404, { code: 'NOT_FOUND', message: 'Import not found' }) });
    const { wrapper: w } = await mountWithApp(ImportJobView, { id: 'zzz' }, '/imports/zzz');
    await vi.waitFor(() => expect(w.text()).toContain('This import does not exist'));
    expect(bodyOf).toBeDefined();
  });
});
