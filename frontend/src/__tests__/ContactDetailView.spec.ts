import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../composables/useToasts';
import ContactDetailView from '../views/ContactDetailView.vue';
import { callsTo, headersOf, json, makeContact, mockFetch, mountWithApp } from './helpers';

const deleted = makeContact({ deletedAt: '2026-10-05T10:00:00Z', version: 2 });
const common = { 'GET /tags': () => json(200, { data: [] }), 'GET /contacts/:id/activity': () => json(200, { data: [] }) };

beforeEach(() => useToasts().toasts.splice(0));
afterEach(() => vi.unstubAllGlobals());

const button = (w: any, label: string) => w.findAll('button').find((b: any) => b.text() === label);

describe('ContactDetailView', () => {
  it('shows a trashed contact read-only, with a banner and Restore instead of Move to trash', async () => {
    mockFetch({ ...common, 'GET /contacts/:id': () => json(200, deleted) });
    const { wrapper: w } = await mountWithApp(ContactDetailView, { id: 'c1' });
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));

    expect(w.find('.banner.warn').text()).toContain('in the trash');
    expect(w.find('fieldset').attributes('disabled')).toBeDefined(); // disables every input inside
    expect(button(w, 'Restore contact')).toBeTruthy();
    expect(button(w, 'Move to trash')).toBeUndefined();
    expect(button(w, 'Save changes')).toBeUndefined();
  });

  it('restores from the detail page using the current version and shows the editable contact again', async () => {
    let restored = false;
    const fetchMock = mockFetch({
      ...common,
      'GET /contacts/:id': () => json(200, restored ? makeContact({ version: 3 }) : deleted),
      'POST /contacts/:id/restore': () => ((restored = true), json(200, makeContact({ version: 3 }))),
    });
    const { wrapper: w } = await mountWithApp(ContactDetailView, { id: 'c1' });
    await vi.waitFor(() => expect(button(w, 'Restore contact')).toBeTruthy());
    await button(w, 'Restore contact').trigger('click');
    await vi.waitFor(() => expect(button(w, 'Move to trash')).toBeTruthy());
    expect(headersOf(callsTo(fetchMock, 'POST', /restore$/)[0])['If-Match']).toBe('"2"');
    expect(w.find('.banner.warn').exists()).toBe(false);
    expect(useToasts().toasts[0].message).toBe('Restored Ada Lovelace');
  });

  it('points to the contact that owns the email when a restore is blocked', async () => {
    mockFetch({
      ...common,
      'GET /contacts/:id': () => json(200, deleted),
      'POST /contacts/:id/restore': () =>
        json(409, { code: 'EMAIL_TAKEN', message: 'taken', details: [{ field: 'email', message: 'Ada Byron already uses this email' }], existing: { id: 'o1', name: 'Ada Byron' } }),
    });
    const { wrapper: w } = await mountWithApp(ContactDetailView, { id: 'c1' });
    await vi.waitFor(() => expect(button(w, 'Restore contact')).toBeTruthy());
    await button(w, 'Restore contact').trigger('click');
    await vi.waitFor(() => expect(w.find('.banner.warn').text()).toContain("Can't restore"));
    expect(w.find('.banner.warn a').attributes('href')).toBe('/contacts/o1');
  });

  it('moves an active contact to trash after confirmation, then returns to the list with an Undo toast', async () => {
    const fetchMock = mockFetch({
      ...common,
      'GET /contacts/:id': () => json(200, makeContact()),
      'DELETE /contacts/:id': () => json(200, deleted),
    });
    const { wrapper: w, router } = await mountWithApp(ContactDetailView, { id: 'c1' }, '/contacts/c1');
    await vi.waitFor(() => expect(button(w, 'Move to trash')).toBeTruthy());
    await button(w, 'Move to trash').trigger('click');
    expect(w.find('[role=alertdialog]').text()).toContain('Move Ada Lovelace to trash');
    await w.find('[role=alertdialog] button.danger').trigger('click');

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('contacts'));
    expect(headersOf(callsTo(fetchMock, 'DELETE', /./)[0])['If-Match']).toBe('"1"');
    expect(useToasts().toasts[0]).toMatchObject({ message: 'Moved Ada Lovelace to trash', action: { label: 'Undo' } });
  });

  it('turns the page read-only if someone trashes the contact while it is being edited (CONTACT_DELETED)', async () => {
    mockFetch({
      ...common,
      'GET /contacts/:id': () => json(200, makeContact()),
      'PATCH /contacts/:id': () => json(409, { code: 'CONTACT_DELETED', message: 'in trash', current: deleted }),
    });
    const { wrapper: w } = await mountWithApp(ContactDetailView, { id: 'c1' });
    await vi.waitFor(() => expect(w.find('input[name=company]').exists()).toBe(true));
    await w.find('input[name=company]').setValue('New Co');
    await w.find('form').trigger('submit');
    await vi.waitFor(() => expect(w.find('.banner.warn').exists()).toBe(true));
    expect(w.find('fieldset').attributes('disabled')).toBeDefined();
  });
});

