'use client';

import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import {
  ORG_TRANSCRIPT_LIST_DEFAULT_LIMIT,
  type OrgTranscriptExport,
} from '@canopy/protocol/canopy-core/core';
import {
  Badge,
  Button,
  DataTable,
  DialogModal,
  ErrorBanner,
  Notice,
  type DataTableColumn,
} from '@canopy/ui-shared/components';
import type { SettingsFailure } from '../../errors';
import { withPrivacyClass } from '../../account/privacy-class';
import {
  useSettingsClient,
  useSettingsDownloadFile,
  useSettingsPrivacy,
} from '../../host';
import {
  TRANSCRIPTS_DOWNLOAD_FAILED_COPY,
  downloadFailureCopy,
  useTranscriptsErrorCopy,
} from './transcripts-errors';
import {
  exportDownloadPath,
  exportExpiryLabel,
  exportFailureReason,
  exportIncludesLabel,
  formatTranscriptBytes,
  formatTranscriptDate,
  formatTranscriptRange,
  memberName,
} from './transcripts-format';
import { useLoadMoreSentinel, usePagedList } from './use-paged-list';

function ExportStatus({
  item,
}: {
  readonly item: OrgTranscriptExport;
}): JSX.Element | null {
  switch (item.status) {
    case 'preparing':
      return <Badge tone="warning">Preparing</Badge>;
    case 'ready':
      return (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <Badge tone="success">Ready</Badge>
          {item.expiresAt === null ? null : (
            <span className="text-xs fg-secondary">
              {exportExpiryLabel(item.expiresAt)}
            </span>
          )}
        </span>
      );
    case 'failed': {
      const reason = exportFailureReason(item.failureReason);
      return (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <Badge tone="danger">Failed</Badge>
          {reason === null ? null : (
            <span className="text-xs fg-secondary">{reason}</span>
          )}
        </span>
      );
    }
    case 'expired':
      return (
        <Badge tone="neutral" muted>
          Expired
        </Badge>
      );
    case 'deleted':
      return null;
  }
}

