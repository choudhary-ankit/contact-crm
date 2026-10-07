import { afterEach, describe, expect, it, vi } from 'vitest';
import MetricsView from '../views/MetricsView.vue';
import { callsTo, json, mockFetch, mountWithApp } from './helpers';

const metrics = (over: Record<string, any> = {}) => ({
  range: 30,
  generatedAt: '2026-10-07T10:00:00Z',
  contacts: { active: 1000, newInRange: 120, newPrevRange: 100, changePct: 20, inTrash: 7 },
  quality: {
    withEmail: 900, withPhone: 800, withCompany: 700, noContactInfo: 50, reachable: 950, untagged: 250, stale: 400, staleDays: 90,
    duplicatePhoneContacts: 0, duplicatePhoneGroups: 0,
  },
  tags: [{ name: 'Customer', count: 600 }, { name: 'Lead', count: 300 }],
  daily: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, created: i % 7, edits: i % 3 })),
  activity: [{ type: 'TAG_ADDED', count: 80 }, { type: 'CONTACT_UPDATED', count: 20 }],
  trash: { current: 7, deletedInRange: 9, restoredInRange: 2 },
  imports: { jobs: 4, completed: 3, failed: 1, rowsCreated: 500, rowsUpdated: 40, rowsRejected: 12, rowsSubmitted: 552, acceptRate: 97.8 },
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

const open = async (data = metrics(), startAt = '/metrics', waitFor = 'Active contacts') => {
  const fetchMock = mockFetch({ 'GET /metrics': () => json(200, data) });
  const ctx = await mountWithApp(MetricsView, {}, startAt);
  await vi.waitFor(() => expect(ctx.wrapper.text()).toContain(waitFor));
  return { ...ctx, fetchMock };
};

describe('MetricsView', () => {
  it('shows the headline numbers with percentages computed from the counts', async () => {
    const { wrapper: w } = await open();
    const kpis = w.findAll('.kpi').map((k) => k.text());
    expect(kpis[0]).toContain('1,000');
    expect(kpis[0]).toContain('7 in trash');
    expect(kpis[1]).toContain('120');
    expect(kpis[1]).toContain('▲ 20% vs previous 30 days');
    expect(kpis[2]).toContain('95%'); // 950 / 1000 reachable
    expect(kpis[3]).toContain('25%'); // 250 / 1000 untagged
    expect(kpis[3]).toContain('250 contacts');
  });

  it('shows a decline in red with a down arrow, and no comparison when there is no previous period', async () => {
    const { wrapper: down } = await open(metrics({ contacts: { active: 10, newInRange: 5, newPrevRange: 10, changePct: -50, inTrash: 0 } }));
    expect(down.find('.kpi .down').text()).toContain('▼ 50%');
    const { wrapper: none } = await open(metrics({ contacts: { active: 10, newInRange: 5, newPrevRange: 0, changePct: null, inTrash: 0 } }));
    expect(none.text()).toContain('No previous period to compare');
  });

  it('lists tags, completeness, activity, trash and import results', async () => {
    const { wrapper: w } = await open();
    const tags = w.findAll('.bars')[0].text();
    expect(tags).toContain('Customer');
    expect(tags).toContain('600');
    expect(w.text()).toContain('90%'); // email 900/1000
    expect(w.text()).toContain('Tags added');
    expect(w.text()).toContain('Contacts edited');
    expect(w.find('.facts').text()).toContain('Moved to trash (period)9');
    expect(w.find('.facts').text()).toContain('97.8%');
    expect(w.find('.facts').text()).toContain('12 rows rejected');
  });

  it('"Needs attention" rows link to the pre-filtered contact list, and show "None" when a count is zero', async () => {
    const { wrapper: w } = await open();
    const href = (label: string) => {
      const a = w.findAll('.attention tr').find((tr) => tr.text().includes(label))!.find('a');
      return a.exists() ? a.attributes('href') : undefined;
    };
    expect(href('No email and no phone')).toBe('/?attention=no_contact_info');
    expect(href('Untagged')).toBe('/?attention=untagged');
    expect(href('Not updated in 90+ days')).toBe('/?attention=stale');
    expect(w.findAll('.attention tr').find((tr) => tr.text().includes('Possible duplicates'))!.text()).toContain('None');
    expect(w.find('a[href="/?attention=duplicate_phone"]').exists()).toBe(false);
  });

  it('charts the daily series with an accessible summary', async () => {
    const { wrapper: w } = await open();
    const svg = w.find('svg[role=img]');
    expect(svg.attributes('aria-label')).toContain('30 days');
    expect(svg.attributes('aria-label')).toContain('New contacts:');
    expect(svg.findAll('polyline')).toHaveLength(2);
    expect(w.findAll('.chart tbody tr')).toHaveLength(30); // screen-reader data table
  });

  it('requests the selected period and keeps it in the URL', async () => {
    const { wrapper: w, router, fetchMock } = await open();
    expect(new URL(callsTo(fetchMock, 'GET', /metrics$/)[0][0] as string, 'http://t').searchParams.get('range')).toBe('30');
    await w.find('select[aria-label=Period]').setValue('7');
    await vi.waitFor(() => expect(callsTo(fetchMock, 'GET', /metrics$/).some(([u]) => String(u).includes('range=7'))).toBe(true));
    expect(router.currentRoute.value.query.range).toBe('7');
  });

  it('starts from the period in the URL', async () => {
    const { fetchMock } = await open(metrics(), '/metrics?range=90');
    expect(String(callsTo(fetchMock, 'GET', /metrics$/)[0][0])).toContain('range=90');
  });

  it('invites you to add data when the account is empty', async () => {
    const { wrapper: w } = await open(
      metrics({ contacts: { active: 0, newInRange: 0, newPrevRange: 0, changePct: null, inTrash: 0 }, imports: { jobs: 0, completed: 0, failed: 0, rowsCreated: 0, rowsUpdated: 0, rowsRejected: 0, rowsSubmitted: 0, acceptRate: null } }),
      '/metrics', 'No data yet',
    );
    expect(w.text()).toContain('No data yet');
    expect(w.findAll('a').map((a) => a.text())).toEqual(expect.arrayContaining(['Go to contacts', 'Import contacts']));
  });

  it('shows an error with Retry and recovers', async () => {
    let healthy = false;
    mockFetch({ 'GET /metrics': () => (healthy ? json(200, metrics()) : Promise.reject(new TypeError('Failed to fetch'))) });
    const { wrapper: w } = await mountWithApp(MetricsView, {}, '/metrics');
    await vi.waitFor(() => expect(w.text()).toMatch(/Could not load metrics: Cannot reach the server/));
    healthy = true;
    await w.findAll('button').find((b) => b.text() === 'Retry')!.trigger('click');
    await vi.waitFor(() => expect(w.text()).toContain('Active contacts'));
  });
});
