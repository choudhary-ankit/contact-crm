import { afterEach, describe, expect, it, vi } from 'vitest';
import ContactDetailView from '../views/ContactDetailView.vue';
import { json, makeContact, mockFetch, mountWithApp } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const ACTIVITY = [
  { id: 3, contactId: 'c1', type: 'TAG_ADDED', payload: { tag: { id: 't', name: 'VIP' } }, createdAt: '2026-10-07T12:00:00Z' },
  { id: 2, contactId: 'c1', type: 'CONTACT_UPDATED', payload: { changes: { company: { from: null, to: 'Acme' } } }, createdAt: '2026-10-07T11:00:00Z' },
  { id: 1, contactId: 'c1', type: 'CONTACT_CREATED', payload: {}, createdAt: '2026-10-07T10:00:00Z' },
];
const open = async (activity: unknown[] = ACTIVITY, startAt = '/contacts/c1') => {
  mockFetch({
    'GET /contacts/:id': () => json(200, makeContact()),
    'GET /contacts/:id/activity': () => json(200, { data: activity }),
    'GET /tags': () => json(200, { data: [] }),
  });
  const ctx = await mountWithApp(ContactDetailView, { id: 'c1' }, startAt);
  await vi.waitFor(() => expect(ctx.wrapper.find('[role=tablist]').exists()).toBe(true));
  return ctx;
};
const tab = (w: any, id: string) => w.find(`#tab-${id}`);
const shown = (w: any, id: string) => (w.find(`#panel-${id}`).element as HTMLElement).style.display !== 'none';

describe('contact page tabs', () => {
  it('opens on Details, with the Activity tab showing how many events there are', async () => {
    const { wrapper: w } = await open();
    expect(tab(w, 'details').attributes('aria-selected')).toBe('true');
    expect(tab(w, 'activity').attributes('aria-selected')).toBe('false');
    await vi.waitFor(() => expect(tab(w, 'activity').find('small').text()).toBe('3'));
    expect(shown(w, 'details')).toBe(true);
    expect(shown(w, 'activity')).toBe(false);
    expect(w.find('[role=tabpanel]').attributes('aria-labelledby')).toBe('tab-details');
  });

  it('switches by click and remembers the tab in the URL', async () => {
    const { wrapper: w, router } = await open();
    await tab(w, 'activity').trigger('click');
    expect(tab(w, 'activity').attributes('aria-selected')).toBe('true');
    expect(shown(w, 'activity')).toBe(true);
    expect(shown(w, 'details')).toBe(false);
    await vi.waitFor(() => expect(router.currentRoute.value.query.tab).toBe('activity'));
    await tab(w, 'details').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.query.tab).toBeUndefined());
  });

  it('opens straight on Activity from a shared link, and supports arrow keys', async () => {
    const { wrapper: w } = await open(ACTIVITY, '/contacts/c1?tab=activity');
    expect(tab(w, 'activity').attributes('aria-selected')).toBe('true');
    await w.find('[role=tablist]').trigger('keydown', { key: 'ArrowLeft' });
    expect(tab(w, 'details').attributes('aria-selected')).toBe('true');
    await w.find('[role=tablist]').trigger('keydown', { key: 'ArrowRight' });
    expect(tab(w, 'activity').attributes('aria-selected')).toBe('true');
    expect(tab(w, 'activity').attributes('tabindex')).toBe('0');
    expect(tab(w, 'details').attributes('tabindex')).toBe('-1'); // only the active tab is in the tab order
  });

  it('keeps the details form and tags on the Details tab', async () => {
    const { wrapper: w } = await open();
    expect(w.find('#panel-details input[name=firstName]').exists()).toBe(true);
    expect(w.find('#panel-details .tag-editor').exists()).toBe(true);
    expect(w.find('#panel-activity input').exists()).toBe(false);
  });
});

describe('activity timeline', () => {
  it('lists events newest first, each with an icon, a headline, the specifics and a time', async () => {
    const { wrapper: w } = await open();
    await vi.waitFor(() => expect(w.findAll('.timeline li')).toHaveLength(3));
    const items = w.findAll('.timeline li');
    expect(items.map((i) => i.find('.tl-title').text())).toEqual(['Tag added', 'Contact updated', 'Contact created']);
    expect(items[0].find('.tl-sub').text()).toBe('VIP');
    expect(items[1].find('.tl-sub').text()).toBe('Company: (empty) → Acme');
    expect(items[2].find('.tl-sub').exists()).toBe(false); // the headline says it all
    expect(items.map((i) => i.find('.tl-icon').classes().find((c) => c.startsWith('pal-')))).toEqual(['pal-2', 'pal-0', 'pal-1']);
    expect(items.every((i) => i.find('.tl-icon svg').exists() && i.find('time').attributes('datetime'))).toBe(true);
    expect(w.find('#panel-activity').text()).toContain('Newest first');
  });

  it('shows a friendly empty state when there is no history', async () => {
    const { wrapper: w } = await open([]);
    await vi.waitFor(() => expect(w.find('#panel-activity .empty').exists()).toBe(true));
    expect(w.find('#panel-activity').text()).toContain('No activity yet.');
  });
});

describe('contact page loading', () => {
  it('shows a placeholder shaped like the page, then the contact', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockFetch({
      'GET /contacts/:id': async () => (await gate, json(200, makeContact())),
      'GET /contacts/:id/activity': () => json(200, { data: [] }),
      'GET /tags': () => json(200, { data: [] }),
    });
    const { wrapper: w } = await mountWithApp(ContactDetailView, { id: 'c1' }, '/contacts/c1');
    expect(w.find('.skeleton').exists()).toBe(true);
    expect(w.text()).toContain('Loading contact');
    release();
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    expect(w.find('.skeleton').exists()).toBe(false);
  });
});
