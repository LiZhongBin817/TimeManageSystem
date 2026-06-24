<!-- 管理设置页：管理数据源、模块、用户、权限、通知和同步工具。 -->
<script setup lang="ts">
import { Bell, Delete, Edit, Plus, Refresh, Upload } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import {
  createManagedUser,
  deleteConfigModule,
  getConfigModules,
  getApiUsage,
  getDataSourceInstances,
  getMe,
  getNotificationLogs,
  getNotificationSettings,
  getNotificationUserSettings,
  getPlatformConfigs,
  getPermissions,
  getReferenceModules,
  getSyncOverview,
  getDingTalkSyncSettings,
  getRuntimeSettings,
  getUsers,
  hardDeleteDataSourceInstance,
  initializeStaffAssignments,
  pushDashboardNotification,
  refreshApiCache,
  saveConfigModule,
  saveDingTalkSyncSettings,
  saveRuntimeSettings,
  saveDataSourceInstance,
  saveModuleFields,
  saveNotificationSettings,
  saveNotificationUserSettings,
  savePlatformConfigs,
  savePermissions,
  sendNotificationTest,
  syncDingTalkNow,
  syncEnterpriseMembers,
  syncConfigModule,
  updateManagedUser
} from '../api';
import type {
  ApiUsageSummary,
  DataSourceInstance,
  DingTalkSyncSettings,
  FieldType,
  ManagedUser,
  ModuleConfig,
  ModuleField,
  ModulePermission,
  NotificationLog,
  NotificationSettings,
  NotificationUserSettings,
  RuntimeSettings,
  PermissionSubjectType,
  PlatformConfigs,
  Role,
  SyncOverview,
  User
} from '../types';

type UserDialogMode = 'create' | 'edit';

interface UserFormState {
  id: number;
  username: string;
  loginName: string;
  displayName: string;
  role: Role;
  enabled: boolean;
  defaultDataSourceId: number | null;
  password: string;
  confirmPassword: string;
  newPassword: string;
  confirmNewPassword: string;
}

const loading = ref(false);
const sources = ref<DataSourceInstance[]>([]);
const modules = ref<ModuleConfig[]>([]);
const referenceModules = ref<ModuleConfig[]>([]);
const users = ref<ManagedUser[]>([]);
const permissions = ref<ModulePermission[]>([]);
const notificationLogs = ref<NotificationLog[]>([]);
const apiUsage = ref<ApiUsageSummary | null>(null);
const syncOverview = ref<SyncOverview | null>(null);
const cacheRefreshing = ref(false);
const dingTalkSyncing = ref(false);
const syncSettingsSaving = ref(false);
const runtimeSettingsSaving = ref(false);
const platformConfigsSaving = ref(false);
const me = ref<User>();
const activeTab = ref('sources');
const permissionSubjectType = ref<PermissionSubjectType>('user');
const permissionSubjectId = ref('');
const syncingMembers = ref(false);
const notificationSaving = ref(false);
const notificationUserSaving = ref(false);
const notificationTesting = ref(false);
const notificationPushing = ref(false);
const sourceDialogOpen = ref(false);
const moduleDialogOpen = ref(false);
const userDialogOpen = ref(false);
const userDialogMode = ref<UserDialogMode>('edit');
const sourceForm = reactive<DataSourceInstance>(emptySource());
const moduleForm = reactive<ModuleConfig>(emptyModule());
const userForm = reactive<UserFormState>(emptyUserForm());
const notificationForm = reactive<NotificationSettings>({
  channel: 'dingtalk_robot',
  enabled: false,
  dingtalkEnabled: true,
  feishuEnabled: false,
  webhookUrl: '',
  secret: '',
  dingtalkWebhookUrl: '',
  dingtalkSecret: '',
  feishuWebhookUrl: '',
  feishuSecret: '',
  keywords: ['项目提醒'],
  scheduledTime: '09:00',
  lastScheduledDate: ''
});
const notificationUserForm = reactive<NotificationUserSettings>({
  enabled: false,
  scheduledTime: '09:00',
  lastScheduledDate: ''
});
const dingTalkSyncForm = reactive<DingTalkSyncSettings>({
  enabled: true,
  dingtalkEnabled: true,
  feishuEnabled: false,
  scheduledTime: '02:00',
  startupSyncEnabled: true,
  startupDelayMs: 15000
});
const runtimeForm = reactive<RuntimeSettings>({
  publicBaseUrl: '',
  frontendBaseUrl: '',
  resolvedPublicBaseUrl: '',
  resolvedFrontendBaseUrl: '',
  oauthRequestTimeout: 12000,
  oauthRequestRetries: 2,
  currentAccessBaseUrl: ''
});
const platformConfigForm = reactive<PlatformConfigs>({
  dingtalk: {
    appKey: '',
    appSecret: '',
    corpId: '',
    realmCorpId: '',
    baseUrl: 'https://api.dingtalk.com',
    operatorId: ''
  },
  feishu: {
    appId: '',
    appSecret: '',
    baseUrl: 'https://open.feishu.cn'
  }
});

const fieldTypes: FieldType[] = ['text', 'number', 'date', 'link', 'status', 'staff', 'formula', 'hidden'];
const sourceOptions = computed(() => sources.value.map((item) => ({ label: item.name, value: item.id })));
const sourceNameById = computed(() => new Map(sources.value.map((item) => [item.id, item.name])));
const staffTemplateOptions = computed(() => sources.value
  .filter((item) => item.id && item.id !== sourceForm.id)
  .map((item) => ({ label: item.name, value: item.id! })));
