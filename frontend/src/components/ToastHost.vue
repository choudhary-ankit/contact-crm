<script setup lang="ts">
import { useToasts } from '../composables/useToasts';

const { toasts, dismiss } = useToasts();
</script>

<template>
  <div class="toasts" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind" role="status">
      <span>{{ t.message }}</span>
      <button v-if="t.action" type="button" class="link" @click="t.action.run(); dismiss(t.id)">{{ t.action.label }}</button>
      <button type="button" class="icon-btn" aria-label="Dismiss" @click="dismiss(t.id)">×</button>
    </div>
  </div>
</template>
