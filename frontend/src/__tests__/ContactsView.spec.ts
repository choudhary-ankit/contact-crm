import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import ContactsView from '../views/ContactsView.vue';

const contact = (id: string, first: string) => ({
  id, firstName: first, lastName: 'Tester', email: `${first}@x.io`, phone: null, company: null,
  tags: [{ id: 't1', name: 'VIP' }], version: 1, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', deletedAt: null,
});
const page = (data: unknown[], extra = {}) => ({ data, nextCursor: null, total: data.length, totalCapped: false, ...extra });
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

async function mountView() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'contacts', component: ContactsView }, { path: '/contacts/:id', name: 'contact', component: { template: '<div/>' } }, { path: '/imports/new', name: 'import-new', component: { template: '<div/>' } }] });
  router.push('/');
  await router.isReady();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: 'always' }, mutations: { networkMode: 'always' } } });
  const wrapper = mount(ContactsView, { global: { plugins: [router, [VueQueryPlugin, { queryClient }]] } });
  return wrapper;
}

describe('ContactsView states', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const route = (handlers: { contacts: () => Promise<Response> }) =>
    fetchMock.mockImplementation((url: string) => (url.includes('/tags') ? ok({ data: [{ id: 't1', name: 'VIP' }] }) : handlers.contacts()));

  it('shows a loading state, then the rows with tags and the total', async () => {
    route({ contacts: () => ok(page([contact('1', 'Ada'), contact('2', 'Grace')])) });
    const w = await mountView();
    expect(w.text()).toContain('Loading contacts');
    await vi.waitFor(() => expect(w.text()).toContain('Ada Tester'));
    expect(w.text()).toContain('2 total');
    expect(w.text()).toContain('VIP');
  });

  it('invites you to add the first contact when the account is empty', async () => {
    route({ contacts: () => ok(page([])) });
    const w = await mountView();
    await vi.waitFor(() => expect(w.text()).toContain('No contacts yet.'));
  });

  it('shows "No contacts match" when a search finds nothing, with a way to clear it', async () => {
    route({ contacts: () => ok(page([])) });
    const w = await mountView();
    await vi.waitFor(() => expect(w.text()).toContain('No contacts yet.'));
    await w.find('input[type=search]').setValue('zzzz');
    await vi.waitFor(() => expect(w.text()).toContain('No contacts match your search or filters'), { timeout: 2000 });
    expect(w.findAll('button').map((b) => b.text())).toContain('Clear filters');
  });

  it('shows a backend failure with Retry, and recovers when the retry succeeds', async () => {
    let healthy = false;
    route({ contacts: () => (healthy ? ok(page([contact('1', 'Ada')])) : Promise.reject(new TypeError('Failed to fetch'))) });
    const w = await mountView();

    await vi.waitFor(() => expect(w.find('[role=alert]').exists()).toBe(true));
    expect(w.text()).toMatch(/could not load contacts: cannot reach the server/i);

    healthy = true;
    await w.findAll('button').find((b) => b.text() === 'Retry')!.trigger('click');
    await vi.waitFor(() => expect(w.text()).toContain('Ada Tester'));
    expect(w.find('[role=alert]').exists()).toBe(false);
  });

  it('warns about a 1-character search and does not send it to the API', async () => {
    route({ contacts: () => ok(page([contact('1', 'Ada')])) });
    const w = await mountView();
    await vi.waitFor(() => expect(w.text()).toContain('Ada Tester'));
    fetchMock.mockClear();
    await w.find('input[type=search]').setValue('a');
    await vi.waitFor(() => expect(w.text()).toContain('at least 2 characters'), { timeout: 2000 });
    await flushPromises();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('q=a'))).toBe(false);
  });

  it('ignores an inverted date range and tells the user', async () => {
    route({ contacts: () => ok(page([contact('1', 'Ada')])) });
    const w = await mountView();
    await vi.waitFor(() => expect(w.text()).toContain('Ada Tester'));
    const [from, to] = w.findAll('input[type=date]');
    await from.setValue('2025-06-01');
    await to.setValue('2025-01-01');
    expect(w.text()).toContain('must be on or before');
  });
});
