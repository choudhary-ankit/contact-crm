import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../composables/useToasts';
import ContactsView from '../views/ContactsView.vue';
import { bodyOf, callsTo, headersOf, json, makeContact, mockFetch, mountWithApp, page } from './helpers';

const ada = makeContact();
const grace = makeContact({ id: 'c2', firstName: 'Grace', lastName: 'Hopper', email: 'grace@navy.example', version: 3 });
const trashed = (c = ada) => ({ ...c, deletedAt: '2026-10-05T10:00:00Z', version: c.version + 1 });
const tagsRoute = { 'GET /tags': () => json(200, { data: [{ id: 't1', name: 'VIP' }] }) };

beforeEach(() => useToasts().toasts.splice(0));
afterEach(() => vi.unstubAllGlobals());

const rowMenu = async (w: any, name: string, item: string) => {
  await w.find(`button[aria-label="Actions for ${name}"]`).trigger('click');
  await w.findAll('[role=menuitem]').find((b: any) => b.text() === item)!.trigger('click');
};
const button = (w: any, label: string) => w.findAll('button').find((b: any) => b.text() === label)!;

describe('ContactsView - active list: create, trash, bulk', () => {
  it('opens the Add contact modal from the header button', async () => {
    mockFetch({ ...tagsRoute, 'GET /contacts': () => json(200, page([ada])) });
    const { wrapper: w } = await mountWithApp(ContactsView);
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    await button(w, 'Add contact').trigger('click');
    expect(w.find('[role=dialog]').text()).toContain('Add contact');
  });

  it('moves one contact to trash via the row menu with If-Match, then offers Undo', async () => {
    const fetchMock = mockFetch({
      ...tagsRoute,
      'GET /contacts': () => json(200, page([ada, grace])),
      'DELETE /contacts/:id': () => json(200, trashed(grace)),
      'POST /contacts/:id/restore': () => json(200, { ...grace, version: 5 }),
    });
    const { wrapper: w } = await mountWithApp(ContactsView);
    await vi.waitFor(() => expect(w.text()).toContain('Grace Hopper'));

    await rowMenu(w, 'Grace Hopper', 'Move to trash');
    expect(w.find('[role=alertdialog]').text()).toContain('Move Grace Hopper to trash');
    expect(callsTo(fetchMock, 'DELETE', /./)).toHaveLength(0); // nothing happens until confirmed
    await w.find('[role=alertdialog] button.danger').trigger('click');

    await vi.waitFor(() => expect(callsTo(fetchMock, 'DELETE', /^\/contacts\/c2$/)).toHaveLength(1));
    expect(headersOf(callsTo(fetchMock, 'DELETE', /./)[0])['If-Match']).toBe('"3"'); // the row's version
    await vi.waitFor(() => expect(useToasts().toasts[0]?.message).toBe('Moved Grace Hopper to trash'));
    expect(w.find('[role=alertdialog]').exists()).toBe(false);

    useToasts().toasts[0].action!.run(); // Undo
    await vi.waitFor(() => expect(callsTo(fetchMock, 'POST', /\/restore$/)).toHaveLength(1));
    expect(headersOf(callsTo(fetchMock, 'POST', /\/restore$/)[0])['If-Match']).toBe('"4"'); // version returned by the delete
  });

  it('keeps the dialog open with an explanation when someone else changed the contact (409)', async () => {
    mockFetch({
      ...tagsRoute,
      'GET /contacts': () => json(200, page([ada])),
      'DELETE /contacts/:id': () => json(409, { code: 'VERSION_CONFLICT', message: 'changed', current: { ...ada, version: 2 } }),
    });
    const { wrapper: w } = await mountWithApp(ContactsView);
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    await rowMenu(w, 'Ada Lovelace', 'Move to trash');
    await w.find('[role=alertdialog] button.danger').trigger('click');
    await vi.waitFor(() => expect(w.find('[role=alertdialog] [role=alert]').text()).toMatch(/someone changed this contact/i));
    expect(useToasts().toasts).toHaveLength(0);
  });

  it('bulk-trashes the selected contacts after confirmation', async () => {
    const fetchMock = mockFetch({
      ...tagsRoute,
      'GET /contacts': () => json(200, page([ada, grace])),
      'POST /contacts/bulk/delete': () => json(200, { requested: 2, deleted: 2, alreadyInTrash: 0, notFound: [] }),
    });
    const { wrapper: w } = await mountWithApp(ContactsView);
    await vi.waitFor(() => expect(w.text()).toContain('Grace Hopper'));

    expect(w.find('[role=region]').exists()).toBe(false); // no bulk bar until something is selected
    await w.find('input[aria-label="Select all contacts on this page"]').setValue(true);
    expect(w.find('[role=region]').text()).toContain('2 selected');

    await button(w, 'Move to trash').trigger('click');
    expect(w.find('[role=alertdialog]').text()).toContain('Move 2 contacts to trash');
    await w.find('[role=alertdialog] button.danger').trigger('click');

    await vi.waitFor(() => expect(callsTo(fetchMock, 'POST', /bulk\/delete$/)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, 'POST', /bulk\/delete$/)[0]).contactIds.sort()).toEqual(['c1', 'c2']);
    await vi.waitFor(() => expect(useToasts().toasts[0]?.message).toBe('Moved 2 contacts to trash'));
    expect(w.find('[role=region]').exists()).toBe(false); // selection cleared
  });

  it('shows an invitation to add the first contact when the account is empty', async () => {
    mockFetch({ ...tagsRoute, 'GET /contacts': () => json(200, page([])) });
    const { wrapper: w } = await mountWithApp(ContactsView);
    await vi.waitFor(() => expect(w.text()).toContain('No contacts yet.'));
    expect(button(w, 'Add contact')).toBeTruthy();
  });
});

