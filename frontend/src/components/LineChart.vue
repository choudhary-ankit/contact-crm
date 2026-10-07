<script setup lang="ts">
import { computed } from 'vue';

export interface Series {
  name: string;
  color: string;
  dashed?: boolean;
  values: number[];
}

const props = defineProps<{ labels: string[]; series: Series[] }>();

const W = 640;
const H = 180;
const PAD = { l: 34, r: 8, t: 8, b: 22 };
const niceMax = (n: number) => {
  if (n <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / mag) * mag;
};
const max = computed(() => niceMax(Math.max(0, ...props.series.flatMap((s) => s.values))));
const x = (i: number) => PAD.l + (props.labels.length <= 1 ? 0 : (i / (props.labels.length - 1)) * (W - PAD.l - PAD.r));
const y = (v: number) => PAD.t + (1 - v / max.value) * (H - PAD.t - PAD.b);
const points = (s: Series) => s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
const ticks = computed(() => [0, 0.5, 1].map((f) => ({ v: Math.round(max.value * f), y: y(max.value * f) })));
const short = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const summary = computed(() => props.series.map((s) => `${s.name}: ${s.values.reduce((a, b) => a + b, 0).toLocaleString('en-US')} in total`).join('; '));
</script>

<template>
  <figure class="chart">
    <svg :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="`Line chart over ${labels.length} days. ${summary}`">
      <g v-for="t in ticks" :key="t.v">
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="t.y" :y2="t.y" class="grid-line" />
        <text :x="PAD.l - 6" :y="t.y + 4" class="axis" text-anchor="end">{{ t.v.toLocaleString('en-US') }}</text>
      </g>
      <polyline v-for="s in series" :key="s.name" :points="points(s)" fill="none" :stroke="s.color" stroke-width="2" :stroke-dasharray="s.dashed ? '5 4' : undefined" stroke-linejoin="round" />
      <text v-if="labels.length" :x="PAD.l" :y="H - 4" class="axis">{{ short(labels[0]) }}</text>
      <text v-if="labels.length > 1" :x="W - PAD.r" :y="H - 4" class="axis" text-anchor="end">{{ short(labels[labels.length - 1]) }}</text>
    </svg>
    <figcaption class="legend">
      <span v-for="s in series" :key="s.name"><i class="swatch" :style="{ background: s.color }" :class="{ dashed: s.dashed }" />{{ s.name }}</span>
    </figcaption>
    <table class="sr-only">
      <caption>Daily values</caption>
      <thead><tr><th>Date</th><th v-for="s in series" :key="s.name">{{ s.name }}</th></tr></thead>
      <tbody><tr v-for="(l, i) in labels" :key="l"><td>{{ l }}</td><td v-for="s in series" :key="s.name">{{ s.values[i] }}</td></tr></tbody>
    </table>
  </figure>
</template>
