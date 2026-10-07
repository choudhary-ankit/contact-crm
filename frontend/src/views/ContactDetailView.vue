<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ConflictDialog from '../components/ConflictDialog.vue';
import TagEditor from '../components/TagEditor.vue';
import { useToasts } from '../composables/useToasts';
import { describeActivity, fmtDateTime, initials } from '../format';
import { FIELDS, type Contact, type ContactFields, type EditableKey, type Tag } from '../types';
import { validateContact } from '../validation';

const props = defineProps<{ id: string }>();
const router = useRouter();
const qc = useQueryClient();
const { push: toast } = useToasts();

const contactQuery = useQuery({ queryKey: computed(() => ['contact', props.id]), queryFn: () => api.getContact(props.id) });
const activityQuery = useQuery({ queryKey: computed(() => ['activity', props.id]), queryFn: () => api.activity(props.id) });
const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.listTags, staleTime: 60_000 });

const contact = computed(() => contactQuery.data.value);
/** Trashed contacts are read-only until restored. */
const isDeleted = computed(() => !!contact.value?.deletedAt);
const fullName = (c: Pick<Contact, 'firstName' | 'lastName'>) => `${c.firstName} ${c.lastName}`;

// ---- edit form state. `base` is the snapshot (and version) the user started editing from.
const toFields = (c: Contact): ContactFields => ({
  firstName: c.firstName, lastName: c.lastName, email: c.email ?? '', phone: c.phone ?? '', company: c.company ?? '',
});
const form = reactive<ContactFields>({ firstName: '', lastName: '', email: '', phone: '', company: '' });
const base = ref<{ fields: ContactFields; version: number } | null>(null);

function loadForm(c: Contact) {
  Object.assign(form, toFields(c));
  base.value = { fields: toFields(c), version: c.version };
}
// initialise once per contact id; later refetches must NOT overwrite what the user is typing
watch(() => contactQuery.data.value, (c) => { if (c && !base.value) loadForm(c); }, { immediate: true });
watch(() => props.id, () => (base.value = null));

const changed = computed(() => {
  const out: Partial<Record<EditableKey, string>> = {};
  if (!base.value) return out;
  for (const f of FIELDS) if (form[f.key].trim() !== base.value.fields[f.key]) out[f.key] = form[f.key].trim();
  return out;
});
const dirty = computed(() => Object.keys(changed.value).length > 0);

// ---- validation (mirrors the server's rules; the server stays the source of truth)
const serverErrors = ref<Record<string, string>>({});
const existingOwner = ref<{ id: string; name: string } | null>(null);
const clientErrors = computed(() => validateContact(form));
const errorFor = (k: string) => clientErrors.value[k] ?? serverErrors.value[k];
watch(form, () => { serverErrors.value = {}; existingOwner.value = null; }, { deep: true });

// ---- save with optimistic concurrency
const saveNotice = ref<string | null>(null);
const saveError = ref<string | null>(null);
const conflict = ref<{ latest: Contact; mine: Partial<Record<EditableKey, string>> } | null>(null);

const toPatch = (m: Partial<Record<EditableKey, string>>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === '' ? null : v])) as Record<string, string | null>;

const save = useMutation({
  mutationFn: (v: { patch: Partial<Record<EditableKey, string>>; version: number }) => api.updateContact(props.id, v.version, toPatch(v.patch)),
  onSuccess: (c) => {
    qc.setQueryData(['contact', props.id], c);
    loadForm(c);
    conflict.value = null;
    saveError.value = null;
    saveNotice.value = 'Saved.';
    qc.invalidateQueries({ queryKey: ['activity', props.id] });
    qc.invalidateQueries({ queryKey: ['contacts'] });
  },
  onError: (err, v) => {
    saveNotice.value = null;
    if (err instanceof ApiError && err.isConflict && err.current) {
      conflict.value = { latest: err.current, mine: v.patch };
      return;
    }
    if (err instanceof ApiError && err.code === 'CONTACT_DELETED' && err.current) {
      qc.setQueryData(['contact', props.id], err.current); // someone moved it to the trash while we were editing
      saveError.value = null;
      return;
    }
    if (err instanceof ApiError && err.details.length) {
      serverErrors.value = Object.fromEntries(err.details.map((d) => [d.field, d.message]));
      existingOwner.value = err.existing ?? null;
      saveError.value = 'Please fix the highlighted fields.';
      return;
    }
    saveError.value = err instanceof Error ? err.message : 'Update failed';
  },
});

function submit() {
  saveNotice.value = null;
  saveError.value = null;
  if (isDeleted.value || !base.value || !dirty.value || Object.keys(clientErrors.value).length) return;
  save.mutate({ patch: changed.value, version: base.value.version });
}