describe('ContactDetailView - tags', () => {
  const active = makeContact({ tags: [{ id: 'old', name: 'Customer' }] });
  const tagList = (w: any) => w.findAll('ul[aria-label="Assigned tags"] .chip').map((c: any) => c.text().replace('×', '').trim());
  const editor = (w: any) => w.findComponent({ name: 'TagEditor' });
  const getCalls = (fn: any) => callsTo(fn, 'GET', /^\/contacts\/c1$/).length;

  it('adds several tags in ONE request and shows the complete list the server returns', async () => {
    const fetchMock = mockFetch({
      ...common,
      'GET /contacts/:id': () => json(200, active),
      'POST /contacts/:id/tags': () => json(201, { added: true, addedCount: 2, tags: [{ id: 'old', name: 'Customer' }, { id: 'n1', name: 'Lead' }, { id: 'n2', name: 'VIP' }] }),
    });
    const { wrapper: w } = await mountWithApp(ContactDetailView, { id: 'c1' }, '/contacts/c1');
    await vi.waitFor(() => expect(tagList(w)).toEqual(['Customer']));

    const input = w.find('input[aria-label="New tag names"]');
    await input.setValue('Lead, VIP');
    await input.trigger('keydown', { key: 'Enter' });
    await w.find('.tag-form').trigger('submit');

    await vi.waitFor(() => expect(tagList(w)).toEqual(['Customer', 'Lead', 'VIP']));
    const posts = callsTo(fetchMock, 'POST', /tags$/);
    expect(posts).toHaveLength(1);
    expect(JSON.parse((posts[0][1] as RequestInit).body as string)).toEqual({ names: ['Lead', 'VIP'] });
    expect(w.findAll('.chips.staged .chip')).toHaveLength(0); // cleared after success
    expect(getCalls(fetchMock)).toBe(1); // no re-fetch of the contact that could overwrite the list
  });

  it('never shows an older tag list over a newer one, even if responses arrive out of order', async () => {
    // the bug: add Lead, then Churned quickly; the slower first response used to land last and hide Churned
    const sent: string[] = [];
    mockFetch({
      ...common,
      'GET /contacts/:id': () => json(200, active),
      'POST /contacts/:id/tags': async (_u, init) => {
        const names = JSON.parse(init.body as string).names as string[];
        sent.push(names[0]);
        const first = names[0] === 'Lead';
        await new Promise((r) => setTimeout(r, first ? 60 : 5)); // first request is the slow one
        const tags = first
          ? [{ id: 'old', name: 'Customer' }, { id: 'n1', name: 'Lead' }]
          : [{ id: 'old', name: 'Customer' }, { id: 'n1', name: 'Lead' }, { id: 'n2', name: 'Churned' }];
        return json(201, { added: true, addedCount: 1, tags });
      },
    });
    const { wrapper: w } = await mountWithApp(ContactDetailView, { id: 'c1' }, '/contacts/c1');
    await vi.waitFor(() => expect(tagList(w)).toEqual(['Customer']));

    editor(w).vm.$emit('add', ['Lead']);
    editor(w).vm.$emit('add', ['Churned']); // fired while the first is still in flight
    await vi.waitFor(() => expect(tagList(w)).toEqual(['Customer', 'Lead', 'Churned']), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 120)); // let any late response land
    expect(tagList(w)).toEqual(['Customer', 'Lead', 'Churned']);
    expect(sent).toEqual(['Lead', 'Churned']); // and they were sent in order, one after the other
  });

  it('keeps the lined-up tags and shows the error when saving fails', async () => {
    mockFetch({
      ...common,
      'GET /contacts/:id': () => json(200, active),
      'POST /contacts/:id/tags': () => json(400, { code: 'VALIDATION_ERROR', message: 'bad', details: [{ field: 'names', message: 'Too many tags' }] }),
    });
    const { wrapper: w } = await mountWithApp(ContactDetailView, { id: 'c1' }, '/contacts/c1');
    await vi.waitFor(() => expect(tagList(w)).toEqual(['Customer']));
    const input = w.find('input[aria-label="New tag names"]');
    await input.setValue('Lead, VIP');
    await input.trigger('keydown', { key: 'Enter' });
    await w.find('.tag-form').trigger('submit');
    await vi.waitFor(() => expect(w.find('.tag-editor [role=alert]').text()).toBe('Too many tags'));
    expect(w.findAll('.chips.staged .chip')).toHaveLength(2); // nothing lost, can retry
    expect(tagList(w)).toEqual(['Customer']);
  });

  it('removes a tag from the list without re-fetching the contact', async () => {
    const two = makeContact({ tags: [{ id: 'a', name: 'Customer' }, { id: 'b', name: 'Lead' }] });
    const fetchMock = mockFetch({ ...common, 'GET /contacts/:id': () => json(200, two), 'DELETE /contacts/:id/tags/:tagId': () => json(204) });
    const { wrapper: w } = await mountWithApp(ContactDetailView, { id: 'c1' }, '/contacts/c1');
    await vi.waitFor(() => expect(tagList(w)).toEqual(['Customer', 'Lead']));
    await w.find('button[aria-label="Remove tag Customer"]').trigger('click');
    await vi.waitFor(() => expect(tagList(w)).toEqual(['Lead']));
    expect(callsTo(fetchMock, 'DELETE', /tags\/a$/)).toHaveLength(1);
    expect(getCalls(fetchMock)).toBe(1);
  });

  it('labels the activity list as newest first', async () => {
    mockFetch({ ...common, 'GET /contacts/:id': () => json(200, active) });
    const { wrapper: w } = await mountWithApp(ContactDetailView, { id: 'c1' }, '/contacts/c1');
    await vi.waitFor(() => expect(w.text()).toContain('Recent activity'));
    expect(w.text()).toContain('Newest first');
  });
});
