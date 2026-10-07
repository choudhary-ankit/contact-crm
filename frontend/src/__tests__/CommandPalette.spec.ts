import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App.vue';
import CommandPalette from '../components/CommandPalette.vue';
import { usePalette } from '../composables/usePalette';
import { callsTo, json, makeContact, mockFetch, mountWithApp, page } from './helpers';

const mounted: Array<{ unmount: () => void }> = [];
const mount = async (...args: Parameters<typeof mountWithApp>) => {
  const ctx = await mountWithApp(...args);
  mounted.push(ctx.wrapper); // each palette registers a global shortcut listener, so every test must unmount its own
  return ctx;
};

afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount());
  usePalette().close();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const hits = [makeContact({ id: 'a1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.io' }), makeContact({ id: 'a2', firstName: 'Adam', lastName: 'Smith', email: null, company: 'Acme' })];
const setup = async () => {
  const fetchMock = mockFetch({ 'GET /contacts': (u) => json(200, ['ad', 'ada'].includes(u.searchParams.get('q') ?? '') ? page(hits) : page([])) });
  const ctx = await mount(CommandPalette);
  usePalette().open();
  await ctx.wrapper.vm.$nextTick();
  return { ...ctx, fetchMock };
};
const options = (w: any) => w.findAll('[role=option]').map((o: any) => o.text());
const key = (w: any, k: string) => w.find('.palette').trigger('keydown', { key: k });

