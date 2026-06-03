<script setup lang="ts">
import { Connection, Lock, User } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getDataSourceInstances, getDataSourcePlatforms, login } from '../api';
import type { DataSourceInstance, DataSourcePlatform, PlatformKey } from '../types';

const router = useRouter();
const loading = ref(false);
const loadingSources = ref(false);
const platforms = ref<DataSourcePlatform[]>([]);
const instances = ref<DataSourceInstance[]>([]);
const form = reactive({
  username: 'admin',
  password: 'admin123',
  platform: 'dingtalk' as PlatformKey,
  dataSourceId: undefined as number | undefined
});

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

async function submit() {
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
        <p class="eyebrow">Time Management System</p>
        <h1>时间管理系统</h1>
      </div>
      <el-form class="login-form" @submit.prevent="submit">
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
        <el-form-item>
          <el-input v-model="form.username" size="large" placeholder="用户名" :prefix-icon="User" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" size="large" placeholder="密码" type="password" :prefix-icon="Lock" show-password />
        </el-form-item>
        <el-button class="full-button" size="large" type="primary" :loading="loading" @click="submit">登录</el-button>
      </el-form>
      <div class="login-hints">
        <span>admin / admin123</span>
        <span>editor / editor123</span>
        <span>viewer / viewer123</span>
      </div>
    </section>
  </main>
</template>
