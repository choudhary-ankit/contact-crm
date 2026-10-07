<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { ChartColumn, FileUp, Search, Trash2, Users } from 'lucide-vue-next';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { api } from './api';
import CommandPalette from './components/CommandPalette.vue';
import ToastHost from './components/ToastHost.vue';
import { usePalette } from './composables/usePalette';
import { modKeyLabel } from './format';

const route = useRoute();
const { open: openPalette } = usePalette();

// Sidebar badge. Lives under the ['contacts'] key prefix, so every delete/restore refreshes it.
const trashCount = useQuery({
  queryKey: ['contacts', 'trash-count'],
  queryFn: () => api.listContacts({ status: 'deleted', sort: 'deletedAt:desc', limit: 1 }),
  select: (p) => p.total ?? 0,
  staleTime: 30_000,
});
const section = computed(() => {
  const n = String(route.name ?? '');
  if (n.startsWith('import')) return 'imports';
  return ['metrics', 'trash'].includes(n) ? n : 'contacts';
});
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="workspace"><span class="logo" aria-hidden="true"><Users :size="16" /></span><span>Contact CRM</span></div>
      <button type="button" class="nav-search" aria-label="Search contacts and pages" @click="openPalette">
        <Search :size="15" aria-hidden="true" /><span>Search…</span><kbd>{{ modKeyLabel() }}</kbd>
      </button>
      <nav aria-label="Main">
        <RouterLink :to="{ name: 'contacts' }" class="nav-item" :class="{ active: section === 'contacts' }"><Users :size="17" aria-hidden="true" />Contacts</RouterLink>
        <RouterLink :to="{ name: 'imports' }" class="nav-item" :class="{ active: section === 'imports' }"><FileUp :size="17" aria-hidden="true" />Imports</RouterLink>
        <RouterLink :to="{ name: 'metrics' }" class="nav-item" :class="{ active: section === 'metrics' }"><ChartColumn :size="17" aria-hidden="true" />Metrics</RouterLink>
        <div class="nav-label">Library</div>
        <RouterLink :to="{ name: 'trash' }" class="nav-item" :class="{ active: section === 'trash' }">
          <Trash2 :size="17" aria-hidden="true" />Trash
          <span v-if="trashCount.data.value" class="count" :aria-label="`${trashCount.data.value} in trash`">{{ trashCount.data.value }}</span>
        </RouterLink>
      </nav>
      <div class="user-card"><span class="avatar" aria-hidden="true">AC</span><div><strong>Ankit</strong><small>Admin</small></div></div>
    </aside>
    <main class="content">
      <RouterView :key="String(route.name)" />
    </main>
    <ToastHost />
    <CommandPalette />
  </div>
</template>
