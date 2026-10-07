import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ConflictDialog from '../components/ConflictDialog.vue';
import type { Contact, ContactFields } from '../types';

const original: ContactFields = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.io', phone: '', company: 'Old Co' };
const latest: Contact = {
  id: '1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.io', phone: '555-0100', company: 'B Corp',
  tags: [], version: 2, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-02T00:00:00Z', deletedAt: null,
};

describe('ConflictDialog', () => {
  const factory = (mine: Record<string, string>) => mount(ConflictDialog, { props: { original, latest, mine } });

  it('only lists the fields the user changed, with all three values', () => {
    const w = factory({ company: 'A Corp' });
    const rows = w.findAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain('Old Co');
    expect(rows[0].text()).toContain('B Corp');
    expect(rows[0].text()).toContain('A Corp');
  });

  it('highlights a field both users edited, but not one only I edited', () => {
    const w = factory({ company: 'A Corp', lastName: 'Byron' });
    expect(w.find('[data-field=company]').classes()).toContain('clash'); // they changed company too
    expect(w.find('[data-field=lastName]').classes()).not.toContain('clash'); // unchanged on server
  });

  it('shows empty values explicitly', () => {
    const w = factory({ phone: '' });
    expect(w.find('[data-field=phone]').text()).toContain('(empty)');
  });

  it('emits the chosen resolution', async () => {
    const w = factory({ company: 'A Corp' });
    const [reapply, discard, cancel] = w.findAll('button');
    await reapply.trigger('click');
    await discard.trigger('click');
    await cancel.trigger('click');
    expect(w.emitted()).toHaveProperty('reapply');
    expect(w.emitted()).toHaveProperty('discard');
    expect(w.emitted()).toHaveProperty('cancel');
  });

  it('disables actions while a resolution is in flight', () => {
    const w = mount(ConflictDialog, { props: { original, latest, mine: { company: 'A' }, busy: true } });
    expect(w.findAll('button').every((b) => b.attributes('disabled') !== undefined)).toBe(true);
  });
});
