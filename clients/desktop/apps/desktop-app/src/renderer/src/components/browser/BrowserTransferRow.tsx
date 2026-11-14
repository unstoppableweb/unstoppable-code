import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import type { BrowserTransfer } from '@canopy/desktop-shared/types';
import { Button, ProgressBar } from '@canopy/ui-shared';
import { isActiveTransfer, useBrowserStore } from '@/stores/browserStore';
import { stageBrowserDownload } from '@/lib/browserChatStaging';
import {
  transferCommandErrorMessage,
  transferErrorLabel,
  transferMoving,
  transferName,
  transferPercentage,
  transferSizeLabel,
  transferStatusLabel,
  type BrowserTransferRowCommand,
} from './browserTransferFormat';
import { ErrorBanner } from '@canopy/ui-shared/components';

interface BrowserTransferRowProps {
  browserId: string;
  transfer: BrowserTransfer;
}

/**
 * One download or copy in the Files panel: name, progress while it runs,
 * status and size, and the actions its state allows. Cancel and Resume while
 * a download can still finish; Show in folder, Save a copy, and Attach to
 * chat once it has. A copy can only be cancelled while it runs.
 */
export function BrowserTransferRow({
  browserId,
  transfer,
}: BrowserTransferRowProps): JSX.Element {
  const runTransferCommand = useBrowserStore((s) => s.runTransferCommand);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const nameId = useId();

  // A new state supersedes the outcome of the last command.
  useEffect(() => {
    setError(null);
  }, [transfer.status]);

  const run = useCallback(
    (command: BrowserTransferRowCommand): void => {
      setError(null);
      setPending(true);
      void runTransferCommand({
        kind: command,
        browserId,
        transferId: transfer.id,
      })
        .then(async (result) => {
          if (!result.ok) {
            setError(transferCommandErrorMessage(command, result.error?.code));
            return;
          }
          // Staging reports its own outcome in a toast.
          if (command === 'attach' && result.attachPath)
            await stageBrowserDownload(
              result.attachPath,
              transferName(transfer),
            );
        })
        .catch(() => {
          setError(transferCommandErrorMessage(command));
        })
        .finally(() => {
          setPending(false);
        });
    },
    [browserId, runTransferCommand, transfer],
  );

  const name = transferName(transfer);
  const status = transferStatusLabel(transfer);
  const active = isActiveTransfer(transfer);
  const resumable = transfer.status === 'interrupted' && active;
  const finishedDownload =
    transfer.kind === 'download' && transfer.status === 'complete';
  const percentage = transferPercentage(transfer);
  const details = [
    status,
    transferSizeLabel(transfer),
    transferErrorLabel(transfer),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' • ');

  return (
    <li
      data-testid={`browser-transfer-row-${transfer.id}`}
      aria-label={`${name}, ${status}`}
      className="flex flex-col gap-1.5 border-b px-2 py-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          id={nameId}
          className="min-w-0 flex-1 truncate text-xs fg-primary"
          title={name}
        >
          {name}
        </span>
        {resumable && (
          <RowButton
            testId={`browser-transfer-resume-${transfer.id}`}
            describedBy={nameId}
            disabled={pending}
            onClick={(): void => run('resume')}
          >
            Resume
          </RowButton>
        )}
        {active && (
          <RowButton
            testId={`browser-transfer-cancel-${transfer.id}`}
            describedBy={nameId}
            disabled={pending}
            onClick={(): void => run('cancel')}
          >
            Cancel
          </RowButton>
        )}
      </div>
      {transferMoving(transfer) && (
        <ProgressBar
          value={percentage ?? 0}
          indeterminate={
            percentage === null &&
            (transfer.status === 'in_progress' || transfer.status === 'staging')
          }
          tone={
            transfer.status === 'in_progress' || transfer.status === 'staging'
              ? 'accent'
              : 'neutral'
          }
          label={`${status} ${name}`}
          hideLabel
        />
      )}
      <div className="min-w-0 truncate text-2xs tabular-nums fg-secondary">
        {details}
      </div>
      {finishedDownload && (
        // Their own line, so the name keeps its width in a narrow inspector.
        <div className="flex flex-wrap gap-1.5">
          <RowButton
            testId={`browser-transfer-show-${transfer.id}`}
            describedBy={nameId}
            disabled={pending}
            onClick={(): void => run('show')}
          >
            Show in folder
          </RowButton>
          <RowButton
            testId={`browser-transfer-save-copy-${transfer.id}`}
            describedBy={nameId}
            disabled={pending}
            onClick={(): void => run('save_copy')}
          >
            Save a copy…
          </RowButton>
          <RowButton
            testId={`browser-transfer-attach-${transfer.id}`}
            describedBy={nameId}
            disabled={pending}
            onClick={(): void => run('attach')}
          >
            Attach to chat
          </RowButton>
        </div>
      )}
      <ErrorBanner
        errorSource="browser-transfer-row"
        className=""
        error={error}
      />
    </li>
  );
}

interface RowButtonProps {
  testId: string;
  describedBy: string;
  disabled: boolean;
  onClick: () => void;
  children: string;
}

function RowButton({
  testId,
  describedBy,
  disabled,
  onClick,
  children,
}: RowButtonProps): JSX.Element {
  // The accessible name is the visible label; the file name describes it.
  return (
    <Button
      variant="ghost-quiet"
      size="compact"
      data-testid={testId}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
