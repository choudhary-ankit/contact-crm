<script setup lang="ts">
import { computed } from 'vue';
import { FIELDS, type Contact, type ContactFields, type EditableKey } from '../types';

const props = defineProps<{
  /** values the user started editing from */
  original: ContactFields;
  /** what the user wants to save (only the fields they changed) */
  mine: Partial<Record<EditableKey, string>>;
  /** the server's current copy */
  latest: Contact;
  busy?: boolean;
}>();
const emit = defineEmits<{ reapply: []; discard: []; cancel: [] }>();

const latestValue = (k: EditableKey) => props.latest[k] ?? '';

const rows = computed(() =>
  FIELDS.filter((f) => f.key in props.mine).map((f) => ({
    key: f.key,
    label: f.label,
    original: props.original[f.key],
    mine: props.mine[f.key] ?? '',
    latest: latestValue(f.key),
    // a real clash = the other user changed the same field to something different from what I want
    clash: latestValue(f.key) !== props.original[f.key] && latestValue(f.key) !== (props.mine[f.key] ?? ''),
  })),
);
const show = (v: string) => v || '(empty)';
</script>

<template>
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
    <div class="dialog">
      <h2 id="conflict-title">This contact was changed by someone else</h2>
      <p>
        Someone saved a newer version (v{{ latest.version }}) while you were editing. Your changes were <strong>not</strong>
        saved. Choose how to continue:
      </p>
      <table class="diff">
        <thead><tr><th>Field</th><th>When you opened it</th><th>Latest on server</th><th>Your change</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.key" :class="{ clash: r.clash }" :data-field="r.key">
            <th scope="row">{{ r.label }}</th>
            <td>{{ show(r.original) }}</td>
            <td>{{ show(r.latest) }}</td>
            <td>{{ show(r.mine) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">Highlighted rows were edited by both of you. Other changes made by them are kept either way.</p>
      <div class="row actions">
        <button type="button" class="btn primary" :disabled="busy" @click="emit('reapply')">Apply my changes on top of the latest</button>
        <button type="button" class="btn" :disabled="busy" @click="emit('discard')">Discard mine, load latest</button>
        <button type="button" class="link" :disabled="busy" @click="emit('cancel')">Keep editing</button>
      </div>
    </div>
  </div>
</template>
