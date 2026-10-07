import { afterEach, describe, expect, it, vi } from 'vitest';
import ImportsView from '../views/ImportsView.vue';
import { json, makeJob, mockFetch, mountWithApp } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('ImportsView', () => {
  it('lists imports with type, status, progress and a plain-language result', async () => {
    mockFetch({
      'GET /imports': () => json(200, { data: [
        makeJob({ id: 'a', filename: 'done.csv', status: 'completed', createdCount: 4, errorRows: 2, processedRows: 6, totalRows: 6 }),
        makeJob({ id: 'b', filename: 'upd.csv', mode: 'update', status: 'completed', updatedCount: 3, unchangedCount: 1, errorRows: 0, processedRows: 4, totalRows: 4 }),
        makeJob({ id: 'c', filename: 'review.csv', status: 'ready', validRows: 8, errorRows: 2 }),
        makeJob({ id: 'd', filename: 'bad.csv', status: 'failed', failureReason: 'Missing required column: email' }),
      ] }),
    });
    const { wrapper: w } = await mountWithApp(ImportsView);
    await vi.waitFor(() => expect(w.text()).toContain('done.csv'));
    const rows = w.findAll('tbody tr').map((r) => r.text());
    expect(rows[0]).toContain('Add');
    expect(rows[0]).toContain('4 added, 2 skipped');
    expect(rows[1]).toContain('Update');
    expect(rows[1]).toContain('3 updated, 1 unchanged');
    expect(rows[2]).toContain('Ready to review');
    expect(rows[2]).toContain('8 valid, 2 with problems');
    expect(rows[3]).toContain('Missing required column: email');
    expect(w.findAll('[role=progressbar]')).toHaveLength(2); // only finished/running jobs show a bar
    expect(w.find('a[href="/imports/a"]').text()).toBe('done.csv');
  });

  it('shows an invitation when there are no imports yet', async () => {
    mockFetch({ 'GET /imports': () => json(200, { data: [] }) });
    const { wrapper: w } = await mountWithApp(ImportsView);
    await vi.waitFor(() => expect(w.text()).toContain('No imports yet.'));
    expect(w.findAll('a').some((a) => a.text() === 'Import contacts')).toBe(true);
  });

  it('shows an error with Retry, and recovers', async () => {
    let healthy = false;
    mockFetch({ 'GET /imports': () => (healthy ? json(200, { data: [makeJob()] }) : Promise.reject(new TypeError('Failed to fetch'))) });
    const { wrapper: w } = await mountWithApp(ImportsView);
    await vi.waitFor(() => expect(w.find('[role=alert]').exists()).toBe(true));
    healthy = true;
    await w.findAll('button').find((b) => b.text() === 'Retry')!.trigger('click');
    await vi.waitFor(() => expect(w.text()).toContain('leads.csv'));
  });
});