// conflict resolution
function reapply() {
  if (!conflict.value) return;
  const { latest, mine } = conflict.value;
  // keep only my edits, re-based on the latest version. Fields they changed that I did not touch are preserved.
  save.mutate({ patch: mine, version: latest.version });
}
function discard() {
  if (!conflict.value) return;
  qc.setQueryData(['contact', props.id], conflict.value.latest);
  loadForm(conflict.value.latest);
  conflict.value = null;
  qc.invalidateQueries({ queryKey: ['activity', props.id] });
}

// ---- tags (set operations; independent of the field version)
const tagError = ref<string | null>(null);
const tagEditor = ref<InstanceType<typeof TagEditor> | null>(null);
const tagMsg = (e: unknown) => (e instanceof ApiError ? (e.details[0]?.message ?? e.message) : 'Tag update failed');
const setTags = (tags: Tag[]) => qc.setQueryData<Contact>(['contact', props.id], (c) => (c ? { ...c, tags } : c));
const afterTagChange = () => {
  tagError.value = null;
  qc.invalidateQueries({ queryKey: ['activity', props.id] });
  qc.invalidateQueries({ queryKey: ['tags'] });
  qc.invalidateQueries({ queryKey: ['contacts'] });
};
// One shared scope runs tag changes strictly one after another. Each response is the full tag list at that moment,
// so applying them in order can never show an older list over a newer one (the cause of "tag added but not shown").
const tagScope = computed(() => ({ id: `tags-${props.id}` }));

const addTags = useMutation({
  mutationFn: (names: string[]) => api.addTags(props.id, names),
  scope: tagScope.value,
  onSuccess: (res) => {
    setTags(res.tags);
    tagEditor.value?.clear();
    afterTagChange();
  },
  onError: (e) => (tagError.value = tagMsg(e)),
});
const removeTag = useMutation({
  mutationFn: (tag: Tag) => api.removeTag(props.id, tag.id).then(() => tag),
  scope: tagScope.value,
  onSuccess: (tag) => {
    setTags((contact.value?.tags ?? []).filter((t) => t.id !== tag.id));
    afterTagChange();
  },
  onError: (e) => (tagError.value = tagMsg(e)),
});
const tagsBusy = computed(() => addTags.isPending.value || removeTag.isPending.value);

// ---- move to trash / restore
const confirmTrash = ref(false);
const restoreProblem = ref<{ message: string; existingId?: string } | null>(null);

const restore = useMutation({
  mutationFn: (c: Contact) => api.restoreContact(c.id, c.version),
  onSuccess: (c) => {
    restoreProblem.value = null;
    qc.setQueryData(['contact', props.id], c);
    loadForm(c);
    qc.invalidateQueries({ queryKey: ['activity', props.id] });
    qc.invalidateQueries({ queryKey: ['contacts'] });
    toast({ kind: 'success', message: `Restored ${fullName(c)}` });
  },
  onError: (err) => {
    if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') {
      restoreProblem.value = { message: err.details[0]?.message ?? err.message, existingId: err.existing?.id };
      return;
    }
    toast({ kind: 'error', message: `Couldn't restore. ${err instanceof Error ? err.message : ''}` });
  },
});

const trash = useMutation({
  // uses the latest known version (not the form's), so after a conflict the user can retry knowingly
  mutationFn: (c: Contact) => api.deleteContact(c.id, c.version),
  onSuccess: (c) => {
    confirmTrash.value = false;
    qc.invalidateQueries({ queryKey: ['contacts'] });
    toast({
      kind: 'success',
      message: `Moved ${fullName(c)} to trash`,
      action: { label: 'Undo', run: () => api.restoreContact(c.id, c.version).then(() => qc.invalidateQueries({ queryKey: ['contacts'] })) },
    });
    router.push({ name: 'contacts' });
  },
  onError: (err) => {
    if (err instanceof ApiError && err.isConflict && err.current) qc.setQueryData(['contact', props.id], err.current);
  },
});
const trashError = computed(() => {
  const e = trash.error.value;
  if (!e) return null;
  return e instanceof ApiError && e.isConflict
    ? 'Someone changed this contact. The latest version is loaded, so you can try again.'
    : e.message;
});

const loadError = computed(() => contactQuery.error.value as ApiError | null);
const goBack = () => (window.history.state?.back ? router.back() : router.push({ name: 'contacts' }));
</script>

