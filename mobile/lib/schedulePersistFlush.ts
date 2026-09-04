/**
 * Pending schedule edits on mobile are memory-only until the debounce fires.
 * Screens register a flush callback so AppState / sign-out can push before kill.
 */

type FlushFn = () => Promise<void> | void;

let scheduleFlushFn: FlushFn | null = null;

export function registerPendingScheduleFlush(fn: FlushFn | null): void {
  scheduleFlushFn = fn;
}

export async function flushPendingScheduleEdits(): Promise<void> {
  if (!scheduleFlushFn) return;
  try {
    await Promise.resolve(scheduleFlushFn());
  } catch (err) {
    console.warn('flushPendingScheduleEdits', err);
  }
}
