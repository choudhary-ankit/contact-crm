<script setup lang="ts">
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ContactFormModal from '../components/ContactFormModal.vue';
import RowMenu from '../components/RowMenu.vue';
import { useDebounced } from '../composables/useDebounced';
import { useToasts } from '../composables/useToasts';
import { ATTENTION_LABELS, fmtDate, fmtRelative, initials } from '../format';
import type { Attention, BulkTagResult, Contact, ListParams, SortKey } from '../types';

/** One list component serves both pages: the active contacts and the trash. */
const props = withDefaults(defineProps<{ mode?: 'active' | 'trash' }>(), { mode: 'active' });
const isTrash = computed(() => props.mode === 'trash');

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();
const { push: toast } = useToasts();

// ---- filter state (mirrored into the URL so refresh / back / shared links keep the view)
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const search = ref(str(route.query.q));
const company = ref(str(route.query.company));
const tag = ref(str(route.query.tag));
const createdFrom = ref(str(route.query.from));
const createdTo = ref(str(route.query.to));
const sort = ref<SortKey>((str(route.query.sort) as SortKey) || 'createdAt:desc');
const limit = ref(Number(route.query.limit) || 25);
const ATTENTION_KEYS = Object.keys(ATTENTION_LABELS) as Attention[];
/** Set by the "View" links on the Metrics page. */
const attention = ref<Attention | ''>(ATTENTION_KEYS.find((k) => k === route.query.attention) ?? '');

const debouncedSearch = useDebounced(search, 300);
const debouncedCompany = useDebounced(company, 300);

const searchTooShort = computed(() => debouncedSearch.value.trim().length === 1);
const rangeInvalid = computed(() => !!createdFrom.value && !!createdTo.value && createdFrom.value > createdTo.value);

// ---- cursor pagination: keep the cursor of every page we have visited so "Previous" works
const cursors = ref<(string | undefined)[]>([undefined]);
const pageIndex = ref(0);
const cursor = computed(() => cursors.value[pageIndex.value]);

const filters = computed(() => ({
  status: isTrash.value ? ('deleted' as const) : ('active' as const),
  attention: isTrash.value ? undefined : attention.value || undefined,
  q: searchTooShort.value ? undefined : debouncedSearch.value.trim() || undefined,
  tag: isTrash.value ? undefined : tag.value || undefined,
  company: isTrash.value ? undefined : debouncedCompany.value.trim() || undefined,
  createdFrom: isTrash.value || rangeInvalid.value || !createdFrom.value ? undefined : `${createdFrom.value}T00:00:00`,
  createdTo: isTrash.value || rangeInvalid.value || !createdTo.value ? undefined : `${createdTo.value}T23:59:59.999`,
  sort: isTrash.value ? ('deletedAt:desc' as SortKey) : sort.value,
  limit: limit.value,
}));
const filtersKey = computed(() => JSON.stringify(filters.value));

const total = ref<number | null>(null);
const totalCapped = ref(false);
const selected = ref(new Set<string>());

watch(filtersKey, () => {
  cursors.value = [undefined];
  pageIndex.value = 0;
  total.value = null;
  router.replace({
    query: {
      q: search.value || undefined,
      company: company.value || undefined,
      tag: tag.value || undefined,
      attention: attention.value || undefined,
      from: createdFrom.value || undefined,
      to: createdTo.value || undefined,
      sort: sort.value !== 'createdAt:desc' ? sort.value : undefined,
      limit: limit.value !== 25 ? String(limit.value) : undefined,
    },
  });
});

const params = computed<ListParams>(() => ({ ...filters.value, cursor: cursor.value }));
const list = useQuery({
  queryKey: computed(() => ['contacts', filtersKey.value, cursor.value ?? null]),
  queryFn: () => api.listContacts(params.value),
  placeholderData: keepPreviousData, // keep old rows visible while the next page loads (no flicker)
});
watch(
  () => list.data.value,
  (d) => {
    if (d && d.total !== null) {
      total.value = d.total;
      totalCapped.value = d.totalCapped;
    }
  },
);

