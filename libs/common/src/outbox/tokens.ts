export const OUTBOX_TARGETS = Symbol('OUTBOX_TARGETS');
export const OUTBOX_OPTIONS = Symbol('OUTBOX_OPTIONS');

export interface OutboxOptions {
  /** How often the publisher polls for due events (ms). Default 1000. */
  pollIntervalMs?: number;
  /** Max events processed per tick. Default 50. */
  batchSize?: number;
  /** Per-event publish timeout (ms). Default 5000. */
  publishTimeoutMs?: number;
  /**
   * How often to check for FAILED (poison) events and raise an alert (ms).
   * Default 60000. A 'failed' event is terminal — never retried and invisible
   * to getDuePending — so without this check a stuck money/state event would
   * sit silently forever.
   */
  failedAlertIntervalMs?: number;
}
