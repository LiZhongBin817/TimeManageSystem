import { createRouter, createWebHistory } from 'vue-router';
import { clearToken, getToken } from './api';
import AppShell from './views/AppShell.vue';
import DashboardView from './views/DashboardView.vue';
import LoginView from './views/LoginView.vue';
import ModuleView from './views/ModuleView.vue';
import OAuthCallbackView from './views/OAuthCallbackView.vue';
import ProjectModulesView from './views/ProjectModulesView.vue';
import StaffView from './views/StaffView.vue';
import SettingsView from './views/SettingsView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/oauth/callback', component: OAuthCallbackView },
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', redirect: '/dashboard' },
        { path: 'dashboard', component: DashboardView },
        { path: 'project-modules', component: ProjectModulesView },
        { path: 'modules/staff', component: StaffView },
        { path: 'modules/:moduleKey', component: ModuleView, props: true },
        { path: 'settings', component: SettingsView }
      ]
    }
  ]
});

router.beforeEach((to) => {
  if (!['/login', '/oauth/callback'].includes(to.path) && !getToken()) {
    return '/login';
  }
  if (to.path === '/login' && getToken()) {
    if (to.query.oauthError || to.query.force === '1') {
      clearToken();
      return true;
    }
    return '/dashboard';
  }
  return true;
});