const rows = computed(() => list.data.value?.data ?? []);
const nextCursor = computed(() => list.data.value?.nextCursor ?? null);
const firstLoad = computed(() => list.isPending.value);
const updating = computed(() => list.isFetching.value && !list.isPending.value);
const listError = computed(() => (list.error.value instanceof Error ? list.error.value.message : null));
const hasFilters = computed(
  () => !!(filters.value.q || filters.value.attention || filters.value.tag || filters.value.company || filters.value.createdFrom || filters.value.createdTo),
);
const totalLabel = computed(() =>
  total.value === null ? '' : `${totalCapped.value ? `${total.value.toLocaleString()}+` : total.value.toLocaleString()} ${isTrash.value ? 'in trash' : 'total'}`,
);

function next() {
  if (!nextCursor.value) return;
  cursors.value = [...cursors.value.slice(0, pageIndex.value + 1), nextCursor.value];
  pageIndex.value++;
}
const prev = () => pageIndex.value > 0 && pageIndex.value--;

function clearFilters() {
  search.value = company.value = tag.value = createdFrom.value = createdTo.value = attention.value = '';
}

// ---- tags for the filter dropdown + bulk datalist
const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.listTags, staleTime: 60_000 });
const allTags = computed(() => tagsQuery.data.value ?? []);

// ---- selection (persists across pages until cleared)
const pageAllSelected = computed(() => rows.value.length > 0 && rows.value.every((r) => selected.value.has(r.id)));
function toggle(id: string) {
  const s = new Set(selected.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selected.value = s;
}
function togglePage() {
  const s = new Set(selected.value);
  if (pageAllSelected.value) rows.value.forEach((r) => s.delete(r.id));
  else rows.value.forEach((r) => s.add(r.id));
  selected.value = s;
}

const refreshAll = () => {
  qc.invalidateQueries({ queryKey: ['contacts'] }); // also refreshes the sidebar's trash count
  qc.invalidateQueries({ queryKey: ['tags'] });
};
const errorText = (e: unknown) =>
  e instanceof ApiError ? (e.details[0]?.message ?? e.message) : e instanceof Error ? e.message : 'Something went wrong';
const fullName = (c: Pick<Contact, 'firstName' | 'lastName'>) => `${c.firstName} ${c.lastName}`;

// ---- export (respects the current search and filters)
const exporting = ref(false);
async function exportCsv() {
  exporting.value = true;
  try {
    const { cursor: _c, limit: _l, ...rest } = params.value;
    await api.exportContacts(rest);
  } catch (e) {
    toast({ kind: 'error', message: `Couldn't export. ${errorText(e)}` });
  } finally {
    exporting.value = false;
  }
}

// ---- create
const showCreate = ref(false);
function onCreated(c: Contact) {
  showCreate.value = false;
  refreshAll();
  toast({ kind: 'success', message: `Added ${fullName(c)}` });
  router.push({ name: 'contact', params: { id: c.id } });
}

// ---- bulk assign tag
const bulkTag = ref('');
const bulkNotice = ref<string | null>(null);
const bulkMutation = useMutation({
  mutationFn: () => api.bulkAddTag([...selected.value], bulkTag.value.trim()),
  onSuccess: (r: BulkTagResult) => {
    bulkNotice.value =
      `Tag “${r.tag.name}” added to ${r.added} contact${r.added === 1 ? '' : 's'}` +
      (r.alreadyTagged ? ` (${r.alreadyTagged} already had it)` : '') +
      (r.notFound.length ? `. ${r.notFound.length} could not be found.` : '.');
    selected.value = new Set();
    bulkTag.value = '';
    refreshAll();
  },
  onError: () => (bulkNotice.value = null),
});
const bulkError = computed(() => (bulkMutation.error.value ? errorText(bulkMutation.error.value) : null));
function submitBulk() {
  bulkNotice.value = null;
  if (!bulkTag.value.trim() || !selected.value.size) return;
  bulkMutation.mutate();
}

// ---- restore (trash rows and the Undo toast)
const restoreProblem = ref<{ who: string; message: string; existingId?: string } | null>(null);
const restoreMutation = useMutation({
  // the contact comes from a freshly rendered trash row (or from the delete response for Undo), so its version is current
  mutationFn: (c: Contact) => api.restoreContact(c.id, c.version),
  onSuccess: (c) => {
    restoreProblem.value = null;
    refreshAll();
    toast({
      kind: 'success',
      message: `Restored ${fullName(c)}`,
      action: { label: 'Open', run: () => router.push({ name: 'contact', params: { id: c.id } }) },
    });
  },
  onError: (err, c) => {
    refreshAll();
    if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') {
      restoreProblem.value = { who: fullName(c), message: err.details[0]?.message ?? err.message, existingId: err.existing?.id };
      return;
    }
    toast({ kind: 'error', message: `Couldn't restore ${fullName(c)}. ${errorText(err)}` });
  },
});

