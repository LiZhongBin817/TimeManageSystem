export type Role = 'admin' | 'editor' | 'viewer';

export type ModuleKey =
  | 'dashboard'
  | 'power-standard'
  | 'sales-standard'
  | 'crawler'
  | 'province-system'
  | 'staff'
  | 'todos';

export interface ModuleField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'status' | 'link' | 'staff';
  required?: boolean;
  staffRole?: 'product' | 'tester' | 'developer';
}

export interface ModuleConfig {
  key: ModuleKey;
  title: string;
  sheetName: string;
  sheetId?: string;
  headerRow: number;
  dataStartRow: number;
  editable: boolean;
  fields: ModuleField[];
}

const standardFields: ModuleField[] = [
  { key: 'sequence', label: '序号', type: 'number', required: true },
  { key: 'branchName', label: '分支名称', type: 'text' },
  { key: 'content', label: '内容', type: 'text' },
  { key: 'zentaoLink', label: '禅道链接', type: 'link' },
  { key: 'isCompleted', label: '是否完成', type: 'status' },
  { key: 'plannedTestAt', label: '计划提测时间', type: 'date' },
  { key: 'actualTestAt', label: '实际提测时间', type: 'date' },
  { key: 'launchAt', label: '上线时间', type: 'date' },
  { key: 'developer', label: '研发人员', type: 'staff', staffRole: 'developer' },
  { key: 'productOwner', label: '产品人员', type: 'staff', staffRole: 'product' },
  { key: 'tester', label: '测试人员', type: 'staff', staffRole: 'tester' },
  { key: 'name', label: '名称', type: 'text' },
  { key: 'remark', label: '备注', type: 'text' }
];

const staffFields: ModuleField[] = [
  { key: 'productOwner', label: '产品人员', type: 'text' },
  { key: 'tester', label: '测试人员', type: 'text' },
  { key: 'developer', label: '开发人员', type: 'text' }
];

export const modules: ModuleConfig[] = [
  {
    key: 'power-standard',
    title: '发电标准版',
    sheetName: '发电标准版',
    sheetId: 's2',
    headerRow: 1,
    dataStartRow: 2,
    editable: true,
    fields: standardFields
  },
  {
    key: 'sales-standard',
    title: '售电标准版',
    sheetName: '售电标准版',
    sheetId: 's3',
    headerRow: 1,
    dataStartRow: 2,
    editable: true,
    fields: standardFields
  },
  {
    key: 'crawler',
    title: '爬虫',
    sheetName: '爬虫',
    sheetId: 's4',
    headerRow: 1,
    dataStartRow: 2,
    editable: true,
    fields: standardFields
  },
  {
    key: 'province-system',
    title: '分省系统',
    sheetName: '分省系统',
    sheetId: 's5',
    headerRow: 1,
    dataStartRow: 2,
    editable: true,
    fields: standardFields
  },
  {
    key: 'staff',
    title: '人员信息',
    sheetName: '人员信息',
    sheetId: 's6',
    headerRow: 1,
    dataStartRow: 2,
    editable: true,
    fields: staffFields
  },
  {
    key: 'todos',
    title: '待办事项',
    sheetName: '待办事项',
    sheetId: 's8',
    headerRow: 1,
    dataStartRow: 2,
    editable: true,
    fields: standardFields
  }
];

export const rolePermissions: Record<Role, { editableModules: ModuleKey[] | 'all'; readableModules: ModuleKey[] | 'all' }> = {
  admin: { readableModules: 'all', editableModules: 'all' },
  editor: {
    readableModules: 'all',
    editableModules: ['power-standard', 'sales-standard', 'crawler', 'province-system', 'staff', 'todos']
  },
  viewer: { readableModules: 'all', editableModules: [] }
};

export function findModule(key: string) {
  return modules.find((item) => item.key === key);
}

export function canRead(role: Role, moduleKey: ModuleKey) {
  const readable = rolePermissions[role].readableModules;
  return readable === 'all' || readable.includes(moduleKey);
}

export function canEdit(role: Role, moduleKey: ModuleKey) {
  const editable = rolePermissions[role].editableModules;
  return editable === 'all' || editable.includes(moduleKey);
}
