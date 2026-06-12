<!-- 登录页互动角色：根据表单焦点、密码可见性和登录结果切换状态。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type FocusedField = 'platform' | 'username' | 'password' | null;

const props = defineProps<{
  loginMode: 'oauth' | 'local';
  focusedField: FocusedField;
  passwordVisible: boolean;
  passwordLength: number;
  loading: boolean;
  errorMessage: string;
}>();

const pointer = ref({ x: 0, y: 0 });
const isShaking = ref(false);
let shakeTimer: number | undefined;

const stateClass = computed(() => ({
  'is-oauth': props.loginMode === 'oauth',
  'is-username': props.focusedField === 'username',
  'is-password': props.focusedField === 'password',
  'is-private': props.focusedField === 'password' && !props.passwordVisible,
  'is-visible-password': props.focusedField === 'password' && props.passwordVisible,
  'is-loading': props.loading,
  'is-error': Boolean(props.errorMessage),
  'is-shaking': isShaking.value
}));

const eyeStyle = computed(() => {
  if (props.loading) return {};
  const x = Math.max(-6, Math.min(6, pointer.value.x / 26));
  const y = Math.max(-4, Math.min(4, pointer.value.y / 32));
  return {
    transform: `translate(${x}px, ${y}px)`
  };
});

const panelTone = computed(() => {
  if (props.errorMessage) return 'RETRY';
  if (props.loading) return 'SYNC';
  if (props.focusedField === 'password' && !props.passwordVisible) return 'LOCK';
  if (props.focusedField === 'password' && props.passwordVisible) return 'VIEW';
  if (props.focusedField === 'username') return 'USER';
  return props.loginMode === 'oauth' ? 'SSO' : 'READY';
});

function handlePointerMove(event: PointerEvent) {
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  pointer.value = {
    x: event.clientX - centerX,
    y: event.clientY - centerY
  };
}

watch(() => props.errorMessage, (message) => {
  if (!message) return;
  isShaking.value = false;
  if (shakeTimer) window.clearTimeout(shakeTimer);
  window.requestAnimationFrame(() => {
    isShaking.value = true;
    shakeTimer = window.setTimeout(() => {
      isShaking.value = false;
    }, 620);
  });
});

onMounted(() => {
  window.addEventListener('pointermove', handlePointerMove);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', handlePointerMove);
  if (shakeTimer) window.clearTimeout(shakeTimer);
});
</script>

<template>
  <div class="login-mascot" :class="stateClass" aria-hidden="true">
    <div class="mascot-orbit mascot-orbit-one"></div>
    <div class="mascot-orbit mascot-orbit-two"></div>

    <div class="mascot-core mascot-core-main">
      <div class="mascot-antenna"></div>
      <div class="mascot-head">
        <div class="mascot-face">
          <span class="mascot-eye mascot-eye-left" :style="eyeStyle"></span>
          <span class="mascot-eye mascot-eye-right" :style="eyeStyle"></span>
          <span class="mascot-mouth"></span>
          <span class="mascot-hand mascot-hand-left"></span>
          <span class="mascot-hand mascot-hand-right"></span>
        </div>
      </div>
      <div class="mascot-body">
        <div class="mascot-panel">{{ panelTone }}</div>
        <div class="mascot-bars">
          <span v-for="index in 5" :key="index" :class="{ active: passwordLength >= index * 2 }"></span>
        </div>
      </div>
    </div>

    <div class="mascot-core mascot-core-side mascot-core-left">
      <div class="mascot-antenna"></div>
      <div class="mascot-head">
        <div class="mascot-face">
          <span class="mascot-eye mascot-eye-left" :style="eyeStyle"></span>
          <span class="mascot-eye mascot-eye-right" :style="eyeStyle"></span>
          <span class="mascot-mouth"></span>
          <span class="mascot-hand mascot-hand-left"></span>
          <span class="mascot-hand mascot-hand-right"></span>
        </div>
      </div>
      <div class="mascot-body">
        <div class="mascot-panel">SCAN</div>
        <div class="mascot-bars">
          <span v-for="index in 5" :key="index" :class="{ active: index <= 3 }"></span>
        </div>
      </div>
    </div>

    <div class="mascot-core mascot-core-side mascot-core-right">
      <div class="mascot-antenna"></div>
      <div class="mascot-head">
        <div class="mascot-face">
          <span class="mascot-eye mascot-eye-left" :style="eyeStyle"></span>
          <span class="mascot-eye mascot-eye-right" :style="eyeStyle"></span>
          <span class="mascot-mouth"></span>
          <span class="mascot-hand mascot-hand-left"></span>
          <span class="mascot-hand mascot-hand-right"></span>
        </div>
      </div>
      <div class="mascot-body">
        <div class="mascot-panel">AUTH</div>
        <div class="mascot-bars">
          <span v-for="index in 5" :key="index" :class="{ active: index <= 4 }"></span>
        </div>
      </div>
    </div>
  </div>
</template>
