import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { ApiError } from './api';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    // 'always': never park requests in a "paused" state when the browser reports offline/hidden.
    // We want them to fail so the UI can show "Cannot reach the server" instead of spinning forever.
    mutations: { networkMode: 'always' },
    queries: {
      networkMode: 'always',
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      // retry transient failures only; 4xx are deterministic
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

createApp(App).use(router).use(VueQueryPlugin, { queryClient }).mount('#app');
