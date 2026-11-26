'use client';
import {
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
  DelegationBlocksPage,
  DelegationReadTarget,
  PortableChildRow,
  TranscriptBlockEntry,
  TranscriptReadSource,
} from '@canopy/app-core';
import {
  useDelegationPagesStore,
  useWorkspaceCapabilities,
} from '@canopy/app-state';
import { Button, Notice, NoticeButton } from '@canopy/ui-shared/components';
import {
  DeferredToolOutput,
  ToolOutputReaderContext,
  transcriptFieldUnavailable,
  type ToolOutputReader,
  type ToolOutputIdentity,
  type ToolOutputPage,
} from './DeferredToolOutput';
import { DelegationChildRowNotice } from './delegation-child-rows';

/**
 * Validate block/preview against the host model; never derive an ordinal from an
 * array index. Apply replay blocking narrowly to private body content, not the
 * host's card titles or controls. Omitted-field readers are mounted by this UI.
 */
export type DelegationBlockRenderer = (
  entry: TranscriptBlockEntry,
  row: PortableChildRow,
) => ReactNode;
export interface DelegationRowBlocksProps {
  readonly source: TranscriptReadSource;
  readonly target: DelegationReadTarget;
  readonly row: PortableChildRow;
  readonly epoch: number;
  readonly streamRevisionHint?: number;
  /** Feed a resolved block revision into the owning child's existing hint path. */
  readonly onRevision?: (revision: number) => void;
  readonly renderEntry: DelegationBlockRenderer;
  /** Live v2 availability; the owning host's capability remains required too. */
  readonly available?: boolean;
}
/** UI-local authorization metadata, never a transcript transport field. */
type DelegationBodyIdentity = ToolOutputIdentity & {
  readonly streamRevision: number;
};
const PAGE_COUNT = 16;
const WINDOW_PAGES = 4;

/** No acquisition until explicit expansion; key all window/controller state to provenance. */
export const DelegationRowBlocks = memo(function DelegationRowBlocks(
  props: DelegationRowBlocksProps,
): JSX.Element {
  const capability = useWorkspaceCapabilities(props.source.scope.worktreeId);
  const enabled =
    capability.delegationBlockReads === true && props.available !== false;
  const identity = JSON.stringify([
    props.source,
    props.target,
    props.epoch,
    props.row.id,
    enabled,
  ]);
  return <BlockWindow key={identity} {...props} available={enabled} />;
});

/**
 * The host renders a preview's structure only: its omitted fields are blank,
 * because each one's own viewer below shows the preview and the full body. A
 * text or thinking block with only omitted text has nothing else to render.
 */
function hostEntry(entry: TranscriptBlockEntry): TranscriptBlockEntry | null {
  if (entry.kind !== 'preview') return entry;
  const block: unknown = entry.block;
  if (typeof block !== 'object' || block === null) return entry;
  const fields: Record<string, unknown> = { ...block };
  if (
    (fields.type === 'text' || fields.type === 'thinking') &&
    entry.omittedFields.includes('text')
  )
    return null;
  for (const field of entry.omittedFields) fields[field] = '';
  return { ...entry, block: fields };
}

function BlockContent({
  entry,
  row,
  renderEntry,
}: {
  readonly entry: TranscriptBlockEntry;
  readonly row: PortableChildRow;
  readonly renderEntry: DelegationBlockRenderer;
}): ReactNode {
  const host = hostEntry(entry);
  return host ? <div data-block-content>{renderEntry(host, row)}</div> : null;
}

