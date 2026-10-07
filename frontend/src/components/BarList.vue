<script setup lang="ts">
import { computed } from 'vue';

export interface BarItem {
  label: string;
  value: number;
  /** text shown at the end of the row; defaults to the value */
  display?: string;
}

const props = defineProps<{ items: BarItem[]; max?: number; emptyText?: string }>();
const top = computed(() => props.max ?? Math.max(1, ...props.items.map((i) => i.value)));
const width = (v: number) => `${Math.max(v > 0 ? 2 : 0, Math.min(100, (v / top.value) * 100))}%`;
</script>

<template>
  <ul v-if="items.length" class="bars">
    <li v-for="i in items" :key="i.label">
      <span class="bar-label" :title="i.label">{{ i.label }}</span>
      <span class="bar" role="img" :aria-label="`${i.label}: ${i.display ?? i.value}`"><i :style="{ width: width(i.value) }" /></span>
      <span class="bar-value">{{ i.display ?? i.value.toLocaleString('en-US') }}</span>
    </li>
  </ul>
  <p v-else class="muted">{{ emptyText ?? 'Nothing to show yet.' }}</p>
</template>
