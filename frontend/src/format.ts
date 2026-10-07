import type { Activity, Attention } from './types';

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const LABELS: Record<string, string> = { firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', company: 'Company',
  first_name: 'First name', last_name: 'Last name' };
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : String(v));

const REL = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
/** "2 days ago" style label for the trash view. */
export function fmtRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return REL.format(Math.round(seconds / size), unit);
  return 'just now';
}

export const initials = (first: string, last: string) => `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();

export function describeActivity(a: Activity): string {
  switch (a.type) {
    case 'CONTACT_CREATED':
      return 'Contact created';
    case 'CONTACT_DELETED':
      return `Moved to trash${a.payload.bulk ? ' (bulk)' : ''}`;
    case 'CONTACT_RESTORED':
      return 'Restored from trash';
    case 'TAG_ADDED':
      return `Tag added: ${a.payload.tag?.name ?? ''}${a.payload.bulk ? ' (bulk)' : ''}`;
    case 'TAG_REMOVED':
      return `Tag removed: ${a.payload.tag?.name ?? ''}`;
    case 'CONTACT_UPDATED':
      return Object.entries(a.payload.changes ?? {})
        .map(([f, c]) => `${LABELS[f] ?? f}: ${show(c.from)} → ${show(c.to)}`)
        .join('; ') || 'Contact updated';
  }
}

export const fmtNumber = (n: number) => n.toLocaleString('en-US');
/** Percentage with one decimal at most; 0 when the denominator is 0. */
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export const ATTENTION_LABELS: Record<Attention, string> = {
  no_contact_info: 'No email and no phone',
  untagged: 'Untagged',
  stale: 'Not updated in 90+ days',
  duplicate_phone: 'Possible duplicates (same phone)',
};