const moduleRowsWithLabels = computed(() => {
  const titleCounts = modules.value.reduce<Record<string, number>>((counts, item) => {
    const key = `${item.dataSourceId || 'shared'}:${item.category}:${item.title}`;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  return modules.value.map((item) => {
    const key = `${item.dataSourceId || 'shared'}:${item.category}:${item.title}`;
    return {
      ...item,
      displayTitle: titleCounts[key] > 1 ? `${item.title}（${item.key}）` : item.title
    };
  });
});
const referenceModuleOptions = computed(() => {
  const currentKey = moduleForm.id ? moduleForm.key : '';
  return referenceModules.value
    .filter((item) => item.category === 'project' && item.key !== currentKey)
    .map((item) => ({
      label: item.dataSourceId ? `${item.title}（${sourceNameById.value.get(item.dataSourceId) || '其他数据源'}）` : `${item.title}（公共模板）`,
      value: item.key
    }));
});
const isAdmin = computed(() => me.value?.role === 'admin');
const canUseNotification = computed(() => Boolean(me.value));
const personalNotificationChannel = computed(() => me.value?.platform === 'feishu' ? 'feishu_robot' : 'dingtalk_robot');
const personalNotificationPlatformText = computed(() => notificationChannelText(personalNotificationChannel.value));
const canShowDingTalkNotification = computed(() => isAdmin.value || me.value?.platform === 'dingtalk');
const canShowFeishuNotification = computed(() => isAdmin.value || me.value?.platform === 'feishu');
const userDialogTitle = computed(() => userDialogMode.value === 'create' ? '新增用户' : '用户管理');
const roleOptions: Array<{ label: string; value: Role }> = [
  { label: '管理员', value: 'admin' },
  { label: '编辑者', value: 'editor' },
  { label: '只读用户', value: 'viewer' }
];
const permissionSubjectOptions = computed(() => {
  if (permissionSubjectType.value === 'role') return roleOptions;
  return users.value.map((user) => ({ label: `${user.displayName}（${user.role}）`, value: String(user.id) }));
});
function formatShanghaiTime(value: unknown) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date).replace(/\//g, '-');
}

function platformText(value: unknown) {
  return value === 'feishu' ? '飞书' : '钉钉';
}

function syncDirectionText(value: unknown, platform?: unknown) {
  const target = platformText(platform);
  return value === 'push' ? `本地到${target}` : value === 'pull' ? `${target}到本地` : String(value || '-');
}

function syncStatusText(value: unknown) {
  const text = String(value || '');
  if (text === 'success') return '成功';
  if (text === 'failed') return '失败';
  if (text === 'running') return '运行中';
  if (text === 'skipped') return '已跳过';
  return text || '-';
}

function notificationChannelText(channel: string) {
  return channel === 'feishu_robot' ? '飞书' : '钉钉';
}

function notificationResultText(results: Array<{ channel: string; status: string; message?: string }> = []) {
  const successChannels = results
    .filter((item) => item.status === 'success')
    .map((item) => notificationChannelText(item.channel));
  const failedChannels = results
    .filter((item) => item.status === 'failed')
    .map((item) => `${notificationChannelText(item.channel)}失败${item.message ? `：${item.message}` : ''}`);
  return [
    successChannels.length ? `成功：${successChannels.join('、')}` : '',
    failedChannels.length ? failedChannels.join('；') : ''
  ].filter(Boolean).join('；');
}

function loginMethodText(row: ManagedUser) {
  if (row.loginMethod === 'both' || (row.hasLocalLogin && row.hasEnterpriseLogin)) return '双登录';
  if (row.loginMethod === 'local' || row.hasLocalLogin) return '本地账号';
  if (row.loginMethod === 'enterprise' || row.hasEnterpriseLogin) return '企业账号';
  return '未配置';
}

function loginMethodTagType(row: ManagedUser) {
  if (row.loginMethod === 'both' || (row.hasLocalLogin && row.hasEnterpriseLogin)) return 'success';
  if (row.loginMethod === 'local' || row.hasLocalLogin) return '';
  if (row.loginMethod === 'enterprise' || row.hasEnterpriseLogin) return 'info';
  return 'warning';
}

function identityProviderText(row: ManagedUser) {
  const providers = row.identityProviders || [];
  if (!providers.length) return '未绑定';
  return providers
    .map((provider) => provider === 'feishu' ? '飞书' : '钉钉')
    .join(' / ');
}

function emptySource(): DataSourceInstance {
  return {
    name: '',
    platform: 'dingtalk',
    enabled: true,
    sortOrder: 0,
    staffTemplateDataSourceId: null,
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
    referenceModuleKey: '',
    fields: defaultProjectFields()
  };
}

function emptyUserForm(): UserFormState {
  return {
    id: 0,
    username: '',
    loginName: '',
    displayName: '',
    role: 'viewer',
    enabled: true,
    defaultDataSourceId: null,
    password: '',
    confirmPassword: '',
    newPassword: '',
    confirmNewPassword: ''
  };
}

function assign<T extends object>(target: T, value: T) {
  Object.keys(target).forEach((key) => delete (target as any)[key]);
  Object.assign(target, JSON.parse(JSON.stringify(value)));
}
// 设置页启动时加载各管理面板数据，使首次加载后切换标签更快。
async function load() {
  loading.value = true;
  try {
    me.value = await getMe();
    const [sourceList, moduleList, referenceModuleList] = await Promise.all([
      getDataSourceInstances(undefined, true),
      getConfigModules(),
      getReferenceModules()
    ]);
    sources.value = sourceList;
    modules.value = moduleList;
    referenceModules.value = referenceModuleList;
    if (canUseNotification.value) await loadNotificationConfig();
    if (me.value.role === 'admin') {
      users.value = await getUsers();
      apiUsage.value = await getApiUsage('dingtalk');
      syncOverview.value = await getSyncOverview();
      Object.assign(dingTalkSyncForm, await getDingTalkSyncSettings());
      Object.assign(runtimeForm, await getRuntimeSettings());
      Object.assign(platformConfigForm, await getPlatformConfigs());
      if (!permissionSubjectId.value) permissionSubjectId.value = users.value[0] ? String(users.value[0].id) : 'admin';
      await loadPermissions();
    }
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '配置加载失败');
  } finally {
    loading.value = false;
  }
}

async function submitDingTalkSyncSettings() {
  syncSettingsSaving.value = true;
  try {
    Object.assign(dingTalkSyncForm, await saveDingTalkSyncSettings({
      ...dingTalkSyncForm,
      startupDelayMs: Number(dingTalkSyncForm.startupDelayMs) || 0
    }));
    ElMessage.success('钉钉同步设置已保存');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '同步设置保存失败');
  } finally {
    syncSettingsSaving.value = false;
  }
}

