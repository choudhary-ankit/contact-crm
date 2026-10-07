import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ConfirmDialog from '../components/ConfirmDialog.vue';

const props = { title: 'Move Ada to trash', message: 'You can restore them later.', confirmLabel: 'Move to trash', danger: true };

describe('ConfirmDialog', () => {
  it('shows the title, message and a danger confirm button', () => {
    const w = mount(ConfirmDialog, { props });
    expect(w.text()).toContain('Move Ada to trash');
    expect(w.text()).toContain('You can restore them later.');
    expect(w.find('button.danger').text()).toBe('Move to trash');
  });

  it('emits confirm and cancel from the buttons', async () => {
    const w = mount(ConfirmDialog, { props });
    const [cancel, confirm] = w.findAll('button');
    await confirm.trigger('click');
    await cancel.trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);
    expect(w.emitted('cancel')).toHaveLength(1);
  });

  it('cancels on Escape and on backdrop click, and focuses Cancel first (safe default)', async () => {
    const w = mount(ConfirmDialog, { props, attachTo: document.body });
    expect(document.activeElement?.textContent).toBe('Cancel');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await w.find('.overlay').trigger('click');
    expect(w.emitted('cancel')).toHaveLength(2);
    w.unmount();
  });

  it('shows an error and disables both buttons while busy', () => {
    const w = mount(ConfirmDialog, { props: { ...props, error: 'Someone changed this contact.', busy: true } });
    expect(w.find('[role=alert]').text()).toBe('Someone changed this contact.');
    expect(w.findAll('button').every((b) => b.attributes('disabled') !== undefined)).toBe(true);
  });
});
