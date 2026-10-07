<script setup lang="ts">
import { Plus, X } from 'lucide-vue-next';
import { computed, ref } from 'vue';
import { pal } from '../format';
import type { Tag } from '../types';
import { validateTagName } from '../validation';

const MAX_AT_ONCE = 20;

const props = defineProps<{ tags: Tag[]; suggestions: Tag[]; busy?: boolean; error?: string | null }>();
const emit = defineEmits<{ add: [names: string[]]; remove: [tag: Tag] }>();

/** Tags typed but not saved yet. They stay here until the parent confirms success (so a failed save loses nothing). */
const staged = ref<string[]>([]);
const draft = ref('');
const localError = ref<string | null>(null);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const assigned = (name: string) => props.tags.some((t) => same(t.name, name));
/** Commas and semicolons separate names, so a pasted "VIP, Lead; Customer" becomes three tags. */
const parts = (text: string) => text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);

/** Moves what is typed into the staged list. Returns false (and keeps the text) if something is invalid. */
function stage(): boolean {
  const notes: string[] = [];
  for (const name of parts(draft.value)) {
    const problem = validateTagName(name);
    if (problem) return !(localError.value = problem);
    if (assigned(name)) notes.push(`"${name}" is already added`);
    else if (!staged.value.some((s) => same(s, name))) {
      if (staged.value.length >= MAX_AT_ONCE) return !(localError.value = `You can add up to ${MAX_AT_ONCE} tags at a time`);
      staged.value.push(name);
    }
  }
  draft.value = '';
  localError.value = notes.join('. ') || null;
  return true;
}

function submit() {
  if (!stage()) return;
  if (!staged.value.length) {
    localError.value ||= 'Enter a tag name';
    return;
  }
  emit('add', [...staged.value]);
}

function onEnter() {
  if (draft.value.trim()) stage();
  else if (staged.value.length) submit();
}
function onKey(e: KeyboardEvent) {
  if (e.key === ',' || e.key === ';') {
    e.preventDefault();
    stage();
  }
}

const unstage = (name: string) => (staged.value = staged.value.filter((s) => s !== name));
const pending = computed(() => staged.value.length + parts(draft.value).filter((n) => !assigned(n) && !staged.value.some((s) => same(s, n))).length);

/** Called by the parent after the tags were saved. */
function clear() {
  staged.value = [];
  draft.value = '';
  localError.value = null;
}
defineExpose({ clear });
</script>

<template>
  <div class="tag-editor">
    <ul class="chips" aria-label="Assigned tags">
      <li v-for="t in tags" :key="t.id" class="chip" :class="pal(t.name)">
        {{ t.name }}
        <button type="button" class="chip-x" :disabled="busy" :aria-label="`Remove tag ${t.name}`" @click="emit('remove', t)"><X :size="12" aria-hidden="true" /></button>
      </li>
      <li v-if="!tags.length" class="muted">No tags yet</li>
    </ul>

    <form class="tag-form" @submit.prevent="submit">
      <div class="row">
        <input
          v-model="draft" list="tag-suggestions" placeholder="Type tags, separated by commas…" maxlength="200" aria-label="New tag names"
          :disabled="busy" @keydown.enter.prevent="onEnter" @keydown="onKey"
        />
        <datalist id="tag-suggestions"><option v-for="s in suggestions" :key="s.id" :value="s.name" /></datalist>
        <button type="submit" class="btn" :disabled="busy || pending === 0"><Plus aria-hidden="true" />{{ pending > 1 ? `Add ${pending} tags` : 'Add tag' }}</button>
      </div>
      <ul v-if="staged.length" class="chips staged" aria-label="Tags waiting to be added">
        <li v-for="s in staged" :key="s" class="chip pending">
          {{ s }}
          <button type="button" class="chip-x" :disabled="busy" :aria-label="`Don't add ${s}`" @click="unstage(s)"><X :size="12" aria-hidden="true" /></button>
        </li>
      </ul>
      <small class="muted">Press Enter or comma after each tag to line up several, then add them together.</small>
    </form>
    <p v-if="localError || error" class="error" role="alert">{{ localError || error }}</p>
  </div>
</template>
