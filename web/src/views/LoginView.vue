<script setup lang="ts">
import { Connection, Lock, User } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getDataSourceInstances, getDataSourcePlatforms, login, oauthStartUrl } from '../api';
import type { DataSourceInstance, DataSourcePlatform, PlatformKey } from '../types';

type LoginMode = 'oauth' | 'local';

const router = useRouter();
const route = useRoute();
const loading = ref(false);
const loadingSources = ref(false);
const platforms = ref<DataSourcePlatform[]>([]);
const instances = ref<DataSourceInstance[]>([]);
const loginMode = ref<LoginMode>('oauth');
const form = reactive({
  username: '',
  password: '',
  platform: 'dingtalk' as PlatformKey
});

const activeInstance = computed(() => instances.value.find((item) => item.enabled));
const hasDataSource = computed(() => Boolean(activeInstance.value));
const currentProviderLabel = computed(() => (form.platform === 'feishu' ? '飞书登录' : '钉钉登录'));
const loginModeOptions = computed(() => {
  return [
    { label: currentProviderLabel.value, value: 'oauth' },
    { label: '账号密码登录', value: 'local' }
  ];
});

async function loadPlatforms() {
  platforms.value = await getDataSourcePlatforms();
}

async function loadInstances() {
  loadingSources.value = true;
  try {
    instances.value = await getDataSourceInstances(form.platform);
    loginMode.value = 'oauth';
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '数据源实例加载失败');
  } finally {
    loadingSources.value = false;
  }
}

function startOAuthLogin() {
  if (!hasDataSource.value) {
    ElMessage.warning('当前平台未配置可用数据源，请先到系统配置中绑定');
    return;
  }
  location.href = oauthStartUrl(form.platform);
}

async function submitLocalLogin() {
  if (!hasDataSource.value) {
    ElMessage.warning('当前平台未配置可用数据源，请先到系统配置中绑定');
    return;
  }
  if (false) {
    ElMessage.warning('当前平台未授权账号密码登录');
    return;
  }
  loading.value = true;
  try {
    await login(form.username, form.password, form.platform);
    ElMessage.success('登录成功');
    router.push('/dashboard');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '登录失败');
  } finally {
    loading.value = false;
  }
}

function submitLogin() {
  if (loginMode.value === 'local') {
    submitLocalLogin();
    return;
  }
  startOAuthLogin();
}

watch(() => form.platform, loadInstances);
onMounted(async () => {
  const oauthError = String(route.query.oauthError || '');
  if (oauthError) ElMessage.error(oauthError);
  try {
    await loadPlatforms();
    await loadInstances();
  } catch {
    platforms.value = [
      { key: 'dingtalk', label: '钉钉' },
      { key: 'feishu', label: '飞书' }
    ];
  }
});
</script>

<template>
  <main class="login-page">
    <section class="login-panel">
      <div>
        <p class="eyebrow">Task Management System</p>
        <h1>任务管理系统</h1>
      </div>

      <el-form class="login-form" @submit.prevent="submitLogin">
        <el-form-item>
          <el-select v-model="form.platform" size="large" class="full-field" placeholder="企业平台" :prefix-icon="Connection">
            <el-option v-for="item in platforms" :key="item.key" :label="item.label" :value="item.key" />
          </el-select>
        </el-form-item>

        <el-segmented v-if="loginModeOptions.length > 1" v-model="loginMode" class="login-mode-switch" :options="loginModeOptions" />

        <template v-if="loginMode === 'local'">
          <el-form-item>
            <el-input v-model="form.username" size="large" placeholder="用户名" :prefix-icon="User" />
          </el-form-item>
          <el-form-item>
            <el-input v-model="form.password" size="large" placeholder="密码" type="password" :prefix-icon="Lock" show-password />
          </el-form-item>
        </template>

        <el-button class="full-button" size="large" type="primary" :loading="loading || loadingSources" @click="submitLogin">
          {{ loginMode === 'local' ? '账号密码登录' : currentProviderLabel }}
        </el-button>
      </el-form>
    </section>
  </main>
</template>
