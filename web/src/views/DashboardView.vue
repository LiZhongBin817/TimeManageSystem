<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { getSummary } from '../api';

const loading = ref(false);
const summary = ref<any>();

const totalInProgress = computed(() => {
  return (summary.value?.moduleStats || []).reduce((sum: number, item: any) => sum + item.developing + item.testing, 0);
});

async function load() {
  loading.value = true;
  try {
    summary.value = await getSummary();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '汇总数据加载失败');
  } finally {
    loading.value = false;
  }
}

function versionsText(items: string[]) {
  return items.length ? items.join('、') : '暂无';
}

function versionItems(items: string[]) {
  return items.length ? items : ['暂无'];
}

function rateStyle(rate: number) {
  return { width: `${Math.max(0, Math.min(100, rate || 0))}%` };
}

onMounted(load);
</script>

<template>
  <main v-loading="loading" class="content dashboard-page">
    <div class="dashboard-hero">
      <div>
        <p class="eyebrow">项目进度总览</p>
        <h1>汇总看板</h1>
        <span>当前日期：{{ summary?.currentDate || '-' }}</span>
      </div>
      <div class="toolbar">
        <el-tag :type="summary?.source === 'dingtalk' ? 'success' : 'warning'">
          {{ summary?.source === 'dingtalk' ? '钉钉实时数据' : '本地模拟数据' }}
        </el-tag>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </div>

    <section class="kpi-grid">
      <article class="kpi-card primary">
        <span>整体完成率</span>
        <strong>{{ summary?.overview?.overallRate || 0 }}%</strong>
        <div class="progress-track">
          <div class="progress-fill" :style="rateStyle(summary?.overview?.overallRate || 0)"></div>
        </div>
      </article>
      <article class="kpi-card">
        <span>总需求数</span>
        <strong>{{ summary?.overview?.totalRows || 0 }}</strong>
      </article>
      <article class="kpi-card">
        <span>已完成</span>
        <strong>{{ summary?.overview?.totalDone || 0 }}</strong>
      </article>
      <article class="kpi-card warning">
        <span>进行中</span>
        <strong>{{ totalInProgress }}</strong>
        <small>开发 {{ (summary?.moduleStats || []).reduce((sum: number, item: any) => sum + item.developing, 0) }} / 测试 {{ (summary?.moduleStats || []).reduce((sum: number, item: any) => sum + item.testing, 0) }}</small>
      </article>
    </section>

    <section class="module-card-grid">
      <article v-for="item in summary?.moduleStats || []" :key="item.key" class="module-card">
        <header>
          <div>
            <h3>{{ item.title }}</h3>
            <span>{{ item.done }} / {{ item.total }} 已完成</span>
          </div>
          <strong>{{ item.completionRate }}%</strong>
        </header>
        <div class="progress-track">
          <div class="progress-fill" :style="rateStyle(item.completionRate)"></div>
        </div>
        <div class="module-metrics">
          <div><span>需求数</span><strong>{{ item.total }}</strong></div>
          <div><span>完成</span><strong>{{ item.done }}</strong></div>
          <div><span>开发中</span><strong class="danger-cell">{{ item.developing }}</strong></div>
          <div><span>测试中</span><strong class="danger-cell">{{ item.testing }}</strong></div>
        </div>
        <div class="version-list">
          <div>
            <b>测试中</b>
            <span v-for="version in versionItems(item.testingVersions || [])" :key="`testing-${item.key}-${version}`" class="version-pill">{{ version }}</span>
          </div>
          <div>
            <b>开发中</b>
            <span v-for="version in versionItems(item.developingVersions || [])" :key="`developing-${item.key}-${version}`" class="version-pill">{{ version }}</span>
          </div>
        </div>
      </article>
    </section>

    <section class="dashboard-section">
      <div class="section-heading">
        <h2>分项目进度详情</h2>
        <span>按完成率和当前进行中版本快速定位风险点</span>
      </div>
      <div class="detail-list">
        <article v-for="item in summary?.moduleStats || []" :key="`${item.key}-detail`" class="detail-row">
          <div class="detail-title">
            <strong>{{ item.title }}</strong>
            <span>{{ item.completionRate }}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" :style="rateStyle(item.completionRate)"></div>
          </div>
          <div class="detail-progress">
            <span>测试中：{{ versionsText(item.testingVersions || []) }}</span>
            <span>开发中：{{ versionsText(item.developingVersions || []) }}</span>
          </div>
        </article>
      </div>
    </section>

    <section class="dashboard-section">
      <div class="section-heading">
        <h2>研发人员任务进展</h2>
        <span>横向查看每位研发在各模块的总数、完成数和未完成数</span>
      </div>
      <div class="dashboard-table-wrap">
        <table class="dashboard-table developer-table">
          <thead>
            <tr>
              <th rowspan="2">研发人员</th>
              <th v-for="item in summary?.moduleStats || []" :key="item.key" colspan="3">{{ item.title }}</th>
            </tr>
            <tr>
              <template v-for="item in summary?.moduleStats || []" :key="`${item.key}-sub`">
                <th>总数</th>
                <th>完成</th>
                <th>未完成</th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr v-for="developer in summary?.developerStats || []" :key="developer.name">
              <td class="strong-cell">{{ developer.name }}</td>
              <template v-for="module in developer.modules" :key="`${developer.name}-${module.title}`">
                <td>{{ module.total }}</td>
                <td>{{ module.done }}</td>
                <td class="danger-cell">{{ module.unfinished }}</td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>
