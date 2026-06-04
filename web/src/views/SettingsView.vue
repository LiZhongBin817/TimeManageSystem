<script setup lang="ts">
import { Delete, Edit, Plus, Refresh, Upload } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import {
  deleteConfigModule,
  deleteDataSourceInstance,
  getConfigModules,
  getDataSourceInstances,
  getMe,
  getPermissions,
  getUsers,
  saveConfigModule,
  saveDataSourceInstance,
  saveModuleFields,
  savePermissions,
  syncEnterpriseMembers,
  syncConfigModule,
  updateManagedUser
} from '../api';
import type { DataSourceInstance, FieldType, ManagedUser, ModuleConfig, ModuleField, ModulePermission, PermissionSubjectType, Role, User } from '../types';

const loading = ref(false);
const sources = ref<DataSourceInstance[]>([]);
const modules = ref<ModuleConfig[]>([]);
const users = ref<ManagedUser[]>([]);
const permissions = ref<ModulePermission[]>([]);
const me = ref<User>();
const activeTab = ref('sources');
const permissionSubjectType = ref<PermissionSubjectType>('user');
const permissionSubjectId = ref('');
const syncingMembers = ref(false);
const sourceDialogOpen = ref(false);
const moduleDialogOpen = ref(false);
const userDialogOpen = ref(false);
const sourceForm = reactive<DataSourceInstance>(emptySource());
const moduleForm = reactive<ModuleConfig>(emptyModule());
const userForm = reactive<Pick<ManagedUser, 'id' | 'displayName' | 'role' | 'enabled' | 'defaultDataSourceId'>>({
  id: 0,
  displayName: '',
  role: 'viewer',
  enabled: true,
  defaultDataSourceId: null
});

const fieldTypes: FieldType[] = ['text', 'number', 'date', 'link', 'status', 'staff', 'formula', 'hidden'];
const sourceOptions = computed(() => sources.value.map((item) => ({ label: item.name, value: item.id })));
const isAdmin = computed(() => me.value?.role === 'admin');
const roleOptions: Array<{ label: string; value: Role }> = [
  { label: '管理员', value: 'admin' },
  { label: '编辑者', value: 'editor' },
  { label: '只读用户', value: 'viewer' }
];
const permissionSubjectOptions = computed(() => {
  if (permissionSubjectType.value === 'role') return roleOptions;
  return users.value.map((user) => ({ label: `${user.displayName}（${user.role}）`, value: String(user.id) }));
});

function emptySource(): DataSourceInstance {
  return {
    name: '',
    platform: 'dingtalk',
    enabled: true,
    sortOrder: 0,
    config: {
      appKey: '',
      appSecret: '',
      corpId: '',
      workbookId: '',
      operatorId: '',
      appId: '',
      spreadsheetToken: '',
      redirectUri: '',
      loginEnabled: 'true',
      localLoginEnabled: 'false'
    }
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

function assign<T extends object>(target: T, value: T) {
  Object.keys(target).forEach((key) => delete (target as any)[key]);
  Object.assign(target, JSON.parse(JSON.stringify(value)));
}

async function load() {
  loading.value = true;
  try {
    me.value = await getMe();
    const [sourceList, moduleList] = await Promise.all([
      getDataSourceInstances(undefined, true),
      getConfigModules()
    ]);
    sources.value = sourceList;
    modules.value = moduleList;
    if (me.value.role === 'admin') {
      users.value = await getUsers();
      if (!permissionSubjectId.value) permissionSubjectId.value = users.value[0] ? String(users.value[0].id) : 'admin';
      await loadPermissions();
    }
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '配置加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadPermissions() {
  if (!isAdmin.value || !permissionSubjectId.value) return;
  try {
    permissions.value = await getPermissions(permissionSubjectType.value, permissionSubjectId.value);
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '权限加载失败');
  }
}

async function submitPermissions() {
  if (!permissionSubjectId.value) return;
  try {
    permissions.value = await savePermissions(permissionSubjectType.value, permissionSubjectId.value, permissions.value);
    ElMessage.success('权限已保存');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '权限保存失败');
  }
}

async function syncMembers() {
  syncingMembers.value = true;
  try {
    const result = await syncEnterpriseMembers();
    users.value = result.users?.length ? result.users : await getUsers();
    ElMessage.success(`企业成员同步完成：新增 ${result.created} 人，更新 ${result.updated} 人`);
    if (permissionSubjectType.value === 'user' && !users.value.some((user) => String(user.id) === permissionSubjectId.value)) {
      permissionSubjectId.value = users.value[0] ? String(users.value[0].id) : '';
    }
    await loadPermissions();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '企业成员同步失败');
  } finally {
    syncingMembers.value = false;
  }
}

