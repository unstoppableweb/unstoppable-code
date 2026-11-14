import { useEffect, useRef, useState, type JSX } from 'react';
import type { CreateMemoryReportFailureReason } from '@canopy/desktop-shared/types';
import {
  Button,
  ConfirmDialog,
  DialogModal,
  LoadingSpinner,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';
import { useMemoryReportStore } from '@/stores/memoryReportStore';
import { describeMemoryReport } from './format';

const FAILURE_COPY: Record<CreateMemoryReportFailureReason, string> = {
  disabled:
    "Couldn't create the report because memory diagnostics are off. Turn on Memory diagnostics and try again.",
  'in-progress':
    "Couldn't start a report because another one is still being saved. Wait for it to finish, then try again.",
  'insufficient-disk':
    "Couldn't create the report because there isn't enough free disk space. Free up some space and try again.",
  failed: "Couldn't create the memory report. Try again.",
};

const SHARING_NOTE =
  'Reports can contain chat and file content, so share them only with people you trust.';

function freezeWarning(estimate: string | null): string {
  return estimate === null
    ? `${brandText.appName} will stop responding until the report is saved.`
    : `${brandText.appName} will stop responding for ${estimate} while it saves the report.`;
}

/**
 * The memory report confirmation and its progress overlay. The overlay sits a
 * tier above Settings: its dialog is portaled into a `z-dropdown` stacking
 * context. Like Settings, the dialog marks itself as a native Browser view
 * overlay, so open Browser tabs step aside while it shows.
 */
export function MemoryReportOverlay(): JSX.Element | null {
  const flow = useMemoryReportStore((state) => state.flow);
  const confirm = useMemoryReportStore((state) => state.confirm);
  const cancel = useMemoryReportStore((state) => state.cancel);
  const dismiss = useMemoryReportStore((state) => state.dismiss);
  const reveal = useMemoryReportStore((state) => state.reveal);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);

  const settled = flow.phase === 'saved' || flow.phase === 'failed';
  useEffect(() => {
    // The dialog opened with nothing to focus; its outcome brings Done.
    if (settled) doneRef.current?.focus();
  }, [settled]);

  if (flow.phase === 'idle') return null;
  if (flow.phase === 'confirming') {
    return (
      <ConfirmDialog
        title="Create a memory report?"
        message={`${freezeWarning(flow.estimate)} ${SHARING_NOTE}`}
        confirmLabel="Create report"
        confirmTestId="settings-memory-report-confirm"
        dataTestId="settings-memory-report-dialog"
        focusCancel
        onConfirm={() => {
          void confirm();
        }}
        onCancel={cancel}
      />
    );
  }

  const title =
    flow.phase === 'generating' ? (
      <span className="flex items-center gap-2">
        <LoadingSpinner className="shrink-0" decorative />
        Generating…
      </span>
    ) : flow.phase === 'saved' ? (
      'Memory report saved'
    ) : (
      'Report not created'
    );

  return (
    <>
      <div ref={setLayer} className="relative z-dropdown" />
      {layer ? (
        <DialogModal
          portalContainer={layer}
          title={title}
          maxWidth="md"
          dataTestId="memory-report-overlay"
          showCloseButton={settled}
          closeOnBackdrop={false}
          closeOnEscape={settled}
          // Closing returns focus to the control that opened the report.
          trapFocus
          onClose={dismiss}
        >
          <div
            className="flex flex-col gap-4"
            data-testid={`memory-report-${flow.phase}`}
            aria-busy={flow.phase === 'generating'}
          >
            {flow.phase === 'generating' ? (
              <p className="text-s fg-secondary" role="status">
                {freezeWarning(flow.estimate)}
              </p>
            ) : flow.phase === 'saved' ? (
              <div className="flex flex-col gap-2 text-s" role="status">
                <p className="fg-primary">
                  {describeMemoryReport(flow.report)}
                </p>
                <p className="fg-secondary">{SHARING_NOTE}</p>
                {flow.revealFailed ? (
                  <ErrorBanner
                    errorSource="memory-report-reveal-folder"
                    className=""
                    error="Couldn't open the folder. The report may have been moved or deleted."
                  />
                ) : null}
              </div>
            ) : (
              <ErrorBanner
                errorSource="memory-report-collect"
                className=""
                error={FAILURE_COPY[flow.reason]}
              />
            )}
            {settled ? (
              <div className="flex items-center justify-end gap-2">
                {flow.phase === 'saved' ? (
                  <Button
                    variant="outline"
                    size="lg"
                    data-testid="memory-report-open-folder"
                    onClick={() => {
                      void reveal(flow.report.reportId);
                    }}
                  >
                    Open folder
                  </Button>
                ) : null}
                <Button
                  ref={doneRef}
                  variant="primary"
                  size="lg"
                  data-testid="memory-report-done"
                  onClick={dismiss}
                >
                  Done
                </Button>
              </div>
            ) : null}
          </div>
        </DialogModal>
      ) : null}
    </>
  );
}
