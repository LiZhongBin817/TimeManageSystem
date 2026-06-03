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
const canEdit = ref(false);
const rows = ref<SheetRow[]>([]);
const keyword = ref('');
const dialogOpen = ref(false);
const editingRow = ref<SheetRow | null>(null);
const form = reactive<Record<string, string | number>>({});
const staffOptions = ref({ product: [] as string[], tester: [] as string[], developer: [] as string[] });
const formulaFields = new Set(['isCompleted', 'name']);
const hiddenFormFields = new Set(['sequence', 'isCompleted', 'name']);

const filteredRows = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter((row) => Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(q)));
});

const editableFields = computed(() => {
  return (moduleConfig.value?.fields || []).filter((field) => !hiddenFormFields.has(field.key));
});

function fieldOptions(field: ModuleField) {
  if (field.type !== 'staff' || !field.staffRole) return [];
  return staffOptions.value[field.staffRole];
}

async function loadStaffOptions() {
  try {
    staffOptions.value = await getStaffOptions();
  } catch {
    staffOptions.value = { product: [], tester: [], developer: [] };
  }
}

async function load() {
  loading.value = true;
  try {
    const data = await getRows(String(route.params.moduleKey));
    moduleConfig.value = data.module;
    canEdit.value = data.canEdit;
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
  editingRow.value = row;
  resetForm(row);
  dialogOpen.value = true;
}

function resetForm(row?: SheetRow) {
  for (const field of moduleConfig.value?.fields || []) {
    form[field.key] = (row?.[field.key] as string | number) ?? '';
  }
}

async function submit() {
  if (!moduleConfig.value) return;
  const payload = Object.fromEntries(
    moduleConfig.value.fields
      .filter((field) => !formulaFields.has(field.key))
      .map((field) => [field.key, form[field.key] ?? ''])
  );
  try {
    await ElMessageBox.confirm(editingRow.value ? '确认保存本次修改？' : '确认新增这条数据？', '写入钉钉表格', { type: 'warning' });
    if (editingRow.value) {
      await updateRow(moduleConfig.value.key, editingRow.value.id, payload);
      ElMessage.success('已保存');
    } else {
      await createRow(moduleConfig.value.key, payload);
      ElMessage.success('已新增');
    }
    dialogOpen.value = false;
    load();
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '保存失败');
  }
}

async function remove(row: SheetRow) {
  if (!moduleConfig.value) return;
  try {
    await ElMessageBox.confirm('确认删除这条数据？真实钉钉模式下会清空对应行。', '删除确认', { type: 'warning' });
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
      <el-button :icon="Refresh" @click="load">刷新</el-button>
      <el-button v-if="canEdit" type="primary" :icon="Plus" @click="openCreate">新增</el-button>
    </div>

    <section class="panel">
      <el-table :data="filteredRows" height="calc(100vh - 245px)" stripe>
        <el-table-column v-for="field in moduleConfig?.fields || []" :key="field.key" :prop="field.key" :label="field.label" min-width="150" sortable>
          <template #default="{ row }">
            <el-tag v-if="field.type === 'status'" size="small">{{ row[field.key] || '-' }}</el-tag>
            <a v-else-if="field.type === 'link' && row[field.key]" :href="String(row[field.key])" target="_blank" rel="noreferrer" class="table-link">
              {{ row[field.key] }}
            </a>
            <span v-else>{{ row[field.key] || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="canEdit" fixed="right" label="操作" width="128">
          <template #default="{ row }">
            <el-button :icon="Edit" circle @click="openEdit(row)" />
            <el-button :icon="Delete" circle type="danger" @click="remove(row)" />
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="dialogOpen" :title="editingRow ? '编辑数据' : '新增数据'" width="680px">
      <el-alert
        v-if="!editingRow"
        class="form-alert"
        type="info"
        show-icon
        :closable="false"
        title="新增会优先写入钉钉表格中已预留的空白模板行，以继承原表网格、公式和基础格式。"
      />
      <el-form label-position="top">
        <el-form-item v-for="field in editableFields" :key="field.key" :label="field.label" :required="field.required">
          <el-input-number v-if="field.type === 'number'" v-model="form[field.key]" :min="0" controls-position="right" class="full-field" />
          <el-date-picker v-else-if="field.type === 'date'" v-model="form[field.key]" type="date" value-format="YYYY-MM-DD" class="full-field" />
          <el-select v-else-if="field.type === 'status'" v-model="form[field.key]" class="full-field" allow-create filterable>
            <el-option label="是" value="是" />
            <el-option label="否" value="否" />
          </el-select>
          <el-select v-else-if="field.type === 'staff'" v-model="form[field.key]" class="full-field" allow-create filterable>
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
