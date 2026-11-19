import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import { Button } from '@canopy/ui-shared/components';
import {
  WorkspaceFilesList,
  type WorkspaceFilesListRow,
} from './WorkspaceFilesList';

export interface WorkspaceFilesCardRow extends WorkspaceFilesListRow {
  /** The version a replacement must still find. */
  readonly versionId?: string;
}

/** One upload, kept so Try again sends it again under the same operation id. */
export interface WorkspaceFileUpload {
  readonly file: File;
  readonly operationId: string;
  readonly replaceFileId?: string;
  readonly expectedVersionId?: string;
}

export interface WorkspaceFilesFailure {
  readonly message: string;
  /** The file's saved copy is gone; its row says so instead of an error. */
  readonly gone?: boolean;
  /** The files changed since they were read: drop Try again and read again. */
  readonly conflict?: boolean;
  /**
   * The write may have landed (it was sent and no answer came): read the
   * files again and keep Try again, which resends under the same operation.
   */
  readonly stale?: boolean;
}

/** Adding, replacing and removing files. */
export interface WorkspaceFilesWrite {
  readonly upload: (
    upload: WorkspaceFileUpload,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly remove: (fileId: string) => Promise<void>;
}

/**
 * The writes the card offers: the host's, only while it has
 * `cloudWorkspaceFileWrite`. Without them the card shows no file picker,
 * Replace, Remove or Try again.
 */
export function workspaceFilesCardWrite(
  capabilities: Pick<CanopyCapabilities, 'cloudWorkspaceFileWrite'>,
  write: WorkspaceFilesWrite | undefined,
): WorkspaceFilesWrite | undefined {
  return capabilities.cloudWorkspaceFileWrite === true ? write : undefined;
}

export interface WorkspaceFilesCardHost {
  readonly write?: WorkspaceFilesWrite;
  readonly download?: (fileId: string, signal: AbortSignal) => Promise<void>;
  readonly describeFailure: (cause: unknown) => WorkspaceFilesFailure;
  /** A write landed or conflicted: read the files again. */
  readonly onChanged: () => void;
  readonly onUnavailable: (fileId: string) => void;
}

export interface WorkspaceFilesCardProps {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly rows: readonly WorkspaceFilesCardRow[];
  readonly onRetry: () => void;
  readonly emptySubtitle: string;
  readonly notice?: ReactNode;
  readonly onOpen?: (id: string) => void;
  readonly onMention?: (id: string) => void;
  /** The host's capabilities for this project; they gate every write. */
  readonly capabilities: Pick<CanopyCapabilities, 'cloudWorkspaceFileWrite'>;
  /** Without it the card only lists. */
  readonly host?: WorkspaceFilesCardHost;
  /** Set to open the file picker, such as from a header's add button. */
  readonly uploadTriggerRef?: RefObject<(() => void) | null>;
}

/**
 * A cloud project's shared workspace files with the actions its host offers
 * (CAN-7008): the list, the file picker, Replace, Remove and an upload's Try
 * again. The host reads the files and carries each action.
 */
export function WorkspaceFilesCard({
  phase,
  rows,
  onRetry,
  emptySubtitle,
  notice,
  onOpen,
  onMention,
  capabilities,
  host,
  uploadTriggerRef,
}: WorkspaceFilesCardProps): JSX.Element {
  const write = workspaceFilesCardWrite(capabilities, host?.write);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryUpload, setRetryUpload] = useState<WorkspaceFileUpload | null>(
    null,
  );
  const input = useRef<HTMLInputElement | null>(null);
  const replacement = useRef<WorkspaceFilesCardRow | null>(null);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    const controller = lifetime.current;
    return (): void => {
      controller.abort();
    };
  }, []);
  const writable = write !== undefined;
  useEffect(() => {
    if (uploadTriggerRef === undefined || !writable) return;
    uploadTriggerRef.current = (): void => {
      replacement.current = null;
      input.current?.click();
    };
    return (): void => {
      uploadTriggerRef.current = null;
    };
  }, [uploadTriggerRef, writable]);
  const actionFailed = (
    current: WorkspaceFilesCardHost,
    cause: unknown,
    row?: WorkspaceFilesCardRow,
  ): void => {
    if (lifetime.current.signal.aborted) return;
    const failure = current.describeFailure(cause);
    if (failure.gone === true && row !== undefined) {
      current.onUnavailable(row.id);
    } else {
      setError(failure.message);
    }
    if (failure.conflict === true) {
      setRetryUpload(null);
      current.onChanged();
    } else if (failure.stale === true) {
      current.onChanged();
    }
  };
  const upload = async (pending: WorkspaceFileUpload): Promise<void> => {
    if (host === undefined || write === undefined) return;
    setBusy(true);
    setError(null);
    setRetryUpload(null);
    try {
      await write.upload(pending, lifetime.current.signal);
      if (!lifetime.current.signal.aborted) host.onChanged();
    } catch (cause) {
      if (!lifetime.current.signal.aborted) {
        setRetryUpload(pending);
        actionFailed(host, cause);
      }
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };
  const picked = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    const target = replacement.current;
    replacement.current = null;
    if (target !== null && target.versionId === undefined) return;
    void upload({
      file,
      operationId: crypto.randomUUID(),
      ...(target === null
        ? {}
        : { replaceFileId: target.id, expectedVersionId: target.versionId }),
    });
  };
  const remove = (row: WorkspaceFilesCardRow): Promise<boolean> => {
    if (host === undefined || write === undefined)
      return Promise.resolve(false);
    setBusy(true);
    setError(null);
    return write
      .remove(row.id)
      .then(() => {
        if (lifetime.current.signal.aborted) return false;
        host.onChanged();
        return true;
      })
      .catch((cause: unknown) => {
        actionFailed(host, cause, row);
        return false;
      })
      .finally(() => {
        if (!lifetime.current.signal.aborted) setBusy(false);
      });
  };
  const rowOf = (id: string): WorkspaceFilesCardRow | undefined =>
    rows.find((row) => row.id === id);
  const download = host?.download;
  return (
    <WorkspaceFilesList
      phase={phase}
      rows={rows.map((row) => ({
        id: row.id,
        name: row.name,
        meta: row.meta,
        ...(row.unavailable === undefined
          ? {}
          : { unavailable: row.unavailable }),
      }))}
      onRetry={onRetry}
      emptySubtitle={emptySubtitle}
      notice={notice}
      error={error}
      busy={busy}
      busyLabel="Saving workspace file…"
      afterError={
        retryUpload !== null ? (
          <Button
            size="compact"
            disabled={busy}
            onClick={(): void => {
              void upload(retryUpload);
            }}
          >
            Try again
          </Button>
        ) : null
      }
      {...(onOpen === undefined ? {} : { onOpen })}
      {...(onMention === undefined ? {} : { onMention })}
      {...(host === undefined || download === undefined
        ? {}
        : {
            onDownload: (id: string): void => {
              const row = rowOf(id);
              if (row !== undefined)
                void download(row.id, lifetime.current.signal).catch(
                  (cause: unknown) => actionFailed(host, cause, row),
                );
            },
          })}
      {...(!writable
        ? {}
        : {
            // A replacement names the version it replaces, so a host whose
            // rows carry none offers no Replace.
            ...(rows.every((row) => row.versionId !== undefined)
              ? {
                  onReplace: (id: string): void => {
                    replacement.current = rowOf(id) ?? null;
                    input.current?.click();
                  },
                }
              : {}),
            onRemove: (id: string): Promise<boolean> => {
              const row = rowOf(id);
              return row === undefined ? Promise.resolve(false) : remove(row);
            },
          })}
    >
      {writable ? (
        <input
          type="file"
          className="hidden"
          ref={input}
          onChange={picked}
          data-testid="workspace-files-input"
          disabled={busy}
        />
      ) : null}
    </WorkspaceFilesList>
  );
}
