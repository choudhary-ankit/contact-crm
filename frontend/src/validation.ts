import type { ContactFields } from './types';

/** Mirrors the server's rules for instant feedback; the server stays the source of truth. */
export function validateContact(f: ContactFields): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.firstName.trim()) e.firstName = 'First name is required';
  else if (f.firstName.trim().length > 100) e.firstName = 'First name is limited to 100 characters';
  if (!f.lastName.trim()) e.lastName = 'Last name is required';
  else if (f.lastName.trim().length > 100) e.lastName = 'Last name is limited to 100 characters';
  const email = f.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = 'Enter a valid email address';
  const phone = f.phone.trim();
  if (phone) {
    const digits = phone.replace(/\D/g, '').length;
    if (!/^\+?[\d\s().-]+$/.test(phone) || digits < 7 || digits > 15) e.phone = 'Phone must be 7–15 digits';
  }
  if (f.company.trim().length > 150) e.company = 'Company is limited to 150 characters';
  return e;
}

/** Returns an error message for a tag name, or null when it is acceptable. */
export function validateTagName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return 'Enter a tag name';
  if (name.length > 50) return 'Tag names are limited to 50 characters';
  if (name.includes(',')) return 'Tag names cannot contain commas';
  return null;
}
