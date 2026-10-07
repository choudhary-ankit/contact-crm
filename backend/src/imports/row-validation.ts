import { isEmail } from 'class-validator';
import { Column, ColumnMap } from './csv';

export interface FieldError {
  field: string;
  message: string;
}

/** undefined = leave unchanged, null = clear (update mode only) */
export interface ImportValues {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  tags: string[];
}

export const CLEAR_TOKEN = '[clear]';
const MAX_TAGS = 20;

export interface ReadRowResult {
  values: ImportValues;
  errors: FieldError[];
}

/**
 * Turns one CSV row into values + friendly errors, using the same rules as the contact form/API.
 * Create mode: blank optional cells stay empty.
 * Update mode: email is the match key; blank cells leave the field unchanged and "[clear]" empties an optional field.
 */
export function readRow(mode: 'create' | 'update', cells: string[], map: ColumnMap): ReadRowResult {
  const errors: FieldError[] = [];
  const values: ImportValues = { tags: [] };
  const cell = (c: Column) => (map.index[c] === undefined ? undefined : (cells[map.index[c]!] ?? '').trim());
  const fail = (field: string, message: string) => errors.push({ field, message });

  /** returns undefined (skip), null (clear), or the trimmed value */
  const pick = (c: Column, label: string, opts: { required?: boolean; clearable?: boolean }): string | null | undefined => {
    const raw = cell(c);
    if (raw === undefined) return undefined; // column not in file
    if (raw === '') {
      if (opts.required && mode === 'create') fail(c, `${label} is required`);
      return mode === 'create' ? null : undefined;
    }
    if (mode === 'update' && raw.toLowerCase() === CLEAR_TOKEN) {
      if (!opts.clearable) fail(c, `${label} can't be cleared`);
      return opts.clearable ? null : undefined;
    }
    return raw;
  };

  const first = pick('first_name', 'First name', { required: true });
  if (first !== undefined) {
    values.firstName = first;
    if (first && first.length > 100) fail('first_name', 'First name is limited to 100 characters');
  }
  const last = pick('last_name', 'Last name', { required: true });
  if (last !== undefined) {
    values.lastName = last;
    if (last && last.length > 100) fail('last_name', 'Last name is limited to 100 characters');
  }

  // email: required key in update mode, optional in create mode
  const rawEmail = cell('email');
  if (rawEmail !== undefined) {
    if (rawEmail === '') {
      if (mode === 'update') fail('email', 'Email is required to find the contact');
      values.email = null;
    } else if (!isEmail(rawEmail) || rawEmail.length > 254) {
      fail('email', 'Not a valid email address');
    } else {
      values.email = rawEmail.toLowerCase();
    }
  }

  const phone = pick('phone', 'Phone', { clearable: true });
  if (phone !== undefined) {
    values.phone = phone;
    if (phone) {
      const digits = phone.replace(/\D/g, '').length;
      if (!/^\+?[\d\s().-]+$/.test(phone) || digits < 7 || digits > 15) fail('phone', 'Phone must be 7 to 15 digits');
    }
  }

  const company = pick('company', 'Company', { clearable: true });
  if (company !== undefined) {
    values.company = company;
    if (company && company.length > 150) fail('company', 'Company is limited to 150 characters');
  }

  const rawTags = cell('tags');
  if (rawTags) {
    if (mode === 'update' && rawTags.toLowerCase() === CLEAR_TOKEN) {
      fail('tags', 'Import only adds tags; remove tags in the app');
    } else {
      const seen = new Set<string>();
      for (const t of rawTags.split(';').map((s) => s.trim()).filter(Boolean)) {
        if (t.length > 50) fail('tags', `Tag "${t.slice(0, 20)}…" is longer than 50 characters`);
        else if (t.includes(',')) fail('tags', `Tag "${t}" cannot contain commas`);
        else if (!seen.has(t.toLowerCase())) {
          seen.add(t.toLowerCase());
          values.tags.push(t);
        }
      }
      if (values.tags.length > MAX_TAGS) fail('tags', `A contact can get at most ${MAX_TAGS} tags per row`);
    }
  }

  return { values, errors };
}