function previewField(block: unknown, field: string): string {
  if (typeof block !== 'object' || block === null || !(field in block))
    return '';
  const value: unknown = Reflect.get(block, field);
  return typeof value === 'string' ? value : '';
}
function scrollerFor(element: HTMLElement): HTMLElement {
  let parent = element.parentElement;
  while (parent) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
    parent = parent.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.documentElement;
}
interface WindowAnchor {
  readonly element?: HTMLElement;
  readonly top?: number;
  readonly scroller?: HTMLElement;
  readonly focusOrdinal?: number;
}
function BlockWindow({
  source: incomingSource,
  target: incomingTarget,
  row,
  epoch,
  streamRevisionHint,
  onRevision,
  renderEntry,
  available,
}: DelegationRowBlocksProps): JSX.Element {
  // The wrapper keys the full provenance. Equal-by-value host objects share
  // this lifetime and must not release another reader's source lease.
  const [source] = useState(incomingSource);
  const [target] = useState(incomingTarget);
  const store = useDelegationPagesStore();
  const reads = store((state) => state);
  const parentRead = useContext(ToolOutputReaderContext);
  const [opened, setOpened] = useState(false);
  const [pages, setPages] = useState<readonly DelegationBlocksPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<'failed' | 'unavailable'>();
  const [runTruncated, setRunTruncated] = useState(false);
  const sequence = useRef(0);
  const pending = useRef<AbortController | undefined>(undefined);
  const container = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const bodyReads = useRef(new Map<AbortController, number>());
  const acceptedRevision = useRef<number | undefined>(
    streamRevisionHint !== undefined &&
      Number.isSafeInteger(streamRevisionHint) &&
      streamRevisionHint >= 0
      ? streamRevisionHint
      : undefined,
  );
  if (
    streamRevisionHint !== undefined &&
    Number.isSafeInteger(streamRevisionHint) &&
    streamRevisionHint >= 0 &&
    (acceptedRevision.current === undefined ||
      streamRevisionHint > acceptedRevision.current)
  )
    acceptedRevision.current = streamRevisionHint;
  const revision = acceptedRevision.current;
  const handledRevision = useRef(revision);
  const currentPages = useRef(pages);
  currentPages.current = pages;
  const lastRequest = useRef<{
    cursor?: string;
    firstBlockOrdinal?: number;
    direction: 'first' | 'earlier' | 'more' | 'refresh';
  }>({ firstBlockOrdinal: 0, direction: 'first' });
  const entries = useMemo(() => {
    const byOrdinal = new Map<number, TranscriptBlockEntry>();
    for (const page of pages)
      for (const entry of page.entries) byOrdinal.set(entry.ordinal, entry);
    return [...byOrdinal.values()].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
  }, [pages]);
  const blocksCurrent = pages.every(
    (page) => revision === undefined || page.transcriptRevision >= revision,
  );
  const currentEntries = useRef(entries);
  currentEntries.current = blocksCurrent ? entries : [];
  const blockHeights = useRef(new Map<number, number>());
  const anchor = useRef<WindowAnchor | undefined>(undefined);
  const blockRevision = pages[0]?.transcriptRevision;
  const previousRevision = useRef(blockRevision);

  useLayoutEffect(() => {
    const ordinals = new Set(
      currentEntries.current.map((entry) => entry.ordinal),
    );
    if (blocksCurrent) {
      blockHeights.current.clear();
      for (const element of container.current?.querySelectorAll<HTMLElement>(
        '[data-block-ordinal]',
      ) ?? [])
        blockHeights.current.set(
          Number(element.dataset.blockOrdinal),
          element.getBoundingClientRect().height,
        );
    }
    for (const [controller, ordinal] of bodyReads.current)
      if (!ordinals.has(ordinal) || previousRevision.current !== blockRevision)
        controller.abort();
    previousRevision.current = blockRevision;
    const saved = anchor.current;
    anchor.current = undefined;
    if (!saved) return;
    if (
      saved.element?.isConnected &&
      saved.scroller &&
      saved.top !== undefined
    ) {
      saved.scroller.scrollTop +=
        saved.element.getBoundingClientRect().top - saved.top;
    }
    const focus = [
      ...(container.current?.querySelectorAll<HTMLElement>(
        '[data-block-ordinal]',
      ) ?? []),
    ].find(
      (element) => Number(element.dataset.blockOrdinal) === saved.focusOrdinal,
    );
    focus?.focus({ preventScroll: true });
  }, [entries, blockRevision, blocksCurrent]);
  useEffect(() => {
    const releaseTarget = reads.retainTarget?.({ source, target, epoch });
    const bodies = bodyReads.current;
    return (): void => {
      sequence.current += 1;
      pending.current?.abort();
      currentEntries.current = [];
      for (const controller of bodies.keys()) controller.abort();
      releaseTarget?.();
    };
  }, [reads, source, target, epoch]);

  const bodyReader = useMemo<ToolOutputReader | null>(
    () =>
      parentRead
        ? async (identity, offset, signal): Promise<ToolOutputPage> => {
            if (
              identity.kind !== 'row' ||
              identity.messageId !== row.id ||
              revision !== acceptedRevision.current ||
              !currentEntries.current.some(
                (entry) => entry.ordinal === identity.blockOrdinal,
              )
            )
              throw new Error(
                transcriptFieldUnavailable(
                  identity.kind === 'row' ? identity.field : 'output',
                ),
              );
            const bodyRevision = blockRevision;
            const controller = new AbortController();
            const abort = (): void => controller.abort();
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) controller.abort();
            bodyReads.current.set(controller, identity.blockOrdinal);
            try {
              const scopedIdentity: DelegationBodyIdentity = {
                ...identity,
                streamRevision: Math.max(blockRevision ?? 0, revision ?? 0),
              };
              const result = await parentRead(
                scopedIdentity,
                offset,
                controller.signal,
              );
              if (
                controller.signal.aborted ||
                currentPages.current[0]?.transcriptRevision !== bodyRevision ||
                revision !== acceptedRevision.current ||
                !currentEntries.current.some(
                  (entry) => entry.ordinal === identity.blockOrdinal,
                )
              )
                throw new DOMException('Cancelled', 'AbortError');
              return result;
            } finally {
              signal.removeEventListener('abort', abort);
              bodyReads.current.delete(controller);
            }
          }
        : null,
    [parentRead, row.id, blockRevision, revision],
  );

  const load = useCallback(
    async (
      direction: 'first' | 'earlier' | 'more' | 'refresh',
      retry = false,
    ): Promise<void> => {
      const before = currentPages.current;
      const requestedPosition = retry
        ? lastRequest.current
        : direction === 'more'
          ? { cursor: before[before.length - 1]?.cursor, direction }
          : {
              firstBlockOrdinal:
                direction === 'refresh'
                  ? (before[0]?.firstBlockOrdinal ?? 0)
                  : direction === 'earlier'
                    ? Math.max(
                        0,
                        (before[0]?.firstBlockOrdinal ?? 0) - PAGE_COUNT,
                      )
                    : 0,
              direction,
            };
      const retainedStartOrdinal = before[0]?.firstBlockOrdinal ?? 0;
      const currentBlockCount = row.blocksPaged?.blockCount;
      const position =
        direction === 'refresh' &&
        currentBlockCount !== undefined &&
        retainedStartOrdinal >= currentBlockCount
          ? { firstBlockOrdinal: 0, direction }
          : requestedPosition;
      if (position.direction === 'more' && !position.cursor) return;
      lastRequest.current = position;
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      const token = ++sequence.current;
      let refreshRevision = acceptedRevision.current;
      const adoptRefreshRevision = (page: DelegationBlocksPage): void => {
        if (
          direction === 'refresh' &&
          Number.isSafeInteger(page.transcriptRevision) &&
          page.transcriptRevision >= 0 &&
          (refreshRevision === undefined ||
            page.transcriptRevision > refreshRevision)
        )
          refreshRevision = page.transcriptRevision;
      };
      setOpened(true);
      setLoading(true);
      setFailure(undefined);
      let result = await reads.readBlocks(
        {
          ...source,
          target,
          messageId: row.id,
          epoch,
          streamRevisionHint:
            direction === 'refresh'
              ? refreshRevision
              : acceptedRevision.current,
          ...(position.cursor
            ? { cursor: position.cursor }
            : { firstBlockOrdinal: position.firstBlockOrdinal ?? 0 }),
          limit: PAGE_COUNT,
        },
        controller.signal,
      );
      if (controller.signal.aborted || token !== sequence.current) return;
      if (!result.ok) {
        setLoading(false);
        if (result.kind !== 'cancelled')
          setFailure(result.kind === 'unavailable' ? 'unavailable' : 'failed');
        return;
      }
      adoptRefreshRevision(result.value);
      if (
        position.direction === 'refresh' &&
        before.length > 0 &&
        (before[before.length - 1]?.nextBlockOrdinal ??
          (before[before.length - 1]?.firstBlockOrdinal ?? 0) +
            (before[before.length - 1]?.entries.length ?? 0)) >
          result.value.blockCount &&
        result.value.firstBlockOrdinal !== 0
      ) {
        result = await reads.readBlocks(
          {
            ...source,
            target,
            messageId: row.id,
            epoch,
            streamRevisionHint: refreshRevision,
            firstBlockOrdinal: 0,
            limit: PAGE_COUNT,
          },
          controller.signal,
        );
        if (controller.signal.aborted || token !== sequence.current) return;
        if (!result.ok) {
          setLoading(false);
          if (result.kind !== 'cancelled')
            setFailure(
              result.kind === 'unavailable' ? 'unavailable' : 'failed',
            );
          return;
        }
        adoptRefreshRevision(result.value);
      }
      const page = result.value;
      setRunTruncated((previous) => previous || page.runTruncated === true);
      let next: readonly DelegationBlocksPage[] = [page];
      if (
        position.direction === 'refresh' &&
        (page.firstBlockOrdinal !== 0 ||
          (before[0]?.firstBlockOrdinal ?? 0) === 0)
      ) {
        const end = before[before.length - 1];
        const lastOrdinal = end
          ? end.firstBlockOrdinal + end.entries.length
          : page.firstBlockOrdinal + PAGE_COUNT;
        while (next.length < WINDOW_PAGES) {
          const tail = next[next.length - 1];
          if (
            !tail?.cursor ||
            tail.firstBlockOrdinal + tail.entries.length >= lastOrdinal
          )
            break;
          const more = await reads.readBlocks(
            {
              ...source,
              target,
              messageId: row.id,
              epoch,
              streamRevisionHint:
                direction === 'refresh'
                  ? refreshRevision
                  : acceptedRevision.current,
              cursor: tail.cursor,
              limit: PAGE_COUNT,
            },
            controller.signal,
          );
          if (controller.signal.aborted || token !== sequence.current) return;
          if (
            !more.ok ||
            more.value.transcriptRevision !== page.transcriptRevision
          ) {
            setLoading(false);
            setFailure('failed');
            return;
          }
          next = [...next, more.value];
        }
      }
      if (
        Number.isSafeInteger(page.transcriptRevision) &&
        page.transcriptRevision >= 0 &&
        (acceptedRevision.current === undefined ||
          page.transcriptRevision > acceptedRevision.current)
      ) {
        acceptedRevision.current = page.transcriptRevision;
        handledRevision.current = page.transcriptRevision;
      }
      onRevision?.(page.transcriptRevision);
      setLoading(false);
      const sameRevision = before.every(
        (item) => item.transcriptRevision === page.transcriptRevision,
      );
      if (
        position.direction === 'more' &&
        page.firstBlockOrdinal !== 0 &&
        sameRevision
      )
        next = [...before, page].slice(-WINDOW_PAGES);
      else if (
        position.direction === 'earlier' &&
        sameRevision &&
        page.firstBlockOrdinal + page.entries.length >=
          (before[0]?.firstBlockOrdinal ?? 0)
      )
        next = [page, ...before].slice(0, WINDOW_PAGES);
      const newOrdinals = new Set(
        next.flatMap((item) => item.entries.map((entry) => entry.ordinal)),
      );
      const oldOrdinals = new Set(
        currentEntries.current.map((entry) => entry.ordinal),
      );
      const retained = [
        ...(container.current?.querySelectorAll<HTMLElement>(
          '[data-block-ordinal]',
        ) ?? []),
      ].filter((element) =>
        newOrdinals.has(Number(element.dataset.blockOrdinal)),
      );
      const scroller = container.current
        ? scrollerFor(container.current)
        : undefined;
      const visible = scroller
        ? (retained.find(
            (element) =>
              element.getBoundingClientRect().bottom >=
              scroller.getBoundingClientRect().top,
          ) ?? retained[0])
        : undefined;
      anchor.current = {
        element: visible,
        top: visible?.getBoundingClientRect().top,
        scroller,
        focusOrdinal:
          position.direction === 'refresh'
            ? undefined
            : page.entries.find((entry) => !oldOrdinals.has(entry.ordinal))
                ?.ordinal,
      };
      setPages(next);
    },
    [
      reads,
      source,
      target,
      row.id,
      row.blocksPaged?.blockCount,
      epoch,
      onRevision,
    ],
  );

  useLayoutEffect(() => {
    if (revision === handledRevision.current) return;
    handledRevision.current = revision;
    sequence.current += 1;
    pending.current?.abort();
    for (const controller of bodyReads.current.keys()) controller.abort();
    if (revision !== undefined)
      reads.advanceRevision?.({
        source,
        target,
        epoch,
        streamRevisionHint: revision,
      });
    if (opened) void load('refresh');
  }, [revision, reads, source, target, epoch, opened, load]);

  function collapse(): void {
    sequence.current += 1;
    pending.current?.abort();
    for (const controller of bodyReads.current.keys()) controller.abort();
    currentEntries.current = [];
    setPages([]);
    setOpened(false);
    setLoading(false);
    setFailure(undefined);
    toggle.current?.focus({ preventScroll: true });
  }
  return (
    <div
      ref={container}
      data-testid="delegation-row-blocks"
      aria-busy={loading}
    >
      <DelegationChildRowNotice partial />
      {available && (
        <Button
          ref={toggle}
          variant="ghost"
          size="sm"
          aria-expanded={opened}
          onClick={() => {
            if (opened) collapse();
            else void load('first');
          }}
        >
          {opened ? 'Hide message' : 'Show message'}
        </Button>
      )}
      {opened && (
        <>
          {(pages[0]?.firstBlockOrdinal ?? 0) > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => {
                void load('earlier');
              }}
            >
              Show earlier
            </Button>
          )}
          {loading && (
            <div role="status" className="text-xs fg-secondary">
              Loading messages…
            </div>
          )}
          {failure && (
            <Notice
              intent="neutral"
              surface="none"
              actions={
                <NoticeButton
                  disabled={loading}
                  onClick={() => {
                    void load(lastRequest.current.direction, true);
                  }}
                >
                  Try again
                </NoticeButton>
              }
            >
              {failure === 'unavailable'
                ? "Couldn't load messages in this view."
                : "Couldn't load messages."}
            </Notice>
          )}
          {runTruncated && (
            <Notice intent="neutral" surface="none">
              Part of this agent's messages isn't shown here.
            </Notice>
          )}
          <ToolOutputReaderContext.Provider value={bodyReader}>
            {entries.map((entry) => (
              <div
                key={entry.ordinal}
                data-block-ordinal={entry.ordinal}
                tabIndex={-1}
                className="focus-ring"
                style={
                  !blocksCurrent
                    ? { minHeight: blockHeights.current.get(entry.ordinal) }
                    : undefined
                }
              >
                {blocksCurrent &&
                  (entry.kind === 'notice' ? (
                    <DelegationChildRowNotice />
                  ) : (
                    <>
                      <BlockContent
                        entry={entry}
                        row={row}
                        renderEntry={renderEntry}
                      />
                      {entry.kind === 'preview' &&
                        entry.omittedFields.map((field) => (
                          <DeferredToolOutput
                            key={field}
                            identity={{
                              kind: 'row',
                              messageId: row.id,
                              blockOrdinal: entry.ordinal,
                              field,
                            }}
                            preview={previewField(entry.block, field)}
                          />
                        ))}
                    </>
                  ))}
              </div>
            ))}
          </ToolOutputReaderContext.Provider>
          {pages[pages.length - 1]?.cursor && (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => {
                void load('more');
              }}
            >
              Show more
            </Button>
          )}
        </>
      )}
      {row.truncated && <DelegationChildRowNotice />}
    </div>
  );
}
