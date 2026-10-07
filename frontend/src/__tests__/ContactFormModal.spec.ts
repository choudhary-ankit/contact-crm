import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContactFormModal from '../components/ContactFormModal.vue';
import { bodyOf, callsTo, headersOf, json, makeContact, mockFetch, mountWithApp } from './helpers';

afterEach(() => vi.unstubAllGlobals());

async function open(routes = {}) {
  const fetchMock = mockFetch({ 'GET /tags': () => json(200, { data: [{ id: 't1', name: 'VIP' }] }), ...routes });
  const { wrapper } = await mountWithApp(ContactFormModal);
  await flushPromises();
  return { w: wrapper, fetchMock };
}
const fill = async (w: Awaited<ReturnType<typeof open>>['w'], values: Record<string, string>) => {
  for (const [name, v] of Object.entries(values)) await w.find(`input[name=${name}]`).setValue(v);
};

describe('ContactFormModal', () => {
  it('blocks submit with field errors and never calls the API', async () => {
    const { w, fetchMock } = await open();
    await fill(w, { email: 'nope', phone: '12' });
    await w.find('form').trigger('submit');
    expect(w.text()).toContain('First name is required');
    expect(w.text()).toContain('Last name is required');
    expect(w.text()).toContain('Enter a valid email address');
    expect(w.text()).toContain('Phone must be 7–15 digits');
    expect(callsTo(fetchMock, 'POST', /^\/contacts$/)).toHaveLength(0);
  });

  it('creates a contact: trims, sends blanks as null, includes de-duplicated tags, and emits created', async () => {
    const created = makeContact({ id: 'new1', firstName: 'Ada', lastName: 'Byron' });
    const { w, fetchMock } = await open({ 'POST /contacts': () => json(201, created) });
    await fill(w, { firstName: '  Ada ', lastName: 'Byron', email: ' ada@x.io ' });
    const tag = w.find('input[aria-label="Add a tag"]');
    await tag.setValue('VIP');
    await tag.trigger('keydown', { key: 'Enter' });
    await tag.setValue('vip'); // same tag, different case
    await tag.trigger('keydown', { key: 'Enter' });
    await tag.setValue('Lead'); // left half-typed: submitting must still include it
    await w.find('form').trigger('submit');
    await vi.waitFor(() => expect(w.emitted('created')).toBeTruthy());

    const [call] = callsTo(fetchMock, 'POST', /^\/contacts$/);
    expect(bodyOf(call)).toEqual({ firstName: 'Ada', lastName: 'Byron', email: 'ada@x.io', phone: null, company: null, tags: ['VIP', 'Lead'] });
    expect(headersOf(call).Authorization).toMatch(/^Bearer /);
    expect(w.emitted('created')![0]).toEqual([created]);
  });

  it('rejects invalid tag names inline', async () => {
    const { w } = await open();
    const tag = w.find('input[aria-label="Add a tag"]');
    await tag.setValue('a,b');
    await tag.trigger('keydown', { key: 'Enter' });
    expect(w.text()).toContain('cannot contain commas');
    expect(w.findAll('.chip')).toHaveLength(0);
  });

  it('shows the duplicate-email error from the server with a link to the existing contact', async () => {
    const { w } = await open({
      'POST /contacts': () =>
        json(409, {
          code: 'EMAIL_TAKEN', message: 'taken', details: [{ field: 'email', message: 'Ada Lovelace already uses this email' }],
          existing: { id: 'abc', name: 'Ada Lovelace' },
        }),
    });
    await fill(w, { firstName: 'Ada', lastName: 'Byron', email: 'ada@x.io' });
    await w.find('form').trigger('submit');
    await vi.waitFor(() => expect(w.text()).toContain('Ada Lovelace already uses this email'));
    expect(w.find('input[name=email]').attributes('aria-invalid')).toBe('true');
    expect(w.find('a').text()).toBe('Open contact');
    expect(w.emitted('created')).toBeUndefined(); // form stays open so nothing typed is lost
  });

  it('shows a generic failure banner when the server is unreachable', async () => {
    const { w } = await open({ 'POST /contacts': () => Promise.reject(new TypeError('Failed to fetch')) });
    await fill(w, { firstName: 'Ada', lastName: 'Byron' });
    await w.find('form').trigger('submit');
    await vi.waitFor(() => expect(w.find('[role=alert]').text()).toMatch(/cannot reach the server/i));
  });

  it('closes via Cancel and the close button', async () => {
    const { w } = await open();
    await w.find('button[aria-label=Close]').trigger('click');
    await w.findAll('button').find((b) => b.text() === 'Cancel')!.trigger('click');
    expect(w.emitted('close')).toHaveLength(2);
  });
});
