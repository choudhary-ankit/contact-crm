import { ref } from 'vue';

// module-level so the sidebar button, the keyboard shortcut and the palette share one state
const isOpen = ref(false);

export function usePalette() {
  return {
    isOpen,
    open: () => (isOpen.value = true),
    close: () => (isOpen.value = false),
    toggle: () => (isOpen.value = !isOpen.value),
  };
}
