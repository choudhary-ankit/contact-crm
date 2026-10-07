<script setup lang="ts">
defineProps<{ steps: string[]; current: number }>();
</script>

<template>
  <ol class="steps" aria-label="Import progress">
    <li v-for="(s, i) in steps" :key="s" :class="{ on: i === current, done: i < current }" :aria-current="i === current ? 'step' : undefined">
      <span class="num">{{ i < current ? '✓' : i + 1 }}</span>{{ s }}
    </li>
  </ol>
</template>
