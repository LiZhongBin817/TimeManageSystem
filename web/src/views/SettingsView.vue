<script setup lang="ts">
import { Delete, Edit, Plus, Refresh, Upload } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import {
  deleteConfigModule,
  deleteDataSourceInstance,
  getConfigModules,
  getDataSourceInstances,
  saveConfigModule,
  saveDataSourceInstance,
  saveModuleFields,
  syncConfigModule
} from '../api';
import type { DataSourceInstance, FieldType, ModuleConfig, ModuleField, PlatformKey } from '../types';

const loading = ref(false);
const sources = ref<DataSourceInstance[]>([]);
const modules = ref<ModuleConfig[]>([]);
const activeTab = ref('sources');
const sourceDialogOpen = ref(false);
const moduleDialogOpen = ref(false);
const sourceForm = reactive<DataSourceInstance>(emptySource());
const moduleForm = reactive<ModuleConfig>(emptyModule());

const fieldTypes: FieldType[] = ['text', 'number', 'date', 'link', 'status', 'staff', 'formula', 'hidden'];
const staffRoles = [
  { label: '产品人员', value: 'product' },
  { label: '测试人员', value: 'tester' },
  { label: '研发人员', value: 'developer' }
] as const;

const sourceOptions = computed(() => sources.value.map((item) => ({ label: item.name, value: item.id })));

function emptySource(): DataSourceInstance {
  return {
    name: '',
    platform: 'dingtalk',
    enabled: true,
    sortOrder: 0,
    config: {
      appKey: '',
      appSecret: '',
      workbookId: '',
      operatorId: '',
      appId: '',
      spreadsheetToken: ''
    }
  };
}

function emptyModule(): ModuleConfig {
  return {
    key: '',
    title: '',
    category: 'project',
    dataSourceId: undefined,
    sheetName: '',
    sheetId: '',
    headerRow: 1,
    dataStartRow: 2,
    editable: true,
    enabled: true,
    sortOrder: 0,
    fields: defaultProjectFields()
  };
}

function defaultProjectFields(): ModuleField[] {
  return [
    { key: 'sequence', label: '序号', type: 'number', required: true, hidden: true },
    { key: 'branchName', label: '分支名称', type: 'text' },
    { key: 'content', label: '内容', type: 'text' },
    { key: 'zentaoLink', label: '禅道链接', type: 'link' },
    { key: 'isCompleted', label: '是否完成', type: 'formula', hidden: true, formula: true },
    { key: 'plannedTestAt', label: '计划提测时间', type: 'date' },
    { key: 'actualTestAt', label: '实际提测时间', type: 'date' },
    { key: 'launchAt', label: '上线时间', type: 'date' },
    { key: 'developer', label: '研发人员', type: 'staff', staffRole: 'developer' },
    { key: 'productOwner', label: '产品人员', type: 'staff', staffRole: 'product' },
    { key: 'tester', label: '测试人员', type: 'staff', staffRole: 'tester' },
    { key: 'name', label: '名称', type: 'formula', hidden: true, formula: true },
    { key: 'remark', label: '备注', type: 'text' }
  ];
}

function assign<T extends object>(target: T, value: T) {
  Object.keys(target).forEach((key) => delete (target as any)[key]);
  Object.assign(target, JSON.parse(JSON.stringify(value)));
}

async function load() {
  loading.value = true;
  try {
    const [sourceList, moduleList] = await Promise.all([
      getDataSourceInstances(undefined, true),
      getConfigModules()
    ]);
    sources.value = sourceList;
    modules.value = moduleList;
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '配置加载失败');
  } finally {
    loading.value = false;
  }
}

function openSourceCreate() {
  assign(sourceForm, emptySource());
  sourceDialogOpen.value = true;
}

function openSourceEdit(row: DataSourceInstance) {
  assign(sourceForm, row);
  sourceDialogOpen.value = true;
}

async function submitSource() {
  try {
    await saveDataSourceInstance(sourceForm);
    ElMessage.success('数据源实例已保存');
    sourceDialogOpen.value = false;
    load();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '保存失败');
  }
}