<template>
  <section>
    <header class="page-header">
      <button type="button" class="link" @click="goBack">← Back</button>
      <span class="spacer" />
      <template v-if="contact">
        <button v-if="isDeleted" type="button" class="btn primary" :disabled="restore.isPending.value" @click="restore.mutate(contact)">
          {{ restore.isPending.value ? 'Restoring…' : 'Restore contact' }}
        </button>
        <button v-else type="button" class="btn danger-outline" @click="trash.reset(); confirmTrash = true">Move to trash</button>
      </template>
    </header>

    <div class="page-body">
      <p v-if="contactQuery.isPending.value" class="state" role="status">Loading contact…</p>
      <div v-else-if="loadError" class="state error" role="alert">
        <p>{{ loadError.status === 404 ? 'This contact does not exist.' : `Could not load contact: ${loadError.message}` }}</p>
        <button v-if="loadError.status !== 404" type="button" class="btn" @click="contactQuery.refetch()">Retry</button>
      </div>

      <template v-else-if="contact && base">
        <div class="identity">
          <span class="avatar large" aria-hidden="true">{{ initials(contact.firstName, contact.lastName) }}</span>
          <div>
            <h1>{{ fullName(contact) }}</h1>
            <p class="muted">
              Created {{ fmtDateTime(contact.createdAt) }} · Updated {{ fmtDateTime(contact.updatedAt) }} · v{{ contact.version }}
            </p>
          </div>
        </div>

        <div v-if="isDeleted" class="banner warn" role="status">
          <span>
            This contact is in the trash{{ contact.deletedAt ? ` since ${fmtDateTime(contact.deletedAt)}` : '' }}. It's read-only until you restore it.
            <template v-if="restoreProblem">
              <strong>Can't restore:</strong> {{ restoreProblem.message }}.
              <RouterLink v-if="restoreProblem.existingId" :to="{ name: 'contact', params: { id: restoreProblem.existingId } }">Open that contact</RouterLink>
              to change its email, then try again.
            </template>
          </span>
        </div>

        <div class="columns">
          <form class="card" novalidate @submit.prevent="submit">
            <h2>Details</h2>
            <fieldset :disabled="isDeleted" class="plain">
              <label v-for="f in FIELDS" :key="f.key">
                {{ f.label }}<span v-if="f.required" aria-hidden="true"> *</span>
                <input
                  v-model="form[f.key]" :name="f.key" :type="f.key === 'email' ? 'email' : f.key === 'phone' ? 'tel' : 'text'"
                  :aria-invalid="!!errorFor(f.key)" :aria-describedby="errorFor(f.key) ? `err-${f.key}` : undefined"
                />
                <small v-if="errorFor(f.key)" :id="`err-${f.key}`" class="error">
                  {{ errorFor(f.key) }}
                  <RouterLink v-if="f.key === 'email' && existingOwner" :to="{ name: 'contact', params: { id: existingOwner.id } }">Open contact</RouterLink>
                </small>
              </label>
            </fieldset>

            <p v-if="saveError" class="error" role="alert">{{ saveError }}</p>
            <p v-if="saveNotice" class="success" role="status">{{ saveNotice }}</p>
            <div v-if="!isDeleted" class="row">
              <button type="submit" class="btn primary" :disabled="!dirty || save.isPending.value">{{ save.isPending.value ? 'Saving…' : 'Save changes' }}</button>
              <button type="button" class="btn" :disabled="!dirty || save.isPending.value" @click="loadForm(contact)">Reset</button>
            </div>
          </form>

          <div>
            <div class="card">
              <h2>Tags</h2>
              <TagEditor
                ref="tagEditor" :tags="contact.tags" :suggestions="tagsQuery.data.value ?? []" :busy="tagsBusy || isDeleted" :error="tagError"
                @add="(names) => addTags.mutate(names)" @remove="(tag) => removeTag.mutate(tag)"
              />
            </div>

            <div class="card">
              <div class="row between"><h2>Recent activity</h2><span class="muted small-text">Newest first</span></div>
              <p v-if="activityQuery.isPending.value" class="muted" role="status">Loading activity…</p>
              <p v-else-if="activityQuery.isError.value" class="error" role="alert">
                Could not load activity. <button type="button" class="link" @click="activityQuery.refetch()">Retry</button>
              </p>
              <p v-else-if="!activityQuery.data.value?.length" class="muted">No activity yet.</p>
              <ul v-else class="activity">
                <li v-for="a in activityQuery.data.value" :key="a.id">
                  <span class="badge" :data-type="a.type">{{ a.type }}</span>
                  <span>{{ describeActivity(a) }}</span>
                  <time :datetime="a.createdAt">{{ fmtDateTime(a.createdAt) }}</time>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <ConflictDialog
          v-if="conflict" :original="base.fields" :mine="conflict.mine" :latest="conflict.latest" :busy="save.isPending.value"
          @reapply="reapply" @discard="discard" @cancel="conflict = null"
        />
        <ConfirmDialog
          v-if="confirmTrash"
          :title="`Move ${fullName(contact)} to trash`"
          message="They'll disappear from lists and search. You can restore them from Trash."
          confirm-label="Move to trash" danger :busy="trash.isPending.value" :error="trashError"
          @confirm="trash.mutate(contact)" @cancel="confirmTrash = false"
        />
      </template>
    </div>
  </section>
</template>
