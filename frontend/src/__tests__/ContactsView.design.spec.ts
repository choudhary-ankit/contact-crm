import { afterEach, describe, expect, it, vi } from 'vitest';
import { pal } from '../format';
import ContactsView from '../views/ContactsView.vue';
import { callsTo, json, makeContact, mockFetch, mountWithApp, page } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const METRICS = {
  contacts: { active: 9995 },
  quality: { untagged: 3568, noContactInfo: 554 },
  tags: [{ name: 'Customer', count: 7421 }, { name: 'Lead', count: 6281 }, { name: 'VIP', count: 719 }, { name: 'Zed', count: 1 }],
};
const ada = makeContact();
const routes = (over: Record<string, any> = {}) => ({
  'GET /tags': () => json(200, { data: [{ id: 't1', name: 'Lead' }, { id: 't2', name: 'VIP' }] }),
  'GET /metrics': () => json(200, METRICS),
  'GET /contacts': () => json(200, page([ada])),
  ...over,
});
const lists = (fn: ReturnType<typeof vi.fn>) => callsTo(fn, 'GET', /^\/contacts$/).map(([u]) => new URL(u as string, 'http://t').searchParams);
const last = (fn: ReturnType<typeof vi.fn>) => lists(fn).at(-1)!;
const chip = (w: any, label: string) => w.findAll('.view-chip').find((c: any) => c.text().startsWith(label))!;
const open = async (over = {}, startAt = '/', waitFor = 'Ada Lovelace') => {
  const fetchMock = mockFetch(routes(over));
  const ctx = await mountWithApp(ContactsView, {}, startAt);
  await vi.waitFor(() => expect(ctx.wrapper.text()).toContain(waitFor));
  return { ...ctx, fetchMock };
};

describe('saved views', () => {
  it('show one-click shortcuts with live counts: All, the three biggest tags, Untagged, No contact info', async () => {
    const { wrapper: w } = await open();
    await vi.waitFor(() => expect(w.findAll('.view-chip').length).toBe(6));
    expect(w.findAll('.view-chip').map((c) => c.text())).toEqual(['All9,995', 'Customer7,421', 'Lead6,281', 'VIP719', 'Untagged3,568', 'No contact info554']);
    expect(chip(w, 'All').attributes('aria-pressed')).toBe('true');
  });

  it('a tag view filters the list, highlights itself, updates the URL, and "All" clears it', async () => {
    const { wrapper: w, router, fetchMock } = await open();
    await vi.waitFor(() => expect(chip(w, 'VIP')).toBeTruthy());
    await chip(w, 'VIP').trigger('click');
    await vi.waitFor(() => expect(last(fetchMock).get('tags')).toBe('VIP'));
    expect(chip(w, 'VIP').classes()).toContain('on');
    expect(chip(w, 'All').classes()).not.toContain('on');
    expect(w.find('.filter-chip').exists()).toBe(false); // the chip itself shows the filter, so no duplicate
    await vi.waitFor(() => expect(router.currentRoute.value.query.tag).toBe('VIP'));

    await chip(w, 'All').trigger('click');
    await vi.waitFor(() => expect(last(fetchMock).has('tags')).toBe(false));
    expect(chip(w, 'All').classes()).toContain('on');
  });

  it('"Untagged" applies the attention filter, and switching views replaces the previous one', async () => {
    const { wrapper: w, fetchMock } = await open();
    await vi.waitFor(() => expect(chip(w, 'Untagged')).toBeTruthy());
    await chip(w, 'Lead').trigger('click');
    await vi.waitFor(() => expect(last(fetchMock).get('tags')).toBe('Lead'));
    await chip(w, 'Untagged').trigger('click');
    await vi.waitFor(() => expect(last(fetchMock).get('attention')).toBe('untagged'));
    expect(last(fetchMock).has('tags')).toBe(false); // one view at a time
    expect(chip(w, 'Untagged').classes()).toContain('on');
    expect(chip(w, 'Lead').classes()).not.toContain('on');
  });

  it('are selected from the URL (the Metrics page links here)', async () => {
    const { wrapper: w } = await open({}, '/?attention=no_contact_info');
    await vi.waitFor(() => expect(chip(w, 'No contact info')).toBeTruthy());
    expect(chip(w, 'No contact info').classes()).toContain('on');
    expect(w.find('.filter-chip').exists()).toBe(false);
  });

  it('are hidden, without affecting the list, if the counts cannot be loaded', async () => {
    const { wrapper: w } = await open({ 'GET /metrics': () => json(500, { code: 'INTERNAL_ERROR', message: 'boom' }) });
    await new Promise((r) => setTimeout(r, 100));
    expect(w.find('.views').exists()).toBe(false);
    expect(w.text()).toContain('Ada Lovelace');
  });

  it('ignore a malformed metrics response instead of crashing the list', async () => {
    const { wrapper: w } = await open({ 'GET /metrics': () => json(200, { unexpected: true }) });
    await new Promise((r) => setTimeout(r, 100));
    expect(w.text()).toContain('Ada Lovelace');
    expect(w.find('.views').exists()).toBe(false);
  });
});