async function submitRuntimeSettings() {
  runtimeSettingsSaving.value = true;
  try {
    Object.assign(runtimeForm, await saveRuntimeSettings({
      publicBaseUrl: runtimeForm.publicBaseUrl.trim(),
      frontendBaseUrl: runtimeForm.frontendBaseUrl.trim(),
      oauthRequestTimeout: Number(runtimeForm.oauthRequestTimeout) || 12000,
      oauthRequestRetries: Number(runtimeForm.oauthRequestRetries) || 0
    }));
    ElMessage.success('运行配置已保存');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '运行配置保存失败');
  } finally {
    runtimeSettingsSaving.value = false;
  }
}

async function submitPlatformConfigs() {
  platformConfigsSaving.value = true;
  try {
    Object.assign(platformConfigForm, await savePlatformConfigs({
      dingtalk: {
        appKey: platformConfigForm.dingtalk.appKey.trim(),
        appSecret: platformConfigForm.dingtalk.appSecret.trim(),
        corpId: platformConfigForm.dingtalk.corpId.trim(),
        realmCorpId: platformConfigForm.dingtalk.realmCorpId.trim(),
        baseUrl: platformConfigForm.dingtalk.baseUrl.trim(),
        operatorId: platformConfigForm.dingtalk.operatorId.trim()
      },
      feishu: {
        appId: platformConfigForm.feishu.appId.trim(),
        appSecret: platformConfigForm.feishu.appSecret.trim(),
        baseUrl: platformConfigForm.feishu.baseUrl.trim()
      }
    }));
    ElMessage.success('平台配置已保存');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '平台配置保存失败');
  } finally {
    platformConfigsSaving.value = false;
  }
}

function useCurrentAccessBaseUrl() {
  const currentBaseUrl = window.location.origin;
  runtimeForm.publicBaseUrl = currentBaseUrl;
  runtimeForm.frontendBaseUrl = currentBaseUrl;
}

async function refreshUsage() {
  if (!isAdmin.value) return;
  const [usage, overview] = await Promise.all([
    getApiUsage('dingtalk'),
    getSyncOverview()
  ]);
  apiUsage.value = usage;
  syncOverview.value = overview;
}

async function clearDingTalkCache() {
  cacheRefreshing.value = true;
  try {
    const result = await refreshApiCache({ platform: 'dingtalk' });
    ElMessage.success(`钉钉缓存已清理：${result.removed} 条`);
    await refreshUsage();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '缓存清理失败');
  } finally {
    cacheRefreshing.value = false;
  }
}

async function syncDingTalkData() {
  dingTalkSyncing.value = true;
  try {
    const result = await syncDingTalkNow();
    ElMessage.success(result.message || '信息同步已开始，请稍后刷新同步记录');
    await refreshUsage();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '信息同步失败');
  } finally {
    dingTalkSyncing.value = false;
  }
}

async function loadNotificationConfig() {
  try {
    const settings = await getNotificationSettings();
    const userSettings = await getNotificationUserSettings();
    Object.assign(notificationForm, settings);
    notificationForm.dingtalkEnabled = Boolean(settings.dingtalkEnabled ?? settings.channel === 'dingtalk_robot');
    notificationForm.feishuEnabled = Boolean(settings.feishuEnabled ?? settings.channel === 'feishu_robot');
    Object.assign(notificationUserForm, userSettings);
    if (!notificationForm.keywords?.length) notificationForm.keywords = ['项目提醒'];
    notificationLogs.value = await getNotificationLogs();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '消息推送配置加载失败');
  }
}

async function submitNotificationUserSettings() {
  notificationUserSaving.value = true;
  try {
    Object.assign(notificationUserForm, await saveNotificationUserSettings(notificationUserForm));
    ElMessage.success('个人定时推送配置已保存');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '个人定时推送配置保存失败');
  } finally {
    notificationUserSaving.value = false;
  }
}

async function submitNotification() {
  notificationSaving.value = true;
  try {
    notificationForm.channel = notificationForm.feishuEnabled && !notificationForm.dingtalkEnabled ? 'feishu_robot' : 'dingtalk_robot';
    notificationForm.webhookUrl = notificationForm.channel === 'feishu_robot'
      ? notificationForm.feishuWebhookUrl.trim()
      : notificationForm.dingtalkWebhookUrl.trim();
    notificationForm.secret = notificationForm.channel === 'feishu_robot'
      ? notificationForm.feishuSecret.trim()
      : notificationForm.dingtalkSecret.trim();
    notificationForm.dingtalkWebhookUrl = notificationForm.dingtalkWebhookUrl.trim();
    notificationForm.dingtalkSecret = notificationForm.dingtalkSecret.trim();
    notificationForm.feishuWebhookUrl = notificationForm.feishuWebhookUrl.trim();
    notificationForm.feishuSecret = notificationForm.feishuSecret.trim();
    notificationForm.keywords = notificationForm.keywords.map((item) => item.trim()).filter(Boolean);
    if (!notificationForm.keywords.length) notificationForm.keywords = ['项目提醒'];
    Object.assign(notificationForm, await saveNotificationSettings(notificationForm));
    ElMessage.success('消息推送配置已保存');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '消息推送配置保存失败');
  } finally {
    notificationSaving.value = false;
  }
}

function addNotificationKeyword() {
  notificationForm.keywords.push('');
}

function removeNotificationKeyword(index: number) {
  notificationForm.keywords.splice(index, 1);
  if (!notificationForm.keywords.length) notificationForm.keywords.push('');
}

async function testNotification() {
  notificationTesting.value = true;
  try {
    const result = await sendNotificationTest();
    ElMessage.success(notificationResultText(result.result.results) || '测试消息已发送');
    await loadNotificationConfig();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '测试消息发送失败');
  } finally {
    notificationTesting.value = false;
  }
}

async function pushNotificationNow() {
  notificationPushing.value = true;
  try {
    const result = await pushDashboardNotification();
    const platformText = notificationResultText(result.results) || '推送完成';
    ElMessage.success(`${platformText}；开发中 ${result.summary.developing}，测试中 ${result.summary.testing}`);
    await loadNotificationConfig();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '推送失败');
  } finally {
    notificationPushing.value = false;
  }
}

async function refreshNotificationLogs() {
  try {
    notificationLogs.value = await getNotificationLogs();
    ElMessage.success('推送记录已刷新');
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '推送记录刷新失败');
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
  sourceForm.staffTemplateDataSourceId = me.value?.dataSourceId || sources.value.find((item) => item.id)?.id || null;
  sourceDialogOpen.value = true;
}

