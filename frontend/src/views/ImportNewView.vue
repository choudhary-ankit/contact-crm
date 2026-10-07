<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import FormatGuide from '../components/FormatGuide.vue';
import StepIndicator from '../components/StepIndicator.vue';
import { useToasts } from '../composables/useToasts';
import type { ImportMode } from '../types';

const MAX_BYTES = 5 * 1024 * 1024;

const route = useRoute();
const router = useRouter();
const { push: toast } = useToasts();

const mode = ref<ImportMode>(route.query.mode === 'update' ? 'update' : 'create');
const formats = useQuery({ queryKey: ['import-formats'], queryFn: api.importFormats, staleTime: Infinity });
const format = computed(() => formats.data.value?.find((f) => f.mode === mode.value));

const MODES: Array<{ mode: ImportMode; title: string; text: string }> = [
  { mode: 'create', title: 'Add new contacts', text: 'Creates one contact per row. Emails that already exist are reported, never overwritten.' },
  { mode: 'update', title: 'Update existing contacts', text: 'Finds each contact by email and changes only the columns you fill in.' },
];

// ---- file selection (validated before anything is sent)
const file = ref<File | null>(null);
const fileError = ref<string | null>(null);
const dragging = ref(false);
const input = ref<HTMLInputElement | null>(null);

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function pick(f: File | undefined | null) {
  file.value = null;
  fileError.value = null;
  if (!f) return;
  if (!/\.csv$/i.test(f.name)) fileError.value = 'Choose a .csv file. Export spreadsheets as CSV first.';
  else if (f.size === 0) fileError.value = 'This file is empty.';
  else if (f.size > MAX_BYTES) fileError.value = `This file is ${size(f.size)}. The limit is 5 MB.`;
  else file.value = f;
}
const onDrop = (e: DragEvent) => {
  dragging.value = false;
  pick(e.dataTransfer?.files?.[0]);
};
function clear() {
  file.value = null;
  fileError.value = null;
  if (input.value) input.value.value = '';
}
function selectMode(m: ImportMode) {
  mode.value = m;
  router.replace({ query: m === 'update' ? { mode: m } : {} });
}

// ---- upload
const upload = useMutation({
  mutationFn: () => api.uploadImport(mode.value, file.value!),
  onSuccess: (job) => router.push({ name: 'import', params: { id: job.id } }),
});
const uploadError = computed(() => {
  const e = upload.error.value;
  if (!e) return null;
  return e instanceof ApiError ? (e.details[0]?.message ?? e.message) : 'Upload failed';
});

const downloading = ref(false);
async function downloadSample() {
  downloading.value = true;
  try {
    await api.downloadTemplate(mode.value);
  } catch (e) {
    toast({ kind: 'error', message: `Couldn't download the sample. ${e instanceof Error ? e.message : ''}` });
  } finally {
    downloading.value = false;
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <RouterLink :to="{ name: 'imports' }" class="link">← Imports</RouterLink>
      <h1>Import contacts</h1>
    </header>

    <div class="page-body">
      <StepIndicator :steps="['Type', 'Upload', 'Review', 'Import']" :current="file ? 1 : 0" />

      <fieldset class="plain" role="radiogroup" aria-label="What do you want to do?">
        <div class="grid2 modes">
          <label v-for="m in MODES" :key="m.mode" class="mode" :class="{ on: mode === m.mode }">
            <input type="radio" name="mode" :value="m.mode" :checked="mode === m.mode" class="sr-only" @change="selectMode(m.mode)" />
            <strong>{{ m.title }}</strong>
            <span>{{ m.text }}</span>
          </label>
        </div>
      </fieldset>

      <div class="import-grid">
        <div>
          <label
            class="drop" :class="{ dragging, filled: !!file }"
            @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop"
          >
            <input ref="input" type="file" accept=".csv,text/csv" class="sr-only" aria-label="Choose a CSV file" @change="pick(($event.target as HTMLInputElement).files?.[0])" />
            <template v-if="file">
              <strong>{{ file.name }}</strong>
              <span class="muted">{{ size(file.size) }} · ready to check</span>
            </template>
            <template v-else>
              <strong>Drop a .csv file here, or browse</strong>
              <span class="muted">UTF-8, header row required, up to 5 MB or 50,000 rows</span>
            </template>
          </label>
          <p v-if="fileError" class="error" role="alert">{{ fileError }}</p>
          <p v-if="uploadError" class="error" role="alert">{{ uploadError }}</p>
          <div class="row" style="margin-top: 12px">
            <button type="button" class="btn primary" :disabled="!file || upload.isPending.value" @click="upload.mutate()">
              {{ upload.isPending.value ? 'Uploading…' : 'Upload and check file' }}
            </button>
            <button v-if="file" type="button" class="btn" :disabled="upload.isPending.value" @click="clear">Remove file</button>
          </div>
          <p class="muted small-text">Nothing is saved yet. You'll review the results before any contact is added or changed.</p>
        </div>

        <p v-if="formats.isPending.value" class="state" role="status">Loading format guide…</p>
        <div v-else-if="formats.isError.value" class="state error" role="alert">
          Could not load the format guide. <button type="button" class="link" @click="formats.refetch()">Retry</button>
        </div>
        <FormatGuide v-else-if="format" :format="format" :downloading="downloading" @download="downloadSample" />
      </div>
    </div>
  </section>
</template>
