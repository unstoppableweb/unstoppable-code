'use client';
import {
  Children,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  DelegationPage,
  DelegationReadTarget,
  TranscriptReadSource,
} from '@canopy/app-core';
import {
  useCanopyClient,
  useDelegationPagesStore,
  useWorkspaceCapabilities,
} from '@canopy/app-state';
import { Button, Notice, NoticeButton } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  ToolOutputReaderContext,
  transcriptFieldUnavailable,
  type ToolOutputReader,
  type ToolOutputPage,
} from './DeferredToolOutput';
import {
  delegationChildRows,
  DelegationChildRowNotice,
  type DelegationChildRowDisplay,
  type DelegationChildRowEntry,
} from './delegation-child-rows';
import {
  DelegationRowBlocks,
  type DelegationBlockRenderer,
} from './DelegationRowBlocks';
import { TranscriptReadHostContext } from './transcript-read-host-context';
export type { DelegationChildRowEntry } from './delegation-child-rows';

/** Unknown store markers also fail closed rather than showing inline rows. */
export function isStreamBackedDelegation(
  transcriptStore: string | undefined,
): boolean {
  return transcriptStore !== undefined && transcriptStore !== 'chat-log-v1';
}

export interface DelegationChildPagesProps {
  readonly source?: TranscriptReadSource;
  readonly renderBlock?: DelegationBlockRenderer;
  readonly v2Available?: boolean;
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly hint?: { readonly epoch: number; readonly streamRevision?: number };
  /** The card's result, which the rows do not repeat. */
  readonly finalText?: string;
  /** Return one keyed element per entry, in order (including empty rows). */
  readonly renderRows?: (
    entries: readonly DelegationChildRowEntry[],
    display?: DelegationChildRowDisplay,
  ) => ReactNode;
}

function Unavailable({
  delegationId,
  runGeneration,
}: DelegationChildPagesProps): JSX.Element {
  return (
    <p
      className="px-2.5 py-2 text-xs fg-secondary"
      data-testid="delegation-child-pages-unavailable"
      data-target-delegation-id={delegationId}
      data-target-run-generation={runGeneration}
    >
      Couldn't load messages in this view.
    </p>
  );
}

type ReadableProps = DelegationChildPagesProps & {
  readonly source: TranscriptReadSource;
  readonly renderRows: NonNullable<DelegationChildPagesProps['renderRows']>;
};

/** Mount only when expanded; hosts without a renderer keep the same notice. */
export const DelegationChildPages = memo(function DelegationChildPages(
  props: DelegationChildPagesProps,
): JSX.Element {
  const host = useContext(TranscriptReadHostContext);
  const source = props.source ?? host?.source;
  const renderRows = props.renderRows ?? host?.renderRows;
  const hint = props.hint ?? (host ? { epoch: host.epoch } : undefined);
  if (!source || !renderRows) return <Unavailable {...props} />;
  return (
    <ReadableChildPages
      {...props}
      source={source}
      renderRows={renderRows}
      renderBlock={props.renderBlock ?? host?.renderBlock}
      v2Available={props.v2Available ?? host?.v2Available}
      hint={hint}
    />
  );
});

function ReadableChildPages(props: ReadableProps): JSX.Element {
  const client = useCanopyClient();
  const capabilities = useWorkspaceCapabilities(props.source.scope.worktreeId);
  const identity = JSON.stringify([
    props.source,
    props.delegationId,
    props.runGeneration,
    props.hint?.epoch ?? 0,
    props.v2Available,
  ]);
  return client.transcripts && capabilities.delegationTranscriptReads ? (
    <ChildWindow key={identity} {...props} />
  ) : (
    <Unavailable {...props} />
  );
}

