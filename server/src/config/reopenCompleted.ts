/** 撤销完成操作的业务常量。 */
export const REOPEN_COMPLETED_REASON_MIN_LENGTH = 1;
export const REOPEN_COMPLETED_AUDIT_ACTION = 'reopen_completed';
export const REOPEN_COMPLETED_SYNC_AUDIT_ACTION = 'reopen_completed_sync';
export const REOPEN_COMPLETED_REQUIRED_FIELD_KEYS = ['launchAt', 'isCompleted'] as const;

export const REOPEN_COMPLETED_LOCAL_PATCH = {
  launchAt: '',
  isCompleted: '否'
} as const;
