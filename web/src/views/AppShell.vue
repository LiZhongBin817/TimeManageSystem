<script setup lang="ts">
import { DataAnalysis, Document, Grid, List, Monitor, OfficeBuilding, SwitchButton, UserFilled } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { clearToken, getMe, getModules } from '../api';
import type { ModuleConfig, User } from '../types';

const router = useRouter();
const route = useRoute();
const user = ref<User>();
const modules = ref<ModuleConfig[]>([]);

const navIcons: Record<string, any> = {
  'power-standard': Monitor,
  'sales-standard': Document,
  crawler: DataAnalysis,
  'province-system': OfficeBuilding,
  staff: UserFilled,
  todos: List
};

const active = computed(() => route.path);

async function boot() {
  try {
    const [me, moduleList] = await Promise.all([getMe(), getModules()]);
    user.value = me;
    modules.value = moduleList;
  } catch {
    ElMessage.error('获取用户信息失败');
  }
}

function logout() {
  clearToken();
  router.push('/login');
}

onMounted(boot);
</script>

<template>
  <div class="app-layout">
    <aside class="sidebar">
      <div class="brand">
        <el-icon><Grid /></el-icon>
        <span>时间管理系统</span>
      </div>
      <el-menu :default-active="active" router class="nav-menu">
        <el-menu-item index="/dashboard">
          <el-icon><DataAnalysis /></el-icon>
          <span>汇总看板</span>
        </el-menu-item>
        <el-menu-item v-for="item in modules" :key="item.key" :index="`/modules/${item.key}`">
          <el-icon><component :is="navIcons[item.key] || Document" /></el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>
    </aside>
    <section class="main-area">
      <header class="topbar">
        <div>
          <p class="eyebrow">钉钉表格数据源</p>
          <h2>{{ route.path === '/dashboard' ? '汇总看板' : modules.find((m) => route.path.includes(m.key))?.title || '模块管理' }}</h2>
        </div>
        <div class="user-box">
          <span>{{ user?.displayName }}</span>
          <el-tag size="small">{{ user?.role }}</el-tag>
          <el-button :icon="SwitchButton" circle @click="logout" />
        </div>
      </header>
      <RouterView />
    </section>
  </div>
</template>
