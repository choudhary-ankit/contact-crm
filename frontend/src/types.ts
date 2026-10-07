export interface Tag {
  id: string;
  name: string;
}

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  tags: Tag[];
  version: number;
  createdAt: string;
  updatedAt: string;
  /** null for active contacts; ISO timestamp when in the trash */
  deletedAt: string | null;
}

export interface ContactPage {
  data: Contact[];
  nextCursor: string | null;
  /** only present on the first page */
  total: number | null;
  totalCapped: boolean;
}

export type ActivityType =
  | 'CONTACT_CREATED'
  | 'CONTACT_UPDATED'
  | 'CONTACT_DELETED'
  | 'CONTACT_RESTORED'
  | 'TAG_ADDED'
  | 'TAG_REMOVED';

export interface Activity {
  id: number;
  contactId: string;
  type: ActivityType;
  payload: {
    changes?: Record<string, { from: unknown; to: unknown }>;
    tag?: { id: string; name: string };
    bulk?: boolean;
  };
  createdAt: string;
}

export interface BulkTagResult {
  tag: Tag;
  requested: number;
  matched: number;
  added: number;
  alreadyTagged: number;
  notFound: string[];
}

export interface BulkDeleteResult {
  requested: number;
  deleted: number;
  alreadyInTrash: number;
  notFound: string[];
}

export type SortKey = 'createdAt:desc' | 'createdAt:asc' | 'name:asc' | 'name:desc' | 'deletedAt:desc';

export interface CreateContactInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  tags?: string[];
}

export type Attention = 'no_contact_info' | 'untagged' | 'stale' | 'duplicate_phone';

export interface ListParams {
  status?: 'active' | 'deleted';
  attention?: Attention;
  q?: string;
  tag?: string;
  company?: string;
  createdFrom?: string;
  createdTo?: string;
  sort: SortKey;
  limit: number;
  cursor?: string;
}

export type EditableKey = 'firstName' | 'lastName' | 'email' | 'phone' | 'company';
export type ContactFields = Record<EditableKey, string>;

export const FIELDS: ReadonlyArray<{ key: EditableKey; label: string; required?: boolean }> = [
  { key: 'firstName', label: 'First name', required: true },
  { key: 'lastName', label: 'Last name', required: true },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'company', label: 'Company' },
];

// ---- CSV import
export type ImportMode = 'create' | 'update';
export type ImportStatus = 'validating' | 'ready' | 'importing' | 'completed' | 'failed' | 'cancelled';

export interface ImportJob {
  id: string;
  mode: ImportMode;
  filename: string;
  status: ImportStatus;
  totalRows: number | null;
  validRows: number | null;
  errorRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  notes: string[];
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ImportRowError {
  row: number;
  phase: 'validate' | 'import';
  field: string | null;
  message: string;
}

export interface ImportFormat {
  mode: ImportMode;
  title: string;
  summary: string;
  columns: Array<{ column: string; required: boolean; rule: string; example: string }>;
  notes: string[];
  filename: string;
}

// ---- metrics
export interface Metrics {
  range: 7 | 30 | 90;
  generatedAt: string;
  contacts: { active: number; newInRange: number; newPrevRange: number; changePct: number | null; inTrash: number };
  quality: {
    withEmail: number; withPhone: number; withCompany: number; noContactInfo: number; reachable: number;
    untagged: number; stale: number; staleDays: number; duplicatePhoneContacts: number; duplicatePhoneGroups: number;
  };
  tags: Array<{ name: string; count: number }>;
  daily: Array<{ date: string; created: number; edits: number }>;
  activity: Array<{ type: ActivityType; count: number }>;
  trash: { current: number; deletedInRange: number; restoredInRange: number };
  imports: {
    jobs: number; completed: number; failed: number; rowsCreated: number; rowsUpdated: number;
    rowsRejected: number; rowsSubmitted: number; acceptRate: number | null;
  };
}