function DeleteExportDialog({
  busy,
  failure,
  onConfirm,
  onClose,
}: {
  readonly busy: boolean;
  readonly failure: SettingsFailure | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <DialogModal
      title="Delete this export?"
      dataTestId="transcripts-export-delete-dialog"
      maxWidth="md"
      trapFocus
      onClose={(): void => {
        if (!busy) onClose();
      }}
      footer={
        <div className="flex justify-end">
          <Button
            variant="destructive"
            loading={busy}
            loadingLabel="Deleting export…"
            disabled={busy}
            onClick={onConfirm}
            data-testid="transcripts-export-delete-confirm"
          >
            Delete export
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-s text-pretty fg-secondary">
          The ZIP is removed and can&apos;t be downloaded again. The sessions
          themselves aren&apos;t affected.
        </p>
        {failure === null ? null : (
          <ErrorBanner
            errorSource="organization-transcripts-export-delete"
            error={failure.copy}
            details={failure.details}
          />
        )}
      </div>
    </DialogModal>
  );
}

/**
 * Exports: every export of the organization except deleted ones, newest
 * first, with Download for Ready exports and Delete for Ready, Failed and
 * Expired ones. Preparing exports have no actions; the worker retries a
 * failed attempt on its own.
 */
export function TranscriptExportsView({
  organizationId,
}: {
  readonly organizationId: string;
}): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useTranscriptsErrorCopy();
  const downloadFile = useSettingsDownloadFile();
  const { blockClassName } = useSettingsPrivacy();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<OrgTranscriptExport | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<SettingsFailure | null>(
    null,
  );
  const deleteKey = useRef<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      const result = await client.read('organization.transcripts.exports', {
        organizationId,
        limit: ORG_TRANSCRIPT_LIST_DEFAULT_LIMIT,
        ...(cursor === null ? {} : { cursor }),
      });
      return { items: result.exports, nextCursor: result.nextCursor };
    },
    [client, organizationId],
  );
  const { state, loadMore, retry } = usePagedList(
    organizationId,
    load,
    (item) => item.id,
    (error: unknown) => errorCopy.loadFailure(error),
  );
  const sentinel = useLoadMoreSentinel(
    state.status === 'ready' &&
      state.nextCursor !== null &&
      !state.loadingMore &&
      state.moreFailure === null,
    loadMore,
  );

  const download = useCallback(
    async (item: OrgTranscriptExport): Promise<void> => {
      setDownloadNotice(null);
      if (downloadFile === null) {
        setDownloadNotice(TRANSCRIPTS_DOWNLOAD_FAILED_COPY);
        return;
      }
      const result = await downloadFile({
        path: exportDownloadPath(organizationId, item.id),
        suggestedName: `transcripts-${item.requestedAt.slice(0, 10)}.zip`,
      });
      setDownloadNotice(downloadFailureCopy(result));
    },
    [downloadFile, organizationId],
  );

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null) return;
    deleteKey.current ??= globalThis.crypto.randomUUID();
    setDeleteBusy(true);
    setDeleteFailure(null);
    try {
      await client.write('organization.transcripts.exports.delete', {
        organizationId,
        exportId: deleting.id,
        idempotencyKey: deleteKey.current,
      });
      const id = deleting.id;
      setRemoved((previous) => new Set([...previous, id]));
      setDeleting(null);
      deleteKey.current = null;
    } catch (error) {
      setDeleteFailure(errorCopy.actionFailure(error, 'delete the export'));
    } finally {
      setDeleteBusy(false);
    }
  };

  const columns = useMemo(
    (): ReadonlyArray<DataTableColumn<OrgTranscriptExport>> => [
      {
        key: 'requested',
        header: 'Requested',
        overflow: 'nowrap',
        render: (item) => formatTranscriptDate(item.requestedAt),
      },
      {
        key: 'by',
        header: 'By',
        overflow: 'truncate',
        render: (item) => (
          <span className={withPrivacyClass('', blockClassName)}>
            {memberName(item.requestedBy)}
          </span>
        ),
      },
      {
        key: 'range',
        header: 'Range',
        overflow: 'nowrap',
        showFrom: 'md',
        render: (item) =>
          formatTranscriptRange({ from: item.from, to: item.to }),
      },
      {
        key: 'includes',
        header: 'Includes',
        showFrom: 'lg',
        render: (item) => exportIncludesLabel(item),
      },
      {
        key: 'size',
        header: 'Size',
        align: 'right',
        overflow: 'nowrap',
        render: (item) => {
          if (item.status === 'preparing') return 'Pending';
          return item.sizeBytes === null
            ? '—'
            : formatTranscriptBytes(item.sizeBytes);
        },
      },
      {
        key: 'status',
        header: 'Status',
        render: (item) => <ExportStatus item={item} />,
      },
      {
        key: 'actions',
        header: 'Actions',
        headerHidden: true,
        align: 'right',
        render: (item) =>
          item.status === 'preparing' || item.status === 'expired' ? null : (
            <span className="flex items-center justify-end gap-1">
              {item.status === 'ready' ? (
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={(): void => void download(item)}
                  data-testid={`transcripts-export-download-${item.id}`}
                >
                  Download
                </Button>
              ) : null}
              <Button
                variant="ghost-destructive"
                size="compact"
                onClick={(): void => {
                  setDeleteFailure(null);
                  deleteKey.current = null;
                  setDeleting(item);
                }}
                data-testid={`transcripts-export-delete-${item.id}`}
              >
                Delete
              </Button>
            </span>
          ),
      },
    ],
    [blockClassName, download],
  );

  const rows =
    state.status === 'ready'
      ? state.items.filter(
          (item) => item.status !== 'deleted' && !removed.has(item.id),
        )
      : [];

  return (
    <div className="flex flex-col gap-4" data-testid="transcripts-exports">
      {downloadNotice === null ? null : (
        <Notice
          intent="destructive"
          errorSource="organization-transcripts-export-download"
          onDismiss={(): void => setDownloadNotice(null)}
        >
          {downloadNotice}
        </Notice>
      )}
      {state.status === 'error' ? (
        <ErrorBanner
          errorSource="organization-transcripts-exports"
          error={state.failure.copy}
          details={state.failure.details}
          onRetry={retry}
        />
      ) : (
        <DataTable
          caption="Exports"
          columns={columns}
          rows={rows}
          rowKey={(item) => item.id}
          loading={state.status === 'loading'}
          emptyLabel="No exports yet. Start one from Sessions."
          breakpoints="container"
          testId="transcripts-exports-table"
        />
      )}
      {state.status === 'ready' && state.moreFailure !== null ? (
        <ErrorBanner
          errorSource="organization-transcripts-exports-more"
          error={state.moreFailure.copy}
          details={state.moreFailure.details}
          onRetry={retry}
        />
      ) : null}
      <div ref={sentinel} aria-hidden="true" />
      <p className="text-xs text-pretty fg-secondary">
        Any owner can download a Ready export. Only one export can run at a time
        per organization, so Export is off while one is preparing.
      </p>
      {deleting === null ? null : (
        <DeleteExportDialog
          busy={deleteBusy}
          failure={deleteFailure}
          onConfirm={(): void => void confirmDelete()}
          onClose={(): void => setDeleting(null)}
        />
      )}
    </div>
  );
}