function onPermissionSubjectTypeChange() {
  permissionSubjectId.value = permissionSubjectType.value === 'role'
    ? 'admin'
    : users.value[0] ? String(users.value[0].id) : '';
  loadPermissions();
}

function openSourceCreate() {
  assign(sourceForm, emptySource());
  sourceDialogOpen.value = true;
}

function openSourceEdit(row: DataSourceInstance) {
  assign(sourceForm, { ...row, config: { ...emptySource().config, ...row.config } });
  sourceDialogOpen.value = true;
}

async function submitSource() {
  try {
    const payload = JSON.parse(JSON.stringify(sourceForm));
    await saveDataSourceInstance(payload);
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
    await ElMessageBox.confirm('确认删除这个模块？仅删除本地模块配置、字段和权限，不删除外部表格数据。', '删除确认', { type: 'warning' });
    await deleteConfigModule(row.id);
    ElMessage.success('已删除模块');
    load();
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '删除失败');
  }
}

async function legacyRemoveModule(row: ModuleConfig) {
  if (!row.id) return;
  try {
    await ElMessageBox.confirm('确认停用这个模块？', '停用确认', { type: 'warning' });
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

function openUserEdit(row: ManagedUser) {
  Object.assign(userForm, {
    id: row.id,
    displayName: row.displayName,
    role: row.role,
    enabled: row.enabled,
    defaultDataSourceId: row.defaultDataSourceId || null
  });
  userDialogOpen.value = true;
}

async function submitUser() {
  try {
    await updateManagedUser(userForm);
    ElMessage.success('用户已保存');
    userDialogOpen.value = false;
    load();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '保存失败');
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

        <el-tab-pane v-if="isAdmin" label="用户管理" name="users">
          <div class="toolbar permission-toolbar">
            <el-button type="primary" :loading="syncingMembers" @click="syncMembers">同步企业成员</el-button>
          </div>
          <el-table :data="users" stripe>
            <el-table-column prop="displayName" label="显示名称" min-width="150" />
            <el-table-column prop="username" label="登录标识" min-width="220" />
            <el-table-column prop="role" label="角色" width="110" />
            <el-table-column label="默认数据源" min-width="180">
              <template #default="{ row }">
                {{ row.defaultDataSourceName || '跟随登录页选择' }}
              </template>
            </el-table-column>
            <el-table-column prop="enabled" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="createdAt" label="创建时间" min-width="170" />
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button :icon="Edit" circle @click="openUserEdit(row)" />
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane v-if="isAdmin" label="权限管理" name="permissions">
          <div class="toolbar permission-toolbar">
            <el-segmented
              v-model="permissionSubjectType"
              :options="[{ label: '用户', value: 'user' }, { label: '角色', value: 'role' }]"
              @change="onPermissionSubjectTypeChange"
            />
            <el-select v-model="permissionSubjectId" class="permission-subject-select" filterable @change="loadPermissions">
              <el-option v-for="item in permissionSubjectOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-button type="primary" @click="submitPermissions">保存权限</el-button>
            <el-button :loading="syncingMembers" @click="syncMembers">同步企业成员</el-button>
          </div>
          <el-table :data="permissions" stripe>
            <el-table-column prop="moduleTitle" label="模块" min-width="180" />
            <el-table-column prop="category" label="分类" width="110" />
            <el-table-column label="查看菜单" width="110" align="center">
              <template #default="{ row }"><el-checkbox v-model="row.canView" /></template>
            </el-table-column>
            <el-table-column label="新增" width="100" align="center">
              <template #default="{ row }"><el-checkbox v-model="row.canCreate" :disabled="!row.canView" /></template>
            </el-table-column>
            <el-table-column label="编辑" width="100" align="center">
              <template #default="{ row }"><el-checkbox v-model="row.canUpdate" :disabled="!row.canView" /></template>
            </el-table-column>
            <el-table-column label="删除" width="100" align="center">
              <template #default="{ row }"><el-checkbox v-model="row.canDelete" :disabled="!row.canView" /></template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </section>

    <el-dialog v-model="sourceDialogOpen" title="数据源实例" width="760px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="实例名称" required><el-input v-model="sourceForm.name" /></el-form-item>
          <el-form-item label="平台" required>
            <el-select v-model="sourceForm.platform" class="full-field">
              <el-option label="钉钉" value="dingtalk" />
              <el-option label="飞书" value="feishu" />
            </el-select>
          </el-form-item>
          <el-form-item label="排序"><el-input-number v-model="sourceForm.sortOrder" class="full-field" /></el-form-item>
          <el-form-item label="启用"><el-switch v-model="sourceForm.enabled" /></el-form-item>
          <el-form-item label="启用备用登录">
            <el-select v-model="sourceForm.config.localLoginEnabled" class="full-field">
              <el-option label="启用" value="true" />
              <el-option label="停用" value="false" />
            </el-select>
          </el-form-item>
          <el-form-item label="启用企业登录">
            <el-select v-model="sourceForm.config.loginEnabled" class="full-field">
              <el-option label="启用" value="true" />
              <el-option label="停用" value="false" />
            </el-select>
          </el-form-item>
          <el-form-item label="OAuth 回调地址">
            <el-input v-model="sourceForm.config.redirectUri" placeholder="不填则使用后端默认 callback" />
          </el-form-item>
        </div>
        <div class="form-grid">
          <template v-if="sourceForm.platform === 'dingtalk'">
            <el-form-item label="AppKey"><el-input v-model="sourceForm.config.appKey" /></el-form-item>
            <el-form-item label="AppSecret"><el-input v-model="sourceForm.config.appSecret" show-password /></el-form-item>
            <el-form-item label="CorpId"><el-input v-model="sourceForm.config.corpId" placeholder="企业 CorpId，可选但建议填写" /></el-form-item>
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
        <el-table-column label="字段 key" min-width="150"><template #default="{ row }"><el-input v-model="row.key" /></template></el-table-column>
        <el-table-column label="显示名" min-width="150"><template #default="{ row }"><el-input v-model="row.label" /></template></el-table-column>
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
              <el-option label="产品人员" value="product" />
              <el-option label="测试人员" value="tester" />
              <el-option label="研发人员" value="developer" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="必填" width="76"><template #default="{ row }"><el-checkbox v-model="row.required" /></template></el-table-column>
        <el-table-column label="隐藏" width="76"><template #default="{ row }"><el-checkbox v-model="row.hidden" /></template></el-table-column>
        <el-table-column label="公式" width="76"><template #default="{ row }"><el-checkbox v-model="row.formula" /></template></el-table-column>
        <el-table-column label="操作" width="76">
          <template #default="{ $index }"><el-button :icon="Delete" circle type="danger" @click="removeField($index)" /></template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="moduleDialogOpen = false">取消</el-button>
        <el-button type="primary" @click="submitModule">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="userDialogOpen" title="用户管理" width="560px">
      <el-form label-position="top">
        <el-form-item label="显示名称" required><el-input v-model="userForm.displayName" /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="userForm.role" class="full-field">
            <el-option label="管理员" value="admin" />
            <el-option label="编辑者" value="editor" />
            <el-option label="只读用户" value="viewer" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认数据源">
          <el-select v-model="userForm.defaultDataSourceId" class="full-field" clearable placeholder="跟随登录页选择">
            <el-option label="跟随登录页选择" :value="null" />
            <el-option v-for="source in sources" :key="source.id" :label="source.name" :value="source.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="启用"><el-switch v-model="userForm.enabled" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="userDialogOpen = false">取消</el-button>
        <el-button type="primary" @click="submitUser">保存</el-button>
      </template>
    </el-dialog>
  </main>
</template>
