'use client';

import { CodeBlock } from '@canopy/ui-shared/primitives/CodeBlock';
import { useRef, useState, type JSX } from 'react';
import {
  FeedbackDiagnosticsExpiredError,
  type FeedbackDiagnosticsEntryContent,
  type FeedbackDiagnosticsSnapshot,
  type FeedbackReportClient,
} from '@canopy/protocol/feedback-report';
import { Button, Disclosure, Notice } from '@canopy/ui-shared/components';
import { formatByteSize } from '@canopy/ui-shared/lib/format-byte-size';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** The inventory can hold thousands of files; it grows on request. */
const INVENTORY_PAGE_SIZE = 200;

const DOWNLOAD_REQUIRED_COPY: Record<
  Extract<
    FeedbackDiagnosticsEntryContent,
    { kind: 'download-required' }
  >['reason'],
  string
> = {
  binary: 'This file isn’t text. Save a copy to inspect it.',
  'too-large':
    'This file is too large to show here. Save a copy to inspect it.',
};

type EntryView =
  | { path: string; status: 'reading' }
  | { path: string; status: 'failed' }
  | { path: string; status: 'read'; content: FeedbackDiagnosticsEntryContent };

export interface FeedbackDiagnosticsPreviewProps {
  readonly client: FeedbackReportClient;
  readonly snapshot: FeedbackDiagnosticsSnapshot;
  readonly onExpired: () => void;
}

/**
 * The inventory and manifest of one prepared archive, read back from the
 * archive itself. Its text renders only as text and stays out of session replay.
 */
export function FeedbackDiagnosticsPreview({
  client,
  snapshot,
  onExpired,
}: FeedbackDiagnosticsPreviewProps): JSX.Element {
  const [visibleCount, setVisibleCount] = useState(INVENTORY_PAGE_SIZE);
  const [view, setView] = useState<EntryView | null>(null);
  const latestRead = useRef<string | null>(null);
  const { entries, skippedEntries, sizeBytes } = snapshot;
  const inlineContents = client.diagnosticTextVisibility === 'inline';

  function readEntry(path: string): void {
    if (view?.path === path) {
      latestRead.current = null;
      setView(null);
      return;
    }
    latestRead.current = path;
    setView({ path, status: 'reading' });
    void (
      client.readDiagnosticsEntry?.(snapshot.id, path) ??
      Promise.reject(new Error('Diagnostics are unavailable.'))
    )
      .then((content) => {
        if (latestRead.current === path)
          setView({ path, status: 'read', content });
      })
      .catch((error: unknown) => {
        if (error instanceof FeedbackDiagnosticsExpiredError) {
          onExpired();
          return;
        }
        if (latestRead.current === path) setView({ path, status: 'failed' });
      });
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-testid="feedback-diagnostics-preview"
    >
      <p className="text-xs fg-secondary">
        {entries.length} {entries.length === 1 ? 'file' : 'files'},{' '}
        {formatByteSize(sizeBytes)}. This is the archive that gets sent.
      </p>
      {inlineContents ? (
        <Disclosure label="Manifest" dataTestId="feedback-diagnostics-manifest">
          <CodeBlock
            variant="bare"
            className="max-h-64"
            data-dd-privacy="hidden"
            data-selectable
          >
            {snapshot.manifest}
          </CodeBlock>
        </Disclosure>
      ) : (
        <p className="text-xs fg-secondary">
          Save a copy to inspect the manifest and every file, including logs and
          error traces. The saved archive is identical to the attachment.
        </p>
      )}
      <ul
        className="flex min-w-0 flex-col gap-1"
        data-testid="feedback-diagnostics-inventory"
      >
        {entries.slice(0, visibleCount).map((entry) => (
          <li key={entry.path} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2 text-xs fg-secondary">
              <span
                className={`min-w-0 flex-1 truncate font-mono ${REPLAY_BLOCK_CLASS}`}
                data-dd-privacy="hidden"
                title={entry.path}
              >
                {entry.path}
              </span>
              <span className="shrink-0">
                {formatByteSize(entry.sizeBytes)}
              </span>
              {inlineContents ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={view?.path === entry.path}
                  onClick={(): void => readEntry(entry.path)}
                  data-testid="feedback-diagnostics-entry-view"
                >
                  {view?.path === entry.path ? 'Hide' : 'View'}
                </Button>
              ) : null}
            </div>
            {view?.path === entry.path ? <EntryBody view={view} /> : null}
          </li>
        ))}
      </ul>
      {entries.length > visibleCount ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={(): void =>
              setVisibleCount((count) => count + INVENTORY_PAGE_SIZE)
            }
            data-testid="feedback-diagnostics-show-more"
          >
            Show more ({entries.length - visibleCount} left)
          </Button>
        </div>
      ) : null}
      {skippedEntries.length > 0 ? (
        <Notice intent="neutral" data-testid="feedback-diagnostics-skipped">
          <span className="block">Left out of the archive:</span>
          <ul className="flex min-w-0 flex-col gap-1">
            {skippedEntries.map((entry) => (
              <li
                key={entry.path}
                className={`break-words font-mono text-xs ${REPLAY_BLOCK_CLASS}`}
                data-dd-privacy="hidden"
              >
                {entry.path}: {entry.reason}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}

function EntryBody({ view }: { readonly view: EntryView }): JSX.Element {
  if (view.status === 'reading')
    return <p className="text-xs fg-secondary">Opening this file…</p>;
  if (view.status === 'failed')
    return (
      <p className="text-xs fg-secondary">
        Couldn’t open this file. Save a copy to inspect it.
      </p>
    );
  if (view.content.kind === 'download-required')
    return (
      <p className="text-xs fg-secondary">
        {DOWNLOAD_REQUIRED_COPY[view.content.reason]}
      </p>
    );
  return (
    <CodeBlock
      variant="bare"
      className="max-h-64"
      data-dd-privacy="hidden"
      data-selectable
      data-testid="feedback-diagnostics-entry-text"
    >
      {view.content.text}
    </CodeBlock>
  );
}
