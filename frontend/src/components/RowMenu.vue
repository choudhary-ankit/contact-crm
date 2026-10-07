<script setup lang="ts">
import { Ellipsis, type LucideIcon } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineProps<{ label: string; items: Array<{ key: string; label: string; danger?: boolean; icon?: LucideIcon }> }>();
const emit = defineEmits<{ select: [key: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

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

function choose(key: string) {
  open.value = false;
  emit('select', key);
}
</script>

<template>
  <div ref="root" class="menu">
    <button type="button" class="icon-btn" :aria-label="label" aria-haspopup="menu" :aria-expanded="open" @click.stop="open = !open">
      <Ellipsis aria-hidden="true" />
    </button>
    <ul v-if="open" class="menu-list" role="menu">
      <li v-for="i in items" :key="i.key" role="none">
        <button type="button" role="menuitem" :class="{ danger: i.danger }" @click="choose(i.key)">
          <component :is="i.icon" v-if="i.icon" aria-hidden="true" />{{ i.label }}
        </button>
      </li>
    </ul>
  </div>
</template>
