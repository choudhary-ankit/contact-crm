import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImportNewView from '../views/ImportNewView.vue';
import { callsTo, csvResponse, FORMATS, headersOf, json, makeJob, mockFetch, mountWithApp } from './helpers';

afterEach(() => vi.unstubAllGlobals());

async function open(routes = {}, startAt = '/imports/new') {
  const fetchMock = mockFetch({ 'GET /imports/formats': () => json(200, FORMATS), ...routes });
  const ctx = await mountWithApp(ImportNewView, {}, startAt);
  await vi.waitFor(() => expect(ctx.wrapper.text()).toContain('File format'));
  return { ...ctx, fetchMock };
}
const choose = async (w: any, file: File) => {
  const input = w.find('input[type=file]');
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
};
const csv = (name = 'leads.csv', body = 'first_name,last_name\nAda,Lovelace') => new File([body], name, { type: 'text/csv' });
const uploadBtn = (w: any) => w.findAll('button').find((b: any) => b.text().includes('Upload and check file'))!;

describe('ImportNewView', () => {
  it('shows the format guide for the selected type and switches when the type changes', async () => {
    const { wrapper: w } = await open();
    expect(w.find('.format').text()).toContain('add new contacts');
    expect(w.find('.format').text()).toContain('first_name');
    await w.findAll('input[name=mode]')[1].setValue(true);
    await vi.waitFor(() => expect(w.find('.format').text()).toContain('update existing contacts'));
    expect(w.find('.format').text()).toContain('Identifies the contact');
    expect(w.find('.format pre').text()).toContain('email\nada@example.com'); // example built from the column specs
  });

  it('preselects update mode from the URL', async () => {
    const { wrapper: w } = await open({}, '/imports/new?mode=update');
    expect((w.findAll('input[name=mode]')[1].element as HTMLInputElement).checked).toBe(true);
  });

  it('downloads the sample file for the selected type', async () => {
    const created = vi.fn(() => 'blob:sample');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { wrapper: w, fetchMock } = await open({ 'GET /imports/templates/:mode': () => csvResponse('first_name\nAda', 'contacts-add-sample.csv') });
    await w.findAll('button').find((b) => b.text() === 'Download sample CSV')!.trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    expect(callsTo(fetchMock, 'GET', /templates\/create$/)).toHaveLength(1);
    expect(created).toHaveBeenCalled();
    click.mockRestore();
  });

  it.each([
    ['a non-CSV file', new File(['x'], 'data.xlsx'), /Choose a \.csv file/],
    ['an empty file', csv('empty.csv', ''), /This file is empty/],
    ['a file over 5 MB', csv('big.csv', 'a'.repeat(5 * 1024 * 1024 + 1)), /limit is 5 MB/],
  ])('rejects %s before sending anything', async (_label, file, message) => {
    const { wrapper: w, fetchMock } = await open();
    await choose(w, file);
    expect(w.find('[role=alert]').text()).toMatch(message);
    expect(uploadBtn(w).attributes('disabled')).toBeDefined();
    expect(callsTo(fetchMock, 'POST', /imports/)).toHaveLength(0);
  });

  it('uploads multipart (no JSON content type), then opens the job page', async () => {
    const { wrapper: w, router, fetchMock } = await open({ 'POST /imports': () => json(202, makeJob({ id: 'job-9', status: 'validating' })) });
    expect(uploadBtn(w).attributes('disabled')).toBeDefined(); // nothing chosen yet
    await choose(w, csv());
    expect(w.text()).toContain('leads.csv');
    await uploadBtn(w).trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('import'));
    expect(router.currentRoute.value.params.id).toBe('job-9');

    const [call] = callsTo(fetchMock, 'POST', /^\/imports$/);
    const body = (call[1] as RequestInit).body as FormData;
    expect(body.get('mode')).toBe('create');
    expect((body.get('file') as File).name).toBe('leads.csv');
    expect(headersOf(call)['Content-Type']).toBeUndefined(); // the browser must add the multipart boundary itself
  });

  it('shows the server\'s reason when an upload is refused and keeps the chosen file', async () => {
    const { wrapper: w } = await open({
      'POST /imports': () => json(400, { code: 'VALIDATION_ERROR', message: 'bad', details: [{ field: 'file', message: 'This does not look like a text CSV file' }] }),
    });
    await choose(w, csv());
    await uploadBtn(w).trigger('click');
    await vi.waitFor(() => expect(w.find('[role=alert]').text()).toBe('This does not look like a text CSV file'));
    expect(w.text()).toContain('leads.csv');
    expect(uploadBtn(w).attributes('disabled')).toBeUndefined(); // can retry
  });

  it('lets you remove the chosen file', async () => {
    const { wrapper: w } = await open();
    await choose(w, csv());
    await w.findAll('button').find((b) => b.text() === 'Remove file')!.trigger('click');
    expect(w.text()).toContain('Drop a .csv file here');
    await flushPromises();
  });

  it('shows an error with Retry if the format guide cannot be loaded', async () => {
    mockFetch({ 'GET /imports/formats': () => Promise.reject(new TypeError('Failed to fetch')) });
    const { wrapper: w } = await mountWithApp(ImportNewView, {}, '/imports/new');
    await vi.waitFor(() => expect(w.text()).toContain('Could not load the format guide'));
  });
});