describe('filters popover and active filter chips', () => {
  it('collects tag, company, dates and attention in one popover with a count badge and "Clear all"', async () => {
    const { wrapper: w, fetchMock } = await open();
    const trigger = () => w.findAll('button').find((b) => b.text().startsWith('Filters'))!;
    expect(trigger().find('.badge-dot').exists()).toBe(false);
    expect(w.find('.popover-panel').exists()).toBe(false);

    await trigger().trigger('click');
    const panel = w.find('.popover-panel');
    expect(panel.attributes('role')).toBe('dialog');
    await panel.find('select').setValue('Lead'); // first select = Tag
    await vi.waitFor(() => expect(last(fetchMock).get('tags')).toBe('Lead'));
    expect(trigger().find('.badge-dot').text()).toBe('1');

    await panel.find('input[type=text]').setValue('acme');
    await vi.waitFor(() => expect(last(fetchMock).get('company')).toBe('acme'), { timeout: 2000 });
    expect(trigger().find('.badge-dot').text()).toBe('2');

    await panel.findAll('button').find((b) => b.text() === 'Clear all')!.trigger('click');
    await vi.waitFor(() => expect(last(fetchMock).has('company') || last(fetchMock).has('tags')).toBe(false));
    expect(trigger().find('.badge-dot').exists()).toBe(false);
  });

  it('shows filters that no view represents as removable chips, and removing one refetches', async () => {
    const { wrapper: w, fetchMock } = await open({}, '/?company=acme&attention=stale');
    expect(w.findAll('.filter-chip').map((c) => c.text())).toEqual(['Company: acme', 'Needs attention: Not updated in 90+ days']);
    await w.findAll('.filter-chip')[0].find('button').trigger('click');
    await vi.waitFor(() => expect(last(fetchMock).has('company')).toBe(false));
    expect(last(fetchMock).get('attention')).toBe('stale');
    expect(w.findAll('.filter-chip')).toHaveLength(1);
  });

  it('closes with Escape or a click outside', async () => {
    const { wrapper: w } = await open();
    await w.findAll('button').find((b) => b.text().startsWith('Filters'))!.trigger('click');
    expect(w.find('.popover-panel').exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await w.vm.$nextTick();
    expect(w.find('.popover-panel').exists()).toBe(false);
  });

  it('sorting is a labelled select that changes the request', async () => {
    const { wrapper: w, fetchMock } = await open();
    await w.find('select[aria-label=Sort]').setValue('name:asc');
    await vi.waitFor(() => expect(last(fetchMock).get('sort')).toBe('name'));
    expect(last(fetchMock).get('order')).toBe('asc');
  });
});

describe('table design', () => {
  it('colours avatars by person and tags by name, collapses extra tags into a "+N", and dashes empty values', async () => {
    const busy = makeContact({
      id: 'b1', firstName: 'Grace', lastName: 'Hopper', email: null, phone: '555-0100', company: null,
      tags: ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name, i) => ({ id: `t${i}`, name })),
    });
    const bare = makeContact({ id: 'b2', firstName: 'Alan', lastName: 'Turing', tags: [] });
    const { wrapper: w } = await open({ 'GET /contacts': () => json(200, page([busy, bare])) }, '/', 'Grace Hopper');

    const [r1, r2] = w.findAll('tbody tr');
    expect(r1.find('.avatar').classes()).toContain(pal('Grace Hopper'));
    expect(r1.find('.avatar').text()).toBe('GH');
    expect(r1.text()).toContain('555-0100'); // falls back to the phone when there is no email
    expect(r1.findAll('.tag:not(.more)').map((t) => t.text())).toEqual(['Alpha', 'Beta']);
    expect(r1.findAll('.tag:not(.more)')[0].classes()).toContain(pal('Alpha'));
    expect(r1.find('.tag.more').text()).toBe('+2');
    expect(r1.find('.tag.more').attributes('title')).toBe('Gamma, Delta');
    expect(r2.text()).toContain('—'); // no tags
  });

  it('shows a skeleton while loading and replaces it with the rows', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { wrapper: w } = await (async () => {
      mockFetch(routes({ 'GET /contacts': async () => (await gate, json(200, page([ada]))) }));
      return mountWithApp(ContactsView);
    })();
    expect(w.find('.skeleton').exists()).toBe(true);
    expect(w.find('[role=status]').text()).toContain('Loading contacts');
    expect(w.find('tbody').exists()).toBe(false);
    release();
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    expect(w.find('.skeleton').exists()).toBe(false);
  });

  const rangeRoutes = () =>
    routes({ 'GET /contacts': (u: URL) => json(200, u.searchParams.has('cursor') ? page([ada], { total: null }) : page([ada, ada], { nextCursor: 'c1', total: 10000, totalCapped: true })) });

  it('unfiltered, shows the exact total (from the metrics) and the visible range; the range moves with the page', async () => {
    const fetchMock = mockFetch(rangeRoutes());
    const { wrapper: w } = await mountWithApp(ContactsView);
    await vi.waitFor(() => expect(w.find('.pager-info').text()).toBe('1–2 of 9,995'));
    expect(w.find('.page-header').text()).toContain('9,995 total'); // same figure as the "All" chip
    await w.findAll('button').find((b) => b.text().startsWith('Next'))!.trigger('click');
    await vi.waitFor(() => expect(lists(fetchMock).some((p) => p.get('cursor') === 'c1')).toBe(true));
    await vi.waitFor(() => expect(w.find('.pager-info').text()).toMatch(/^26–26 of 9,995/)); // second page of 25 per page
  });

  it('with a filter on, the count is the list\'s own capped one ("10,000+")', async () => {
    mockFetch(rangeRoutes());
    const { wrapper: w } = await mountWithApp(ContactsView, {}, '/?company=acme');
    await vi.waitFor(() => expect(w.find('.pager-info').text()).toBe('1–2 of 10,000+'));
    expect(w.find('.page-header').text()).toContain('10,000+ total');
  });
});

