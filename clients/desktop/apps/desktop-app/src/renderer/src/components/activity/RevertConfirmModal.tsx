import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
  ActivityFileDiffResponse,
  ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import {
  Button,
  ConfirmDialog,
  ErrorState,
  Stack,
  Surface,
} from '@canopy/ui-shared/components';
import { DiffContentView } from './DiffContentView';

interface RevertConfirmModalProps {
  file: ChangedFileInfo;
  projectId: string;
  worktreeId: string;
  reverting: boolean;
  error?: string | null;
  /** Main already recorded the revert failure, so this dialog must not. */
  errorRecorded?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function displayPath(file: ChangedFileInfo): string {
  const path = file.repoName ? `${file.repoName}/${file.path}` : file.path;
  if (file.status === 'renamed' && file.previousPath) {
    const prev = file.repoName
      ? `${file.repoName}/${file.previousPath}`
      : file.previousPath;
    return `${prev} → ${path}`;
  }
  return path;
}

export function RevertConfirmModal({
  file,
  projectId,
  worktreeId,
  reverting,
  error,
  errorRecorded = false,
  onConfirm,
  onCancel,
}: RevertConfirmModalProps): JSX.Element {
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewData, setPreviewData] =
    useState<ActivityFileDiffResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewData(null);

    void window.api.activity
      .getFileDiff({
        projectId,
        worktreeId,
        filePath: file.path,
        source: 'uncommitted',
        repoId: file.repoId,
      })
      .then((result: ActivityFileDiffResponse) => {
        if (cancelled) return;
        setPreviewData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreviewError(
          err instanceof Error ? err.message : 'Failed to load diff preview',
        );
      })
      .finally(() => {
        if (cancelled) return;
        setPreviewLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [file.path, file.repoId, projectId, worktreeId]);

  const handleTogglePreview = useCallback((): void => {
    setPreviewExpanded((prev) => !prev);
  }, []);

  const fileName = file.path.split('/').pop() ?? file.path;
  const message =
    file.status === 'unmerged' ? (
      'Its conflict markers are removed and the HEAD version is restored. This can’t be undone.'
    ) : (
      <>
        Its uncommitted changes (
        <span className="tabular-nums">
          <span className="fg-success-strong">+{file.insertions}</span>{' '}
          <span className="fg-destructive-strong">−{file.deletions}</span>
        </span>
        ) are removed. This can’t be undone.
      </>
    );

  return (
    <ConfirmDialog
      title={`Discard changes to “${fileName}”?`}
      message={message}
      confirmLabel="Discard changes"
      busyLabel="Discarding…"
      busy={reverting}
      errorMessage={error}
      {...(errorRecorded
        ? { errorRecordingDisabled: true as const }
        : { errorSource: 'changed-files-revert' })}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
      dataTestId="revert-confirm-modal"
      confirmTestId="revert-confirm-btn"
    >
      <Stack gap="inline">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs fg-tertiary">
            {displayPath(file)}
          </span>
          <Button
            variant="ghost"
            size="compact"
            className="-mr-3 shrink-0"
            aria-expanded={previewExpanded}
            onClick={handleTogglePreview}
          >
            {previewExpanded ? 'Hide changes' : 'Show changes'}
          </Button>
        </div>
        <Surface variant="outline" className="overflow-hidden">
          <div
            className={`max-h-60 overflow-auto ${previewExpanded ? '' : 'hidden'}`}
          >
            {previewError ? (
              <ErrorState space="panel" message={previewError} />
            ) : (
              <DiffContentView
                oldValue={previewData?.oldValue ?? ''}
                newValue={previewData?.newValue ?? ''}
                viewMode="unified"
                loading={previewLoading}
                truncated={previewData?.truncated ?? false}
                binary={previewData?.binary ?? false}
                imagePreview={previewData?.imagePreview}
              />
            )}
          </div>
        </Surface>
      </Stack>
    </ConfirmDialog>
  );
}
