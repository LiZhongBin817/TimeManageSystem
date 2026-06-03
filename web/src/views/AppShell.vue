<script setup lang="ts">
import { DataAnalysis, Grid, List, Monitor, Setting, SwitchButton, UserFilled } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { clearToken, getMe } from '../api';
import type { User } from '../types';

const router = useRouter();
const route = useRoute();
const user = ref<User>();

const canConfigure = computed(() => user.value?.role === 'admin' || user.value?.role === 'editor');
const active = computed(() => route.path);
const pageTitle = computed(() => {
  if (route.path.startsWith('/project-modules')) return '项目模块';
  if (route.path.startsWith('/modules/staff')) return '人员信息';
  if (route.path.startsWith('/modules/todos')) return '待办事项';
  if (route.path.startsWith('/settings')) return '系统配置';
  return '汇总看板';
});

async function boot() {
  try {
    user.value = await getMe();
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
        <span>任务管理系统</span>
      </div>
      <el-menu :default-active="active" router class="nav-menu">
        <el-menu-item index="/dashboard">
          <el-icon><DataAnalysis /></el-icon>
          <span>汇总看板</span>
        </el-menu-item>
        <el-menu-item index="/project-modules">
          <el-icon><Monitor /></el-icon>
          <span>项目模块</span>
        </el-menu-item>
        <el-menu-item index="/modules/staff">
          <el-icon><UserFilled /></el-icon>
          <span>人员信息</span>
        </el-menu-item>
        <el-menu-item index="/modules/todos">
          <el-icon><List /></el-icon>
          <span>待办事项</span>
        </el-menu-item>
        <el-menu-item v-if="canConfigure" index="/settings">
          <el-icon><Setting /></el-icon>
          <span>系统配置</span>
        </el-menu-item>
      </el-menu>
    </aside>
    <section class="main-area">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ user?.dataSourceName || '数据源未选择' }}</p>
          <h2>{{ pageTitle }}</h2>
        </div>
        <div class="user-box">
          <span>{{ user?.displayName }}</span>
          <el-tag size="small">{{ user?.role }}</el-tag>
          <el-tag size="small" type="info">{{ user?.platform === 'feishu' ? '飞书' : '钉钉' }}</el-tag>
          <el-tag v-if="user?.provider" size="small" type="success">{{ user.provider === 'local' ? '本地' : '企业登录' }}</el-tag>
          <el-button :icon="SwitchButton" circle @click="logout" />
        </div>
      </header>
      <RouterView />
    </section>
  </div>
</template>
