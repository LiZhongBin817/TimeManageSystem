<script setup lang="ts">
import { Delete, Edit, Plus, Refresh, Search } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  createProjectRow,
  deleteProjectRow,
  getMe,
  getProjectModules,
  getProjectRows,
  getStaffOptions,
  updateProjectRow
} from '../api';
import type { ModuleConfig, ModuleField, SheetRow, User } from '../types';

const loading = ref(false);
const modules = ref<ModuleConfig[]>([]);
const selectedKey = ref('');
const moduleConfig = ref<ModuleConfig>();
const canCreate = ref(false);
const canUpdate = ref(false);
const canDelete = ref(false);
const user = ref<User>();
const rows = ref<SheetRow[]>([]);
const keyword = ref('');
const filters = reactive({
  content: '',
  isCompleted: '',
  plannedTestAt: [] as string[],
  actualTestAt: [] as string[],
  launchAt: [] as string[],
  developer: '',
  productOwner: '',
  tester: ''
});
const dialogOpen = ref(false);
const editingRow = ref<SheetRow | null>(null);
const form = reactive<Record<string, string | number>>({});
const staffOptions = ref({ product: [] as string[], tester: [] as string[], developer: [] as string[] });
const isRestrictedUser = computed(() => user.value?.role !== 'admin');
const suppressSelectionWatch = ref(false);

const filteredRows = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  return rows.value.filter((row) => {
    if (q && !Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(q))) return false;
    if (filters.content.trim() && !String(row.content ?? '').toLowerCase().includes(filters.content.trim().toLowerCase())) return false;
    if (filters.isCompleted && String(row.isCompleted ?? '').trim() !== filters.isCompleted) return false;
    if (!matchDateRange(row.plannedTestAt, filters.plannedTestAt)) return false;
    if (!matchDateRange(row.actualTestAt, filters.actualTestAt)) return false;
    if (!matchDateRange(row.launchAt, filters.launchAt)) return false;
    if (filters.developer && String(row.developer ?? '').trim() !== filters.developer) return false;
    if (filters.productOwner && String(row.productOwner ?? '').trim() !== filters.productOwner) return false;
    if (filters.tester && String(row.tester ?? '').trim() !== filters.tester) return false;
    return true;
  });
});

const editableFields = computed(() => (moduleConfig.value?.fields || []).filter((field) => !isFormHidden(field)));

function isFormulaField(field: ModuleField) {
  return field.formula || field.type === 'formula' || field.key === 'isCompleted' || field.key === 'name';
}

function isFormHidden(field: ModuleField) {
  return field.hidden || field.type === 'hidden' || isFormulaField(field) || field.key === 'sequence';
}

function hasField(key: string) {
  return Boolean(moduleConfig.value?.fields.some((field) => field.key === key));
}

function fieldOptions(field: ModuleField) {
  if (field.type !== 'staff' || !field.staffRole) return [];
  return staffOptions.value[field.staffRole];
}

function matchDateRange(value: unknown, range: string[]) {
  if (!range?.length || range.length !== 2) return true;
  const text = String(value ?? '').trim();
  if (!text || text === '-') return false;
  return text >= range[0] && text <= range[1];
}

function clearFilters() {
  keyword.value = '';
  filters.content = '';
  filters.isCompleted = '';
  filters.plannedTestAt = [];
  filters.actualTestAt = [];
  filters.launchAt = [];
  filters.developer = '';
  filters.productOwner = '';
  filters.tester = '';
}

function isCompletedRow(row: SheetRow) {
  return ['是', '已完成', '完成', 'true'].includes(String(row.isCompleted ?? '').trim().toLowerCase());
}

async function loadModules() {
  modules.value = await getProjectModules();
  if (!selectedKey.value && modules.value.length) selectedKey.value = modules.value[0].key;
}

async function loadStaffOptions() {
  try {
    staffOptions.value = await getStaffOptions();
  } catch {
    staffOptions.value = { product: [], tester: [], developer: [] };
  }
}

