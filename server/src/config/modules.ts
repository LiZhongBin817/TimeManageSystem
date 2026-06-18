/**
 * 兼容性转出：保留旧导入路径使用的模块配置 API。
 */
export type {
  Role,
  ModuleField,
  ModuleConfig,
  DataSourceInstance,
  PlatformConfig,
  PlatformKey,
  ModuleCategory
} from './configStore';

export {
  canConfigure,
  canEdit,
  canRead,
  findModule,
  getDataSource,
  getPlatformConfigs,
  hardDeleteDataSource,
  listDataSources,
  listModules,
  replaceModuleFields,
  rolePermissions,
  saveDataSource,
  savePlatformConfig,
  saveModule,
  updateModuleSheetId
} from './configStore';

export type ModuleKey = string;
