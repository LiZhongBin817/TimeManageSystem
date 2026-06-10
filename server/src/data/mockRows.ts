/**
 * 开发环境兜底数据：当表格型项目模块需要示例数据时使用。
 */
import { ModuleKey } from '../config/modules';

export interface SheetRow {
  id: string;
  rowNumber?: number;
  [key: string]: string | number | undefined;
}

export const mockRows: Record<Exclude<ModuleKey, 'dashboard'>, SheetRow[]> = {
  'power-standard': [
    { id: 'p-1', rowNumber: 2, name: '华东发电台账', province: '江苏', owner: '张工', progress: 78, status: '进行中', updatedAt: '2026-06-01' },
    { id: 'p-2', rowNumber: 3, name: '新能源标准整理', province: '浙江', owner: '李工', progress: 100, status: '已完成', updatedAt: '2026-05-28' }
  ],
  'sales-standard': [
    { id: 's-1', rowNumber: 2, name: '售电客户A', province: '山东', owner: '王工', amount: 320000, status: '进行中', updatedAt: '2026-06-02' },
    { id: 's-2', rowNumber: 3, name: '售电客户B', province: '安徽', owner: '赵工', amount: 180000, status: '待确认', updatedAt: '2026-05-30' }
  ],
  crawler: [
    { id: 'c-1', rowNumber: 2, name: '政策公告采集', source: '能源局', owner: '陈工', status: '正常', updatedAt: '2026-06-02' },
    { id: 'c-2', rowNumber: 3, name: '交易中心采集', source: '交易中心官网', owner: '周工', status: '待处理', updatedAt: '2026-06-01' }
  ],
  'province-system': [
    { id: 'ps-1', rowNumber: 2, province: '广东', systemName: '广东分省系统', owner: '黄工', progress: 64, status: '进行中', updatedAt: '2026-06-01' },
    { id: 'ps-2', rowNumber: 3, province: '四川', systemName: '四川分省系统', owner: '刘工', progress: 42, status: '风险', updatedAt: '2026-05-29' }
  ],
  staff: [
    { id: 'u-1', rowNumber: 2, name: '张工', department: '产品部', role: '项目负责人', phone: '13800000001', status: '在职' },
    { id: 'u-2', rowNumber: 3, name: '李工', department: '技术部', role: '前端工程师', phone: '13800000002', status: '在职' }
  ],
  todos: [
    { id: 't-1', rowNumber: 2, title: '确认钉钉表格字段', module: '汇总看板', owner: '张工', dueDate: '2026-06-05', status: '待办' },
    { id: 't-2', rowNumber: 3, title: '补充省份进度数据', module: '分省系统', owner: '黄工', dueDate: '2026-06-08', status: '进行中' }
  ]
};
