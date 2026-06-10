<!-- 人员分配页面：管理所选数据源下产品、测试、研发人员列表。 -->
<script setup lang="ts">
import { Delete, Plus, Refresh, Upload, UserFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  getDataSourceInstances,
  getMe,
  getStaffMembers,
  initializeStaffAssignments,
  saveStaffAssignments,
  syncEnterpriseMembers
} from '../api';
import type { DataSourceInstance, StaffMember, User } from '../types';

const loading = ref(false);
const saving = ref(false);
const syncing = ref(false);
const initializing = ref(false);
const user = ref<User>();
const sources = ref<DataSourceInstance[]>([]);
const members = ref<StaffMember[]>([]);
const templateDataSourceId = ref<number>();
const staffTopbarActionsEl = ref<HTMLElement | null>(null);

const isAdmin = computed(() => user.value?.role === 'admin');
const currentSourceName = computed(() => user.value?.dataSourceName || '-');
const templateOptions = computed(() =>
  sources.value
    .filter((item) => item.id && item.id !== user.value?.dataSourceId)
    .map((item) => ({ label: item.name, value: item.id! }))
);
const roleSummary = computed(() => ({
  product: members.value.filter((item) => item.product).length,
  tester: members.value.filter((item) => item.tester).length,
  developer: members.value.filter((item) => item.developer).length
}));

function normalizeMembers(rows: StaffMember[]) {
  return rows.map((row, index) => ({
    ...row,
    key: row.key || `${row.userId ? 'user' : 'manual'}:${row.userId || row.displayName || index}`,
    displayName: row.displayName || '',
    source: row.source || (row.userId ? 'enterprise' : 'manual'),
    product: Boolean(row.product),
    tester: Boolean(row.tester),
    developer: Boolean(row.developer),
    enabled: row.enabled !== false,
    sortOrder: row.sortOrder ?? index * 10
  }));
}

async function load() {
  loading.value = true;
  try {
    const [currentUser, sourceList, staff] = await Promise.all([
      getMe(),
      getDataSourceInstances(undefined, true),
      getStaffMembers()
    ]);
    user.value = currentUser;
    sources.value = sourceList;
    members.value = normalizeMembers(staff.members);
    templateDataSourceId.value = templateOptions.value[0]?.value;
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '人员信息加载失败');
  } finally {
    loading.value = false;
  }
}

function addManualMember() {
  members.value.push({
    key: `manual:${Date.now()}`,
    userId: null,
    username: '',
    displayName: '',
    source: 'manual',
    product: false,
    tester: false,
    developer: false,
    enabled: true,
    sortOrder: members.value.length * 10
  });
}

async function removeManualMember(row: StaffMember) {
  try {
    await ElMessageBox.confirm(`确认移除外部人员「${row.displayName || '未命名'}」？`, '移除确认', { type: 'warning' });
    members.value = members.value.filter((item) => item.key !== row.key);
  } catch {
    // 用户取消
  }
}
// 保存整份人员分配列表，因为角色勾选会在服务端展开为按角色存储的记录。
async function submit() {
  saving.value = true;
  try {
    const payload = members.value
      .map((item, index) => ({
        ...item,
        displayName: String(item.displayName || '').trim(),
        sortOrder: index * 10
      }))
      .filter((item) => item.displayName && (item.product || item.tester || item.developer));
    const result = await saveStaffAssignments(payload);
    members.value = normalizeMembers(result.members);
    ElMessage.success('人员分组已保存');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '人员分组保存失败');
  } finally {
    saving.value = false;
  }
}

async function syncMembers() {
  syncing.value = true;
  try {
    const result = await syncEnterpriseMembers();
    ElMessage.success(`企业成员同步完成：新增 ${result.created} 人，更新 ${result.updated} 人`);
    await load();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '企业成员同步失败');
  } finally {
    syncing.value = false;
  }
}

