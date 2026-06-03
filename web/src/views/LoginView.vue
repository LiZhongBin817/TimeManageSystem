<script setup lang="ts">
import { Connection, Lock, User } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getDataSourceInstances, getDataSourcePlatforms, getLoginConfig, login, oauthStartUrl } from '../api';
import type { DataSourceInstance, DataSourcePlatform, PlatformKey } from '../types';

const router = useRouter();
const route = useRoute();
const loading = ref(false);
const loadingSources = ref(false);
const platforms = ref<DataSourcePlatform[]>([]);
const instances = ref<DataSourceInstance[]>([]);
const localLoginOpen = ref(false);
const localLoginEnabled = ref(true);
const form = reactive({
  username: 'admin',
  password: 'admin123',
  platform: 'dingtalk' as PlatformKey,
  dataSourceId: undefined as number | undefined
});

const currentProviderLabel = computed(() => (form.platform === 'feishu' ? '飞书登录' : '钉钉登录'));

async function loadPlatforms() {
  platforms.value = await getDataSourcePlatforms();
}

async function loadInstances() {
  loadingSources.value = true;
  try {
    instances.value = await getDataSourceInstances(form.platform);
    form.dataSourceId = instances.value[0]?.id;
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '数据源实例加载失败');
  } finally {
    loadingSources.value = false;
  }
}

function startOAuthLogin() {
  if (!form.dataSourceId) {
    ElMessage.warning('请先选择数据源实例');
    return;
  }
  location.href = oauthStartUrl(form.platform, form.dataSourceId);
}

async function submitLocalLogin() {
  if (!form.dataSourceId) {
    ElMessage.warning('请先选择数据源实例');
    return;
  }
  loading.value = true;
  try {
    await login(form.username, form.password, form.dataSourceId);
    ElMessage.success('登录成功');
    router.push('/dashboard');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '登录失败');
  } finally {
    loading.value = false;
  }
}

watch(() => form.platform, loadInstances);

onMounted(async () => {
  const oauthError = String(route.query.oauthError || '');
  if (oauthError) ElMessage.error(oauthError);
  try {
    const [loginConfig] = await Promise.all([getLoginConfig(), loadPlatforms()]);
    localLoginEnabled.value = loginConfig.localLoginEnabled;
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
      <el-form class="login-form" @submit.prevent="submitLocalLogin">
        <el-form-item>
          <el-select v-model="form.platform" size="large" class="full-field" placeholder="平台类型" :prefix-icon="Connection">
            <el-option v-for="item in platforms" :key="item.key" :label="item.label" :value="item.key" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-select v-model="form.dataSourceId" size="large" class="full-field" placeholder="数据源实例" :loading="loadingSources" filterable>
            <el-option v-for="item in instances" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-button class="full-button" size="large" type="primary" @click="startOAuthLogin">{{ currentProviderLabel }}</el-button>

        <el-collapse v-if="localLoginEnabled" v-model="localLoginOpen" class="local-login-collapse">
          <el-collapse-item title="管理员备用登录" name="local">
            <el-form-item>
              <el-input v-model="form.username" size="large" placeholder="用户名" :prefix-icon="User" />
            </el-form-item>
            <el-form-item>
              <el-input v-model="form.password" size="large" placeholder="密码" type="password" :prefix-icon="Lock" show-password />
            </el-form-item>
            <el-button class="full-button" size="large" type="default" :loading="loading" @click="submitLocalLogin">账号密码登录</el-button>
            <div class="login-hints">
              <span>admin / admin123</span>
              <span>editor / editor123</span>
              <span>viewer / viewer123</span>
            </div>
          </el-collapse-item>
        </el-collapse>
      </el-form>
    </section>
  </main>
</template>
