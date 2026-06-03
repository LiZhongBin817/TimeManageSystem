<script setup lang="ts">
import { Lock, User } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { login } from '../api';

const router = useRouter();
const loading = ref(false);
const form = reactive({ username: 'admin', password: 'admin123' });

async function submit() {
  loading.value = true;
  try {
    await login(form.username, form.password);
    ElMessage.success('登录成功');
    router.push('/dashboard');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '登录失败');
  } finally {
    loading.value = false;
  }
}
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