function openSourceEdit(row: DataSourceInstance) {
  assign(sourceForm, { ...row, config: { ...emptySource().config, ...row.config } });
  sourceForm.staffTemplateDataSourceId = null;
  sourceDialogOpen.value = true;
}
// 保存数据源配置后，刷新依赖它的模块和用户选项列表。
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

async function initializeStaffForSource(row: DataSourceInstance) {
  if (!row.id) return;
  const templateId = sources.value.find((item) => item.id && item.id !== row.id && item.id === me.value?.dataSourceId)?.id
    || sources.value.find((item) => item.id && item.id !== row.id)?.id;
  if (!templateId) {
    ElMessage.warning('暂无可用的人员模板来源');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `会用「${sourceNameById.value.get(templateId) || '模板数据源'}」的人员分组覆盖「${row.name}」，确认继续？`,
      '初始化人员配置',
      { type: 'warning' }
    );
    const result = await initializeStaffAssignments(templateId, row.id);
    ElMessage.success(`人员配置初始化完成，复制 ${result.copied || 0} 条角色记录`);
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '初始化人员配置失败');
  }
}

function openModuleCreate() {
  assign(moduleForm, emptyModule());
  moduleForm.dataSourceId = me.value?.dataSourceId;
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
// 从参考模块复制字段，用于快速创建相似的项目模块。
function applyReferenceModule(referenceModuleKey?: string) {
  const source = referenceModules.value.find((item) => item.key === referenceModuleKey);
  if (!source) return;
  moduleForm.category = source.category;
  moduleForm.headerRow = source.headerRow;
  moduleForm.dataStartRow = source.dataStartRow;
  moduleForm.editable = source.editable;
  moduleForm.fields = JSON.parse(JSON.stringify(source.fields));
}
// 先持久化模块元数据，再按保存后的模块 id 写入有序字段列表。
async function submitModule() {
  try {
    const moduleKey = String(moduleForm.key || '').trim();
    if (!moduleKey) {
      ElMessage.error('请填写模块 key');
      return;
    }
    const duplicate = modules.value.find((item) => item.key === moduleKey && item.id !== moduleForm.id);
    if (duplicate) {
      ElMessage.error(`模块 key 已存在：${moduleKey}`);
      return;
    }
    const moduleTitle = String(moduleForm.title || '').trim();
    const duplicateTitle = modules.value.find((item) =>
      item.id !== moduleForm.id
      && item.title === moduleTitle
      && item.category === moduleForm.category
      && (item.dataSourceId || undefined) === (moduleForm.dataSourceId || undefined)
    );
    if (duplicateTitle) {
      ElMessage.error(`同一数据源下模块名称已存在：${moduleTitle}`);
      return;
    }
    moduleForm.title = moduleTitle;
    moduleForm.key = moduleKey;
    moduleForm.referenceModuleKey = moduleForm.referenceModuleKey || undefined;
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
  userDialogMode.value = 'edit';
  Object.assign(userForm, {
    id: row.id,
    username: row.username,
    loginName: row.loginName || '',
    displayName: row.displayName,
    role: row.role,
    enabled: row.enabled,
    defaultDataSourceId: row.defaultDataSourceId || null,
    password: '',
    confirmPassword: '',
    newPassword: '',
    confirmNewPassword: ''
  });
  userDialogOpen.value = true;
}

function openUserCreate() {
  userDialogMode.value = 'create';
  Object.assign(userForm, emptyUserForm());
  userDialogOpen.value = true;
}
// 用户保存逻辑覆盖新增/编辑、可选密码变更、启用状态、角色和默认数据源。
async function submitUser() {
  try {
    const displayName = userForm.displayName.trim();
    if (!displayName) {
      ElMessage.warning('请填写显示名称');
      return;
    }

    const loginName = userForm.loginName.trim();
    if (!/^[A-Za-z0-9_.-]{3,50}$/.test(loginName)) {
      ElMessage.warning('登录账号需为 3-50 位字母、数字、下划线、点或短横线');
      return;
    }

    if (userDialogMode.value === 'create') {
      if (!userForm.password.trim() || userForm.password.length < 6) {
        ElMessage.warning('初始密码至少 6 位');
        return;
      }
      if (userForm.password !== userForm.confirmPassword) {
        ElMessage.warning('两次输入的密码不一致');
        return;
      }
      await createManagedUser({
        loginName,
        password: userForm.password,
        displayName,
        role: userForm.role,
        enabled: userForm.enabled,
        defaultDataSourceId: userForm.defaultDataSourceId
      });
      ElMessage.success('用户已创建。如登录页未显示账号密码登录，请在数据源实例中启用备用登录');
    } else {
      const newPassword = userForm.newPassword.trim() ? userForm.newPassword : undefined;
      if (newPassword && newPassword.length < 6) {
        ElMessage.warning('新密码至少 6 位');
        return;
      }
      if (newPassword && newPassword !== userForm.confirmNewPassword) {
        ElMessage.warning('两次输入的新密码不一致');
        return;
      }
      await updateManagedUser({
        id: userForm.id,
        loginName,
        displayName,
        role: userForm.role,
        enabled: userForm.enabled,
        defaultDataSourceId: userForm.defaultDataSourceId,
        newPassword
      });
      ElMessage.success(newPassword
        ? `用户已保存，密码已修改。请使用登录账号 ${loginName} 和新密码登录`
        : '用户已保存');
    }
    userDialogOpen.value = false;
    load();
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '保存失败');
  }
}

async function toggleSourceEnabled(row: DataSourceInstance) {
  if (!row.id) return;
  const nextEnabled = !row.enabled;
  try {
    await ElMessageBox.confirm(
      `确认${nextEnabled ? '启用' : '停用'}这个数据源实例？`,
      `${nextEnabled ? '启用' : '停用'}确认`,
      { type: 'warning' }
    );
    await saveDataSourceInstance({ ...row, enabled: nextEnabled });
    ElMessage.success(`已${nextEnabled ? '启用' : '停用'}`);
    load();
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || `${nextEnabled ? '启用' : '停用'}失败`);
  }
}

async function hardRemoveSource(row: DataSourceInstance) {
  if (!row.id) return;
  try {
    await ElMessageBox.confirm(
      `确认永久删除「${row.name}」？此操作会删除该数据源下的模块配置、本地数据、同步记录和缓存，无法恢复。`,
      '永久删除确认',
      { type: 'error', confirmButtonText: '永久删除' }
    );
    await hardDeleteDataSourceInstance(row.id);
    ElMessage.success('已永久删除');
    load();
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '永久删除失败');
  }
}