async function initializeFromTemplate() {
  if (!templateDataSourceId.value) {
    ElMessage.warning('请选择人员模板来源');
    return;
  }
  initializing.value = true;
  try {
    await ElMessageBox.confirm('会用模板数据源的人员分组覆盖当前数据源的人员配置，确认继续？', '初始化人员配置', { type: 'warning' });
    const result = await initializeStaffAssignments(templateDataSourceId.value);
    members.value = normalizeMembers(result.members);
    ElMessage.success(`人员配置初始化完成，复制 ${result.copied || 0} 条角色记录`);
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '初始化人员配置失败');
  } finally {
    initializing.value = false;
  }
}

async function mountStaffTopbarActions() {
  await nextTick();
  const target = document.getElementById('topbar-actions');
  const actions = staffTopbarActionsEl.value;
  if (!target || !actions) return;
  if (actions.parentElement !== target) target.replaceChildren(actions);
}

onMounted(() => {
  load();
  mountStaffTopbarActions();
});

onBeforeUnmount(() => {
  const target = document.getElementById('topbar-actions');
  if (target && staffTopbarActionsEl.value && target.contains(staffTopbarActionsEl.value)) {
    target.replaceChildren();
  }
});
</script>

<template>
  <main v-loading="loading" class="content staff-page">
    <div ref="staffTopbarActionsEl" class="staff-topbar-actions">
      <el-button :icon="Refresh" @click="load">刷新</el-button>
    </div>

    <section class="staff-header panel">
      <div>
        <p class="eyebrow">本地人员分组</p>
        <h2>人员信息</h2>
        <span>当前数据源：{{ currentSourceName }}</span>
      </div>
      <div class="staff-summary">
        <article>
          <span>产品人员</span>
          <strong>{{ roleSummary.product }}</strong>
        </article>
        <article>
          <span>测试人员</span>
          <strong>{{ roleSummary.tester }}</strong>
        </article>
        <article>
          <span>研发人员</span>
          <strong>{{ roleSummary.developer }}</strong>
        </article>
      </div>
    </section>

    <section v-if="isAdmin" class="filter-panel staff-actions">
        <el-button type="primary" :icon="Upload" :loading="syncing" @click="syncMembers">同步企业成员</el-button>
        <el-select v-model="templateDataSourceId" class="staff-template-select" placeholder="人员模板来源" clearable filterable>
          <el-option v-for="item in templateOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-button :loading="initializing" @click="initializeFromTemplate">初始化人员配置</el-button>
        <el-button :icon="Plus" @click="addManualMember">新增外部人员</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存人员分组</el-button>
    </section>

    <el-alert
      v-if="!isAdmin"
      class="form-alert"
      type="info"
      :closable="false"
      title="人员信息由管理员维护；项目模块里的产品、测试、研发人员下拉来自当前数据源的本地人员分组。"
    />

    <section class="panel">
      <el-table :data="members" height="calc(100vh - 390px)" stripe>
        <el-table-column label="显示名称" min-width="180">
          <template #default="{ row }">
            <el-input v-if="isAdmin && row.source === 'manual'" v-model="row.displayName" placeholder="外部人员姓名" />
            <span v-else>{{ row.displayName || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="username" label="登录标识" min-width="220">
          <template #default="{ row }">{{ row.username || '-' }}</template>
        </el-table-column>
        <el-table-column label="来源" width="120">
          <template #default="{ row }">
            <el-tag :type="row.source === 'manual' ? 'warning' : 'success'">
              <el-icon><UserFilled /></el-icon>
              {{ row.source === 'manual' ? '外部人员' : '企业成员' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="产品人员" width="120" align="center">
          <template #default="{ row }"><el-checkbox v-model="row.product" :disabled="!isAdmin" /></template>
        </el-table-column>
        <el-table-column label="测试人员" width="120" align="center">
          <template #default="{ row }"><el-checkbox v-model="row.tester" :disabled="!isAdmin" /></template>
        </el-table-column>
        <el-table-column label="研发人员" width="120" align="center">
          <template #default="{ row }"><el-checkbox v-model="row.developer" :disabled="!isAdmin" /></template>
        </el-table-column>
        <el-table-column v-if="isAdmin" label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.source === 'manual'"
              :icon="Delete"
              circle
              type="danger"
              @click="removeManualMember(row)"
            />
          </template>
        </el-table-column>
      </el-table>
    </section>
  </main>
</template>