async function removeSource(row: DataSourceInstance) {
  if (!row.id) return;
  try {
    await ElMessageBox.confirm('确认停用这个数据源实例？', '停用确认', { type: 'warning' });
    await deleteDataSourceInstance(row.id);
    ElMessage.success('已停用');
    load();
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '停用失败');
  }
}

function openModuleCreate() {
  assign(moduleForm, emptyModule());
  moduleDialogOpen.value = true;
}

function openModuleEdit(row: ModuleConfig) {
  assign(moduleForm, row);
  moduleDialogOpen.value = true;
}

function addField() {
  moduleForm.fields.push({ key: '', label: '', type: 'text' });
}

function removeField(index: number) {
  moduleForm.fields.splice(index, 1);
}

async function submitModule() {
  try {
    const saved = await saveConfigModule(moduleForm);
    if (saved.id) await saveModuleFields(saved.id, moduleForm.fields);
    ElMessage.success('模块配置已保存');
    moduleDialogOpen.value = false;
    load();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '保存失败');
  }
}

async function removeModule(row: ModuleConfig) {
  if (!row.id) return;
  try {
    await ElMessageBox.confirm('确认停用这个模块？停用后不会出现在项目模块下拉中。', '停用确认', { type: 'warning' });
    await deleteConfigModule(row.id);
    ElMessage.success('已停用');
    load();
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '停用失败');
  }
}

async function syncModule(row: ModuleConfig) {
  if (!row.id) return;
  try {
    const result = await syncConfigModule(row.id);
    ElMessage.success(result.message || '同步完成');
    load();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '同步失败');
  }
}

onMounted(load);
</script>

