import { describe, expect, it } from 'vitest';
import { activityDetail, activityTitle, fmtSmartDate, paletteIndex, pal } from '../format';
import type { Activity } from '../types';

const act = (type: Activity['type'], payload: Activity['payload'] = {}): Activity => ({ id: 1, contactId: 'c', type, payload, createdAt: '2026-10-07T10:00:00Z' });

describe('colour palette', () => {
  it('is stable, case-insensitive and always one of the 8 slots', () => {
    expect(paletteIndex('VIP')).toBe(paletteIndex('vip'));
    expect(paletteIndex('Ada Lovelace')).toBe(paletteIndex('Ada Lovelace'));
    for (const name of ['', 'a', 'Customer', 'Lead', 'x'.repeat(500), 'Ünïcode ✓']) {
      const i = paletteIndex(name);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(8);
      expect(pal(name)).toBe(`pal-${i}`);
    }
  });

  it('spreads different names across several colours', () => {
    const used = new Set(['Customer', 'Lead', 'Prospect', 'VIP', 'Partner', 'Churned', 'Ada', 'Grace', 'Alan', 'Linus'].map(paletteIndex));
    expect(used.size).toBeGreaterThanOrEqual(4);
  });
});

describe('fmtSmartDate', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  it('is relative within a week and an absolute date after that', () => {
    expect(fmtSmartDate('2026-10-05T12:00:00Z', now)).toBe('2 days ago');
    expect(fmtSmartDate('2026-10-07T09:00:00Z', now)).toBe('3 hours ago');
    expect(fmtSmartDate('2026-09-01T12:00:00Z', now)).toMatch(/Sep 1, 2026/);
  });
});

describe('activity wording', () => {
  it('gives each event a headline, and details only when there is something to add', () => {
    expect(activityTitle(act('CONTACT_CREATED'))).toBe('Contact created');
    expect(activityTitle(act('CONTACT_DELETED', { bulk: true }))).toBe('Moved to trash (bulk)');
    expect(activityTitle(act('CONTACT_RESTORED'))).toBe('Restored from trash');
    expect(activityTitle(act('TAG_ADDED'))).toBe('Tag added');
    expect(activityDetail(act('TAG_ADDED', { tag: { id: 't', name: 'VIP' } }))).toBe('VIP');
    expect(activityDetail(act('TAG_REMOVED', { tag: { id: 't', name: 'Lead' } }))).toBe('Lead');
    expect(activityDetail(act('CONTACT_CREATED'))).toBeNull();
    expect(activityDetail(act('CONTACT_UPDATED', { changes: { company: { from: null, to: 'Acme' } } }))).toBe('Company: (empty) → Acme');
    expect(activityDetail(act('CONTACT_UPDATED'))).toBeNull();
  });
});