describe('ContactsView - trash', () => {
  const trashMode = () => mountWithApp(ContactsView, { mode: 'trash' });

  it('lists trashed contacts via status=deleted with Restore buttons and no selection or tag filters', async () => {
    const fetchMock = mockFetch({ ...tagsRoute, 'GET /contacts': () => json(200, page([trashed()])) });
    const { wrapper: w } = await trashMode();
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));

    const url = new URL(callsTo(fetchMock, 'GET', /^\/contacts$/)[0][0] as string, 'http://test');
    expect(url.searchParams.get('status')).toBe('deleted');
    expect(url.searchParams.get('sort')).toBe('deletedAt');
    expect(w.find('h1').text()).toBe('Trash');
    expect(button(w, 'Restore')).toBeTruthy();
    expect(w.find('input[type=checkbox]').exists()).toBe(false);
    expect(w.text()).not.toContain('All tags'); // no tag / company / date filters in the trash
    expect(w.text()).not.toContain('+ Add contact');
  });

  it('restores a contact using its current version', async () => {
    const fetchMock = mockFetch({
      ...tagsRoute,
      'GET /contacts': () => json(200, page([trashed()])),
      'POST /contacts/:id/restore': () => json(200, { ...ada, version: 3 }),
    });
    const { wrapper: w } = await trashMode();
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    await button(w, 'Restore').trigger('click');
    await vi.waitFor(() => expect(useToasts().toasts[0]?.message).toBe('Restored Ada Lovelace'));
    expect(headersOf(callsTo(fetchMock, 'POST', /\/restore$/)[0])['If-Match']).toBe('"2"');
  });

  it('explains an email clash on restore and links to the contact that owns the email', async () => {
    mockFetch({
      ...tagsRoute,
      'GET /contacts': () => json(200, page([trashed()])),
      'POST /contacts/:id/restore': () =>
        json(409, { code: 'EMAIL_TAKEN', message: 'taken', details: [{ field: 'email', message: 'Ada Byron already uses this email' }], existing: { id: 'owner1', name: 'Ada Byron' } }),
    });
    const { wrapper: w } = await trashMode();
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace'));
    await button(w, 'Restore').trigger('click');
    await vi.waitFor(() => expect(w.find('.banner.danger').exists()).toBe(true));
    expect(w.find('.banner').text()).toContain("Can't restore Ada Lovelace");
    expect(w.find('.banner').text()).toContain('Ada Byron already uses this email');
    expect(w.find('.banner a').text()).toBe('Open that contact');
    expect(w.find('.banner a').attributes('href')).toBe('/contacts/owner1');
    expect(useToasts().toasts).toHaveLength(0);
  });

  it('shows "Trash is empty" with no calls to action', async () => {
    mockFetch({ ...tagsRoute, 'GET /contacts': () => json(200, page([])) });
    const { wrapper: w } = await trashMode();
    await vi.waitFor(() => expect(w.text()).toContain('Trash is empty.'));
    await flushPromises();
    expect(w.findAll('button').map((b) => b.text())).not.toContain('Add contact');
  });
});