<template>
  <main v-loading="loading" class="content settings-page">
    <div class="toolbar">
      <el-button :icon="Refresh" @click="load">刷新</el-button>
    </div>

    <section class="panel">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="数据源实例" name="sources">
          <div class="settings-actions">
            <el-button type="primary" :icon="Plus" @click="openSourceCreate">新增实例</el-button>
          </div>
          <el-table :data="sources" stripe>
            <el-table-column prop="name" label="实例名称" min-width="180" />
            <el-table-column prop="platform" label="平台" width="110">
              <template #default="{ row }">{{ row.platform === 'feishu' ? '飞书' : '钉钉' }}</template>
            </el-table-column>
            <el-table-column prop="enabled" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="sortOrder" label="排序" width="90" />
            <el-table-column label="操作" width="180">
              <template #default="{ row }">
                <el-button :icon="Edit" circle @click="openSourceEdit(row)" />
                <el-button :icon="Delete" circle type="danger" @click="removeSource(row)" />
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="模块配置" name="modules">
          <div class="settings-actions">
            <el-button type="primary" :icon="Plus" @click="openModuleCreate">新增模块</el-button>
          </div>
          <el-table :data="modules" stripe>
            <el-table-column prop="title" label="模块名称" min-width="160" />
            <el-table-column prop="key" label="模块 key" min-width="150" />
            <el-table-column prop="category" label="分类" width="100" />
            <el-table-column prop="sheetName" label="工作表" min-width="150" />
            <el-table-column prop="enabled" label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="230">
              <template #default="{ row }">
                <el-button :icon="Upload" circle @click="syncModule(row)" />
                <el-button :icon="Edit" circle @click="openModuleEdit(row)" />
                <el-button :icon="Delete" circle type="danger" @click="removeModule(row)" />
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </section>

    <el-dialog v-model="sourceDialogOpen" title="数据源实例" width="720px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="实例名称" required>
            <el-input v-model="sourceForm.name" />
          </el-form-item>
          <el-form-item label="平台" required>
            <el-select v-model="sourceForm.platform" class="full-field">
              <el-option label="钉钉" value="dingtalk" />
              <el-option label="飞书" value="feishu" />
            </el-select>
          </el-form-item>
          <el-form-item label="排序">
            <el-input-number v-model="sourceForm.sortOrder" class="full-field" />
          </el-form-item>
          <el-form-item label="启用">
            <el-switch v-model="sourceForm.enabled" />
          </el-form-item>
        </div>
        <div class="form-grid">
          <template v-if="sourceForm.platform === 'dingtalk'">
            <el-form-item label="AppKey"><el-input v-model="sourceForm.config.appKey" /></el-form-item>
            <el-form-item label="AppSecret"><el-input v-model="sourceForm.config.appSecret" show-password /></el-form-item>
            <el-form-item label="WorkbookId"><el-input v-model="sourceForm.config.workbookId" /></el-form-item>
            <el-form-item label="OperatorId"><el-input v-model="sourceForm.config.operatorId" /></el-form-item>
          </template>
          <template v-else>
            <el-form-item label="AppId"><el-input v-model="sourceForm.config.appId" /></el-form-item>
            <el-form-item label="AppSecret"><el-input v-model="sourceForm.config.appSecret" show-password /></el-form-item>
            <el-form-item label="SpreadsheetToken"><el-input v-model="sourceForm.config.spreadsheetToken" /></el-form-item>
            <el-form-item label="BaseUrl"><el-input v-model="sourceForm.config.baseUrl" placeholder="https://open.feishu.cn" /></el-form-item>
          </template>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="sourceDialogOpen = false">取消</el-button>
        <el-button type="primary" @click="submitSource">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="moduleDialogOpen" title="模块配置" width="1080px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="模块名称" required><el-input v-model="moduleForm.title" /></el-form-item>
          <el-form-item label="模块 key" required><el-input v-model="moduleForm.key" /></el-form-item>
          <el-form-item label="分类">
            <el-select v-model="moduleForm.category" class="full-field">
              <el-option label="项目模块" value="project" />
              <el-option label="人员信息" value="staff" />
              <el-option label="待办事项" value="todo" />
            </el-select>
          </el-form-item>
          <el-form-item label="绑定数据源">
            <el-select v-model="moduleForm.dataSourceId" class="full-field" clearable>
              <el-option v-for="item in sourceOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="工作表名称" required><el-input v-model="moduleForm.sheetName" /></el-form-item>
          <el-form-item label="SheetId / TableId"><el-input v-model="moduleForm.sheetId" /></el-form-item>
          <el-form-item label="表头行"><el-input-number v-model="moduleForm.headerRow" class="full-field" :min="1" /></el-form-item>
          <el-form-item label="数据起始行"><el-input-number v-model="moduleForm.dataStartRow" class="full-field" :min="1" /></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="moduleForm.sortOrder" class="full-field" /></el-form-item>
          <el-form-item label="可编辑"><el-switch v-model="moduleForm.editable" /></el-form-item>
          <el-form-item label="启用"><el-switch v-model="moduleForm.enabled" /></el-form-item>
        </div>
      </el-form>

      <div class="field-editor-header">
        <strong>字段配置</strong>
        <el-button size="small" :icon="Plus" @click="addField">新增字段</el-button>
      </div>
      <el-table :data="moduleForm.fields" class="field-table">
        <el-table-column label="字段 key" min-width="150">
          <template #default="{ row }"><el-input v-model="row.key" /></template>
        </el-table-column>
        <el-table-column label="显示名" min-width="150">
          <template #default="{ row }"><el-input v-model="row.label" /></template>
        </el-table-column>
        <el-table-column label="类型" width="130">
          <template #default="{ row }">
            <el-select v-model="row.type" class="full-field">
              <el-option v-for="type in fieldTypes" :key="type" :label="type" :value="type" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="人员角色" width="130">
          <template #default="{ row }">
            <el-select v-model="row.staffRole" class="full-field" clearable :disabled="row.type !== 'staff'">
              <el-option v-for="role in staffRoles" :key="role.value" :label="role.label" :value="role.value" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="必填" width="76">
          <template #default="{ row }"><el-checkbox v-model="row.required" /></template>
        </el-table-column>
        <el-table-column label="隐藏" width="76">
          <template #default="{ row }"><el-checkbox v-model="row.hidden" /></template>
        </el-table-column>
        <el-table-column label="公式" width="76">
          <template #default="{ row }"><el-checkbox v-model="row.formula" /></template>
        </el-table-column>
        <el-table-column label="操作" width="76">
          <template #default="{ $index }">
            <el-button :icon="Delete" circle type="danger" @click="removeField($index)" />
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="moduleDialogOpen = false">取消</el-button>
        <el-button type="primary" @click="submitModule">保存</el-button>
      </template>
    </el-dialog>
  </main>
</template>
