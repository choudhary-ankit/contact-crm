<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import StepIndicator from '../components/StepIndicator.vue';
import { useToasts } from '../composables/useToasts';
import { fmtDateTime, fmtNumber, pct } from '../format';
import type { ImportJob } from '../types';

const props = defineProps<{ id: string }>();
const router = useRouter();
const qc = useQueryClient();
const { push: toast } = useToasts();

const ACTIVE = ['validating', 'importing'];
const job = useQuery({
  queryKey: computed(() => ['import', props.id]),
  queryFn: () => api.getImport(props.id),
  // poll while the worker is busy; stop once the job reaches a resting state
  refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.status) ? 1000 : false),
});
const j = computed(() => job.data.value);
const isUpdate = computed(() => j.value?.mode === 'update');
const verb = computed(() => (isUpdate.value ? 'Update' : 'Import'));

const stepIndex = computed(() => {
  const s = j.value?.status;
  if (s === 'validating' || s === 'ready') return 2;
  if (s === 'importing') return 3;
  return s === 'completed' ? 4 : 2;
});

// ---- rejected rows
const shown = ref(100);
const errors = useQuery({
  queryKey: computed(() => ['import-errors', props.id, shown.value, j.value?.status]),
  queryFn: () => api.importErrors(props.id, 0, shown.value),
  enabled: computed(() => !!j.value && j.value.errorRows > 0 && ['ready', 'completed'].includes(j.value.status)),
});
const errorRows = computed(() => errors.data.value?.data ?? []);
const errorTotal = computed(() => errors.data.value?.total ?? 0);

// ---- actions
const setJob = (next: ImportJob) => {
  qc.setQueryData(['import', props.id], next);
  qc.invalidateQueries({ queryKey: ['imports'] });
};
const actionError = ref<string | null>(null);
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

const confirm = useMutation({
  mutationFn: () => api.confirmImport(props.id),
  onSuccess: setJob,
  onError: (e) => {
    actionError.value = msg(e);
    job.refetch();
  },
});
const showCancel = ref(false);
const cancel = useMutation({
  mutationFn: () => api.cancelImport(props.id),
  onSuccess: (next) => {
    showCancel.value = false;
    setJob(next);
    toast({ kind: 'success', message: 'Import cancelled. Nothing was changed.' });
    router.push({ name: 'imports' });
  },
});

const downloadingErrors = ref(false);
async function downloadRejected() {
  downloadingErrors.value = true;
  try {
    await api.downloadImportErrors(props.id);
  } catch (e) {
    toast({ kind: 'error', message: `Couldn't download the rejected rows. ${msg(e)}` });
  } finally {
    downloadingErrors.value = false;
  }
}

const progress = computed(() => (j.value?.totalRows ? pct(j.value.processedRows, j.value.totalRows) : 0));
const loadError = computed(() => job.error.value as ApiError | null);
const fieldLabel = (f: string | null) => (f ? f.replace(/_/g, ' ') : '');
</script>

