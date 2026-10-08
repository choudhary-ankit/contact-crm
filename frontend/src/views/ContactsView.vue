<script setup lang="ts">
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ArrowUpDown, ChevronLeft, ChevronRight, CircleAlert, Download, Eye, Tag as TagIcon, Trash2, TriangleAlert, Upload, UserPlus, Users, X,
  Plus, Search, SearchX, RotateCcw,
} from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ContactFormModal from '../components/ContactFormModal.vue';
import EmptyState from '../components/EmptyState.vue';
import FiltersPopover from '../components/FiltersPopover.vue';
import RowMenu from '../components/RowMenu.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import { useDebounced } from '../composables/useDebounced';
import { useToasts } from '../composables/useToasts';
import { ATTENTION_LABELS, fmtDate, fmtNumber, fmtRelative, fmtSmartDate, initials, pal } from '../format';
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
/** Set by the "View" links on the Metrics page and by the view chips. */
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
// The list's own count is capped at 10,000 (cheap to compute). With no filters we already know the exact figure from the
// metrics numbers used by the "All" chip, so show that and keep the header and the chip consistent.
const exactActive = computed(() => {
  const n = metrics.data.value?.contacts?.active;
  return !isTrash.value && !hasFilters.value && typeof n === 'number' ? n : null;
});
const totalText = computed(() => {
  if (exactActive.value !== null && total.value !== null) return fmtNumber(exactActive.value);
  return total.value === null ? '' : `${fmtNumber(total.value)}${totalCapped.value ? '+' : ''}`;
});
const totalLabel = computed(() => (total.value === null ? '' : `${totalText.value} ${isTrash.value ? 'in trash' : 'total'}`));
const rangeText = computed(() => {
  if (!rows.value.length) return '';
  const start = pageIndex.value * limit.value + 1;
  const end = start + rows.value.length - 1;
  return total.value === null ? `${start}–${end}` : `${start}–${end} of ${totalText.value}`;
});

function next() {
  if (!nextCursor.value) return;
  cursors.value = [...cursors.value.slice(0, pageIndex.value + 1), nextCursor.value];
  pageIndex.value++;
}
const prev = () => pageIndex.value > 0 && pageIndex.value--;

function clearFilters() {
  search.value = company.value = tag.value = createdFrom.value = createdTo.value = attention.value = '';
}

// ---- tags (filter dropdown + bulk input)
const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.listTags, staleTime: 60_000 });
const allTags = computed(() => tagsQuery.data.value ?? []);

