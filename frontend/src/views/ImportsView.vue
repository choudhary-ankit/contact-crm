<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';
import { api } from '../api';
import { fmtDateTime, fmtNumber, pct } from '../format';
import type { ImportJob } from '../types';

const list = useQuery({
  queryKey: ['imports'],
  queryFn: api.listImports,
  // keep the progress bars live while anything is running
  refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'validating' || j.status === 'importing') ? 1500 : false),
});
const jobs = computed(() => list.data.value ?? []);

const label = (j: ImportJob) => (j.status === 'ready' ? 'Ready to review' : j.status);
const type = (j: ImportJob) => (j.mode === 'create' ? 'Add' : 'Update');
function result(j: ImportJob): string {
  if (j.status === 'failed') return j.failureReason ?? 'Failed';
  if (j.status === 'ready') return `${fmtNumber(j.validRows ?? 0)} valid, ${fmtNumber(j.errorRows)} with problems`;
  if (j.status === 'validating') return 'Checking…';
  if (j.status === 'cancelled') return 'Nothing changed';
  const done = j.mode === 'create' ? `${fmtNumber(j.createdCount)} added` : `${fmtNumber(j.updatedCount)} updated, ${fmtNumber(j.unchangedCount)} unchanged`;
  return j.errorRows ? `${done}, ${fmtNumber(j.errorRows)} skipped` : done;
}
const progress = (j: ImportJob) => (j.status === 'completed' ? 100 : j.totalRows ? pct(j.processedRows, j.totalRows) : 0);
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Imports</h1>
      <span class="spacer" />
      <RouterLink :to="{ name: 'import-new' }" class="btn primary">Import contacts</RouterLink>
    </header>

    <div class="page-body">
      <p class="note">Upload a CSV to add or update many contacts at once. Files are checked first, and nothing changes until you confirm.</p>

      <p v-if="list.isPending.value" class="state" role="status">Loading imports…</p>
      <div v-else-if="list.isError.value" class="state error" role="alert">
        <p>Could not load imports: {{ (list.error.value as Error).message }}</p>
        <button type="button" class="btn" @click="list.refetch()">Retry</button>
      </div>
      <div v-else-if="!jobs.length" class="state">
        <p>No imports yet.</p>
        <RouterLink :to="{ name: 'import-new' }" class="btn primary">Import contacts</RouterLink>
      </div>

      <div v-else class="table-wrap">
        <table class="grid">
          <thead><tr><th>File</th><th>Type</th><th>Status</th><th class="progress-col">Progress</th><th>Result</th><th>Uploaded</th></tr></thead>
          <tbody>
            <tr v-for="j in jobs" :key="j.id">
              <td><RouterLink :to="{ name: 'import', params: { id: j.id } }">{{ j.filename }}</RouterLink></td>
              <td>{{ type(j) }}</td>
              <td><span class="pill" :data-status="j.status">{{ label(j) }}</span></td>
              <td class="progress-col">
                <div v-if="['importing', 'completed'].includes(j.status)" class="progress" role="progressbar" :aria-valuenow="progress(j)" aria-valuemin="0" aria-valuemax="100" :aria-label="`${j.filename} ${progress(j)}%`"><i :style="{ width: `${progress(j)}%` }" /></div>
                <span v-else class="muted">—</span>
              </td>
              <td>{{ result(j) }}</td>
              <td class="nowrap">{{ fmtDateTime(j.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