<template>
  <section>
    <header class="page-header">
      <RouterLink :to="{ name: 'imports' }" class="link">← Imports</RouterLink>
      <h1>{{ j ? j.filename : 'Import' }}</h1>
      <span v-if="j" class="pill" :data-status="j.status">{{ j.status === 'ready' ? 'Ready to ' + (isUpdate ? 'update' : 'import') : j.status }}</span>
    </header>

    <div class="page-body">
      <p v-if="job.isPending.value" class="state" role="status">Loading import…</p>
      <div v-else-if="loadError" class="state error" role="alert">
        <p>{{ loadError.status === 404 ? 'This import does not exist.' : `Could not load this import: ${loadError.message}` }}</p>
        <button v-if="loadError.status !== 404" type="button" class="btn" @click="job.refetch()">Retry</button>
      </div>

      <template v-else-if="j">
        <StepIndicator :steps="['Type', 'Upload', 'Review', 'Import']" :current="stepIndex" />
        <p class="muted">{{ isUpdate ? 'Update existing contacts' : 'Add new contacts' }} · uploaded {{ fmtDateTime(j.createdAt) }}</p>
        <p v-for="n in j.notes" :key="n" class="note">{{ n }}</p>

        <!-- 1. being checked by the worker -->
        <div v-if="j.status === 'validating'" class="card center" role="status">
          <div class="progress indeterminate" aria-hidden="true"><i /></div>
          <strong>Checking your file…</strong>
          <span class="muted">Every row is validated against your existing contacts. Nothing is saved yet.</span>
        </div>

        <!-- 2. unusable file -->
        <div v-else-if="j.status === 'failed'" class="banner danger" role="alert">
          <span><strong>This file couldn't be used.</strong> {{ j.failureReason }}</span>
          <RouterLink :to="{ name: 'import-new', query: isUpdate ? { mode: 'update' } : {} }" class="btn small">Upload another file</RouterLink>
        </div>

        <div v-else-if="j.status === 'cancelled'" class="card center">
          <strong>This import was cancelled.</strong>
          <span class="muted">Nothing was changed.</span>
          <RouterLink :to="{ name: 'import-new' }" class="btn small">Start a new import</RouterLink>
        </div>

        <!-- 3. review -->
        <template v-else-if="j.status === 'ready'">
          <div class="kpis">
            <div class="kpi"><span class="sub">Rows checked</span><b>{{ fmtNumber(j.totalRows ?? 0) }}</b></div>
            <div class="kpi ok"><span class="sub">Ready to {{ isUpdate ? 'update' : 'add' }}</span><b>{{ fmtNumber(j.validRows ?? 0) }}</b></div>
            <div class="kpi" :class="{ bad: j.errorRows > 0 }"><span class="sub">With problems (skipped)</span><b>{{ fmtNumber(j.errorRows) }}</b></div>
          </div>
          <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>
          <div class="row" style="margin: 12px 0">
            <button type="button" class="btn primary" :disabled="!j.validRows || confirm.isPending.value" @click="actionError = null; confirm.mutate()">
              {{ confirm.isPending.value ? 'Starting…' : `${verb} ${fmtNumber(j.validRows ?? 0)} contact${j.validRows === 1 ? '' : 's'}` }}
            </button>
            <button v-if="j.errorRows > 0" type="button" class="btn" :disabled="downloadingErrors" @click="downloadRejected">Download rejected rows</button>
            <button type="button" class="btn danger-outline" @click="showCancel = true">Cancel import</button>
          </div>
          <p v-if="!j.validRows" class="muted">None of the rows can be imported. Fix the problems below and upload the file again.</p>
        </template>

        <!-- 4. running -->
        <div v-else-if="j.status === 'importing'" class="card" role="status">
          <div class="row between"><strong>{{ isUpdate ? 'Updating' : 'Importing' }} contacts…</strong><span>{{ progress }}%</span></div>
          <div class="progress" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100" :aria-label="`${progress}% processed`"><i :style="{ width: `${progress}%` }" /></div>
          <span class="muted">{{ fmtNumber(j.processedRows) }} of {{ fmtNumber(j.totalRows ?? 0) }} rows processed. You can leave this page; the import keeps running.</span>
        </div>

        <!-- 5. done -->
        <template v-else-if="j.status === 'completed'">
          <div class="banner ok" role="status"><span><strong>Import finished.</strong> {{ fmtNumber(j.processedRows) }} rows processed{{ j.finishedAt ? ` · ${fmtDateTime(j.finishedAt)}` : '' }}.</span></div>
          <div class="kpis">
            <div v-if="!isUpdate" class="kpi ok"><span class="sub">Contacts added</span><b>{{ fmtNumber(j.createdCount) }}</b></div>
            <template v-else>
              <div class="kpi ok"><span class="sub">Contacts updated</span><b>{{ fmtNumber(j.updatedCount) }}</b></div>
              <div class="kpi"><span class="sub">Already up to date</span><b>{{ fmtNumber(j.unchangedCount) }}</b></div>
            </template>
            <div class="kpi" :class="{ bad: j.errorRows > 0 }"><span class="sub">Skipped (problems)</span><b>{{ fmtNumber(j.errorRows) }}</b></div>
          </div>
          <div class="row" style="margin: 12px 0">
            <RouterLink :to="{ name: 'contacts' }" class="btn primary">View contacts</RouterLink>
            <button v-if="j.errorRows > 0" type="button" class="btn" :disabled="downloadingErrors" @click="downloadRejected">Download rejected rows</button>
            <RouterLink :to="{ name: 'import-new' }" class="btn">Import another file</RouterLink>
          </div>
        </template>

        <!-- problems table -->
        <div v-if="j.errorRows > 0 && ['ready', 'completed'].includes(j.status)" class="card">
          <h2>Rows with problems</h2>
          <p class="muted">These rows were skipped. Download them, fix the highlighted problems, and upload the file again.</p>
          <p v-if="errors.isPending.value" class="muted" role="status">Loading…</p>
          <p v-else-if="errors.isError.value" class="error" role="alert">Could not load the problems. <button type="button" class="link" @click="errors.refetch()">Retry</button></p>
          <div v-else class="table-wrap">
            <table class="grid compact">
              <thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead>
              <tbody>
                <tr v-for="(e, i) in errorRows" :key="`${e.row}-${i}`">
                  <td>{{ e.row }}</td><td>{{ fieldLabel(e.field) }}</td>
                  <td>{{ e.message }}<span v-if="e.phase === 'import'" class="muted"> (found while importing)</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="errorTotal > errorRows.length" class="muted">
            Showing {{ fmtNumber(errorRows.length) }} of {{ fmtNumber(errorTotal) }} problems.
            <button v-if="shown < 500" type="button" class="link" @click="shown = Math.min(500, shown + 100)">Show more</button>
            <span v-else>Download the rejected rows to see all of them.</span>
          </p>
        </div>
      </template>

      <ConfirmDialog
        v-if="showCancel" title="Cancel this import" message="The uploaded file is discarded and nothing is added or changed."
        confirm-label="Cancel import" danger :busy="cancel.isPending.value" :error="cancel.error.value ? msg(cancel.error.value) : null"
        @confirm="cancel.mutate()" @cancel="showCancel = false"
      />
    </div>
  </section>
</template>