// ---- move to trash (single + bulk)
const trashTarget = ref<Contact | null>(null);
const confirmBulkTrash = ref(false);

const trashMutation = useMutation({
  mutationFn: (c: Contact) => api.deleteContact(c.id, rows.value.find((r) => r.id === c.id)?.version ?? c.version),
  onSuccess: (c) => {
    trashTarget.value = null;
    const s = new Set(selected.value);
    s.delete(c.id);
    selected.value = s;
    refreshAll();
    toast({ kind: 'success', message: `Moved ${fullName(c)} to trash`, action: { label: 'Undo', run: () => restoreMutation.mutate(c) } });
  },
  onError: () => refreshAll(), // refresh so the row carries the latest version before a retry
});
const trashError = computed(() => {
  const e = trashMutation.error.value;
  if (!e) return null;
  return e instanceof ApiError && e.isConflict
    ? 'Someone changed this contact since you loaded the list. The latest version is loaded, so you can try again.'
    : errorText(e);
});

const bulkTrashMutation = useMutation({
  mutationFn: () => api.bulkDelete([...selected.value]),
  onSuccess: (r) => {
    confirmBulkTrash.value = false;
    selected.value = new Set();
    refreshAll();
    toast({
      kind: 'success',
      message: `Moved ${r.deleted} contact${r.deleted === 1 ? '' : 's'} to trash` + (r.notFound.length ? `. ${r.notFound.length} could not be found.` : ''),
    });
  },
});

