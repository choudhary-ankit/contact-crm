import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'contacts', component: () => import('./views/ContactsView.vue'), props: { mode: 'active' } },
    { path: '/trash', name: 'trash', component: () => import('./views/ContactsView.vue'), props: { mode: 'trash' } },
    { path: '/contacts/:id', name: 'contact', component: () => import('./views/ContactDetailView.vue'), props: true },
    { path: '/imports', name: 'imports', component: () => import('./views/ImportsView.vue') },
    { path: '/imports/new', name: 'import-new', component: () => import('./views/ImportNewView.vue') },
    { path: '/imports/:id', name: 'import', component: () => import('./views/ImportJobView.vue'), props: true },
    { path: '/metrics', name: 'metrics', component: () => import('./views/MetricsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