describe('CommandPalette', () => {
  it('opens as an accessible dialog with the pages and actions, focused on the search box', async () => {
    const { wrapper: w } = await setup();
    expect(w.find('[role=dialog]').attributes('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(w.find('input').element);
    expect(options(w).join(' | ')).toMatch(/Contacts.*Add contact.*Import contacts.*Imports.*Metrics.*Trash/);
    expect(w.find('input').attributes('role')).toBe('combobox');
  });

  it('filters pages and actions as you type, including by keyword', async () => {
    const { wrapper: w } = await setup();
    await w.find('input').setValue('dash');
    expect(options(w)).toEqual(['MetricsGo to']); // "dashboard" is a keyword of Metrics
    await w.find('input').setValue('csv');
    expect(options(w).map((o: string) => o.replace(/Action|Go to/, ''))).toEqual(['Import contacts', 'Imports']);
  });

  it('searches contacts after a short pause, and shows them above the pages', async () => {
    const { wrapper: w, fetchMock } = await setup();
    await w.find('input').setValue('ad');
    await vi.waitFor(() => expect(options(w)[0]).toContain('Ada Lovelace'), { timeout: 3000 });
    expect(options(w)[1]).toContain('Adam Smith');
    expect(options(w)[1]).toContain('Acme'); // falls back to company when there is no email
    const q = callsTo(fetchMock, 'GET', /^\/contacts$/).map(([u]) => new URL(u as string, 'http://t').searchParams);
    expect(q.some((p) => p.get('q') === 'ad' && p.get('limit') === '15' && p.get('sort') === 'name' && !p.has('status'))).toBe(true); // active contacts only (status is omitted for active)
  });

  it('ranks names that start with the query above names that merely contain it', async () => {
    const mix = [
      makeContact({ id: 'x1', firstName: 'Abigail', lastName: 'Kadar', email: 'abigail@x.io' }), // only contains "ada" in the middle of the surname
      makeContact({ id: 'x2', firstName: 'Grace', lastName: 'Adair', email: 'g@x.io' }), // last name starts with "ada"
      makeContact({ id: 'x3', firstName: 'Ada', lastName: 'Lovelace', email: 'l@x.io' }), // first name starts with "ada"
    ];
    mockFetch({ 'GET /contacts': () => json(200, page(mix)) });
    const { wrapper: w } = await mount(CommandPalette);
    usePalette().open();
    await w.vm.$nextTick();
    await w.find('input').setValue('ada');
    await vi.waitFor(() => expect(options(w)[0]).toContain('Ada Lovelace'), { timeout: 3000 });
    const labels = w.findAll('[role=option]').map((o: any) => o.findAll('span').find((s: any) => !s.classes().includes('avatar') && !s.classes().includes('hint'))!.text());
    expect(labels.slice(0, 3)).toEqual(['Ada Lovelace', 'Grace Adair', 'Abigail Kadar']); // first-name prefix, then last-name prefix, then the rest
  });

  it('does not search for a single character', async () => {
    const { wrapper: w, fetchMock } = await setup();
    await w.find('input').setValue('a');
    await new Promise((r) => setTimeout(r, 350));
    expect(callsTo(fetchMock, 'GET', /^\/contacts$/)).toHaveLength(0);
  });

  it('moves with the arrow keys (wrapping), and Enter opens the highlighted result', async () => {
    const { wrapper: w, router } = await setup();
    expect(w.findAll('[role=option]')[0].attributes('aria-selected')).toBe('true');
    await key(w, 'ArrowUp'); // wraps to the last item
    expect(w.findAll('[role=option]').at(-1)!.attributes('aria-selected')).toBe('true');
    await key(w, 'Enter'); // last = Trash
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('trash'));
    expect(w.find('[role=dialog]').exists()).toBe(false); // closes after choosing
  });

  it('opens a contact found by search', async () => {
    const { wrapper: w, router } = await setup();
    await w.find('input').setValue('ada');
    await vi.waitFor(() => expect(options(w)[0]).toContain('Ada Lovelace'), { timeout: 3000 });
    await w.findAll('[role=option]')[0].trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.params.id).toBe('a1'));
  });

  it('"Add contact" jumps to the list with the create form requested', async () => {
    const { wrapper: w, router } = await setup();
    await w.find('input').setValue('add contact');
    await key(w, 'Enter');
    await vi.waitFor(() => expect(router.currentRoute.value.query.new).toBe('1'));
  });

  it('says so when nothing matches, and closes on Escape or a click outside', async () => {
    const { wrapper: w } = await setup();
    await w.find('input').setValue('zzzzzzzz');
    await new Promise((r) => setTimeout(r, 350));
    expect(w.find('.palette-empty').text()).toContain('No results for “zzzzzzzz”');
    await key(w, 'Escape');
    expect(w.find('[role=dialog]').exists()).toBe(false);

    usePalette().open();
    await w.vm.$nextTick();
    await w.find('.palette-overlay').trigger('mousedown');
    expect(w.find('[role=dialog]').exists()).toBe(false);
  });

  it('toggles from anywhere with Cmd+K or Ctrl+K', async () => {
    const { wrapper: w } = await setup();
    usePalette().close();
    await w.vm.$nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    await w.vm.$nextTick();
    expect(w.find('[role=dialog]').exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true }));
    await w.vm.$nextTick();
    expect(w.find('[role=dialog]').exists()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' })); // plain "k" must not open it
    await w.vm.$nextTick();
    expect(w.find('[role=dialog]').exists()).toBe(false);
  });
});

describe('App shell', () => {
  const shell = async (startAt = '/') => {
    mockFetch({ 'GET /contacts': () => json(200, { data: [], nextCursor: null, total: 12, totalCapped: false }) });
    return mount(App, {}, startAt);
  };

  it('has icon navigation, a trash count, and highlights the current section', async () => {
    const { wrapper: w } = await shell('/trash');
    await vi.waitFor(() => expect(w.find('.count').exists()).toBe(true));
    expect(w.find('.count').text()).toBe('12');
    expect(w.findAll('nav a').map((a) => a.text().replace(/\d+/, '').trim())).toEqual(['Contacts', 'Imports', 'Metrics', 'Trash']);
    expect(w.findAll('nav svg').length).toBeGreaterThanOrEqual(4);
    expect(w.find('.nav-item.active').text()).toContain('Trash');
  });

  it('keeps "Imports" highlighted on the import wizard and job pages', async () => {
    const { wrapper: w } = await shell('/imports/new');
    expect(w.find('.nav-item.active').text()).toContain('Imports');
  });

  it('the sidebar search button opens the palette and shows the shortcut', async () => {
    const { wrapper: w } = await shell();
    expect(w.find('.nav-search kbd').text()).toMatch(/⌘K|Ctrl K/);
    await w.find('.nav-search').trigger('click');
    await vi.waitFor(() => expect(w.find('.palette').exists()).toBe(true));
  });
});
