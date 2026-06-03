<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { setToken } from '../api';

const route = useRoute();
const router = useRouter();

onMounted(() => {
  const token = String(route.query.token || '');
  if (!token) {
    ElMessage.error('企业登录失败，请重新登录');
    router.replace('/login');
    return;
  }
  setToken(token);
  router.replace('/dashboard');
});
</script>

<template>
  <main class="login-page">
    <section class="login-panel">
      <p class="eyebrow">OAuth Callback</p>
      <h1>正在完成登录</h1>
    </section>
  </main>
</template>