async function resetUserPassword() {
  if (userDialogMode.value !== 'edit' || !userForm.id) return;
  const loginName = userForm.loginName.trim();
  if (!/^[A-Za-z0-9_.-]{3,50}$/.test(loginName)) {
    ElMessage.warning('登录账号需为 3-50 位字母、数字、下划线、点或短横线');
    return;
  }
  try {
    await ElMessageBox.confirm('确认将该用户密码重置为默认密码 123456？', '重置密码', { type: 'warning' });
    await updateManagedUser({
      id: userForm.id,
      loginName,
      displayName: userForm.displayName.trim(),
      role: userForm.role,
      enabled: userForm.enabled,
      defaultDataSourceId: userForm.defaultDataSourceId,
      resetPassword: true
    });
    ElMessage.success(`密码已重置为默认密码 123456，请使用登录账号 ${loginName} 登录`);
    userForm.newPassword = '';
    userForm.confirmNewPassword = '';
    userDialogOpen.value = false;
    load();
  } catch (error: any) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '重置密码失败');
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
            <el-table-column prop="name" label="实例名称" min-width="220">
              <template #default="{ row }">
                <span class="source-name-cell">
                  <span>{{ row.name }}</span>
                  <el-tag v-if="row.id === me?.dataSourceId" size="small" type="success">当前使用</el-tag>
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="platform" label="平台" width="110">
              <template #default="{ row }">{{ row.platform === 'feishu' ? '飞书' : '钉钉' }}</template>
            </el-table-column>
            <el-table-column prop="enabled" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="sortOrder" label="排序" width="90" />
            <el-table-column label="操作" width="310">
              <template #default="{ row }">
                <el-button v-if="isAdmin" size="small" @click="initializeStaffForSource(row)">初始化人员</el-button>
                <el-button :icon="Edit" circle @click="openSourceEdit(row)" />
                <el-button size="small" :type="row.enabled ? 'warning' : 'success'" @click="toggleSourceEnabled(row)">
                  {{ row.enabled ? '停用' : '启用' }}
                </el-button>
                <el-button :icon="Delete" circle type="danger" @click="hardRemoveSource(row)" />
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane v-if="isAdmin" label="接口与同步" name="api-usage">
          <section class="dashboard-section">
            <div class="section-heading">
              <h2>运行配置</h2>
              <span>留空时自动跟随当前访问地址，适合 WSL IP 变化场景。</span>
            </div>
            <el-form label-position="top" class="sync-settings-form">
              <div class="sync-settings-grid">
                <el-form-item label="对外访问地址">
                  <el-input v-model="runtimeForm.publicBaseUrl" placeholder="http://172.23.74.232:8888" />
                </el-form-item>
                <el-form-item label="前端访问地址">
                  <el-input v-model="runtimeForm.frontendBaseUrl" placeholder="http://172.23.74.232:8888" />
                </el-form-item>
                <el-form-item label="OAuth 超时时间(毫秒)">
                  <el-input-number v-model="runtimeForm.oauthRequestTimeout" class="full-field" :min="1000" :max="60000" :step="1000" />
                </el-form-item>
                <el-form-item label="OAuth 重试次数">
                  <el-input-number v-model="runtimeForm.oauthRequestRetries" class="full-field" :min="0" :max="5" />
                </el-form-item>
              </div>
              <div class="settings-actions">
                <el-button @click="useCurrentAccessBaseUrl">使用当前访问地址</el-button>
                <el-button type="primary" :loading="runtimeSettingsSaving" @click="submitRuntimeSettings">保存运行配置</el-button>
              </div>
              <div class="field-help">当前解析：{{ runtimeForm.resolvedPublicBaseUrl || '-' }} / {{ runtimeForm.resolvedFrontendBaseUrl || '-' }}</div>
            </el-form>
          </section>
          <section class="dashboard-section">
            <div class="section-heading">
              <h2>平台配置</h2>
              <span>维护钉钉、飞书应用级公共信息，新增数据源实例时不需要重复填写。</span>
            </div>
            <el-form label-position="top" class="sync-settings-form">
              <h3 class="form-subtitle">钉钉应用</h3>
              <div class="sync-settings-grid">
                <el-form-item label="AppKey / Client ID">
                  <el-input v-model="platformConfigForm.dingtalk.appKey" />
                </el-form-item>
                <el-form-item label="AppSecret / Client Secret">
                  <el-input v-model="platformConfigForm.dingtalk.appSecret" show-password />
                </el-form-item>
                <el-form-item label="企业 CorpId">
                  <el-input v-model="platformConfigForm.dingtalk.corpId" placeholder="可选，建议填写" />
                </el-form-item>
                <el-form-item label="Realm CorpId">
                  <el-input v-model="platformConfigForm.dingtalk.realmCorpId" placeholder="可选，通常与 CorpId 一致" />
                </el-form-item>
                <el-form-item label="接口 BaseUrl">
                  <el-input v-model="platformConfigForm.dingtalk.baseUrl" placeholder="https://api.dingtalk.com" />
                </el-form-item>
                <el-form-item label="备用 OperatorId">
                  <el-input v-model="platformConfigForm.dingtalk.operatorId" placeholder="可不填，优先使用登录用户身份" />
                </el-form-item>
              </div>
              <h3 class="form-subtitle">飞书应用</h3>
              <div class="sync-settings-grid">
                <el-form-item label="AppId">
                  <el-input v-model="platformConfigForm.feishu.appId" />
                </el-form-item>
                <el-form-item label="AppSecret">
                  <el-input v-model="platformConfigForm.feishu.appSecret" show-password />
                </el-form-item>
                <el-form-item label="接口 BaseUrl">
                  <el-input v-model="platformConfigForm.feishu.baseUrl" placeholder="https://open.feishu.cn" />
                </el-form-item>
              </div>
              <el-button type="primary" :loading="platformConfigsSaving" @click="submitPlatformConfigs">保存平台配置</el-button>
            </el-form>
          </section>
          <div class="settings-actions">
            <el-button :icon="Refresh" @click="refreshUsage">刷新统计</el-button>
            <el-button type="warning" :loading="cacheRefreshing" @click="clearDingTalkCache">清理表格缓存</el-button>
            <el-button type="primary" :loading="dingTalkSyncing" @click="syncDingTalkData">立即同步信息</el-button>
          </div>
          <section class="dashboard-section">
            <div class="section-heading">
              <h2>信息定时同步</h2>
              <span>配置从钉钉或飞书定时同步表格数据；企业成员同步当前仍只支持钉钉。</span>
            </div>
            <el-form label-position="top" class="sync-settings-form">
              <div class="sync-settings-grid">
                <el-form-item label="启用定时同步">
                  <el-switch v-model="dingTalkSyncForm.enabled" />
                </el-form-item>
                <el-form-item label="启用钉钉同步">
                  <el-switch v-model="dingTalkSyncForm.dingtalkEnabled" :disabled="!dingTalkSyncForm.enabled" />
                </el-form-item>
                <el-form-item label="启用飞书同步">
                  <el-switch v-model="dingTalkSyncForm.feishuEnabled" :disabled="!dingTalkSyncForm.enabled" />
                </el-form-item>
                <el-form-item label="每日同步时间">
                  <el-time-picker
                    v-model="dingTalkSyncForm.scheduledTime"
                    class="full-field"
                    format="HH:mm"
                    value-format="HH:mm"
                    :disabled="!dingTalkSyncForm.enabled"
                  />
                </el-form-item>
                <el-form-item label="启动后自动同步">
                  <el-switch v-model="dingTalkSyncForm.startupSyncEnabled" />
                </el-form-item>
                <el-form-item label="启动延迟（毫秒）">
                  <el-input-number v-model="dingTalkSyncForm.startupDelayMs" class="full-field" :min="0" :max="3600000" :step="1000" />
                </el-form-item>
              </div>
              <el-button type="primary" :loading="syncSettingsSaving" @click="submitDingTalkSyncSettings">保存同步设置</el-button>
            </el-form>
          </section>
          <section class="compact-kpi-grid">
            <article>
              <span>本地今日调用</span>
              <strong>{{ apiUsage?.todayCalls || 0 }}</strong>
              <small>缓存命中 {{ apiUsage?.todayCacheHits || 0 }}</small>
            </article>
            <article>
              <span>本地本月调用</span>
              <strong>{{ apiUsage?.monthCalls || 0 }}</strong>
              <small>本月额度 {{ apiUsage?.monthlyWarnLimit || 0 }}，每月重置</small>
            </article>
            <article>
              <span>失败次数</span>
              <strong>{{ apiUsage?.monthFailures || 0 }}</strong>
              <small>超时 {{ apiUsage?.monthTimeouts || 0 }}</small>
            </article>
            <article>
              <span>缓存命中率</span>
              <strong>{{ apiUsage?.cacheHitRate || 0 }}%</strong>
              <small>状态 {{ apiUsage?.warnLevel || '正常' }}</small>
            </article>
          </section>
          <section class="dashboard-section">
            <div class="section-heading">
              <h2>本地数据同步</h2>
              <span>查看本地数据是否已经推送到对应平台表格。</span>
            </div>
            <section class="compact-kpi-grid">
              <article><span>本地行数</span><strong>{{ syncOverview?.rows.total || 0 }}</strong><small>全部模块</small></article>
              <article><span>已同步</span><strong>{{ syncOverview?.rows.synced || 0 }}</strong><small>已写入平台</small></article>
              <article><span>待同步</span><strong>{{ syncOverview?.rows.pending || 0 }}</strong><small>等待推送</small></article>
              <article><span>失败</span><strong>{{ syncOverview?.rows.failed || 0 }}</strong><small>需要重试或检查</small></article>
            </section>
          </section>
          <section class="dashboard-section">
            <div class="section-heading">
              <h2>表格同步任务</h2>
              <span>最近从钉钉或飞书同步到本地数据库的定时或手动记录。</span>
            </div>
            <el-table :data="syncOverview?.jobs || []" stripe>
              <el-table-column label="开始时间" min-width="190">
                <template #default="{ row }">{{ formatShanghaiTime(row.started_at) }}</template>
              </el-table-column>
              <el-table-column label="平台" width="100">
                <template #default="{ row }">{{ platformText(row.platform) }}</template>
              </el-table-column>
              <el-table-column prop="module_key" label="模块" min-width="150" />
              <el-table-column label="方向" width="120">
                <template #default="{ row }">{{ syncDirectionText(row.direction, row.platform) }}</template>
              </el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }">{{ syncStatusText(row.status) }}</template>
              </el-table-column>
              <el-table-column prop="total_rows" label="行数" width="90" />
              <el-table-column prop="message" label="说明" min-width="220" />
            </el-table>
          </section>
          <section class="dashboard-section">
            <div class="section-heading">
              <h2>企业成员同步</h2>
              <span>查看钉钉用户数据是否已经同步到本地用户。</span>
            </div>
            <el-table :data="syncOverview?.memberLogs || []" stripe>
              <el-table-column label="时间" min-width="190">
                <template #default="{ row }">{{ formatShanghaiTime(row.created_at) }}</template>
              </el-table-column>
              <el-table-column prop="provider" label="平台" width="110" />
              <el-table-column label="状态" width="100">
                <template #default="{ row }">{{ syncStatusText(row.status) }}</template>
              </el-table-column>
              <el-table-column prop="total" label="总数" width="90" />
              <el-table-column prop="created" label="新增" width="90" />
              <el-table-column prop="updated" label="更新" width="90" />
              <el-table-column prop="message" label="说明" min-width="220" />
            </el-table>
          </section>
        </el-tab-pane>

        <el-tab-pane label="模块配置" name="modules">
          <div class="settings-actions">
            <el-button type="primary" :icon="Plus" @click="openModuleCreate">新增模块</el-button>
          </div>
          <el-table :data="moduleRowsWithLabels" stripe>
            <el-table-column prop="displayTitle" label="模块名称" min-width="200" />
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

        <el-tab-pane v-if="canUseNotification" label="消息推送" name="notification">
          <div class="notification-settings">
            <div class="subsection-title">机器人配置</div>
            <el-form label-position="top">
              <div class="notification-schedule-grid">
                <el-form-item label="启用定时推送">
                  <el-switch v-model="notificationForm.enabled" :disabled="!isAdmin" />
                </el-form-item>
                <el-form-item label="每日推送时间">
                  <el-time-picker
                    v-model="notificationForm.scheduledTime"
                    class="full-field"
                    format="HH:mm"
                    value-format="HH:mm"
                    :disabled="!isAdmin"
                  />
                </el-form-item>
              </div>
              <div class="notification-channel-grid">
                <section v-if="canShowDingTalkNotification" class="notification-channel-panel">
                  <div class="notification-channel-header">
                    <div>
                      <strong>钉钉机器人</strong>
                      <span>发送到钉钉群自定义机器人</span>
                    </div>
                    <el-switch v-model="notificationForm.dingtalkEnabled" :disabled="!isAdmin" />
                  </div>
                  <el-form-item label="Webhook">
                    <el-input
                      v-model="notificationForm.dingtalkWebhookUrl"
                      :disabled="!isAdmin"
                      placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
                    />
                  </el-form-item>
                  <el-form-item label="加签 Secret">
                    <el-input
                      v-model="notificationForm.dingtalkSecret"
                      :disabled="!isAdmin"
                      show-password
                      placeholder="SEC..."
                    />
                  </el-form-item>
                </section>
                <section v-if="canShowFeishuNotification" class="notification-channel-panel">
                  <div class="notification-channel-header">
                    <div>
                      <strong>飞书机器人</strong>
                      <span>发送到飞书群自定义机器人</span>
                    </div>
                    <el-switch v-model="notificationForm.feishuEnabled" :disabled="!isAdmin" />
                  </div>
                  <el-form-item label="Webhook">
                    <el-input
                      v-model="notificationForm.feishuWebhookUrl"
                      :disabled="!isAdmin"
                      placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                    />
                  </el-form-item>
                  <el-form-item label="加签 Secret">
                    <el-input
                      v-model="notificationForm.feishuSecret"
                      :disabled="!isAdmin"
                      show-password
                      placeholder="飞书机器人开启签名校验时填写"
                    />
                  </el-form-item>
                </section>
              </div>
              <el-form-item label="自定义关键词" class="notification-keyword-form">
                  <div class="keyword-list">
                    <div v-for="(_keyword, index) in notificationForm.keywords" :key="index" class="keyword-row">
                      <el-input v-model="notificationForm.keywords[index]" :disabled="!isAdmin" placeholder="例如：项目提醒" />
                      <el-button :icon="Delete" circle :disabled="!isAdmin || notificationForm.keywords.length <= 1" @click="removeNotificationKeyword(index)" />
                    </div>
                    <el-button v-if="isAdmin" size="small" :icon="Plus" @click="addNotificationKeyword">新增关键词</el-button>
                  </div>
              </el-form-item>
            </el-form>
            <el-alert
              v-if="!isAdmin"
              type="info"
              :closable="false"
              title="消息机器人 Webhook 和加签密钥由管理员统一维护，你可以配置个人定时推送并立即推送自己的任务汇总。"
            />
            <div class="subsection-title">个人定时推送</div>
            <el-alert
              class="notification-platform-alert"
              type="info"
              :closable="false"
              :title="`个人推送平台：${personalNotificationPlatformText}机器人。个人立即推送和个人定时推送只会发送到当前登录平台。`"
            />
            <el-form label-position="top">
              <div class="form-grid">
                <el-form-item label="启用个人定时推送">
                  <el-switch v-model="notificationUserForm.enabled" />
                </el-form-item>
                <el-form-item label="个人每日推送时间">
                  <el-time-picker
                    v-model="notificationUserForm.scheduledTime"
                    class="full-field"
                    format="HH:mm"
                    value-format="HH:mm"
                  />
                </el-form-item>
              </div>
            </el-form>
            <div class="settings-actions notification-actions">
              <el-button v-if="isAdmin" type="primary" :loading="notificationSaving" @click="submitNotification">保存配置</el-button>
              <el-button type="primary" plain :loading="notificationUserSaving" @click="submitNotificationUserSettings">保存个人定时</el-button>
              <el-button v-if="isAdmin" :loading="notificationTesting" @click="testNotification">发送测试消息</el-button>
              <el-button type="success" :icon="Bell" :loading="notificationPushing" @click="pushNotificationNow">立即推送到{{ personalNotificationPlatformText }}</el-button>
              <el-button :icon="Refresh" @click="refreshNotificationLogs">刷新推送记录</el-button>
            </div>
            <el-alert
              type="info"
              :closable="false"
              title="管理员推送全部任务汇总；非管理员只推送研发人员为自己的开发中/测试中任务。"
            />
            <el-table :data="notificationLogs" stripe class="notification-log-table">
              <el-table-column prop="createdAtText" label="时间" min-width="170" />
              <el-table-column v-if="isAdmin" prop="user_display_name" label="推送人" min-width="120">
                <template #default="{ row }">
                  {{ row.user_display_name || row.user_id || '-' }}
                </template>
              </el-table-column>
              <el-table-column prop="actionText" label="类型" width="130" />
              <el-table-column label="平台" width="100">
                <template #default="{ row }">
                  {{ notificationChannelText(row.channel) }}
                </template>
              </el-table-column>
              <el-table-column prop="status" label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="row.status === 'success' ? 'success' : 'danger'">{{ row.status }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="message" label="消息" min-width="240" />
            </el-table>
          </div>
        </el-tab-pane>

        <el-tab-pane v-if="isAdmin" label="用户管理" name="users">
          <div class="toolbar permission-toolbar">
            <el-button type="primary" :icon="Plus" @click="openUserCreate">新增用户</el-button>
            <el-button type="primary" :loading="syncingMembers" @click="syncMembers">同步企业成员</el-button>
          </div>
          <el-table :data="users" stripe>
            <el-table-column prop="displayName" label="显示名称" min-width="150" />
            <el-table-column label="登录账号" min-width="180">
              <template #default="{ row }">{{ row.loginName || '-' }}</template>
            </el-table-column>
            <el-table-column label="企业身份" width="130">
              <template #default="{ row }">
                <el-tag :type="row.hasEnterpriseLogin ? 'success' : 'info'" size="small">
                  {{ identityProviderText(row) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="role" label="角色" width="110" />
            <el-table-column label="登录方式" width="120">
              <template #default="{ row }">
                <el-tag :type="loginMethodTagType(row)" size="small">{{ loginMethodText(row) }}</el-tag>
              </template>
            </el-table-column>
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
        <div class="source-section-title">实例信息</div>
        <div class="form-grid">
          <el-form-item label="实例名称" required>
            <el-input v-model="sourceForm.name" placeholder="例如：钉钉-项目管理表" />
            <div class="field-help">登录、模块绑定和用户默认数据源中展示的名称，建议写清平台和用途。</div>
          </el-form-item>
          <el-form-item label="平台" required>
            <el-select v-model="sourceForm.platform" class="full-field">
              <el-option label="钉钉" value="dingtalk" />
              <el-option label="飞书" value="feishu" />
            </el-select>
            <div class="field-help">选择该实例使用的表格平台，平台不同，需要填写的接入信息也不同。</div>
          </el-form-item>
          <el-form-item v-if="!sourceForm.id" label="人员模板来源">
            <el-select v-model="sourceForm.staffTemplateDataSourceId" class="full-field" clearable filterable placeholder="选择要复制的人员分组">
              <el-option v-for="item in staffTemplateOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <div class="field-help">新建数据源后，会复制该数据源下的产品、测试、研发人员分组；为空则创建空人员配置。</div>
          </el-form-item>
        </div>
        <template v-if="isAdmin">
          <div class="source-section-title">基础配置</div>
          <el-alert
            class="source-help"
            type="info"
            :closable="false"
            title="基础配置用于控制这个数据源实例是否可用、登录方式以及排序。普通用户只使用管理员配置好的实例，不需要维护这些公共信息。"
          />
          <div class="form-grid">
            <el-form-item label="排序">
              <el-input-number v-model="sourceForm.sortOrder" class="full-field" />
              <div class="field-help">数字越小越靠前，用于登录页和配置列表排序。</div>
            </el-form-item>
            <el-form-item label="启用">
              <el-switch v-model="sourceForm.enabled" />
              <div class="field-help">停用后该数据源不会出现在登录和业务读取中。</div>
            </el-form-item>
            <el-form-item label="启用备用登录">
              <el-select v-model="sourceForm.config.localLoginEnabled" class="full-field">
                <el-option label="启用" value="true" />
                <el-option label="停用" value="false" />
              </el-select>
              <div class="field-help">是否允许账号密码登录。建议只在管理员应急维护时开启。</div>
            </el-form-item>
            <el-form-item label="启用企业登录">
              <el-select v-model="sourceForm.config.loginEnabled" class="full-field">
                <el-option label="启用" value="true" />
                <el-option label="停用" value="false" />
              </el-select>
              <div class="field-help">是否允许使用钉钉或飞书登录进入系统。</div>
            </el-form-item>
            <el-form-item label="OAuth 回调地址">
              <el-input v-model="sourceForm.config.redirectUri" placeholder="不填则使用后端默认 callback" />
              <div class="field-help">只有需要覆盖后端环境变量时才填写；一般本地和部署环境分别用 .env 控制即可。</div>
            </el-form-item>
          </div>
        </template>
        <div class="source-section-title">平台接入配置</div>
        <el-alert
          class="source-help"
          type="success"
          :closable="false"
          :title="sourceForm.platform === 'dingtalk'
            ? '钉钉配置来自钉钉开放平台企业内部应用，以及需要读取的在线表格链接。'
            : '飞书配置来自飞书开放平台应用，以及需要读取的电子表格链接。'"
        />
        <div class="form-grid">
          <template v-if="sourceForm.platform === 'dingtalk'">
            <el-form-item label="钉钉表格 WorkbookId">
              <el-input v-model="sourceForm.config.workbookId" />
              <div class="field-help">每个数据源实例不同的在线表格工作簿 ID；AppKey、AppSecret、CorpId 会自动继承同平台已有配置。</div>
            </el-form-item>
          </template>
          <template v-else>
            <el-form-item label="电子表格 Token">
              <el-input v-model="sourceForm.config.spreadsheetToken" />
              <div class="field-help">每个数据源实例不同的飞书电子表格 token；AppId、AppSecret 会自动继承同平台已有配置。</div>
            </el-form-item>
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
          <el-form-item v-if="!moduleForm.id" label="参考模块">
            <el-select
              v-model="moduleForm.referenceModuleKey"
              class="full-field"
              clearable
              filterable
              placeholder="选择已有项目模块作为字段和公式参考"
              @change="applyReferenceModule"
            >
              <el-option v-for="item in referenceModuleOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <div class="field-help">仅在创建时复制字段配置和公式来源；保存后新模块可独立维护。</div>
          </el-form-item>
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

    <el-dialog v-model="userDialogOpen" :title="userDialogTitle" width="560px">
      <el-form label-position="top">
        <el-form-item label="登录账号" required>
          <el-input v-model="userForm.loginName" placeholder="3-50 位字母、数字、下划线、点或短横线" />
          <div class="field-help">用于账号密码登录，可由管理员修改。</div>
        </el-form-item>
        <el-form-item label="显示名称" required><el-input v-model="userForm.displayName" /></el-form-item>
        <template v-if="userDialogMode === 'create'">
          <el-form-item label="初始密码" required>
            <el-input v-model="userForm.password" type="password" show-password placeholder="至少 6 位" />
          </el-form-item>
          <el-form-item label="确认密码" required>
            <el-input v-model="userForm.confirmPassword" type="password" show-password placeholder="再次输入初始密码" />
          </el-form-item>
        </template>
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
        <template v-if="userDialogMode === 'edit'">
          <el-form-item label="修改密码">
            <el-input v-model="userForm.newPassword" type="password" show-password placeholder="为空则不修改密码" />
            <div class="field-help">填写后保存，即可把该用户密码修改为这里输入的新密码。</div>
          </el-form-item>
          <el-form-item v-if="userForm.newPassword" label="确认新密码">
            <el-input v-model="userForm.confirmNewPassword" type="password" show-password placeholder="再次输入新密码" />
          </el-form-item>
          <el-form-item label="重置密码">
            <el-button type="warning" plain @click="resetUserPassword">重置为默认密码 123456</el-button>
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="userDialogOpen = false">取消</el-button>
        <el-button type="primary" @click="submitUser">保存</el-button>
      </template>
    </el-dialog>
  </main>
</template>