// ---- saved views: one-click shortcuts with live counts (from the metrics endpoint; hidden if it fails)
const metrics = useQuery({ queryKey: ['metrics', 30], queryFn: () => api.metrics(30), staleTime: 60_000, enabled: computed(() => !isTrash.value), retry: false });
const views = computed(() => {
  // chip counts are a nicety: ignore the response entirely unless it has the shape we expect, so it can never break the list
  const raw = metrics.data.value;
  const m = raw && raw.contacts && raw.quality ? raw : undefined;
  const list: Array<{ key: string; label: string; count?: number; on: boolean; apply: () => void }> = [
    { key: 'all', label: 'All', count: m?.contacts.active, on: !tag.value && !attention.value, apply: () => ((tag.value = ''), (attention.value = '')) },
  ];
  for (const t of (Array.isArray(m?.tags) ? m!.tags : []).slice(0, 3)) {
    list.push({
      key: `tag:${t.name}`, label: t.name, count: t.count,
      on: tag.value.toLowerCase() === t.name.toLowerCase() && !attention.value,
      apply: () => ((attention.value = ''), (tag.value = t.name)),
    });
  }
  if (m) {
    list.push(
      { key: 'untagged', label: 'Untagged', count: m.quality.untagged, on: attention.value === 'untagged' && !tag.value, apply: () => ((tag.value = ''), (attention.value = 'untagged')) },
      { key: 'no_contact_info', label: 'No contact info', count: m.quality.noContactInfo, on: attention.value === 'no_contact_info' && !tag.value, apply: () => ((tag.value = ''), (attention.value = 'no_contact_info')) },
    );
  }
  return list;
});
/** Filters not already represented by the selected view chip get their own removable chip. */
const activeChips = computed(() => {
  const chips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (isTrash.value) return chips; // the Trash only filters by search, so leftover URL filters must not show as active
  const viewKeys = new Set(views.value.filter((v) => v.on).map((v) => v.key));
  const tagShown = tag.value && [...viewKeys].some((k) => k.startsWith('tag:'));
  const attentionShown = attention.value && viewKeys.has(attention.value);
  if (tag.value && !tagShown) chips.push({ key: 'tag', label: `Tag: ${tag.value}`, clear: () => (tag.value = '') });
  if (company.value.trim()) chips.push({ key: 'company', label: `Company: ${company.value.trim()}`, clear: () => (company.value = '') });
  if (createdFrom.value) chips.push({ key: 'from', label: `From ${fmtDate(createdFrom.value)}`, clear: () => (createdFrom.value = '') });
  if (createdTo.value) chips.push({ key: 'to', label: `Until ${fmtDate(createdTo.value)}`, clear: () => (createdTo.value = '') });
  if (attention.value && !attentionShown) chips.push({ key: 'attention', label: `Needs attention: ${ATTENTION_LABELS[attention.value]}`, clear: () => (attention.value = '') });
  return chips;
});

// ---- selection (persists across pages until cleared)
const pageAllSelected = computed(() => rows.value.length > 0 && rows.value.every((r) => selected.value.has(r.id)));
const pageSomeSelected = computed(() => !pageAllSelected.value && rows.value.some((r) => selected.value.has(r.id)));
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
  qc.invalidateQueries({ queryKey: ['metrics'] });
};
const errorText = (e: unknown) =>
  e instanceof ApiError ? (e.details[0]?.message ?? e.message) : e instanceof Error ? e.message : 'Something went wrong';
const fullName = (c: Pick<Contact, 'firstName' | 'lastName'>) => `${c.firstName} ${c.lastName}`;
const VISIBLE_TAGS = 2;

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