function onRowAction(c: Contact, key: string) {
  if (key === 'open') router.push({ name: 'contact', params: { id: c.id } });
  if (key === 'trash') {
    trashMutation.reset();
    trashTarget.value = c;
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <h1>{{ isTrash ? 'Trash' : 'Contacts' }}</h1>
      <span v-if="totalLabel" class="muted">{{ totalLabel }}</span>
      <span class="spacer" />
      <template v-if="!isTrash">
        <button type="button" class="btn" :disabled="exporting" @click="exportCsv">{{ exporting ? 'Exporting…' : 'Export CSV' }}</button>
        <RouterLink :to="{ name: 'import-new' }" class="btn">Import CSV</RouterLink>
        <button type="button" class="btn primary" @click="showCreate = true">+ Add contact</button>
      </template>
    </header>

    <div class="page-body">
      <p v-if="isTrash" class="note">Trashed contacts are hidden from lists and search. Restore one to bring back its tags and history.</p>

      <form class="filters" role="search" @submit.prevent>
        <label class="grow">
          Search
          <input v-model="search" type="search" placeholder="Name, email or phone" maxlength="100" />
          <small v-if="searchTooShort" class="warn">Type at least 2 characters to search</small>
        </label>
        <template v-if="!isTrash">
          <label>
            Tag
            <select v-model="tag">
              <option value="">All tags</option>
              <option v-for="t in allTags" :key="t.id" :value="t.name">{{ t.name }}</option>
            </select>
          </label>
          <label>
            Company
            <input v-model="company" type="search" placeholder="Contains…" maxlength="150" />
          </label>
          <label>Created from <input v-model="createdFrom" type="date" /></label>
          <label>Created to <input v-model="createdTo" type="date" /></label>
          <label>
            Sort
            <select v-model="sort">
              <option value="createdAt:desc">Newest first</option>
              <option value="createdAt:asc">Oldest first</option>
              <option value="name:asc">Name A → Z</option>
              <option value="name:desc">Name Z → A</option>
            </select>
          </label>
        </template>
        <span v-if="attention && !isTrash" class="chip filter-chip">
          Needs attention: {{ ATTENTION_LABELS[attention] }}
          <button type="button" class="chip-x" aria-label="Remove needs attention filter" @click="attention = ''">×</button>
        </span>
        <button v-if="hasFilters" type="button" class="link" @click="clearFilters">Clear filters</button>
      </form>
      <p v-if="rangeInvalid" class="error" role="alert">“Created from” must be on or before “Created to”. The date filter is ignored until fixed.</p>

      <div v-if="!isTrash && selected.size" class="bulkbar" role="region" aria-label="Bulk actions">
        <strong>{{ selected.size }} selected</strong>
        <form class="row" @submit.prevent="submitBulk">
          <input v-model="bulkTag" list="bulk-tags" placeholder="Tag to assign…" maxlength="60" aria-label="Tag to assign to selected contacts" />
          <datalist id="bulk-tags"><option v-for="t in allTags" :key="t.id" :value="t.name" /></datalist>
          <button type="submit" class="btn primary" :disabled="bulkMutation.isPending.value || !bulkTag.trim()">
            {{ bulkMutation.isPending.value ? 'Assigning…' : 'Add tag' }}
          </button>
        </form>
        <button type="button" class="btn danger-outline" @click="bulkTrashMutation.reset(); confirmBulkTrash = true">Move to trash</button>
        <button type="button" class="link" @click="selected = new Set()">Clear selection</button>
        <span v-if="bulkError" class="error" role="alert">{{ bulkError }}</span>
      </div>
      <p v-if="bulkNotice" class="success" role="status">{{ bulkNotice }}</p>

      <div v-if="restoreProblem" class="banner danger" role="alert">
        <span>
          Can't restore {{ restoreProblem.who }}. {{ restoreProblem.message }}.
          <RouterLink v-if="restoreProblem.existingId" :to="{ name: 'contact', params: { id: restoreProblem.existingId } }">Open that contact</RouterLink>
          to change its email, then try again.
        </span>
        <button type="button" class="icon-btn" aria-label="Dismiss" @click="restoreProblem = null">×</button>
      </div>

      <!-- states -->
      <p v-if="firstLoad" class="state" role="status">Loading {{ isTrash ? 'trash' : 'contacts' }}…</p>
      <div v-else-if="list.isError.value && !rows.length" class="state error" role="alert">
        <p>Could not load {{ isTrash ? 'the trash' : 'contacts' }}: {{ listError }}</p>
        <button type="button" class="btn" @click="list.refetch()">Retry</button>
      </div>
      <div v-else-if="!rows.length" class="state">
        <template v-if="hasFilters">
          <p>No contacts match your search or filters.</p>
          <button type="button" class="btn" @click="clearFilters">Clear filters</button>
        </template>
        <template v-else-if="isTrash">
          <p>Trash is empty.</p>
        </template>
        <template v-else>
          <p>No contacts yet.</p>
          <button type="button" class="btn primary" @click="showCreate = true">Add contact</button>
        </template>
      </div>

      <template v-else>
        <p v-if="list.isError.value" class="error" role="alert">
          Could not refresh: {{ listError }} <button type="button" class="link" @click="list.refetch()">Retry</button>
        </p>
        <div class="meta" aria-live="polite">
          <span>Page {{ pageIndex + 1 }}</span>
          <span v-if="updating" class="muted">Updating…</span>
        </div>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th v-if="!isTrash" class="narrow-col"><input type="checkbox" :checked="pageAllSelected" aria-label="Select all contacts on this page" @change="togglePage" /></th>
                <th>Name</th>
                <th>Company</th>
                <th v-if="!isTrash">Tags</th>
                <th>{{ isTrash ? 'Deleted' : 'Created' }}</th>
                <th class="narrow-col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody :class="{ stale: updating }">
              <tr v-for="c in rows" :key="c.id" :class="{ selected: selected.has(c.id) }">
                <td v-if="!isTrash"><input type="checkbox" :checked="selected.has(c.id)" :aria-label="`Select ${fullName(c)}`" @change="toggle(c.id)" /></td>
                <td>
                  <div class="person">
                    <span class="avatar" aria-hidden="true">{{ initials(c.firstName, c.lastName) }}</span>
                    <div>
                      <RouterLink :to="{ name: 'contact', params: { id: c.id } }">{{ fullName(c) }}</RouterLink>
                      <div class="sub">{{ c.email ?? c.phone ?? '—' }}</div>
                    </div>
                  </div>
                </td>
                <td>{{ c.company ?? '—' }}</td>
                <td v-if="!isTrash"><span v-for="t in c.tags" :key="t.id" class="chip small">{{ t.name }}</span></td>
                <td class="nowrap" :title="isTrash ? (c.deletedAt ?? '') : ''">{{ isTrash ? (c.deletedAt ? fmtRelative(c.deletedAt) : '—') : fmtDate(c.createdAt) }}</td>
                <td class="actions-col">
                  <button v-if="isTrash" type="button" class="btn small" :disabled="restoreMutation.isPending.value" @click="restoreMutation.mutate(c)">Restore</button>
                  <RowMenu
                    v-else
                    :label="`Actions for ${fullName(c)}`"
                    :items="[{ key: 'open', label: 'Open' }, { key: 'trash', label: 'Move to trash', danger: true }]"
                    @select="(k) => onRowAction(c, k)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <nav class="pager" aria-label="Pagination">
          <button type="button" class="btn" :disabled="pageIndex === 0" @click="prev">← Previous</button>
          <label class="inline">
            Per page
            <select v-model.number="limit"><option :value="10">10</option><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option></select>
          </label>
          <button type="button" class="btn" :disabled="!nextCursor" @click="next">Next →</button>
        </nav>
      </template>
    </div>

    <ContactFormModal v-if="showCreate" @close="showCreate = false" @created="onCreated" />
    <ConfirmDialog
      v-if="trashTarget"
      :title="`Move ${fullName(trashTarget)} to trash`"
      message="They'll disappear from lists and search. You can restore them from Trash."
      confirm-label="Move to trash" danger :busy="trashMutation.isPending.value" :error="trashError"
      @confirm="trashMutation.mutate(trashTarget)" @cancel="trashTarget = null"
    />
    <ConfirmDialog
      v-if="confirmBulkTrash"
      :title="`Move ${selected.size} contact${selected.size === 1 ? '' : 's'} to trash`"
      message="They'll disappear from lists and search. You can restore them from Trash, one at a time."
      confirm-label="Move to trash" danger :busy="bulkTrashMutation.isPending.value"
      :error="bulkTrashMutation.error.value ? errorText(bulkTrashMutation.error.value) : null"
      @confirm="bulkTrashMutation.mutate()" @cancel="confirmBulkTrash = false"
    />
  </section>
</template>
