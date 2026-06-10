<!-- 通用模块表格页：按配置字段渲染项目、人员、待办模块的行增删改查。 -->
<script setup lang="ts">
import { Delete, Edit, Plus, Refresh, Search } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { createRow, deleteRow, getRows, getStaffOptions, updateRow } from '../api';
import type { ModuleConfig, ModuleField, SheetRow } from '../types';

const route = useRoute();
const loading = ref(false);
const moduleConfig = ref<ModuleConfig>();
const canCreate = ref(false);
const canUpdate = ref(false);
const canDelete = ref(false);
const rows = ref<SheetRow[]>([]);
const cacheMeta = ref<any>(null);
const keyword = ref('');
const filters = reactive<Record<string, string | string[]>>({});
const dialogOpen = ref(false);
const editingRow = ref<SheetRow | null>(null);
const form = reactive<Record<string, string | number>>({});
const staffOptions = ref({ product: [] as string[], tester: [] as string[], developer: [] as string[] });

const filterableFields = computed(() => {
  return (moduleConfig.value?.fields || []).filter((field) =>
    !field.hidden &&
    field.type !== 'hidden' &&
    field.type !== 'formula' &&
    !['sequence', 'zentaoLink', 'remark'].includes(field.key)
  );
});

const filteredRows = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  return rows.value.filter((row) => {
    if (q && !Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(q))) return false;
    for (const field of filterableFields.value) {
      const filterValue = filters[field.key];
      if (!filterValue || (Array.isArray(filterValue) && !filterValue.length)) continue;
      const cell = String(row[field.key] ?? '').trim();
      if (field.type === 'date') {
        if (!matchDateRange(cell, filterValue as string[])) return false;
      } else if (field.type === 'staff' || field.type === 'status') {
        if (cell !== filterValue) return false;
      } else if (!cell.toLowerCase().includes(String(filterValue).trim().toLowerCase())) {
        return false;
      }
    }
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

function clearFilters() {
  keyword.value = '';
  for (const key of Object.keys(filters)) delete filters[key];
}

function isCompletedRow(row: SheetRow) {
  return ['是', '已完成', '完成', 'true'].includes(String(row.isCompleted ?? '').trim().toLowerCase());
}
// 人员选择项单独加载，因为只有项目/待办模块需要人员分配选项。
async function loadStaffOptions() {
  try {
    staffOptions.value = await getStaffOptions();
  } catch {
    staffOptions.value = { product: [], tester: [], developer: [] };
  }
}
// 同时加载模块元数据和行数据，确保表格列始终匹配当前模块配置。
async function load() {
  loading.value = true;
  try {
    const data = await getRows(String(route.params.moduleKey));
    moduleConfig.value = data.module;
    canCreate.value = data.canCreate;
    canUpdate.value = data.canUpdate;
    canDelete.value = data.canDelete;
    cacheMeta.value = data.cacheMeta || null;
    rows.value = data.rows;
    if (data.module.key !== 'staff') await loadStaffOptions();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '数据加载失败');
  } finally {
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
      await updateRow(moduleConfig.value.key, editingRow.value.id, buildPayload());
      ElMessage.success('已保存');
    } else {
      if (!canCreate.value) throw new Error('没有新增权限');
      await createRow(moduleConfig.value.key, buildPayload());
      ElMessage.success('已新增');
    }
    dialogOpen.value = false;
    load();
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
    await deleteRow(moduleConfig.value.key, row.id);
    ElMessage.success('已删除');
    load();
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '删除失败');
  }
}

watch(() => route.params.moduleKey, load, { immediate: true });
</script>

<template>
  <main v-loading="loading" class="content">
    <div class="toolbar">
      <el-input v-model="keyword" class="search-input" :prefix-icon="Search" placeholder="搜索当前模块数据" clearable />
      <el-tag v-if="cacheMeta?.updatedAt" :type="cacheMeta.stale ? 'warning' : 'success'">
        缓存{{ cacheMeta.stale ? '可能过期' : '正常' }} · 北京时间 {{ formatBeijingTime(cacheMeta.updatedAt) }}
      </el-tag>
      <el-button :icon="Refresh" @click="load">刷新</el-button>
      <el-button v-if="canCreate" type="primary" :icon="Plus" @click="openCreate">新增</el-button>
    </div>

    <section class="filter-panel">
      <template v-for="field in filterableFields" :key="field.key">
        <el-date-picker
          v-if="field.type === 'date'"
          v-model="filters[field.key]"
          class="filter-date"
          type="daterange"
          value-format="YYYY-MM-DD"
          :start-placeholder="`${field.label}开始`"
          :end-placeholder="`${field.label}结束`"
          clearable
        />
        <el-select v-else-if="field.type === 'status'" v-model="filters[field.key]" class="filter-item" :placeholder="field.label" clearable>
          <el-option label="是" value="是" />
          <el-option label="否" value="否" />
        </el-select>
        <el-select v-else-if="field.type === 'staff'" v-model="filters[field.key]" class="filter-item" :placeholder="field.label" filterable clearable>
          <el-option v-for="name in fieldOptions(field)" :key="name" :label="name" :value="name" />
        </el-select>
        <el-input v-else v-model="filters[field.key]" class="filter-item" :placeholder="`按${field.label}过滤`" clearable />
      </template>
      <el-button @click="clearFilters">清空条件</el-button>
    </section>

    <section class="panel">
      <el-table :data="filteredRows" height="calc(100vh - 325px)" stripe>
        <el-table-column v-for="field in moduleConfig?.fields || []" :key="field.key" :prop="field.key" :label="field.label" min-width="150" sortable>
          <template #default="{ row }">
            <el-tag v-if="field.type === 'status'" size="small">{{ row[field.key] || '-' }}</el-tag>
            <a v-else-if="field.type === 'link' && row[field.key]" :href="String(row[field.key])" target="_blank" rel="noreferrer" class="table-link">
              {{ row[field.key] }}
            </a>
            <span v-else>{{ row[field.key] || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Sync" width="130">
          <template #default="{ row }">
            <el-tag :type="row.syncStatus === 'failed' ? 'danger' : row.syncStatus === 'pending' ? 'warning' : 'success'" size="small">
              {{ row.syncStatus || 'synced' }}
            </el-tag>
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
          <el-select v-else-if="field.type === 'staff'" v-model="form[field.key]" class="full-field" allow-create filterable clearable>
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
