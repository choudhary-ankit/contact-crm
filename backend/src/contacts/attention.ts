/**
 * "Needs attention" definitions. They are used by BOTH the list filter (?attention=...) and the metrics counts,
 * so the number on the Metrics page always equals what its "View" link lists.
 * All predicates assume the contacts table is aliased as `c` and already restricted to active contacts.
 */
export const STALE_DAYS = 90;

export const ATTENTION_FILTERS = ['no_contact_info', 'untagged', 'stale', 'duplicate_phone'] as const;
export type Attention = (typeof ATTENTION_FILTERS)[number];

export const NO_CONTACT_INFO = `(c.email IS NULL AND c.phone IS NULL)`;
export const UNTAGGED = `NOT EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id)`;
export const STALE = `c.updated_at < now() - interval '${STALE_DAYS} days'`;

/** Contacts whose phone number is shared with at least one other active contact in the account. */
export const duplicatePhone = (accountParam: string) =>
  `(c.phone_digits <> '' AND c.phone_digits IN (
      SELECT d.phone_digits FROM contacts d
      WHERE d.account_id = ${accountParam} AND d.deleted_at IS NULL AND d.phone_digits <> ''
      GROUP BY d.phone_digits HAVING count(*) > 1))`;

export function attentionSql(a: Attention, accountParam: string): string {
  switch (a) {
    case 'no_contact_info': return NO_CONTACT_INFO;
    case 'untagged': return UNTAGGED;
    case 'stale': return STALE;
    case 'duplicate_phone': return duplicatePhone(accountParam);
  }
}
