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
  metadata?: Record<string, unknown> | null;
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