async function loadRows() {
  if (!selectedKey.value) return;
  moduleConfig.value = modules.value.find((item) => item.key === selectedKey.value) || moduleConfig.value;
  loading.value = true;
  try {
    const data = await getProjectRows(selectedKey.value);
    moduleConfig.value = data.module;
    canCreate.value = data.canCreate;
    canUpdate.value = data.canUpdate;
    canDelete.value = data.canDelete;
    rows.value = data.rows;
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '数据加载失败');
  } finally {
    loading.value = false;
  }
}

async function refreshAll() {
  loading.value = true;
  try {
    if (!user.value) user.value = await getMe();
    suppressSelectionWatch.value = true;
    await loadModules();
    suppressSelectionWatch.value = false;
    await loadRows();
    if (canCreate.value || canUpdate.value) loadStaffOptions();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '模块加载失败');
  } finally {
    suppressSelectionWatch.value = false;
    loading.value = false;
  }
}

function openCreate() {
  editingRow.value = null;
  resetForm();
  if (moduleConfig.value?.fields.some((field) => field.key === 'sequence')) {
    const maxSequence = rows.value.reduce((max, row) => Math.max(max, Number(row.sequence) || 0), 0);
    form.sequence = maxSequence + 1;
  }
  if (isRestrictedUser.value && hasField('developer')) form.developer = user.value?.displayName || '';
  dialogOpen.value = true;
}

function openEdit(row: SheetRow) {
  if (isCompletedRow(row)) {
    ElMessage.warning('已完成的数据不能编辑');
    return;
  }
  editingRow.value = row;
  resetForm(row);
  dialogOpen.value = true;
}

function resetForm(row?: SheetRow) {
  for (const field of moduleConfig.value?.fields || []) {
    form[field.key] = (row?.[field.key] as string | number) ?? '';
  }
}

function buildPayload() {
  if (!moduleConfig.value) return {};
  return Object.fromEntries(
    moduleConfig.value.fields
      .filter((field) => !isFormulaField(field) && field.type !== 'hidden')
      .map((field) => [field.key, form[field.key] ?? ''])
  );
}

async function submit() {
  if (!moduleConfig.value) return;
  try {
    await ElMessageBox.confirm(editingRow.value ? '确认保存本次修改？' : '确认新增这条数据？', '写入数据源', { type: 'warning' });
    if (editingRow.value) {
      if (!canUpdate.value) throw new Error('没有编辑权限');
      await updateProjectRow(moduleConfig.value.key, editingRow.value.id, buildPayload());
      ElMessage.success('已保存');
    } else {
      if (!canCreate.value) throw new Error('没有新增权限');
      await createProjectRow(moduleConfig.value.key, buildPayload());
      ElMessage.success('已新增');
    }
    dialogOpen.value = false;
    loadRows();
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || error.message || '保存失败');
  }
}

async function remove(row: SheetRow) {
  if (!moduleConfig.value) return;
  if (isCompletedRow(row)) {
    ElMessage.warning('已完成的数据不能删除');
    return;
  }
  try {
    await ElMessageBox.confirm('确认删除这条数据？外部表格中会清空对应行。', '删除确认', { type: 'warning' });
    await deleteProjectRow(moduleConfig.value.key, row.id);
    ElMessage.success('已删除');
    loadRows();
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '删除失败');
  }
}

watch(selectedKey, () => {
  if (!suppressSelectionWatch.value) loadRows();
});
onMounted(refreshAll);
</script>

