import { onScopeDispose, ref, watch, type Ref } from 'vue';

/** Returns a ref that follows `source` after it has been stable for `ms`. */
export function useDebounced<T>(source: Ref<T>, ms = 300): Ref<T> {
  const debounced = ref(source.value) as Ref<T>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(source, (v) => {
    clearTimeout(timer);
    timer = setTimeout(() => (debounced.value = v), ms);
  });
  onScopeDispose(() => clearTimeout(timer));
  return debounced;
}