// ---- create (also opened by the command palette via ?new=1)
const showCreate = ref(false);
// Watch the address instead of checking once on load: when this page is already open, going to ?new=1 does not rebuild it.
watch(
  () => route.query.new,
  (flag) => {
    if (!flag || isTrash.value) return;
    showCreate.value = true;
    const { new: _n, ...rest } = route.query;
    router.replace({ query: rest }); // keep the filters, drop the one-shot flag
  },
  { immediate: true },
);
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
      <span v-if="totalLabel" class="muted small-text">{{ totalLabel }}</span>
      <span class="spacer" />
      <template v-if="!isTrash">
        <button type="button" class="btn" :disabled="exporting" @click="exportCsv"><Download aria-hidden="true" />{{ exporting ? 'Exporting…' : 'Export' }}</button>
        <RouterLink :to="{ name: 'import-new' }" class="btn"><Upload aria-hidden="true" />Import</RouterLink>
        <button type="button" class="btn primary" @click="showCreate = true"><Plus aria-hidden="true" />Add contact</button>
      </template>
    </header>

    <div class="page-body">
      <p v-if="isTrash" class="note"><TriangleAlert aria-hidden="true" /><span>Trashed contacts are hidden from lists and search. Restore one to bring back its tags and history.</span></p>

      <div v-if="!isTrash && views.length > 1" class="views" role="group" aria-label="Saved views">
        <button v-for="v in views" :key="v.key" type="button" class="view-chip" :class="{ on: v.on }" :aria-pressed="v.on" @click="v.apply()">
          {{ v.label }}<small v-if="v.count !== undefined">{{ fmtNumber(v.count) }}</small>
        </button>
      </div>

      <form class="toolbar" role="search" @submit.prevent>
        <label class="searchbox">
          <span class="sr-only">Search</span>
          <Search aria-hidden="true" />
          <input v-model="search" type="search" placeholder="Search name, email or phone" maxlength="100" />
        </label>
        <small v-if="searchTooShort" class="warn">Type at least 2 characters to search</small>
        <span class="spacer" />
        <template v-if="!isTrash">
          <FiltersPopover
            v-model:tag="tag" v-model:company="company" v-model:created-from="createdFrom" v-model:created-to="createdTo"
            v-model:attention="attention" :tags="allTags" :range-invalid="rangeInvalid" @clear="clearFilters"
          />
          <label class="inline">
            <ArrowUpDown :size="15" aria-hidden="true" style="color: var(--subtle)" />
            <span class="sr-only">Sort</span>
            <select v-model="sort" aria-label="Sort">
              <option value="createdAt:desc">Newest first</option>
              <option value="createdAt:asc">Oldest first</option>
              <option value="name:asc">Name A → Z</option>
              <option value="name:desc">Name Z → A</option>
            </select>
          </label>
        </template>
      </form>

      <div v-if="activeChips.length || (hasFilters && isTrash)" class="row" style="margin-bottom: 12px">
        <span v-for="c in activeChips" :key="c.key" class="chip filter-chip">
          {{ c.label }}
          <button type="button" class="chip-x" :aria-label="c.key === 'attention' ? 'Remove needs attention filter' : `Remove filter ${c.label}`" @click="c.clear()"><X :size="12" aria-hidden="true" /></button>
        </span>
        <button v-if="hasFilters" type="button" class="link" @click="clearFilters">Clear filters</button>
      </div>
      <p v-else-if="rangeInvalid" class="error small-text" role="alert">“Created from” must be on or before “Created to”. The date filter is ignored until fixed.</p>

      <div v-if="!isTrash && selected.size" class="bulkbar" role="region" aria-label="Bulk actions">
        <strong>{{ selected.size }} selected</strong>
        <form class="row" @submit.prevent="submitBulk">
          <input v-model="bulkTag" list="bulk-tags" placeholder="Tag to assign…" maxlength="60" aria-label="Tag to assign to selected contacts" />
          <datalist id="bulk-tags"><option v-for="t in allTags" :key="t.id" :value="t.name" /></datalist>
          <button type="submit" class="btn primary" :disabled="bulkMutation.isPending.value || !bulkTag.trim()">
            <TagIcon aria-hidden="true" />{{ bulkMutation.isPending.value ? 'Assigning…' : 'Add tag' }}
          </button>
        </form>
        <button type="button" class="btn danger-outline" @click="bulkTrashMutation.reset(); confirmBulkTrash = true"><Trash2 aria-hidden="true" />Move to trash</button>
        <span class="spacer" />
        <button type="button" class="link" @click="selected = new Set()">Clear selection</button>
        <span v-if="bulkError" class="error" role="alert">{{ bulkError }}</span>
      </div>
      <p v-if="bulkNotice" class="success" role="status">{{ bulkNotice }}</p>

      <div v-if="restoreProblem" class="banner danger" role="alert">
        <CircleAlert aria-hidden="true" />
        <span>
          Can't restore {{ restoreProblem.who }}. {{ restoreProblem.message }}.
          <RouterLink v-if="restoreProblem.existingId" :to="{ name: 'contact', params: { id: restoreProblem.existingId } }">Open that contact</RouterLink>
          to change its email, then try again.
        </span>
        <button type="button" class="icon-btn" aria-label="Dismiss" @click="restoreProblem = null"><X aria-hidden="true" /></button>
      </div>

      <!-- states -->
      <SkeletonRows v-if="firstLoad" :label="`Loading ${isTrash ? 'trash' : 'contacts'}…`" :checkbox="!isTrash" />
      <div v-else-if="list.isError.value && !rows.length" class="state error" role="alert">
        <p>Could not load {{ isTrash ? 'the trash' : 'contacts' }}: {{ listError }}</p>
        <button type="button" class="btn" @click="list.refetch()">Retry</button>
      </div>
      <template v-else-if="!rows.length">
        <EmptyState v-if="hasFilters" :icon="SearchX" title="No contacts match your search or filters." text="Try a different search, or remove a filter.">
          <button type="button" class="btn" @click="clearFilters">Clear filters</button>
        </EmptyState>
        <EmptyState v-else-if="isTrash" :icon="Trash2" title="Trash is empty." text="Contacts you move to the trash show up here, and can be restored." />
        <EmptyState v-else :icon="Users" title="No contacts yet." text="Add your first contact, or import a CSV to bring in many at once.">
          <button type="button" class="btn primary" @click="showCreate = true"><UserPlus aria-hidden="true" />Add contact</button>
          <RouterLink :to="{ name: 'import-new' }" class="btn"><Upload aria-hidden="true" />Import CSV</RouterLink>
        </EmptyState>
      </template>

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
                <th v-if="!isTrash" class="narrow-col">
                  <input type="checkbox" :checked="pageAllSelected" :indeterminate="pageSomeSelected" aria-label="Select all contacts on this page" @change="togglePage" />
                </th>
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
                    <span class="avatar" :class="pal(fullName(c))" aria-hidden="true">{{ initials(c.firstName, c.lastName) }}</span>
                    <div style="min-width: 0">
                      <RouterLink :to="{ name: 'contact', params: { id: c.id } }">{{ fullName(c) }}</RouterLink>
                      <div class="sub">{{ c.email ?? c.phone ?? '—' }}</div>
                    </div>
                  </div>
                </td>
                <td class="nowrap">{{ c.company ?? '—' }}</td>
                <td v-if="!isTrash" class="nowrap">
                  <span v-for="t in c.tags.slice(0, VISIBLE_TAGS)" :key="t.id" class="tag" :class="pal(t.name)">{{ t.name }}</span>
                  <span v-if="c.tags.length > VISIBLE_TAGS" class="tag more" :title="c.tags.slice(VISIBLE_TAGS).map((t) => t.name).join(', ')">+{{ c.tags.length - VISIBLE_TAGS }}</span>
                  <span v-if="!c.tags.length" class="muted">—</span>
                </td>
                <td class="nowrap muted" :title="isTrash ? (c.deletedAt ?? '') : c.createdAt">{{ isTrash ? (c.deletedAt ? fmtRelative(c.deletedAt) : '—') : fmtSmartDate(c.createdAt) }}</td>
                <td class="actions-col">
                  <button v-if="isTrash" type="button" class="btn small" :disabled="restoreMutation.isPending.value" @click="restoreMutation.mutate(c)"><RotateCcw aria-hidden="true" />Restore</button>
                  <RowMenu
                    v-else
                    :label="`Actions for ${fullName(c)}`"
                    :items="[{ key: 'open', label: 'Open', icon: Eye }, { key: 'trash', label: 'Move to trash', danger: true, icon: Trash2 }]"
                    @select="(k) => onRowAction(c, k)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <nav class="pager" aria-label="Pagination">
          <span class="pager-info">{{ rangeText }}</span>
          <span class="row">
            <label class="inline">
              <span class="sr-only">Per page</span>
              <select v-model.number="limit" aria-label="Per page"><option :value="10">10 / page</option><option :value="25">25 / page</option><option :value="50">50 / page</option><option :value="100">100 / page</option></select>
            </label>
            <button type="button" class="btn" :disabled="pageIndex === 0" @click="prev"><ChevronLeft aria-hidden="true" />Previous</button>
            <button type="button" class="btn" :disabled="!nextCursor" @click="next">Next<ChevronRight aria-hidden="true" /></button>
          </span>
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
