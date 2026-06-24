<!-- 看板页面：展示项目进度、进行中排期、研发统计和通知操作。 -->
<script setup lang="ts">
import { Bell, Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { getMe, getSummary, pushDashboardNotification } from '../api';
import type { User } from '../types';

interface ScheduleItem {
  id: string;
  moduleTitle: string;
  status: 'developing' | 'testing';
  name: string;
  branchName: string;
  content: string;
  zentaoLink?: string;
  developer: string;
  productOwner: string;
  tester: string;
  plannedTestAt?: string;
  actualTestAt?: string;
  launchAt?: string;
}

interface DeveloperModuleStat {
  title: string;
  total: number;
  done: number;
  unfinished: number;
}

interface DeveloperStat {
  name: string;
  modules: DeveloperModuleStat[];
}

const loading = ref(false);
const pushing = ref(false);
const summary = ref<any>();
const user = ref<User>();
const dashboardActionsEl = ref<HTMLElement | null>(null);

const developingItems = computed<ScheduleItem[]>(() => summary.value?.inProgress?.developingItems || []);
const testingItems = computed<ScheduleItem[]>(() => summary.value?.inProgress?.testingItems || []);
const inProgressTotal = computed(() => developingItems.value.length + testingItems.value.length);
const totalModules = computed(() => summary.value?.moduleStats?.length || 0);
const cacheInfo = computed(() => summary.value?.cache || {});
// 把按模块统计的研发数据压平成总量和分段条形数据。
const developerStats = computed(() => {
  const moduleStats = summary.value?.moduleStats || [];
  return ((summary.value?.developerStats || []) as DeveloperStat[])
    .map((developer) => {
      const sourceModules = developer.modules || [];
      const modules: DeveloperModuleStat[] = moduleStats.map((module: any): DeveloperModuleStat => {
        return sourceModules.find((item) => item.title === module.title) || {
          title: module.title,
          total: 0,
          done: 0,
          unfinished: 0
        };
      });
      const total = modules.reduce((sum, item) => sum + Number(item.total || 0), 0);
      const done = modules.reduce((sum, item) => sum + Number(item.done || 0), 0);
      const unfinished = modules.reduce((sum, item) => sum + Number(item.unfinished || 0), 0);
      return { ...developer, modules, total, done, unfinished };
    })
    .filter((developer) => developer.total > 0)
    .sort((a, b) => b.unfinished - a.unfinished || b.total - a.total);
});

const maxDeveloperTotal = computed(() => Math.max(1, ...developerStats.value.map((item) => item.total)));
// 刷新看板数据；失败信息在页面内展示，应用外壳仍可继续使用。
async function load() {
  loading.value = true;
  try {
    const [nextUser, nextSummary] = await Promise.all([
      user.value ? Promise.resolve(user.value) : getMe(),
      getSummary()
    ]);
    user.value = nextUser;
    summary.value = nextSummary;
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '汇总数据加载失败');
  } finally {
    loading.value = false;
  }
}

async function pushToCurrentPlatform() {
  pushing.value = true;
  try {
    const result = await pushDashboardNotification();
    const successChannels = result.results
      .filter((item) => item.status === 'success')
      .map((item) => item.channel === 'feishu_robot' ? '飞书' : '钉钉');
    const platformText = successChannels.length ? successChannels.join('、') : '启用平台';
    ElMessage.success(`已推送到${platformText}：开发中 ${result.summary.developing}，测试中 ${result.summary.testing}`);
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '推送失败');
  } finally {
    pushing.value = false;
  }
}

function dateText(value?: string) {
  const text = String(value || '').trim();
  return text && text !== '-' ? text : '未填';
}

function rateStyle(rate: number) {
  return { width: `${Math.max(0, Math.min(100, rate || 0))}%` };
}