function validRevision(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

interface WindowPage {
  readonly cursor: string;
  readonly page: DelegationPage;
}
interface WindowState {
  readonly pages: readonly WindowPage[];
  /** Only opaque cursor breadcrumbs, never retained page bodies. */
  readonly newer: readonly string[];
}
interface Anchor {
  readonly position?: {
    readonly element: HTMLElement;
    readonly top: number;
    readonly scroller: HTMLElement;
  };
  readonly focusId?: string;
}

function scrollContainer(element: HTMLElement): HTMLElement {
  let parent = element.parentElement;
  while (parent) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
    parent = parent.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.documentElement;
}

function ChildWindow({
  source,
  delegationId,
  runGeneration,
  hint,
  finalText,
  renderRows,
  renderBlock,
  v2Available,
}: ReadableProps): JSX.Element {
  const capabilities = useWorkspaceCapabilities(source.scope.worktreeId);
  const logicalAvailable =
    v2Available ?? capabilities.delegationBlockReads === true;
  const store = useDelegationPagesStore();
  const reads = store((state) => state);
  const target = useMemo<DelegationReadTarget>(
    () => ({
      kind: 'delegation',
      chatId: source.scope.chatId,
      delegationId,
      runGeneration,
    }),
    [source.scope.chatId, delegationId, runGeneration],
  );
  // The window key includes the complete serialized source and epoch. Retain
  // the supplied object untouched for that keyed lifetime, including host-only
  // provenance. An equal-by-value new source neither remounts nor refetches.
  const [stableSource] = useState(source);
  const [window, setWindow] = useState<WindowState>({ pages: [], newer: [] });
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const anchor = useRef<Anchor | undefined>(undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  const sequence = useRef(0);
  const currentWindow = useRef(window);
  currentWindow.current = window;
  const acceptedHint = useRef({
    epoch: hint?.epoch ?? 0,
    streamRevision: hint ? validRevision(hint.streamRevision) : 0,
  });
  const [observedRevision, setObservedRevision] = useState<number>();
  const observeRevision = useCallback((revision: number): void => {
    if (
      validRevision(revision) === undefined ||
      revision <= (acceptedHint.current.streamRevision ?? -1)
    )
      return;
    setObservedRevision((previous) => Math.max(previous ?? 0, revision));
  }, []);
  const incomingRevision =
    observedRevision === undefined
      ? validRevision(hint?.streamRevision)
      : Math.max(observedRevision, validRevision(hint?.streamRevision) ?? 0);
  if (
    incomingRevision !== undefined &&
    (acceptedHint.current.streamRevision === undefined ||
      incomingRevision > acceptedHint.current.streamRevision)
  )
    acceptedHint.current = {
      epoch: hint?.epoch ?? 0,
      streamRevision: incomingRevision,
    };
  const readerRevision = acceptedHint.current.streamRevision;
  const handledRevision = useRef(readerRevision);
  const historyLoaded = useRef(false);
  const [newMessages, setNewMessages] = useState(false);
  const revisionlessHint = useRef(false);
  revisionlessHint.current =
    hint !== undefined && hint.streamRevision === undefined;
  const entries = useMemo(
    () => delegationChildRows(window.pages.map((item) => item.page)),
    [window.pages],
  );
  const activeBodies = useRef(new Map<AbortController, string>());
  const currentEntries = useRef(entries);
  currentEntries.current = entries;

  useLayoutEffect(() => {
    const retainedRows = new Set(
      entries
        .filter((entry) => {
          const revision = window.pages.find((item) =>
            item.page.rows.some((row) => row.id === entry.key),
          )?.page.transcriptRevision;
          return (
            readerRevision === undefined ||
            (revision !== undefined && revision >= readerRevision)
          );
        })
        .map((entry) => entry.key),
    );
    for (const [controller, id] of activeBodies.current)
      if (!retainedRows.has(id)) controller.abort();
    const saved = anchor.current;
    anchor.current = undefined;
    if (!saved) return;
    if (saved.position) {
      const { element, top, scroller } = saved.position;
      scroller.scrollTop += element.getBoundingClientRect().top - top;
    }
    const focus = [
      ...(container.current?.querySelectorAll<HTMLElement>(
        '[data-child-row-id]',
      ) ?? []),
    ].find((row) => row.dataset.childRowId === saved.focusId);
    focus?.focus({ preventScroll: true });
  }, [window, entries, readerRevision]);

  const load = useCallback(
    async (
      direction: 'newest' | 'earlier' | 'newer',
      explicit: boolean,
      preserveRows = false,
    ): Promise<void> => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      const token = ++sequence.current;
      const before = currentWindow.current;
      const cursor =
        direction === 'earlier'
          ? before.pages[0]?.page.cursor
          : direction === 'newer'
            ? before.newer[0]
            : 'newest';
      if (cursor === undefined) return;
      setLoading(true);
      setFailed(false);
      let result = await reads.readPage(
        {
          source: stableSource,
          target,
          cursor,
          epoch: acceptedHint.current.epoch,
          streamRevisionHint: revisionlessHint.current
            ? undefined
            : acceptedHint.current.streamRevision,
        },
        controller.signal,
      );
      if (token !== sequence.current || controller.signal.aborted) return;
      let refreshed = direction === 'newest';
      if (!result.ok && result.kind === 'stale') {
        refreshed = true;
        result = await reads.readPage(
          {
            source: stableSource,
            target,
            cursor: 'newest',
            epoch: acceptedHint.current.epoch,
            streamRevisionHint: revisionlessHint.current
              ? undefined
              : acceptedHint.current.streamRevision,
          },
          controller.signal,
        );
        if (token !== sequence.current || controller.signal.aborted) return;
      }
      if (!result.ok) {
        setLoading(false);
        setFailed(result.kind !== 'cancelled');
        return;
      }
      const nextPage: WindowPage = {
        cursor: refreshed ? 'newest' : cursor,
        page: result.value,
      };
      let pages: readonly WindowPage[] = [nextPage];
      let newer: readonly string[] = [];
      if (preserveRows && refreshed) {
        const retained = new Set(
          before.pages.flatMap((item) => item.page.rows.map((row) => row.id)),
        );
        for (const row of nextPage.page.rows) retained.delete(row.id);
        while (retained.size > 0 && pages.length < 4) {
          const earlier = pages[0]?.page.cursor;
          if (!earlier) break;
          const older = await reads.readPage(
            {
              source: stableSource,
              target,
              cursor: earlier,
              epoch: acceptedHint.current.epoch,
              streamRevisionHint: nextPage.page.transcriptRevision,
            },
            controller.signal,
          );
          if (token !== sequence.current || controller.signal.aborted) return;
          if (
            !older.ok ||
            older.value.transcriptRevision !== nextPage.page.transcriptRevision
          ) {
            setLoading(false);
            setFailed(older.ok || older.kind !== 'cancelled');
            return;
          }
          pages = [{ cursor: earlier, page: older.value }, ...pages];
          for (const row of older.value.rows) retained.delete(row.id);
        }
      }
      if (!refreshed && direction === 'earlier') {
        const combined = [nextPage, ...before.pages];
        const dropped = combined.length > 4 ? combined[4] : undefined;
        pages = combined.slice(0, 4);
        newer = dropped ? [dropped.cursor, ...before.newer] : before.newer;
      } else if (!refreshed && direction === 'newer') {
        pages = [...before.pages, nextPage].slice(-4);
        newer = before.newer.slice(1);
      }
      const resolvedRevision = validRevision(result.value.transcriptRevision);
      if (
        resolvedRevision !== undefined &&
        (acceptedHint.current.streamRevision === undefined ||
          resolvedRevision > acceptedHint.current.streamRevision)
      ) {
        acceptedHint.current = {
          ...acceptedHint.current,
          streamRevision: resolvedRevision,
        };
        handledRevision.current = resolvedRevision;
      }
      if (refreshed) {
        historyLoaded.current = false;
        setNewMessages(false);
      } else if (direction === 'earlier') historyLoaded.current = true;
      setLoading(false);
      const nextIds = new Set(
        pages.flatMap((item) => item.page.rows.map((row) => row.id)),
      );
      const oldIds = new Set(currentEntries.current.map((entry) => entry.key));
      const focusId = explicit
        ? result.value.rows.find((row) => !oldIds.has(row.id))?.id
        : undefined;
      const retained = [
        ...(container.current?.querySelectorAll<HTMLElement>(
          '[data-child-row-id]',
        ) ?? []),
      ].filter((row) => nextIds.has(row.dataset.childRowId ?? ''));
      const scroller = container.current
        ? scrollContainer(container.current)
        : undefined;
      const visible = scroller
        ? (retained.find(
            (row) =>
              row.getBoundingClientRect().bottom >=
              scroller.getBoundingClientRect().top,
          ) ?? retained[0])
        : undefined;
      anchor.current = {
        ...(visible && scroller
          ? {
              position: {
                element: visible,
                top: visible.getBoundingClientRect().top,
                scroller,
              },
            }
          : {}),
        focusId,
      };
      setWindow({ pages, newer });
    },
    [reads, stableSource, target],
  );

  useEffect(() => {
    const releaseTarget = reads.retainTarget?.({
      source: stableSource,
      target,
      epoch: acceptedHint.current.epoch,
    });
    const bodies = activeBodies.current;
    void load('newest', false);
    return (): void => {
      sequence.current += 1;
      pending.current?.abort();
      currentEntries.current = [];
      for (const controller of bodies.keys()) controller.abort();
      releaseTarget?.();
    };
  }, [load, reads, stableSource, target]);
  useLayoutEffect(() => {
    if (readerRevision === handledRevision.current) return;
    handledRevision.current = readerRevision;
    for (const controller of activeBodies.current.keys()) controller.abort();
    if (readerRevision !== undefined)
      reads.advanceRevision?.({
        source: stableSource,
        target,
        epoch: acceptedHint.current.epoch,
        streamRevisionHint: readerRevision,
      });
    if (historyLoaded.current) {
      sequence.current += 1;
      pending.current?.abort();
      setLoading(false);
      setNewMessages(true);
    } else void load('newest', false, true);
  }, [readerRevision, reads, stableSource, target, load]);
  const readerEpoch = acceptedHint.current.epoch;
  const windowRevision = Math.max(
    0,
    ...window.pages.map((item) => item.page.transcriptRevision),
  );

  // Same-revision paging preserves the reader. A hint or resolved revision
  // change revokes full bodies; the live row lookup also fences eviction.
  const reader = useMemo<ToolOutputReader>(
    () =>
      async (identity, offset, signal): Promise<ToolOutputPage> => {
        if (
          identity.kind !== 'row' ||
          readerEpoch !== acceptedHint.current.epoch ||
          readerRevision !== acceptedHint.current.streamRevision ||
          windowRevision !==
            Math.max(
              0,
              ...currentWindow.current.pages.map(
                (item) => item.page.transcriptRevision,
              ),
            )
        )
          throw new Error(
            transcriptFieldUnavailable(
              identity.kind === 'row' ? identity.field : 'output',
            ),
          );
        const row = currentEntries.current.find(
          (entry) => entry.key === identity.messageId,
        )?.row;
        const rowRevision = currentWindow.current.pages.find((item) =>
          item.page.rows.some((member) => member.id === identity.messageId),
        )?.page.transcriptRevision;
        if (
          !row ||
          (readerRevision !== undefined &&
            (rowRevision === undefined || rowRevision < readerRevision))
        )
          throw new Error(
            transcriptFieldUnavailable(
              identity.kind === 'row' ? identity.field : 'output',
            ),
          );
        // A paged row can resolve a newer block revision before its card hint.
        // Carry that UI-local fence into body flight identity, never transport.
        const blockRevision =
          'streamRevision' in identity &&
          typeof identity.streamRevision === 'number' &&
          Number.isSafeInteger(identity.streamRevision) &&
          identity.streamRevision >= 0
            ? identity.streamRevision
            : 0;
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) controller.abort();
        activeBodies.current.set(controller, identity.messageId);
        try {
          const result = await reads.readContent(
            {
              ...stableSource,
              target,
              messageId: identity.messageId,
              blockOrdinal: identity.blockOrdinal,
              field: identity.field,
              epoch: readerEpoch,
              streamRevision: Math.max(
                readerRevision ?? 0,
                rowRevision ?? 0,
                blockRevision,
              ),
              ...(logicalAvailable ? { fieldSource: 'logical' } : {}),
              offset,
              limit: 65536,
            },
            controller.signal,
          );
          if (
            controller.signal.aborted ||
            readerRevision !== acceptedHint.current.streamRevision ||
            rowRevision !==
              currentWindow.current.pages.find((item) =>
                item.page.rows.some(
                  (member) => member.id === identity.messageId,
                ),
              )?.page.transcriptRevision ||
            !currentEntries.current.some(
              (entry) => entry.key === identity.messageId,
            )
          )
            throw new DOMException('Cancelled', 'AbortError');
          if (!result.ok) {
            if (result.kind === 'cancelled')
              throw new DOMException('Cancelled', 'AbortError');
            throw new Error(
              transcriptFieldUnavailable(
                identity.kind === 'row' ? identity.field : 'output',
              ),
            );
          }
          return result.value;
        } finally {
          signal.removeEventListener('abort', abort);
          activeBodies.current.delete(controller);
        }
      },
    [
      reads,
      stableSource,
      target,
      readerEpoch,
      readerRevision,
      windowRevision,
      logicalAvailable,
    ],
  );
  const rendered = Children.toArray(
    renderRows(entries, finalText !== undefined ? { finalText } : {}),
  );
  return (
    <div
      ref={container}
      data-testid="delegation-child-pages"
      aria-busy={loading}
    >
      {window.pages[0]?.page.cursor !== undefined && (
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => {
            void load('earlier', true);
          }}
        >
          Load earlier messages
        </Button>
      )}
      <div role="status" className="px-2.5 text-xs fg-secondary">
        {loading ? 'Loading messages…' : null}
      </div>
      {newMessages && (
        <Notice
          role="status"
          intent="neutral"
          surface="none"
          actions={
            <NoticeButton
              disabled={loading}
              onClick={() => {
                void load('newest', true);
              }}
            >
              Show latest
            </NoticeButton>
          }
        >
          New messages
        </Notice>
      )}
      {failed && (
        <Notice
          intent="neutral"
          surface="none"
          actions={
            <NoticeButton
              disabled={loading}
              onClick={() => {
                void load('newest', true);
              }}
            >
              Try again
            </NoticeButton>
          }
        >
          {source.standaloneHistory && source.archivedContainerId
            ? "Couldn't load archived messages."
            : "Couldn't load messages."}
        </Notice>
      )}
      {window.pages.some((item) => item.page.runTruncated) && (
        <Notice intent="neutral" surface="none">
          Part of this agent's messages isn't shown here.
        </Notice>
      )}
      <ToolOutputReaderContext.Provider value={reader}>
        {entries.map((entry, index) => (
          <div
            key={entry.key}
            data-child-row-id={entry.key}
            tabIndex={-1}
            className="focus-ring"
          >
            <div data-child-row-content className={REPLAY_BLOCK_CLASS}>
              {!entry.row.blocksPaged && rendered[index]}
            </div>
            {entry.row.blocksPaged && renderBlock ? (
              <DelegationRowBlocks
                source={stableSource}
                target={target}
                row={entry.row}
                epoch={readerEpoch}
                streamRevisionHint={Math.max(
                  readerRevision ?? 0,
                  window.pages.find((item) =>
                    item.page.rows.some((member) => member.id === entry.key),
                  )?.page.transcriptRevision ?? 0,
                )}
                available={logicalAvailable}
                onRevision={observeRevision}
                renderEntry={renderBlock}
              />
            ) : (
              (entry.row.truncated || entry.row.blocksPaged) && (
                <DelegationChildRowNotice
                  partial={entry.row.blocksPaged !== undefined}
                />
              )
            )}
          </div>
        ))}
      </ToolOutputReaderContext.Provider>
      {window.newer.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => {
            void load('newer', true);
          }}
        >
          Load newer messages
        </Button>
      )}
    </div>
  );
}
