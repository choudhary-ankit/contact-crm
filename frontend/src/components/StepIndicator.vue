<script setup lang="ts">
import { Check } from 'lucide-vue-next';

defineProps<{ steps: string[]; current: number }>();
</script>

<template>
  <ol class="steps" aria-label="Import progress">
    <li v-for="(s, i) in steps" :key="s" :class="{ on: i === current, done: i < current }" :aria-current="i === current ? 'step' : undefined">
      <span class="num"><Check v-if="i < current" :size="12" aria-hidden="true" /><template v-else>{{ i + 1 }}</template></span>{{ s }}
    </li>
  </ol>
</template>
