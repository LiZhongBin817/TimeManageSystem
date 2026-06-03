import { createRouter, createWebHistory } from 'vue-router';
import { getToken } from './api';
import AppShell from './views/AppShell.vue';
import DashboardView from './views/DashboardView.vue';
import LoginView from './views/LoginView.vue';
import ModuleView from './views/ModuleView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', redirect: '/dashboard' },
        { path: 'dashboard', component: DashboardView },
        { path: 'modules/:moduleKey', component: ModuleView, props: true }
      ]
    }
  ]
});

router.beforeEach((to) => {
  if (to.path !== '/login' && !getToken()) {
    return '/login';
  }
  if (to.path === '/login' && getToken()) {
    return '/dashboard';
  }
  return true;
});