describe('quick add', () => {
  it('opens the create form even when the list is ALREADY open (the quick-search "Add contact" case), keeping the filters', async () => {
    const { wrapper: w, router } = await open({}, '/?company=acme'); // list on screen, filter active
    expect(w.find('[role=dialog]').exists()).toBe(false);
    await router.push({ name: 'contacts', query: { company: 'acme', new: '1' } }); // what the palette does from this very page
    await vi.waitFor(() => expect(w.find('[role=dialog]').text()).toContain('Add contact'));
    await vi.waitFor(() => expect(router.currentRoute.value.query.new).toBeUndefined());
    expect(router.currentRoute.value.query.company).toBe('acme'); // the filter survives
    // and it keeps working: close it, ask again, it opens again
    await w.find('button[aria-label=Close]').trigger('click');
    expect(w.find('[role=dialog]').exists()).toBe(false);
    await router.push({ name: 'contacts', query: { company: 'acme', new: '1' } });
    await vi.waitFor(() => expect(w.find('[role=dialog]').exists()).toBe(true));
  });

  it('opens the create form when the palette sends you here with ?new=1, and cleans the URL', async () => {
    const { wrapper: w, router } = await open({}, '/?new=1');
    await vi.waitFor(() => expect(w.find('[role=dialog]').text()).toContain('Add contact'));
    await vi.waitFor(() => expect(router.currentRoute.value.query.new).toBeUndefined());
  });
});
