<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ values: number[]; color?: string }>();
const W = 100;
const H = 28;
const pts = computed(() => {
  const v = props.values;
  if (v.length < 2) return [] as Array<[number, number]>;
  const min = Math.min(...v);
  const span = Math.max(...v) - min || 1;
  return v.map((n, i): [number, number] => [(i / (v.length - 1)) * W, H - 2 - ((n - min) / span) * (H - 6)]);
});
const line = computed(() => pts.value.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
const area = computed(() => (pts.value.length ? `0,${H} ${line.value} ${W},${H}` : ''));
</script>

<template>
  <svg v-if="pts.length" class="spark" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true" :style="{ color: color ?? 'var(--chart-1)' }">
    <polygon :points="area" fill="currentColor" opacity="0.12" />
    <polyline :points="line" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
  </svg>
</template>
