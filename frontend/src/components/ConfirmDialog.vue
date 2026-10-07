<script setup lang="ts">
import { Trash2, TriangleAlert } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineProps<{
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const cancelBtn = ref<HTMLButtonElement | null>(null);
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && emit('cancel');
onMounted(() => {
  window.addEventListener('keydown', onKey);
  cancelBtn.value?.focus(); // safest default for destructive prompts
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="overlay" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-msg" @click.self="emit('cancel')">
    <div class="dialog narrow">
      <span class="empty-icon" :style="danger ? { background: 'var(--danger-soft)', color: 'var(--danger-text)' } : undefined" aria-hidden="true" style="width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center">
        <component :is="danger ? Trash2 : TriangleAlert" :size="18" />
      </span>
      <h2 id="confirm-title">{{ title }}</h2>
      <p id="confirm-msg" class="muted">{{ message }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="row end">
        <button ref="cancelBtn" type="button" class="btn" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button type="button" class="btn" :class="danger ? 'danger' : 'primary'" :disabled="busy" @click="emit('confirm')">
          {{ busy ? 'Working…' : confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
