import { posix, win32 } from 'node:path';
import type { WorkerTerminalPort } from '@canopy/core-runtime/node/terminal';

interface TerminalTransactionTrackerOptions {
  terminal: Pick<WorkerTerminalPort, 'addEventListener' | 'list'>;
  transactionProcessNames: readonly string[];
  onIdle: () => void;
  /** Readiness must reset its debounce when a transaction starts, too. */
  onBusyChange?: (busy: boolean) => void;
}

export interface TerminalTransactionTracker {
  isRunning(): boolean;
  dispose(): void;
}

// Same normalization as core-runtime's terminal/running-detector.ts. Keep the
// tracker independent of the engine and its native PTY dependencies.
function normalizeProcessName(value: string | null | undefined): string {
  return win32
    .basename(posix.basename(value?.trim() ?? ''))
    .toLowerCase()
    .replace(/\.exe$/, '');
}

/** Tracks both in-process and daemon terminals without replacing the IPC sink. */
export function createTerminalTransactionTracker({
  terminal,
  transactionProcessNames,
  onIdle,
  onBusyChange,
}: TerminalTransactionTrackerOptions): TerminalTransactionTracker {
  const names = new Set(transactionProcessNames.map(normalizeProcessName));
  const busy = new Set<string>();
  let disposed = false;
  function update(
    id: string,
    running: boolean,
    processName: string | null | undefined,
  ): void {
    const wasBusy = busy.size > 0;
    if (running && names.has(normalizeProcessName(processName))) busy.add(id);
    else busy.delete(id);
    const nowBusy = busy.size > 0;
    if (wasBusy !== nowBusy) onBusyChange?.(nowBusy);
    if (wasBusy && !nowBusy) onIdle();
  }
  const unsubscribe = terminal.addEventListener((event): void => {
    if (disposed) return;
    if (event.type === 'runningChanged') {
      update(
        event.payload.terminalId,
        event.payload.running,
        event.payload.processName,
      );
    } else if (event.type === 'exit') {
      update(event.payload.terminalId, false, null);
    }
  });
  // Subscribe before taking the one-time snapshot so list()'s own synchronous
  // runningChanged events are not lost. Never list on an idle/readiness check.
  try {
    for (const session of terminal.list()) {
      update(session.id, session.running === true, session.processName);
    }
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return {
    isRunning: (): boolean => busy.size > 0,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      busy.clear();
    },
  };
}
