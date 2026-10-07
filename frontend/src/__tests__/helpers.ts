import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { mount } from '@vue/test-utils';
import { vi } from 'vitest';
import type { Component } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Contact } from '../types';

export const json = (status: number, body?: unknown) =>
  Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));

export const csvResponse = (body: string, filename = 'file.csv') =>
  Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${filename}"` } }));

export const makeJob = (over: Record<string, unknown> = {}) => ({
  id: 'j1', mode: 'create', filename: 'leads.csv', status: 'ready', totalRows: 10, validRows: 8, errorRows: 2, processedRows: 0,
  createdCount: 0, updatedCount: 0, unchangedCount: 0, notes: [], failureReason: null,
  createdAt: '2026-10-07T10:00:00Z', startedAt: null, finishedAt: null, ...over,
});

export const FORMATS = [
  {
    mode: 'create', title: 'Add new contacts', summary: 'Creates one contact per row.', filename: 'contacts-add-sample.csv',
    columns: [
      { column: 'first_name', required: true, rule: 'Up to 100 characters', example: 'Ada' },
      { column: 'email', required: false, rule: 'Valid email', example: 'ada@example.com' },
    ],
    notes: ['Rows with problems are skipped.'],
  },
  {
    mode: 'update', title: 'Update existing contacts', summary: 'Finds each contact by email.', filename: 'contacts-update-sample.csv',
    columns: [{ column: 'email', required: true, rule: 'Identifies the contact', example: 'ada@example.com' }],
    notes: ['Blank leaves a field unchanged.'],
  },
];

export const makeContact = (over: Partial<Contact> = {}): Contact => ({
  id: 'c1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.io', phone: null, company: 'Analytical Engines',
  tags: [{ id: 't1', name: 'VIP' }], version: 1, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
  deletedAt: null, ...over,
});

export const page = (data: Contact[], extra = {}) => ({ data, nextCursor: null, total: data.length, totalCapped: false, ...extra });

type Handler = (url: URL, init: RequestInit) => Promise<Response>;

/** Routes keyed like "GET /contacts/:id"; the /api prefix is stripped. Records every call. */
export function mockFetch(routes: Record<string, Handler>) {
  const compiled = Object.entries(routes).map(([k, h]) => {
    const [method, path] = k.split(' ');
    return { method, re: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`), h };
  });
  const fn = vi.fn((input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://test');
    const path = url.pathname.replace(/^\/api/, '');
    const route = compiled.find((r) => r.method === (init.method ?? 'GET') && r.re.test(path));
    return route ? route.h(url, init) : json(404, { code: 'NOT_FOUND', message: `no mock for ${init.method ?? 'GET'} ${path}` });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** All fetch calls matching "METHOD /path" */
export const callsTo = (fn: ReturnType<typeof vi.fn>, method: string, path: RegExp) =>
  fn.mock.calls.filter(([u, i]) => (i?.method ?? 'GET') === method && path.test(new URL(u as string, 'http://test').pathname.replace(/^\/api/, '')));

export async function mountWithApp(component: Component, props: Record<string, unknown> = {}, startAt = '/') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'contacts', component: { template: '<div/>' } },
      { path: '/trash', name: 'trash', component: { template: '<div/>' } },
      { path: '/contacts/:id', name: 'contact', component: { template: '<div/>' } },
      { path: '/imports', name: 'imports', component: { template: '<div/>' } },
      { path: '/imports/new', name: 'import-new', component: { template: '<div/>' } },
      { path: '/imports/:id', name: 'import', component: { template: '<div/>' } },
      { path: '/metrics', name: 'metrics', component: { template: '<div/>' } },
    ],
  });
  router.push(startAt);
  await router.isReady();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: 'always' }, mutations: { networkMode: 'always' } } });
  const wrapper = mount(component, { props, attachTo: document.body, global: { plugins: [router, [VueQueryPlugin, { queryClient }]] } });
  return { wrapper, router, queryClient };
}

export const bodyOf = (call: unknown[]) => JSON.parse(((call[1] as RequestInit).body as string) ?? 'null');
export const headersOf = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>;
