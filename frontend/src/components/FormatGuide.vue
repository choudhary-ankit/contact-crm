<script setup lang="ts">
import { computed } from 'vue';
import type { ImportFormat } from '../types';

const props = defineProps<{ format: ImportFormat; downloading?: boolean }>();
const emit = defineEmits<{ download: [] }>();

/** A two-line example built from the column specs, so it can never drift from the rules. */
const example = computed(
  () => `${props.format.columns.map((c) => c.column).join(',')}\n${props.format.columns.map((c) => (c.example.includes(',') ? `"${c.example}"` : c.example)).join(',')}`,
);
</script>

<template>
  <section class="card format" :aria-label="`${format.title}: file format`">
    <div class="row between">
      <h2>File format: {{ format.title.toLowerCase() }}</h2>
      <button type="button" class="btn small" :disabled="downloading" @click="emit('download')">
        {{ downloading ? 'Preparing…' : 'Download sample CSV' }}
      </button>
    </div>
    <p class="muted">{{ format.summary }} Use a header row, UTF-8 text, and commas between columns.</p>
    <div class="table-wrap">
      <table class="grid compact">
        <thead><tr><th>Column</th><th>Required</th><th>Rule</th><th>Example</th></tr></thead>
        <tbody>
          <tr v-for="c in format.columns" :key="c.column">
            <td><code>{{ c.column }}</code></td>
            <td>{{ c.required ? 'Yes' : 'No' }}</td>
            <td>{{ c.rule }}</td>
            <td><code>{{ c.example }}</code></td>
          </tr>
        </tbody>
      </table>
    </div>
    <pre class="code" aria-label="Example file">{{ example }}</pre>
    <ul class="notes">
      <li v-for="n in format.notes" :key="n">{{ n }}</li>
    </ul>
  </section>
</template>
