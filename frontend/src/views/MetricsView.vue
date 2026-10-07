<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { ArrowRight, Calendar, ChartColumn, Mail, TrendingDown, TrendingUp, UserPlus, Users, Tag as TagIcon, Upload } from 'lucide-vue-next';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import BarList from '../components/BarList.vue';
import EmptyState from '../components/EmptyState.vue';
import LineChart from '../components/LineChart.vue';
import Sparkline from '../components/Sparkline.vue';
import { ATTENTION_LABELS, fmtNumber, pct } from '../format';
import type { ActivityType, Attention } from '../types';

const route = useRoute();
const router = useRouter();

const RANGES = [7, 30, 90] as const;
const range = computed(() => (RANGES.find((r) => String(r) === route.query.range) ?? 30) as 7 | 30 | 90);
const setRange = (e: Event) => router.replace({ query: { range: (e.target as HTMLSelectElement).value } });

const metrics = useQuery({
  queryKey: computed(() => ['metrics', range.value]),
  queryFn: () => api.metrics(range.value),
  staleTime: 30_000,
  placeholderData: (prev) => prev, // keep the old numbers on screen while a new range loads
});
const m = computed(() => metrics.data.value);
const updating = computed(() => metrics.isFetching.value && !metrics.isPending.value);

const empty = computed(() => !!m.value && m.value.contacts.active === 0 && m.value.contacts.inTrash === 0 && m.value.imports.jobs === 0);
const loadError = computed(() => (metrics.error.value as ApiError | null)?.message ?? null);

const ACTIVITY_LABELS: Record<ActivityType, string> = {
  CONTACT_CREATED: 'Contacts created',
  CONTACT_UPDATED: 'Contacts edited',
  CONTACT_DELETED: 'Moved to trash',
  CONTACT_RESTORED: 'Restored',
  TAG_ADDED: 'Tags added',
  TAG_REMOVED: 'Tags removed',
};

const q = computed(() => m.value!.quality);
const active = computed(() => m.value?.contacts.active ?? 0);

const completeness = computed(() => [
  { label: 'Email', value: pct(q.value.withEmail, active.value), display: `${pct(q.value.withEmail, active.value)}%` },
  { label: 'Phone', value: pct(q.value.withPhone, active.value), display: `${pct(q.value.withPhone, active.value)}%` },
  { label: 'Company', value: pct(q.value.withCompany, active.value), display: `${pct(q.value.withCompany, active.value)}%` },
]);

const attention = computed<Array<{ key: Attention; label: string; count: number; hint?: string }>>(() => [
  { key: 'no_contact_info', label: ATTENTION_LABELS.no_contact_info, count: q.value.noContactInfo, hint: "can't be contacted" },
  { key: 'untagged', label: ATTENTION_LABELS.untagged, count: q.value.untagged, hint: "can't be segmented" },
  { key: 'duplicate_phone', label: ATTENTION_LABELS.duplicate_phone, count: q.value.duplicatePhoneContacts, hint: q.value.duplicatePhoneGroups ? `${fmtNumber(q.value.duplicatePhoneGroups)} shared numbers` : undefined },
  { key: 'stale', label: `Not updated in ${q.value.staleDays}+ days`, count: q.value.stale, hint: 'may be out of date' },
]);

/** Approximate running total of active contacts over the period, ending at today's count (for the sparkline). */
const activeTrend = computed(() => {
  if (!m.value) return [] as number[];
  let running = m.value.contacts.active;
  const out = new Array<number>(m.value.daily.length);
  for (let i = m.value.daily.length - 1; i >= 0; i--) {
    out[i] = running;
    running -= m.value.daily[i].created;
  }
  return out;
});

