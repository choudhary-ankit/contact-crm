import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TagEditor from '../components/TagEditor.vue';

const tags = [{ id: 't1', name: 'VIP' }];
const make = (props: Record<string, unknown> = {}) => mount(TagEditor, { props: { tags, suggestions: [], ...props } });
const input = (w: ReturnType<typeof make>) => w.find('input');
const staged = (w: ReturnType<typeof make>) => w.findAll('.chips.staged .chip').map((c) => c.text().replace('×', '').trim());
const addButton = (w: ReturnType<typeof make>) => w.find('button[type=submit]');

async function typeThenEnter(w: ReturnType<typeof make>, text: string) {
  await input(w).setValue(text);
  await input(w).trigger('keydown', { key: 'Enter' });
}

describe('TagEditor - adding several tags', () => {
  it('Enter lines tags up without saving, and one click adds them all together', async () => {
    const w = make();
    await typeThenEnter(w, 'Lead');
    await typeThenEnter(w, 'Customer');
    expect(w.emitted('add')).toBeUndefined(); // nothing sent yet
    expect(staged(w)).toEqual(['Lead', 'Customer']);
    expect(addButton(w).text()).toBe('Add 2 tags');

    await w.find('form').trigger('submit');
    expect(w.emitted('add')).toHaveLength(1);
    expect(w.emitted('add')![0]).toEqual([['Lead', 'Customer']]); // a single request with every tag
  });

  it('a comma or semicolon also lines the tag up', async () => {
    const w = make();
    await input(w).setValue('Lead');
    await input(w).trigger('keydown', { key: ',' });
    await input(w).setValue('Customer');
    await input(w).trigger('keydown', { key: ';' });
    expect(staged(w)).toEqual(['Lead', 'Customer']);
  });

  it('splits a pasted list into separate tags', async () => {
    const w = make();
    await typeThenEnter(w, 'Lead, Customer; Prospect ,, ');
    expect(staged(w)).toEqual(['Lead', 'Customer', 'Prospect']);
  });

  it('includes a half-typed tag when you click Add', async () => {
    const w = make();
    await typeThenEnter(w, 'Lead');
    await input(w).setValue('Customer'); // typed, never confirmed with Enter
    expect(addButton(w).text()).toBe('Add 2 tags');
    await w.find('form').trigger('submit');
    expect(w.emitted('add')![0]).toEqual([['Lead', 'Customer']]);
  });

  it('pressing Enter on an empty box submits what is lined up', async () => {
    const w = make();
    await typeThenEnter(w, 'Lead');
    await input(w).trigger('keydown', { key: 'Enter' });
    expect(w.emitted('add')![0]).toEqual([['Lead']]);
  });

  it('ignores duplicates (case-insensitively) of lined-up tags, and tells you about tags the contact already has', async () => {
    const w = make();
    await typeThenEnter(w, 'Lead, lead, LEAD, vip');
    expect(staged(w)).toEqual(['Lead']); // VIP is already assigned
    expect(w.find('[role=alert]').text()).toBe('"vip" is already added');
  });

  it('lets you take a lined-up tag back out', async () => {
    const w = make();
    await typeThenEnter(w, 'Lead, Customer');
    await w.find('.chips.staged button[aria-label="Don\'t add Lead"]').trigger('click');
    expect(staged(w)).toEqual(['Customer']);
    expect(addButton(w).text()).toBe('Add tag');
  });

  it('keeps invalid text in the box with an error, and does not emit', async () => {
    const w = make();
    await typeThenEnter(w, `${'x'.repeat(51)}, Lead`);
    expect(w.find('[role=alert]').text()).toMatch(/50 characters/);
    expect(w.emitted('add')).toBeUndefined();
    expect((input(w).element as HTMLInputElement).value).toContain('xxxx'); // not thrown away
  });

  it('limits one batch to 20 tags', async () => {
    const w = make();
    await typeThenEnter(w, Array.from({ length: 21 }, (_, i) => `t${i}`).join(','));
    expect(staged(w)).toHaveLength(20);
    expect(w.find('[role=alert]').text()).toMatch(/up to 20 tags/);
  });

  it('has nothing to add until something is typed', async () => {
    const w = make();
    expect(addButton(w).attributes('disabled')).toBeDefined();
    await w.find('form').trigger('submit');
    expect(w.find('[role=alert]').text()).toBe('Enter a tag name');
    expect(w.emitted('add')).toBeUndefined();
  });

  it('keeps tags lined up until the parent confirms they were saved, then clear() empties everything', async () => {
    const w = make();
    await typeThenEnter(w, 'Lead, Customer');
    await w.find('form').trigger('submit');
    expect(staged(w)).toEqual(['Lead', 'Customer']); // still there: a failed save must not lose them
    (w.vm as unknown as { clear: () => void }).clear();
    await w.vm.$nextTick();
    expect(staged(w)).toEqual([]);
    expect((input(w).element as HTMLInputElement).value).toBe('');
  });
});

describe('TagEditor - assigned tags', () => {
  it('emits remove with the tag object', async () => {
    const w = make();
    await w.find('button.chip-x[aria-label="Remove tag VIP"]').trigger('click');
    expect(w.emitted('remove')?.[0]).toEqual([tags[0]]);
  });

  it('shows an empty state and a server error', () => {
    const w = make({ tags: [], error: 'Tag update failed' });
    expect(w.text()).toContain('No tags yet');
    expect(w.find('[role=alert]').text()).toBe('Tag update failed');
  });

  it('disables everything while busy', () => {
    const w = make({ busy: true });
    expect(input(w).attributes('disabled')).toBeDefined();
    expect(w.find('button.chip-x').attributes('disabled')).toBeDefined();
  });
});
