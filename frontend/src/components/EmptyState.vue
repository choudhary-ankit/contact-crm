<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{ icon: Component; title: string; text?: string }>();
</script>

<template>
  <div class="empty">
    <span class="empty-icon" aria-hidden="true"><component :is="icon" /></span>
    <p class="empty-title">{{ title }}</p>
    <p v-if="text" class="empty-text">{{ text }}</p>
    <div v-if="$slots.default" class="row"><slot /></div>
  </div>
</template>
