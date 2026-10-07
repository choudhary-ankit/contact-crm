<script setup lang="ts">
withDefaults(defineProps<{ rows?: number; label?: string; checkbox?: boolean }>(), { rows: 8, label: 'Loading…', checkbox: true });
</script>

<template>
  <div class="table-wrap" role="status" aria-live="polite">
    <span class="sr-only">{{ label }}</span>
    <div v-for="n in rows" :key="n" class="skel-row" aria-hidden="true" :style="checkbox ? undefined : { gridTemplateColumns: '2fr 1.2fr 1.4fr 0.8fr' }">
      <span v-if="checkbox" class="skeleton line" style="width: 16px; height: 16px" />
      <div class="skel-person">
        <span class="skeleton circle" />
        <div class="stack"><span class="skeleton line" :style="{ width: `${50 + ((n * 17) % 35)}%` }" /><span class="skeleton line" style="width: 42%; height: 8px" /></div>
      </div>
      <span class="skeleton line" :style="{ width: `${40 + ((n * 23) % 45)}%` }" />
      <span class="skeleton pill" />
      <span class="skeleton line" style="width: 60%" />
    </div>
  </div>
</template>
