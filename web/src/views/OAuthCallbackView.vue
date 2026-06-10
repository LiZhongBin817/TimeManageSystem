<!-- OAuth 回调桥接页：保存签发的 token，或在平台错误时返回登录页。 -->
<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { setToken } from '../api';

const route = useRoute();
const router = useRouter();
// 后端处理平台回调后，会携带 JWT token 或错误信息重定向到这里。
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