function formatBeijingTime(value?: string) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return text;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second}`;
}

function statusType(status: ScheduleItem['status']) {
  return status === 'testing' ? 'warning' : 'primary';
}

function developerBarStyle(value: number) {
  return { width: `${Math.max(4, Math.round((value / maxDeveloperTotal.value) * 100))}%` };
}

function segmentStyle(value: number, total: number) {
  return { flexBasis: `${total ? Math.max(4, (value / total) * 100) : 0}%` };
}

async function mountTopbarActions() {
  await nextTick();
  const target = document.getElementById('topbar-actions');
  const actions = dashboardActionsEl.value;
  if (!target || !actions) return;
  if (actions.parentElement !== target) target.replaceChildren(actions);
}

onMounted(() => {
  load();
  mountTopbarActions();
});

onBeforeUnmount(() => {
  const target = document.getElementById('topbar-actions');
  if (target && dashboardActionsEl.value && target.contains(dashboardActionsEl.value)) {
    target.replaceChildren();
  }
});
</script>

<template>
  <main v-loading="loading" class="content dashboard-page">
    <div ref="dashboardActionsEl" class="dashboard-topbar-actions">


        <el-tag :type="summary?.source === 'feishu' ? 'primary' : 'success'">
          {{ summary?.source === 'feishu' ? '飞书实时数据' : '钉钉实时数据' }}
        </el-tag>
        <el-tag v-if="cacheInfo.updatedAt" :type="cacheInfo.stale ? 'warning' : 'success'">
          缓存{{ cacheInfo.stale ? '可能过期' : '正常' }} · 北京时间 {{ formatBeijingTime(cacheInfo.updatedAt) }}
        </el-tag>
        <el-button v-if="user" type="primary" :icon="Bell" :loading="pushing" @click="pushToCurrentPlatform">
          推送汇总
        </el-button>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
    </div>
    <section class="compact-kpi-grid">
      <article>
        <span>进行中总数</span>
        <strong>{{ inProgressTotal }}</strong>
        <small>开发 {{ developingItems.length }} / 测试 {{ testingItems.length }}</small>
      </article>
      <article>
        <span>项目模块</span>
        <strong>{{ totalModules }}</strong>
        <small>当前启用模块</small>
      </article>
      <article>
        <span>总需求数</span>
        <strong>{{ summary?.overview?.totalRows || 0 }}</strong>
        <small>已完成 {{ summary?.overview?.totalDone || 0 }}</small>
      </article>
      <article>
        <span>整体完成率</span>
        <strong>{{ summary?.overview?.overallRate || 0 }}%</strong>
        <div class="progress-track compact">
          <div class="progress-fill" :style="rateStyle(summary?.overview?.overallRate || 0)"></div>
        </div>
      </article>
    </section>

    <section class="dashboard-focus-grid">
      <article class="focus-card developing">
        <header>
          <div>
            <span>开发中汇总</span>
            <strong>{{ developingItems.length }}</strong>
          </div>
          <el-tag type="primary">待提测</el-tag>
        </header>
        <div class="schedule-list">
          <div v-if="!developingItems.length" class="empty-line">暂无开发中项目</div>
          <article v-for="item in developingItems" :key="`developing-${item.id}`" class="schedule-item">
            <div class="schedule-main">
              <el-tag :type="statusType(item.status)" size="small">开发中</el-tag>
              <strong>{{ item.name }}</strong>
              <span>{{ item.moduleTitle }}</span>
            </div>
            <div class="schedule-meta">
              <span>研发：{{ item.developer || '-' }}</span>
              <span>测试：{{ item.tester || '-' }}</span>
              <span>产品：{{ item.productOwner || '-' }}</span>
            </div>
            <div class="schedule-dates">
              <div><span>计划提测</span><b>{{ dateText(item.plannedTestAt) }}</b></div>
              <div><span>实际提测</span><b>{{ dateText(item.actualTestAt) }}</b></div>
              <div><span>上线时间</span><b>{{ dateText(item.launchAt) }}</b></div>
            </div>
          </article>
        </div>
      </article>

      <article class="focus-card testing">
        <header>
          <div>
            <span>测试中汇总</span>
            <strong>{{ testingItems.length }}</strong>
          </div>
          <el-tag type="warning">待上线</el-tag>
        </header>
        <div class="schedule-list">
          <div v-if="!testingItems.length" class="empty-line">暂无测试中项目</div>
          <article v-for="item in testingItems" :key="`testing-${item.id}`" class="schedule-item">
            <div class="schedule-main">
              <el-tag :type="statusType(item.status)" size="small">测试中</el-tag>
              <strong>{{ item.name }}</strong>
              <span>{{ item.moduleTitle }}</span>
            </div>
            <div class="schedule-meta">
              <span>研发：{{ item.developer || '-' }}</span>
              <span>测试：{{ item.tester || '-' }}</span>
              <span>产品：{{ item.productOwner || '-' }}</span>
            </div>
            <div class="schedule-dates">
              <div><span>计划提测</span><b>{{ dateText(item.plannedTestAt) }}</b></div>
              <div><span>实际提测</span><b>{{ dateText(item.actualTestAt) }}</b></div>
              <div><span>上线时间</span><b>{{ dateText(item.launchAt) }}</b></div>
            </div>
          </article>
        </div>
      </article>
    </section>

    <section class="dashboard-section">
      <div class="section-heading">
        <h2>人员分配统计</h2>
        <span>按研发人员统计任务总量、已完成和未完成</span>
      </div>
      <div class="developer-chart">
        <article v-for="developer in developerStats" :key="developer.name" class="developer-bar-row">
          <div class="developer-name">
            <strong>{{ developer.name }}</strong>
            <span>{{ developer.total }} 项</span>
          </div>
          <div class="developer-bar-wrap">
            <div class="developer-total-bar" :style="developerBarStyle(developer.total)">
              <div class="developer-segment done" :style="segmentStyle(developer.done, developer.total)"></div>
              <div class="developer-segment unfinished" :style="segmentStyle(developer.unfinished, developer.total)"></div>
            </div>
          </div>
          <div class="developer-counts">
            <span class="done-dot">已完成 {{ developer.done }}</span>
            <span class="unfinished-dot">未完成 {{ developer.unfinished }}</span>
          </div>
        </article>
        <div v-if="!developerStats.length" class="empty-line">暂无人员分配数据</div>
      </div>
    </section>

    <section class="dashboard-section">
      <div class="section-heading">
        <h2>模块进行中分布</h2>
        <span>用于确认每个模块当前开发和测试压力</span>
      </div>
      <div class="module-status-grid">
        <article v-for="item in summary?.moduleStats || []" :key="item.key" class="module-status-card">
          <header>
            <strong>{{ item.title }}</strong>
            <span>{{ item.completionRate }}%</span>
          </header>
          <div class="progress-track compact">
            <div class="progress-fill" :style="rateStyle(item.completionRate)"></div>
          </div>
          <div class="module-status-metrics">
            <div><span>开发中</span><b>{{ item.developing }}</b></div>
            <div><span>测试中</span><b>{{ item.testing }}</b></div>
            <div><span>已完成</span><b>{{ item.done }}/{{ item.total }}</b></div>
          </div>
        </article>
      </div>
    </section>

    <section class="dashboard-section">
      <div class="section-heading">
        <h2>研发人员任务进展</h2>
        <span>按模块拆分每位研发的总数、完成数和未完成数</span>
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
            <tr v-for="developer in developerStats" :key="`${developer.name}-table`">
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