<template>
  <main v-loading="loading" class="content">
    <div class="toolbar project-toolbar">
      <el-select v-model="selectedKey" class="module-select" placeholder="选择子模块" filterable>
        <el-option v-for="item in modules" :key="item.key" :label="item.title" :value="item.key" />
      </el-select>
      <el-input v-model="keyword" class="search-input" :prefix-icon="Search" placeholder="搜索当前子模块数据" clearable />
      <el-button :icon="Refresh" @click="refreshAll">刷新</el-button>
      <el-button v-if="canCreate" type="primary" :icon="Plus" @click="openCreate">新增</el-button>
    </div>

    <section class="filter-panel">
      <el-alert
        v-if="isRestrictedUser"
        type="info"
        :closable="false"
        class="ownership-alert"
        :title="`当前仅显示研发人员为 ${user?.displayName || '-'} 的项目数据`"
      />
      <el-input v-if="hasField('content')" v-model="filters.content" class="filter-item" placeholder="按内容过滤" clearable />
      <el-select v-if="hasField('isCompleted')" v-model="filters.isCompleted" class="filter-item" placeholder="是否完成" clearable>
        <el-option label="是" value="是" />
        <el-option label="否" value="否" />
      </el-select>
      <el-date-picker v-if="hasField('plannedTestAt')" v-model="filters.plannedTestAt" class="filter-date" type="daterange" value-format="YYYY-MM-DD" start-placeholder="计划提测开始" end-placeholder="计划提测结束" clearable />
      <el-date-picker v-if="hasField('actualTestAt')" v-model="filters.actualTestAt" class="filter-date" type="daterange" value-format="YYYY-MM-DD" start-placeholder="实际提测开始" end-placeholder="实际提测结束" clearable />
      <el-date-picker v-if="hasField('launchAt')" v-model="filters.launchAt" class="filter-date" type="daterange" value-format="YYYY-MM-DD" start-placeholder="上线开始" end-placeholder="上线结束" clearable />
      <el-select v-if="hasField('developer')" v-model="filters.developer" class="filter-item" placeholder="研发人员" filterable clearable>
        <el-option v-for="name in staffOptions.developer" :key="name" :label="name" :value="name" />
      </el-select>
      <el-select v-if="hasField('productOwner')" v-model="filters.productOwner" class="filter-item" placeholder="产品人员" filterable clearable>
        <el-option v-for="name in staffOptions.product" :key="name" :label="name" :value="name" />
      </el-select>
      <el-select v-if="hasField('tester')" v-model="filters.tester" class="filter-item" placeholder="测试人员" filterable clearable>
        <el-option v-for="name in staffOptions.tester" :key="name" :label="name" :value="name" />
      </el-select>
      <el-button @click="clearFilters">清空条件</el-button>
    </section>

    <section class="panel">
      <el-empty v-if="!modules.length" description="暂无启用的项目子模块，请到系统配置中新建模块" />
      <el-table v-else :data="filteredRows" height="calc(100vh - 325px)" stripe>
        <el-table-column v-for="field in moduleConfig?.fields || []" :key="field.key" :prop="field.key" :label="field.label" min-width="150" sortable>
          <template #default="{ row }">
            <el-tag v-if="field.type === 'status'" size="small">{{ row[field.key] || '-' }}</el-tag>
            <a v-else-if="field.type === 'link' && row[field.key]" :href="String(row[field.key])" target="_blank" rel="noreferrer" class="table-link">
              {{ row[field.key] }}
            </a>
            <span v-else>{{ row[field.key] || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="canUpdate || canDelete" fixed="right" label="操作" width="128">
          <template #default="{ row }">
            <el-button v-if="canUpdate && !isCompletedRow(row)" :icon="Edit" circle @click="openEdit(row)" />
            <el-button v-if="canDelete && !isCompletedRow(row)" :icon="Delete" circle type="danger" @click="remove(row)" />
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="dialogOpen" :title="editingRow ? '编辑数据' : '新增数据'" width="680px">
      <el-form label-position="top">
        <el-form-item v-for="field in editableFields" :key="field.key" :label="field.label" :required="field.required">
          <el-input-number v-if="field.type === 'number'" v-model="form[field.key]" :min="0" controls-position="right" class="full-field" />
          <el-date-picker v-else-if="field.type === 'date'" v-model="form[field.key]" type="date" value-format="YYYY-MM-DD" class="full-field" clearable />
          <el-select v-else-if="field.type === 'status'" v-model="form[field.key]" class="full-field" allow-create filterable clearable>
            <el-option label="是" value="是" />
            <el-option label="否" value="否" />
          </el-select>
          <el-select v-else-if="field.type === 'staff'" v-model="form[field.key]" class="full-field" allow-create filterable clearable :disabled="isRestrictedUser && field.key === 'developer'">
            <el-option v-for="name in fieldOptions(field)" :key="name" :label="name" :value="name" />
          </el-select>
          <el-input v-else-if="field.key === 'remark' || field.key === 'content'" v-model="form[field.key]" type="textarea" :rows="3" />
          <el-input v-else v-model="form[field.key]" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </main>
</template>
