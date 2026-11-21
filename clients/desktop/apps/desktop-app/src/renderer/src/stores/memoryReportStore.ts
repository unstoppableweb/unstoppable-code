import { create } from 'zustand';
import type {
  CreateMemoryReportFailureReason,
  MemoryReportSummary,
} from '@canopy/desktop-shared/types';

/**
 * One memory report at a time, started from Settings or the resources
 * popover: a status check, the confirmation, then the progress overlay that
 * stays up to show the outcome.
 */
export type MemoryReportFlow =
  | { readonly phase: 'idle' }
  | { readonly phase: 'confirming'; readonly estimate: string | null }
  | { readonly phase: 'generating'; readonly estimate: string | null }
  | {
      readonly phase: 'saved';
      readonly report: MemoryReportSummary;
      readonly revealFailed: boolean;
    }
  | {
      readonly phase: 'failed';
      readonly reason: CreateMemoryReportFailureReason;
    };

interface MemoryReportState {
  readonly flow: MemoryReportFlow;
  /** The newest report or automatic snapshot main knows about. */
  readonly lastReport: MemoryReportSummary | null;
  /** The status check before the confirmation is in flight. */
  readonly checking: boolean;
  /**
   * Whether memory diagnostics are on; `null` until first known. The sidebar
   * seeds it from the startup preferences and their updates, and the
   * resources popover refreshes it from main on each open, so the popover
   * opens with its Memory report row already in place.
   */
  readonly diagnosticsEnabled: boolean | null;
  request: () => Promise<void>;
  confirm: () => Promise<void>;
  cancel: () => void;
  dismiss: () => void;
  /** Shows a report in the file manager; false when it is gone. */
  reveal: (reportId: string) => Promise<boolean>;
  setLastReport: (report: MemoryReportSummary | null) => void;
  setDiagnosticsEnabled: (enabled: boolean) => void;
}

/** The time a report may freeze the app, as status reports it. */
export function formatReportEstimate(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  if (seconds < 2) {
    return 'about 1 second';
  }
  if (seconds < 60) {
    return `about ${Math.round(seconds)} seconds`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`;
}

const PAINT_FALLBACK_MS = 100;

/**
 * Main and this page stop responding while the report is written, so the
 * overlay must reach the screen first. A hidden window gets no animation
 * frames, hence the timeout.
 */
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, PAINT_FALLBACK_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  });
}

export const useMemoryReportStore = create<MemoryReportState>((set, get) => ({
  flow: { phase: 'idle' },
  lastReport: null,
  checking: false,
  diagnosticsEnabled: null,
  request: async (): Promise<void> => {
    if (get().flow.phase !== 'idle' || get().checking) return;
    set({ checking: true });
    try {
      const status = await window.api.memoryDiagnostics.getStatus();
      if (status.reportInProgress) {
        set({ flow: { phase: 'failed', reason: 'in-progress' } });
      } else if (!status.enabled) {
        set({ flow: { phase: 'failed', reason: 'disabled' } });
      } else {
        set({
          flow: {
            phase: 'confirming',
            estimate: formatReportEstimate(status.estimatedReportSeconds),
          },
        });
      }
    } catch {
      set({ flow: { phase: 'confirming', estimate: null } });
    } finally {
      set({ checking: false });
    }
  },
  confirm: async (): Promise<void> => {
    const { flow } = get();
    if (flow.phase !== 'confirming') return;
    set({ flow: { phase: 'generating', estimate: flow.estimate } });
    await afterNextPaint();
    try {
      const response = await window.api.memoryDiagnostics.createReport();
      set(
        response.ok
          ? {
              flow: {
                phase: 'saved',
                report: response.report,
                revealFailed: false,
              },
              lastReport: response.report,
            }
          : { flow: { phase: 'failed', reason: response.reason } },
      );
    } catch {
      set({ flow: { phase: 'failed', reason: 'failed' } });
    }
  },
  cancel: (): void => {
    if (get().flow.phase === 'confirming') {
      set({ flow: { phase: 'idle' } });
    }
  },
  dismiss: (): void => {
    const { phase } = get().flow;
    if (phase === 'saved' || phase === 'failed') {
      set({ flow: { phase: 'idle' } });
    }
  },
  reveal: async (reportId: string): Promise<boolean> => {
    let revealed = false;
    try {
      revealed = await window.api.memoryDiagnostics.revealReport(reportId);
    } catch {
      revealed = false;
    }
    const { flow } = get();
    if (flow.phase === 'saved' && flow.report.reportId === reportId) {
      set({ flow: { ...flow, revealFailed: !revealed } });
    }
    return revealed;
  },
  setLastReport: (report: MemoryReportSummary | null): void => {
    set({ lastReport: report });
  },
  setDiagnosticsEnabled: (enabled: boolean): void => {
    set({ diagnosticsEnabled: enabled });
  },
}));
