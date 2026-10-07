<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { api } from './api';
import ToastHost from './components/ToastHost.vue';

const route = useRoute();

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
      <div class="workspace"><span class="logo" aria-hidden="true">C</span><span>Contact CRM</span></div>
      <nav aria-label="Main">
        <RouterLink :to="{ name: 'contacts' }" class="nav-item" :class="{ active: section === 'contacts' }">Contacts</RouterLink>
        <RouterLink :to="{ name: 'imports' }" class="nav-item" :class="{ active: section === 'imports' }">Imports</RouterLink>
        <RouterLink :to="{ name: 'metrics' }" class="nav-item" :class="{ active: section === 'metrics' }">Metrics</RouterLink>
        <RouterLink :to="{ name: 'trash' }" class="nav-item" :class="{ active: section === 'trash' }">
          Trash
          <span v-if="trashCount.data.value" class="count" :aria-label="`${trashCount.data.value} in trash`">{{ trashCount.data.value }}</span>
        </RouterLink>
      </nav>
    </aside>
    <main class="content">
      <RouterView :key="String(route.name)" />
    </main>
    <ToastHost />
  </div>
</template>
