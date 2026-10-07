<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api';
import { FIELDS, type Contact, type ContactFields } from '../types';
import { validateContact, validateTagName } from '../validation';

const emit = defineEmits<{ close: []; created: [contact: Contact] }>();

const form = reactive<ContactFields>({ firstName: '', lastName: '', email: '', phone: '', company: '' });
const tags = ref<string[]>([]);
const tagDraft = ref('');
const tagError = ref<string | null>(null);
const attempted = ref(false);
const serverErrors = ref<Record<string, string>>({});
const existing = ref<{ id: string; name: string } | null>(null);
const formError = ref<string | null>(null);

const suggestions = useQuery({ queryKey: ['tags'], queryFn: api.listTags, staleTime: 60_000 });
const clientErrors = computed(() => (attempted.value ? validateContact(form) : {}));
const errorFor = (k: string) => clientErrors.value[k] ?? serverErrors.value[k];

function addTag() {
  const name = tagDraft.value.trim().replace(/,$/, '');
  if (!name) return;
  const problem = validateTagName(name);
  if (problem) return (tagError.value = problem);
  if (tags.value.length >= 20) return (tagError.value = 'You can add up to 20 tags');
  if (!tags.value.some((t) => t.toLowerCase() === name.toLowerCase())) tags.value.push(name);
  tagDraft.value = '';
  tagError.value = null;
}
const removeTag = (name: string) => (tags.value = tags.value.filter((t) => t !== name));

const create = useMutation({
  mutationFn: () =>
    api.createContact({
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      company: form.company.trim() || null,
      tags: tags.value,
    }),
  onSuccess: (c) => emit('created', c),
  onError: (err) => {
    existing.value = null;
    if (err instanceof ApiError && err.details.length) {
      serverErrors.value = Object.fromEntries(err.details.map((d) => [d.field, d.message]));
      existing.value = err.existing ?? null;
      formError.value = null;
      return;
    }
    formError.value = err instanceof Error ? err.message : 'Could not create the contact';
  },
});

function submit() {
  attempted.value = true;
  serverErrors.value = {};
  existing.value = null;
  formError.value = null;
  addTag(); // a half-typed tag shouldn't be silently dropped
  if (Object.keys(validateContact(form)).length) return;
  create.mutate();
}

const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !create.isPending.value && emit('close');
const first = ref<HTMLInputElement[] | null>(null);
onMounted(() => {
  window.addEventListener('keydown', onKey);
  first.value?.[0]?.focus();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="add-title" @click.self="!create.isPending.value && emit('close')">
    <form class="dialog" novalidate @submit.prevent="submit">
      <div class="row between">
        <h2 id="add-title">Add contact</h2>
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')">×</button>
      </div>

      <div class="grid2">
        <label v-for="f in FIELDS.slice(0, 2)" :key="f.key">
          {{ f.label }} *
          <input ref="first" v-model="form[f.key]" :name="f.key" :aria-invalid="!!errorFor(f.key)" autocomplete="off" />
          <small v-if="errorFor(f.key)" class="error">{{ errorFor(f.key) }}</small>
        </label>
      </div>
      <label>
        Email
        <input v-model="form.email" name="email" type="email" placeholder="name@company.com" :aria-invalid="!!errorFor('email')" autocomplete="off" />
        <small v-if="errorFor('email')" class="error">
          {{ errorFor('email') }}
          <RouterLink v-if="existing" :to="{ name: 'contact', params: { id: existing.id } }" @click="emit('close')">Open contact</RouterLink>
        </small>
      </label>
      <div class="grid2">
        <label>
          Phone
          <input v-model="form.phone" name="phone" type="tel" placeholder="+1 (415) 555-0172" :aria-invalid="!!errorFor('phone')" autocomplete="off" />
          <small v-if="errorFor('phone')" class="error">{{ errorFor('phone') }}</small>
        </label>
        <label>
          Company
          <input v-model="form.company" name="company" placeholder="Acme Auto" :aria-invalid="!!errorFor('company')" autocomplete="off" />
          <small v-if="errorFor('company')" class="error">{{ errorFor('company') }}</small>
        </label>
      </div>
      <label>
        Tags
        <input
          v-model="tagDraft" list="modal-tags" placeholder="Add a tag and press Enter" aria-label="Add a tag"
          @keydown.enter.prevent="addTag" @keydown.,="(e: KeyboardEvent) => { e.preventDefault(); addTag(); }"
        />
        <datalist id="modal-tags"><option v-for="t in suggestions.data.value ?? []" :key="t.id" :value="t.name" /></datalist>
        <small v-if="tagError" class="error">{{ tagError }}</small>
      </label>
      <ul v-if="tags.length" class="chips" aria-label="Tags to add">
        <li v-for="t in tags" :key="t" class="chip">
          {{ t }}<button type="button" class="chip-x" :aria-label="`Remove tag ${t}`" @click="removeTag(t)">×</button>
        </li>
      </ul>

      <p v-if="formError" class="error" role="alert">{{ formError }}</p>
      <div class="row end">
        <button type="button" class="btn" :disabled="create.isPending.value" @click="emit('close')">Cancel</button>
        <button type="submit" class="btn primary" :disabled="create.isPending.value">{{ create.isPending.value ? 'Creating…' : 'Create contact' }}</button>
      </div>
    </form>
  </div>
</template>
