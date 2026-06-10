<!-- 已登录应用外壳：加载当前用户和模块，并渲染顶层导航。 -->
<script setup lang="ts">
import { DataAnalysis, List, Monitor, SwitchButton, Tools, UserFilled } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { clearToken, getMe, getModules } from '../api';
import type { ModuleConfig, User } from '../types';

const router = useRouter();
const route = useRoute();
const user = ref<User>();
const readableModules = ref<ModuleConfig[]>([]);
const now = ref(new Date());
let clockTimer: ReturnType<typeof setInterval> | undefined;

const canConfigure = computed(() => user.value?.role === 'admin' || user.value?.role === 'editor');
const hasProjectModules = computed(() => canConfigure.value || readableModules.value.some((item) => item.category === 'project'));
const hasStaff = computed(() => canConfigure.value || readableModules.value.some((item) => item.key === 'staff'));
const hasTodos = computed(() => readableModules.value.some((item) => item.key === 'todos'));
const active = computed(() => route.path);
const pageTitle = computed(() => {
  if (route.path.startsWith('/project-modules')) return '项目模块';
  if (route.path.startsWith('/modules/staff')) return '人员信息';
  if (route.path.startsWith('/modules/todos')) return '待办事项';
  if (route.path.startsWith('/settings')) return '系统配置';
  return '汇总看板';
});

const currentDateText = computed(() => formatBeijingPart(now.value, 'date'));
const currentTimeText = computed(() => formatBeijingPart(now.value, 'time'));

function formatBeijingPart(value: Date, part: 'date' | 'time') {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(value);
  const partMap = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  if (part === 'date') return `${partMap.year}-${partMap.month}-${partMap.day}`;
  return `${partMap.hour}:${partMap.minute}:${partMap.second}`;
}
// 一次性加载用户和模块元数据，使导航能反映当前权限。
async function boot() {
  try {
    user.value = await getMe();
    readableModules.value = await getModules();
  } catch {
    ElMessage.error('获取用户信息失败');
  }
}

function logout() {
  clearToken();
  router.push('/login');
}

onMounted(() => {
  boot();
  clockTimer = setInterval(() => {
    now.value = new Date();
  }, 1000);
});

onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
});

watch(
  () => route.fullPath,
  async () => {
    await nextTick();
    window.scrollTo({ top: 0, left: 0 });
  }
);
</script>

<template>
  <div class="app-layout">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">TMS</span>
        <span>任务管理系统</span>
      </div>
      <el-menu :default-active="active" router class="nav-menu">
        <el-menu-item index="/dashboard">
          <el-icon><DataAnalysis /></el-icon>
          <span>汇总看板</span>
        </el-menu-item>
        <el-menu-item v-if="hasProjectModules" index="/project-modules">
          <el-icon><Monitor /></el-icon>
          <span>项目模块</span>
        </el-menu-item>
        <el-menu-item v-if="hasStaff" index="/modules/staff">
          <el-icon><UserFilled /></el-icon>
          <span>人员信息</span>
        </el-menu-item>
        <el-menu-item v-if="hasTodos" index="/modules/todos">
          <el-icon><List /></el-icon>
          <span>待办事项</span>
        </el-menu-item>
        <el-menu-item v-if="canConfigure" index="/settings">
          <el-icon><Tools /></el-icon>
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
        <div id="topbar-actions" class="topbar-actions"></div>
        <div class="topbar-clock">
          <span>当前日期：{{ currentDateText }}</span>
          <span>当前时间：{{ currentTimeText }}</span>
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
