<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { ChartColumn, CornerDownLeft, FileUp, Search, Trash2, UserPlus, Users, type LucideIcon } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { useDebounced } from '../composables/useDebounced';
import { usePalette } from '../composables/usePalette';
import { initials, pal } from '../format';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
  avatar?: { text: string; cls: string };
  run: () => void;
}

const FETCH = 15;
const SHOW = 6;

const router = useRouter();
const { isOpen, close, toggle } = usePalette();
const query = ref('');
const debounced = useDebounced(query, 200);
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
let returnFocus: HTMLElement | null = null;

const go = (to: Parameters<typeof router.push>[0]) => () => router.push(to);
const COMMANDS: Array<Item & { keywords: string }> = [
  { id: 'go-contacts', label: 'Contacts', hint: 'Go to', icon: Users, keywords: 'people list home', run: go({ name: 'contacts' }) },
  { id: 'add-contact', label: 'Add contact', hint: 'Action', icon: UserPlus, keywords: 'new create', run: go({ name: 'contacts', query: { new: '1' } }) },
  { id: 'import', label: 'Import contacts', hint: 'Action', icon: FileUp, keywords: 'csv upload', run: go({ name: 'import-new' }) },
  { id: 'go-imports', label: 'Imports', hint: 'Go to', icon: FileUp, keywords: 'history csv', run: go({ name: 'imports' }) },
  { id: 'go-metrics', label: 'Metrics', hint: 'Go to', icon: ChartColumn, keywords: 'dashboard analytics reports', run: go({ name: 'metrics' }) },
  { id: 'go-trash', label: 'Trash', hint: 'Go to', icon: Trash2, keywords: 'deleted restore', run: go({ name: 'trash' }) },
];

const term = computed(() => query.value.trim().toLowerCase());
const commands = computed<Item[]>(() =>
  COMMANDS.filter((c) => !term.value || `${c.label} ${c.keywords}`.toLowerCase().includes(term.value)).map(({ keywords: _k, ...c }) => c),
);

const search = useQuery({
  queryKey: computed(() => ['palette', debounced.value.trim()]),
  // fetch a few extra so names that START with the query can be ranked above names that merely contain it
  queryFn: () => api.listContacts({ status: 'active', q: debounced.value.trim(), sort: 'name:asc', limit: FETCH }),
  enabled: computed(() => isOpen.value && debounced.value.trim().length >= 2),
  staleTime: 15_000,
});

const contacts = computed<Item[]>(() =>
  debounced.value.trim().length < 2
    ? []
    : rankByPrefix(search.data.value?.data ?? [], debounced.value.trim())
        .slice(0, SHOW)
        .map((c) => ({
        id: `contact-${c.id}`,
        label: `${c.firstName} ${c.lastName}`,
        hint: c.email ?? c.company ?? c.phone ?? undefined,
        avatar: { text: initials(c.firstName, c.lastName), cls: pal(`${c.firstName} ${c.lastName}`) },
        run: go({ name: 'contact', params: { id: c.id } }),
      })),
);

/** 0 = the name starts with the query, 1 = a last name or email does, 2 = it only appears somewhere inside. Stable within a rank. */
function rankByPrefix<T extends { firstName: string; lastName: string; email: string | null }>(items: T[], q: string): T[] {
  const needle = q.toLowerCase();
  const rank = (c: T) => {
    const full = `${c.firstName} ${c.lastName}`.toLowerCase();
    if (full.startsWith(needle) || c.firstName.toLowerCase().startsWith(needle)) return 0;
    return c.lastName.toLowerCase().startsWith(needle) || (c.email ?? '').toLowerCase().startsWith(needle) ? 1 : 2;
  };
  return items.map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}

const groups = computed(() =>
  [
    { title: 'Contacts', items: contacts.value },
    { title: 'Go to and actions', items: commands.value },
  ].filter((g) => g.items.length),
);
const flat = computed(() => groups.value.flatMap((g) => g.items));
const searching = computed(() => debounced.value.trim().length >= 2 && search.isFetching.value && !contacts.value.length);
const indexOf = (item: Item) => flat.value.findIndex((i) => i.id === item.id);

watch([term, () => contacts.value.length], () => (active.value = 0));
watch(isOpen, async (open) => {
  if (open) {
    returnFocus = document.activeElement as HTMLElement | null;
    query.value = '';
    active.value = 0;
    await nextTick();
    input.value?.focus();
  } else {
    returnFocus?.focus?.();
  }
});

function choose(item: Item | undefined) {
  if (!item) return;
  close();
  item.run();
}

function onKey(e: KeyboardEvent) {
  const n = flat.value.length;
  if (e.key === 'ArrowDown') (e.preventDefault(), (active.value = n ? (active.value + 1) % n : 0));
  else if (e.key === 'ArrowUp') (e.preventDefault(), (active.value = n ? (active.value - 1 + n) % n : 0));
  else if (e.key === 'Home') (e.preventDefault(), (active.value = 0));
  else if (e.key === 'End') (e.preventDefault(), (active.value = Math.max(0, n - 1)));
  else if (e.key === 'Enter') (e.preventDefault(), choose(flat.value[active.value]));
  else if (e.key === 'Escape') (e.preventDefault(), close());
  nextTick(() => document.getElementById(`pal-opt-${active.value}`)?.scrollIntoView?.({ block: 'nearest' }));
}

// Cmd/Ctrl+K from anywhere
const onGlobalKey = (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') (e.preventDefault(), toggle());
};
onMounted(() => window.addEventListener('keydown', onGlobalKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey));
</script>

<template>
  <div v-if="isOpen" class="palette-overlay" @mousedown.self="close">
    <div class="palette" role="dialog" aria-modal="true" aria-label="Quick search" @keydown="onKey">
      <div class="palette-input">
        <Search aria-hidden="true" />
        <input
          ref="input" v-model="query" type="text" role="combobox" aria-label="Search contacts and pages" aria-expanded="true"
          aria-controls="palette-list" :aria-activedescendant="flat.length ? `pal-opt-${active}` : undefined" autocomplete="off"
          placeholder="Search contacts, or jump to a page…"
        />
        <kbd>esc</kbd>
      </div>
      <ul v-if="flat.length" id="palette-list" class="palette-list" role="listbox">
        <template v-for="g in groups" :key="g.title">
          <li class="palette-group" role="presentation">{{ g.title }}</li>
          <li
            v-for="item in g.items" :id="`pal-opt-${indexOf(item)}`" :key="item.id" class="palette-item" role="option"
            :aria-selected="indexOf(item) === active" @mousemove="active = indexOf(item)" @click="choose(item)"
          >
            <span v-if="item.avatar" class="avatar" :class="item.avatar.cls" style="width: 24px; height: 24px; font-size: 0.62rem">{{ item.avatar.text }}</span>
            <component :is="item.icon" v-else-if="item.icon" aria-hidden="true" />
            <span>{{ item.label }}</span>
            <span v-if="item.hint" class="hint">{{ item.hint }}</span>
          </li>
        </template>
      </ul>
      <p v-else-if="searching" class="palette-empty" role="status">Searching…</p>
      <p v-else class="palette-empty" role="status">No results for “{{ query.trim() }}”.</p>
      <div class="palette-foot">
        <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span>
        <span><CornerDownLeft style="width: 12px; height: 12px; vertical-align: -2px" aria-hidden="true" /> to open</span>
        <span><kbd>esc</kbd> to close</span>
      </div>
    </div>
  </div>
</template>
