import type {
  Activity, BulkDeleteResult, BulkTagResult, Contact, ContactPage, CreateContactInput, ImportFormat, ImportJob, ImportMode,
  ImportRowError, ListParams, Metrics, Tag,
} from './types';

const BASE = import.meta.env.VITE_API_URL ?? '/api';
const API_KEY = import.meta.env.VITE_API_KEY ?? 'demo-key';

export interface FieldError {
  field: string;
  message: string;
}

/** Normalised failure for every API call, including "server unreachable" (status 0). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: FieldError[] = [],
    public readonly current?: Contact,
    /** for EMAIL_TAKEN: the active contact that already owns the email */
    public readonly existing?: { id: string; name: string },
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isConflict() {
    return this.status === 409 && this.code === 'VERSION_CONFLICT';
  }
}

async function request<T>(path: string, init: RequestInit & { ifMatch?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}`, ...(init.headers as Record<string, string>) };
  // JSON bodies get a content type; FormData must be left alone so the browser adds the multipart boundary
  if (typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  if (init.ifMatch !== undefined) headers['If-Match'] = `"${init.ifMatch}"`;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.code ?? 'ERROR',
      body?.message ?? `Request failed (${res.status})`,
      body?.details ?? [],
      body?.current,
      body?.existing,
    );
  }
  return body as T;
}

/** Fetches a file with the API key and hands it to the browser as a download. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.code ?? 'ERROR', body?.message ?? `Download failed (${res.status})`, body?.details ?? []);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Drops empty values so the URL only carries active filters. */
export function buildListQuery(p: ListParams): string {
  const [sort, order] = p.sort.split(':');
  const qs = new URLSearchParams();
  const put = (k: string, v: string | number | undefined) => v !== undefined && v !== '' && qs.set(k, String(v));
  put('status', p.status === 'deleted' ? 'deleted' : undefined);
  put('attention', p.attention);
  put('q', p.q);
  put('tags', p.tag);
  put('company', p.company);
  put('createdFrom', p.createdFrom);
  put('createdTo', p.createdTo);
  put('sort', sort);
  put('order', order);
  put('limit', p.limit);
  put('cursor', p.cursor);
  return qs.toString();
}

export const api = {
  listContacts: (p: ListParams) => request<ContactPage>(`/contacts?${buildListQuery(p)}`),
  createContact: (input: CreateContactInput) =>
    request<Contact>('/contacts', { method: 'POST', body: JSON.stringify(input) }),
  getContact: (id: string) => request<Contact>(`/contacts/${id}`),
  updateContact: (id: string, version: number, patch: Record<string, string | null>) =>
    request<Contact>(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(patch), ifMatch: version }),
  /** Soft delete: moves the contact to the trash. */
  deleteContact: (id: string, version: number) => request<Contact>(`/contacts/${id}`, { method: 'DELETE', ifMatch: version }),
  restoreContact: (id: string, version: number) =>
    request<Contact>(`/contacts/${id}/restore`, { method: 'POST', ifMatch: version }),
  bulkDelete: (contactIds: string[]) =>
    request<BulkDeleteResult>('/contacts/bulk/delete', { method: 'POST', body: JSON.stringify({ contactIds }) }),
  listTags: () => request<{ data: Tag[] }>('/tags').then((r) => r.data),
  /** Adds several tags in one request; the response carries the contact's complete, current tag list. */
  addTags: (id: string, names: string[]) =>
    request<{ added: boolean; addedCount: number; tags: Tag[] }>(`/contacts/${id}/tags`, { method: 'POST', body: JSON.stringify({ names }) }),
  removeTag: (id: string, tagId: string) => request<void>(`/contacts/${id}/tags/${tagId}`, { method: 'DELETE' }),
  bulkAddTag: (contactIds: string[], tag: string) =>
    request<BulkTagResult>('/contacts/bulk/tags', { method: 'POST', body: JSON.stringify({ contactIds, tag }) }),
  exportContacts: (p: Omit<ListParams, 'limit' | 'cursor'>) =>
    downloadFile(`/contacts/export.csv?${buildListQuery({ ...p, limit: 100 })}`, 'contacts.csv'),

  // ---- CSV import
  importFormats: () => request<ImportFormat[]>('/imports/formats'),
  downloadTemplate: (mode: ImportMode) => downloadFile(`/imports/templates/${mode}`, `contacts-${mode}-sample.csv`),
  uploadImport: (mode: ImportMode, file: File) => {
    const form = new FormData();
    form.append('mode', mode);
    form.append('file', file);
    return request<ImportJob>('/imports', { method: 'POST', body: form });
  },
  listImports: () => request<{ data: ImportJob[] }>('/imports').then((r) => r.data),
  getImport: (id: string) => request<ImportJob>(`/imports/${id}`),
  importErrors: (id: string, offset = 0, limit = 100) =>
    request<{ data: ImportRowError[]; total: number }>(`/imports/${id}/errors?limit=${limit}&offset=${offset}`),
  downloadImportErrors: (id: string) => downloadFile(`/imports/${id}/errors.csv`, 'rejected-rows.csv'),
  confirmImport: (id: string) => request<ImportJob>(`/imports/${id}/confirm`, { method: 'POST' }),
  cancelImport: (id: string) => request<ImportJob>(`/imports/${id}/cancel`, { method: 'POST' }),

  // ---- metrics
  metrics: (range: 7 | 30 | 90) => request<Metrics>(`/metrics?range=${range}`),

  activity: (id: string) => request<{ data: Activity[] }>(`/contacts/${id}/activity?limit=20`).then((r) => r.data),
};
