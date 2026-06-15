/**
 * 兼容性转出：保留旧导入路径使用的模块配置 API。
 */
export type {
  Role,
  ModuleField,
  ModuleConfig,
  DataSourceInstance,
  ModuleCategory
} from './configStore';

export {
  canConfigure,
  canEdit,
  canRead,
  findModule,
  getDataSource,
  hardDeleteDataSource,
  listDataSources,
  listModules,
  replaceModuleFields,
  rolePermissions,
  saveDataSource,
  saveModule,
  updateModuleSheetId
} from './configStore';

export type ModuleKey = string;
