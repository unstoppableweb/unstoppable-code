'use client';

import { useEffect, useMemo, useState, type JSX } from 'react';
import type { PortalChatMessage } from '@canopy/protocol/portal';
import {
  expandTurnFileRecords,
  reconcileTurnFileRecords,
  turnFileHref,
  type TurnFileRecord,
} from '@canopy/protocol/turn-files';
import {
  TurnFileChipView,
  TurnFilesSummaryView,
  formatTurnFilesHeading,
  useToolApprovalWait,
} from '@canopy/ui-shared/components';
import { useTranscriptFileLinkInteraction } from './TranscriptFileLinks';

/** Host adapter: reuse its existing authorized resolver and viewer. */
export interface TranscriptTurnFilesInteraction {
  readonly filesByTurn?: Readonly<Record<string, readonly TurnFileRecord[]>>;
  readonly collect: (
    messages: readonly PortalChatMessage[],
    retained?: readonly TurnFileRecord[],
  ) => readonly TurnFileRecord[];
  readonly resolve: (file: TurnFileRecord) => Promise<{
    readonly identity: string;
    readonly projectName?: string;
    readonly exists?: boolean;
  } | null>;
}

interface LocatedFile {
  file: TurnFileRecord;
  identity: string;
  projectName?: string;
  exists?: boolean;
  sourceIdentities?: string[];
}

function FileChip({
  entry,
  pending = false,
  waiting = false,
  presentation = 'row',
}: {
  entry: LocatedFile;
  pending?: boolean;
  waiting?: boolean;
  presentation?: 'row' | 'summary';
}): JSX.Element {
  const interaction = useTranscriptFileLinkInteraction();
  const [status, setStatus] = useState<string>();
  const [opening, setOpening] = useState(false);
  const file = entry.file;
  return (
    <TurnFileChipView
      presentation={presentation}
      filename={file.path.split(/[\\/]/).pop() ?? file.path}
      change={file.change}
      pending={pending}
      waiting={waiting}
      opening={opening}
      location={`${file.change === 'updated' ? 'Updated' : 'Saved'} in ${entry.projectName ?? 'project folder'}`}
      {...(pending ? {} : { status })}
      onOpen={(): void => {
        setOpening(true);
        setStatus('Opening…');
        void interaction
          ?.openFileLink?.(turnFileHref(file.path))
          .then(
            (opened) => {
              setStatus(opened ? undefined : 'This file is unavailable.');
            },
            () => {
              setStatus('Unable to open this file. Try again.');
            },
          )
          .finally(() => {
            setOpening(false);
          });
      }}
    />
  );
}

/** File evidence is discovered from tools, independently of model prose. */
export function TurnFiles({
  messages,
  retained,
  complete,
  latest,
  turnId,
}: {
  readonly messages: readonly PortalChatMessage[];
  readonly retained?: readonly TurnFileRecord[];
  readonly complete: boolean;
  readonly latest: boolean;
  readonly turnId: string;
}): JSX.Element | null {
  const interaction = useTranscriptFileLinkInteraction();
  const approvalWait = useToolApprovalWait();
  const host = interaction?.turnFiles;
  const files = useMemo(
    () =>
      expandTurnFileRecords(
        host?.collect(messages, retained ?? host.filesByTurn?.[turnId]) ?? [],
      ),
    [host, messages, retained, turnId],
  );
  const [answer, setAnswer] = useState<{
    files: readonly TurnFileRecord[];
    located: LocatedFile[];
    unresolvedPending: LocatedFile[];
    unresolvedMutation: boolean;
  }>();

  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!latest) setExpanded(false);
  }, [latest]);
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void (async (): Promise<void> => {
      const entries: LocatedFile[] = [];
      const unresolvedPending: LocatedFile[] = [];
      let unresolvedMutation = false;
      const resolutions = new Map<
        string,
        ReturnType<TranscriptTurnFilesInteraction['resolve']>
      >();
      const resolve = (
        file: TurnFileRecord,
      ): ReturnType<TranscriptTurnFilesInteraction['resolve']> => {
        const key = JSON.stringify([
          file.target,
          file.path,
          file.state === 'ready' && !file.removed,
        ]);
        let result = resolutions.get(key);
        if (!result) {
          result = host.resolve(file);
          resolutions.set(key, result);
        }
        return result;
      };
      // Bounded sequential checks avoid bursting a remote host for long turns.
      for (const file of files) {
        try {
          const result = await resolve(file);
          if (cancelled) return;
          if (!result) {
            if (file.state === 'creating')
              unresolvedPending.push({ file, identity: file.path });
            continue;
          }
          const sourceIdentities: string[] = [];
          for (const path of file.movedFrom ?? []) {
            const source = await resolve({
              path,
              state: 'failed',
              ...(file.target ? { target: file.target } : {}),
            });
            if (source) sourceIdentities.push(source.identity);
          }
          entries.push({ file, ...result, sourceIdentities });
        } catch {
          /* Transport failure is not existence evidence. Retry on the next projection. */
          if (file.state !== 'ready' || file.saved || file.change)
            unresolvedMutation = true;
          if (file.state === 'creating')
            unresolvedPending.push({ file, identity: file.path });
        }
      }
      if (!cancelled)
        setAnswer({
          files,
          located: reconcileTurnFileRecords(entries),
          unresolvedPending,
          unresolvedMutation,
        });
    })();
    return (): void => {
      cancelled = true;
    };
  }, [host, files, complete]);
  if (!host || !interaction?.openFileLink) return null;
  const reconciled = answer?.files === files ? answer.located : [];
  const located = reconciled.filter(
    ({ file, exists }) =>
      file.state === 'ready' &&
      !file.removed &&
      exists !== false &&
      (!answer?.unresolvedMutation || file.saved || file.change),
  );
  const pending = complete
    ? []
    : answer?.files === files
      ? [
          ...reconciled.filter((entry) => entry.file.state === 'creating'),
          ...answer.unresolvedPending,
        ]
      : files
          .filter((file) => file.state === 'creating')
          .map((file) => ({ file, identity: file.path }));
  const waiting = new Set(
    pending
      .filter(({ file }) => approvalWait.isFileWaiting(file.path))
      .map(({ identity }) => identity),
  );
  const heading = formatTurnFilesHeading([
    ...located.map((entry) => entry.file),
    ...pending.map(({ file, identity }) => ({
      change: file.change,
      pending: true,
      waiting: waiting.has(identity),
    })),
  ]);
  if (!heading) return null;
  const entries = [
    ...located.map((entry) => (
      <FileChip
        key={entry.identity}
        entry={entry}
        presentation={located.length + pending.length === 1 ? 'summary' : 'row'}
      />
    )),
    ...pending.map((entry) => (
      <FileChip
        key={entry.identity}
        entry={entry}
        pending
        waiting={waiting.has(entry.identity)}
        presentation={located.length + pending.length === 1 ? 'summary' : 'row'}
      />
    )),
  ];
  return (
    <TurnFilesSummaryView
      heading={heading}
      turnId={turnId}
      expanded={expanded}
      onToggle={(): void => setExpanded((value) => !value)}
    >
      {entries}
    </TurnFilesSummaryView>
  );
}
