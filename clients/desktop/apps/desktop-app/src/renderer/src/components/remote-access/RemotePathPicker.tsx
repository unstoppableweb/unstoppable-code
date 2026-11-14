import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  Button,
  ListRow,
  LoadingSpinner,
  Notice,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  ArrowUp,
  CheckIcon,
  FileIcon,
  FolderIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type {
  RemoteControlApi,
  RemoteDirectoryEntry,
  RemoteDirectoryListing,
  RemotePathPickerRequest,
} from '@canopy/desktop-shared/types';
import { DialogModal } from '@/components/shared/DialogModal';
import { describeError } from './remote-access-copy';

export interface RemotePathPickerProps {
  readonly request: RemotePathPickerRequest;
  /** Lists a folder on the computer this window shows. */
  readonly listDirectory: RemoteControlApi['listDirectory'];
  /** Absolute path on that computer, or `null` when cancelled. */
  readonly onResolve: (path: string | null) => void;
}

/** Folders first, then files, each by name. */
function sortDirectoryEntries(
  entries: readonly RemoteDirectoryEntry[],
): RemoteDirectoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/**
 * Stands in for the native open dialog when a window shows another computer:
 * the dialog would otherwise open on that computer's screen. Browses that
 * computer's disk, starting in its home folder.
 */
export function RemotePathPicker({
  request,
  listDirectory,
  onResolve,
}: RemotePathPickerProps): JSX.Element {
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // Typed paths reach places browsing cannot, like another drive or a share.
  const [pathDraft, setPathDraft] = useState('');
  const latestLoad = useRef(0);
  const listingRef = useRef<RemoteDirectoryListing | null>(null);
  listingRef.current = listing;
  const directoryMode = request.mode === 'directory';

  const load = useCallback(
    (path: string | null): void => {
      const seq = ++latestLoad.current;
      setLoading(true);
      setError(null);
      void listDirectory({ path })
        .then((next) => {
          if (seq !== latestLoad.current) return;
          setListing(next);
          setPathDraft(next.path);
          setSelectedFile(null);
        })
        .catch((cause: unknown) => {
          if (seq !== latestLoad.current) return;
          setError(describeError(cause, "Couldn't open this folder."));
          // Show the folder still open, which is what Choose returns.
          setPathDraft(listingRef.current?.path ?? '');
        })
        .finally(() => {
          if (seq === latestLoad.current) setLoading(false);
        });
    },
    [listDirectory],
  );

  useEffect(() => {
    load(null);
  }, [load]);

  const entries = listing
    ? sortDirectoryEntries(listing.entries).filter(
        (entry) => !directoryMode || entry.kind === 'directory',
      )
    : [];
  const chosenPath = directoryMode ? (listing?.path ?? null) : selectedFile;

  return (
    <DialogModal
      onClose={() => onResolve(null)}
      title={request.title}
      maxWidth="lg"
      trapFocus
      scrollableBody={false}
      dataTestId="remote-path-picker"
    >
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label="Go up one folder"
            disabled={loading || !listing?.parent}
            onClick={() => {
              if (listing?.parent) load(listing.parent);
            }}
            data-testid="remote-path-picker-up"
          >
            <ArrowUp size={16} aria-hidden="true" />
          </Button>
          <TextInput
            type="text"
            density="compact"
            mono
            aria-label="Folder path"
            spellCheck={false}
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              const typed = pathDraft.trim();
              if (event.key === 'Enter' && typed !== '') {
                event.preventDefault();
                load(typed);
              }
            }}
            className="min-w-0 flex-1"
            data-testid="remote-path-picker-path"
          />
          {loading ? (
            <LoadingSpinner
              tone="secondary"
              dataTestId="remote-path-picker-loading"
            />
          ) : null}
        </div>
        {error ? (
          <Notice
            errorSource="remote-path-picker-error"
            intent="destructive"
            data-testid="remote-path-picker-error"
          >
            {error}
          </Notice>
        ) : null}
        <ul
          aria-label={
            listing ? `Contents of ${listing.path}` : 'Folder contents'
          }
          className="-mx-2 flex h-72 flex-col gap-px overflow-y-auto"
          data-testid="remote-path-picker-entries"
        >
          {entries.map((entry) => {
            const selected =
              entry.kind === 'file' && selectedFile === entry.path;
            return (
              <li key={entry.path}>
                <ListRow
                  disabled={loading}
                  aria-pressed={entry.kind === 'file' ? selected : undefined}
                  selected={selected}
                  onClick={() => {
                    if (entry.kind === 'directory') {
                      load(entry.path);
                    } else {
                      setSelectedFile(entry.path);
                    }
                  }}
                  onDoubleClick={() => {
                    if (entry.kind === 'file') onResolve(entry.path);
                  }}
                  data-testid={`remote-path-picker-entry-${entry.name}`}
                  data-entry-kind={entry.kind}
                  icon={
                    entry.kind === 'directory' ? (
                      <FolderIcon size={16} aria-hidden="true" />
                    ) : (
                      <FileIcon size={16} aria-hidden="true" />
                    )
                  }
                  trailing={
                    selected ? (
                      <CheckIcon
                        size={16}
                        aria-hidden="true"
                        className="fg-primary"
                      />
                    ) : undefined
                  }
                >
                  {entry.name}
                </ListRow>
              </li>
            );
          })}
          {listing && !loading && entries.length === 0 ? (
            <li className="px-2 py-2 text-s fg-secondary">
              {directoryMode ? 'No folders here' : 'This folder is empty'}
            </li>
          ) : null}
        </ul>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="lg"
            onClick={() => onResolve(null)}
            data-testid="remote-path-picker-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={loading || chosenPath === null}
            onClick={() => {
              if (chosenPath !== null) onResolve(chosenPath);
            }}
            data-testid="remote-path-picker-confirm"
          >
            {directoryMode ? 'Choose this folder' : 'Choose file'}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