const change = computed(() => m.value?.contacts.changePct ?? null);
const updatedAt = computed(() => (m.value ? new Date(m.value.generatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''));
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Metrics</h1>
      <span v-if="updating" class="muted small-text" role="status">Updating…</span>
      <span class="spacer" />
      <span v-if="m" class="muted small-text">Updated {{ updatedAt }}</span>
      <label class="inline">
        <Calendar :size="15" aria-hidden="true" style="color: var(--subtle)" />
        <span class="sr-only">Period</span>
        <select :value="range" aria-label="Period" @change="setRange">
          <option :value="7">Last 7 days</option>
          <option :value="30">Last 30 days</option>
          <option :value="90">Last 90 days</option>
        </select>
      </label>
    </header>

    <div class="page-body">
      <div v-if="metrics.isPending.value" role="status">
        <span class="sr-only">Loading metrics…</span>
        <div class="kpis four" aria-hidden="true">
          <div v-for="n in 4" :key="n" class="kpi"><span class="skeleton line" style="width: 50%" /><span class="skeleton line" style="width: 40%; height: 26px" /><span class="skeleton line" style="width: 60%; height: 8px" /></div>
        </div>
        <div class="columns" aria-hidden="true"><div v-for="n in 2" :key="n" class="card"><span class="skeleton line" style="width: 40%" /><span class="skeleton line" style="height: 140px" /></div></div>
      </div>
      <div v-else-if="metrics.isError.value && !m" class="state error" role="alert">
        <p>Could not load metrics: {{ loadError }}</p>
        <button type="button" class="btn" @click="metrics.refetch()">Retry</button>
      </div>

      <EmptyState v-else-if="empty" :icon="ChartColumn" title="No data yet." text="Add or import contacts to see your metrics.">
        <RouterLink :to="{ name: 'contacts' }" class="btn primary"><Users aria-hidden="true" />Go to contacts</RouterLink>
        <RouterLink :to="{ name: 'import-new' }" class="btn"><Upload aria-hidden="true" />Import contacts</RouterLink>
      </EmptyState>

      <template v-else-if="m">
        <p v-if="metrics.isError.value" class="error" role="alert">Could not refresh: {{ loadError }} <button type="button" class="link" @click="metrics.refetch()">Retry</button></p>

        <div class="kpis four">
          <div class="kpi">
            <span class="sub"><Users aria-hidden="true" />Active contacts</span><b>{{ fmtNumber(m.contacts.active) }}</b>
            <span class="sub"><RouterLink :to="{ name: 'trash' }">{{ fmtNumber(m.contacts.inTrash) }} in trash</RouterLink></span>
            <Sparkline :values="activeTrend" />
          </div>
          <div class="kpi">
            <span class="sub"><UserPlus aria-hidden="true" />New in last {{ m.range }} days</span><b>{{ fmtNumber(m.contacts.newInRange) }}</b>
            <span v-if="change !== null" class="delta" :class="change >= 0 ? 'up' : 'down'">
              <component :is="change >= 0 ? TrendingUp : TrendingDown" aria-hidden="true" />{{ Math.abs(change) }}% vs previous {{ m.range }} days
            </span>
            <span v-else class="sub">No previous period to compare</span>
            <Sparkline :values="m.daily.map((d) => d.created)" color="var(--ok)" />
          </div>
          <div class="kpi">
            <span class="sub"><Mail aria-hidden="true" />Reachable</span><b>{{ pct(q.reachable, m.contacts.active) }}%</b>
            <span class="sub">have an email or a phone</span>
            <div class="progress" aria-hidden="true" style="margin-top: 8px"><i :style="{ width: `${pct(q.reachable, m.contacts.active)}%` }" /></div>
          </div>
          <div class="kpi">
            <span class="sub"><TagIcon aria-hidden="true" />Untagged</span><b>{{ pct(q.untagged, m.contacts.active) }}%</b>
            <span class="sub">{{ fmtNumber(q.untagged) }} contacts</span>
            <div class="progress" aria-hidden="true" style="margin-top: 8px"><i :style="{ width: `${pct(q.untagged, m.contacts.active)}%` }" /></div>
          </div>
        </div>

        <div class="columns">
          <div class="card span-all">
            <h2>New contacts and edits per day</h2>
            <LineChart
              :labels="m.daily.map((d) => d.date)"
              :series="[
                { name: 'New contacts', color: 'var(--chart-1)', values: m.daily.map((d) => d.created) },
                { name: 'Edits', color: 'var(--chart-2)', dashed: true, values: m.daily.map((d) => d.edits) },
              ]"
            />
          </div>
          <div class="card">
            <h2>Contacts by tag</h2>
            <BarList :items="m.tags.map((t) => ({ label: t.name, value: t.count }))" empty-text="No tags in use yet." />
          </div>
          <div class="card">
            <h2>Data completeness</h2>
            <BarList :items="completeness" :max="100" />
          </div>
          <div class="card">
            <h2>Needs attention</h2>
            <table class="grid compact attention">
              <tbody>
                <tr v-for="a in attention" :key="a.key">
                  <td>{{ a.label }}<div v-if="a.hint" class="sub">{{ a.hint }}</div></td>
                  <td class="num">{{ fmtNumber(a.count) }}</td>
                  <td class="actions-col">
                    <RouterLink v-if="a.count > 0" :to="{ name: 'contacts', query: { attention: a.key } }" :aria-label="`View contacts: ${a.label}`">View<ArrowRight :size="13" aria-hidden="true" style="vertical-align: -2px; margin-left: 2px" /></RouterLink>
                    <span v-else class="muted">None</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="card">
            <h2>Activity in the last {{ m.range }} days</h2>
            <BarList :items="m.activity.map((a) => ({ label: ACTIVITY_LABELS[a.type] ?? a.type, value: a.count }))" empty-text="No activity in this period." />
          </div>
          <div class="card">
            <h2>Trash and imports</h2>
            <dl class="facts">
              <div><dt>In trash now</dt><dd><RouterLink :to="{ name: 'trash' }">{{ fmtNumber(m.trash.current) }}</RouterLink></dd></div>
              <div><dt>Moved to trash (period)</dt><dd>{{ fmtNumber(m.trash.deletedInRange) }}</dd></div>
              <div><dt>Restored (period)</dt><dd>{{ fmtNumber(m.trash.restoredInRange) }}</dd></div>
              <div><dt>Imports (period)</dt><dd><RouterLink :to="{ name: 'imports' }">{{ fmtNumber(m.imports.jobs) }}</RouterLink> <span class="muted">({{ m.imports.failed }} failed)</span></dd></div>
              <div><dt>Rows added / updated</dt><dd>{{ fmtNumber(m.imports.rowsCreated) }} / {{ fmtNumber(m.imports.rowsUpdated) }}</dd></div>
              <div><dt>Import success rate</dt><dd>{{ m.imports.acceptRate === null ? '—' : `${m.imports.acceptRate}%` }} <span class="muted">({{ fmtNumber(m.imports.rowsRejected) }} rows rejected)</span></dd></div>
            </dl>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
