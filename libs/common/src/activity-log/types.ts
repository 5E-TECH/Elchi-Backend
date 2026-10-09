export const ActivityAction = {
  CREATED: 'created',
  UPDATED: 'updated',
  DELETED: 'deleted',
  RESTORED: 'restored',
  STATUS_CHANGE: 'status_change',
  PAYMENT: 'payment',
  REFUND: 'refund',
  LOGIN: 'login',
  LOGOUT: 'logout',
  AUTH_FAILURE: 'auth_failure',
  EXPORT: 'export',
  IMPORT: 'import',
  WEBHOOK_RECEIVED: 'webhook_received',
  EXTERNAL_SYNC: 'external_sync',
  ASSIGN: 'assign',
  UNASSIGN: 'unassign',
} as const;

// Plain string so callers can use a domain-specific verb without extending
// the const enum (e.g. 'order.batch_sent'). Use ActivityAction.* whenever
// possible; the const enum gives autocompletion + grep-ability for the
// common cases. (Cannot use a wider union including the const because lint
// complains the const is overridden by `string`, which it is.)
export type ActivityActionType = string;

export const ACTIVITY_LOG_SERVICE_NAME = 'ACTIVITY_LOG_SERVICE_NAME';

export interface ActivityLogInput {
  entity_type: string;
  entity_id: string | number;
  action: ActivityActionType;
  old_value?: unknown;
  new_value?: unknown;
  user_id?: string | null;
  user_name?: string | null;
  user_role?: string | null;
  trace_id?: string | null;
  /**
   * Metadata. Gateway HTTP so'rovidan kelgan amalda `ip`, `user_agent`,
   * `device_id`, `device_name` AVTOMATIK qo'shiladi (f2Ud5tju); shu
   * kalitlardan birini chaqiruvchi o'zi bersa — uniki USTUN.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * Inson o'qiy oladigan qisqa o'zbekcha gap (2WRzdWpZ), masalan
   * "Buyurtma #100439 bekor qilindi". `ActivityDescribeUz` quruvchilaridan
   * oling — servisda qo'lda yozmang. ⚠️ Mijoz ismi/telefoni/manzili
   * QO'SHILMAYDI. Berilmasa ustun NULL (frontend amal yorlig'ini ko'rsatadi).
   */
  description?: string | null;
}

export interface ActivityChangeInput extends Omit<
  ActivityLogInput,
  'old_value' | 'new_value' | 'action'
> {
  action?: ActivityActionType;
  old_value: Record<string, unknown> | null | undefined;
  new_value: Record<string, unknown> | null | undefined;
  ignore_fields?: string[];
}

/** Filters for the paginated audit-log read API ({service}.activity_log.find_all). */
export interface ActivityLogQuery {
  entity_type?: string;
  entity_id?: string | number;
  action?: string;
  /** Actor filter — matches the user_id column. */
  user_id?: string;
  user_role?: string;
  trace_id?: string;
  /** ISO date / parseable timestamp lower & upper bounds on created_at. */
  from?: string | Date;
  to?: string | Date;
  /**
   * Free-text ILIKE across entity_type / entity_id / action / user_name /
   * description (2WRzdWpZ — "bekor" deb qidirilsa bekor qilish qatorlari).
   */
  search?: string;
  page?: number;
  limit?: number;
}

export interface ActivityLogPage<T = unknown> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}
