<script setup lang="ts">
import { SlidersHorizontal } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ATTENTION_LABELS } from '../format';
import type { Attention, Tag } from '../types';

const props = defineProps<{ tags: Tag[]; rangeInvalid?: boolean }>();
const tag = defineModel<string>('tag', { default: '' });
const company = defineModel<string>('company', { default: '' });
const createdFrom = defineModel<string>('createdFrom', { default: '' });
const createdTo = defineModel<string>('createdTo', { default: '' });
const attention = defineModel<Attention | ''>('attention', { default: '' });
const emit = defineEmits<{ clear: [] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const count = computed(() => [tag.value, company.value.trim(), createdFrom.value, createdTo.value, attention.value].filter(Boolean).length);
const attentionOptions = Object.entries(ATTENTION_LABELS) as Array<[Attention, string]>;

const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
};
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (open.value = false);
onMounted(() => {
  document.addEventListener('mousedown', onDoc);
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDoc);
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div ref="root" class="popover">
    <button type="button" class="btn" :aria-expanded="open" aria-haspopup="dialog" @click="open = !open">
      <SlidersHorizontal aria-hidden="true" />Filters<span v-if="count" class="badge-dot" :aria-label="`${count} active`">{{ count }}</span>
    </button>
    <div v-if="open" class="popover-panel" role="dialog" aria-label="Filters">
      <label>
        Tag
        <select v-model="tag">
          <option value="">All tags</option>
          <option v-for="t in props.tags" :key="t.id" :value="t.name">{{ t.name }}</option>
        </select>
      </label>
      <label>
        Company
        <input v-model="company" type="text" placeholder="Contains…" maxlength="150" />
      </label>
      <div class="grid2">
        <label>Created from <input v-model="createdFrom" type="date" /></label>
        <label>Created to <input v-model="createdTo" type="date" /></label>
      </div>
      <p v-if="rangeInvalid" class="error small-text" role="alert">“Created from” must be on or before “Created to”. The date filter is ignored until fixed.</p>
      <label>
        Needs attention
        <select v-model="attention">
          <option value="">Anything</option>
          <option v-for="[key, label] in attentionOptions" :key="key" :value="key">{{ label }}</option>
        </select>
      </label>
      <div class="row between">
        <button type="button" class="link" :disabled="!count" @click="emit('clear')">Clear all</button>
        <button type="button" class="btn small primary" @click="open = false">Done</button>
      </div>
    </div>
  </div>
</template>
