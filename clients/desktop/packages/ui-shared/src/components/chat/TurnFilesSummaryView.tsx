import {
  Children,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from '@tanstack/react-virtual';
import { ChevronDownIcon, ChevronRightIcon } from '../../icons';
import { FileDiff } from '../../icons/AppIcons';
import { DisclosureToggle } from '../Disclosure';
import { OverlayScrollArea } from '../OverlayScrollArea';

/** Git rows the list renders by index, so a long list mounts only those in view. */
export interface TurnChangedFileRows {
  readonly count: number;
  /** One keyed row. */
  readonly renderRow: (index: number) => ReactNode;
}

/** Rows from a list already built, for short fixed lists such as samples. */
export function turnChangedFileRowsFrom(
  rows: readonly ReactNode[],
): TurnChangedFileRows {
  return { count: rows.length, renderRow: (index) => rows[index] };
}

export interface TurnFilesSummaryViewProps {
  readonly heading: string | undefined;

  readonly detail?: ReactNode;
  readonly actions?: ReactNode;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly showFiles?: boolean;
  readonly turnId?: string;
  /** A single file takes the header's content slot, without a duplicate row. */
  readonly singleFile?: ReactNode;
  /** Git rows form their own list, separated from saved outputs by a hairline. */
  readonly changedFiles?: TurnChangedFileRows;
  /** Count stays available while a folded host defers its Git row elements. */
  readonly changedFileCount?: number;
  readonly children: ReactNode;
}

/** Restore a file viewer's origin, or its disclosure while the list is folded. */
export function restoreTurnFileFocus(origin: HTMLElement): void {
  if (!origin.isConnected) return;
  const hidden = origin.closest<HTMLElement>('[hidden]');
  if (!hidden) {
    origin.focus({ preventScroll: true });
    return;
  }
  const disclosure = Array.from(
    hidden.parentElement?.querySelectorAll<HTMLButtonElement>(
      'button[aria-controls]',
    ) ?? [],
  ).find((button) => button.getAttribute('aria-controls') === hidden.id);
  disclosure?.focus({ preventScroll: true });
}

/** Bounded list: ordinary pointer rows are 32px; touch and status rows can grow. */
function FileList({
  children,
  label,
  inline = false,
  focusable = Children.toArray(children).length > 3,
  viewportRef,
}: {
  children: ReactNode;
  label: string;
  inline?: boolean;
  focusable?: boolean;
  viewportRef?: Ref<HTMLDivElement>;
}): JSX.Element {
  // The wrapper is stable for 1, 2, 3 and 4+ files, preserving host file state.
  return (
    <OverlayScrollArea
      className={inline ? 'static' : 'mx-1'}
      viewportClassName={inline ? '' : 'max-h-30 overscroll-contain'}
      contentClassName={inline ? '' : 'flex flex-col py-1'}
      railClassName={inline ? 'hidden' : '-right-1'}
      edgeFadeSize={inline ? 0 : 8}
      viewportRef={viewportRef}
      viewportProps={{
        role: inline ? undefined : 'region',
        'aria-label': inline ? undefined : label,
        tabIndex: !inline && focusable ? 0 : undefined,
        'data-testid': 'turn-files-scroll',
      }}
    >
      {children}
    </OverlayScrollArea>
  );
}

/**
 * Above this many Git rows the list mounts only the rows in view, so a turn
 * that touched thousands of files stays cheap. Every row is still reachable by
 * scrolling; shorter lists keep every row in the DOM and in the tab order.
 */
const MOUNT_ALL_ROWS_UP_TO = 100;
const ROW_HEIGHT = 32;
/** The 120px viewport, so the first render (and server render) fills it. */
const INITIAL_VIEWPORT = { width: 0, height: 120 };

function VirtualRows({
  rows,
  viewport,
}: {
  rows: TurnChangedFileRows;
  viewport: HTMLDivElement | null;
}): JSX.Element {
  // A focused row stays mounted when it scrolls away, so keyboard focus
  // never falls to the page body.
  const focusedIndex = useRef<number | null>(null);
  const rangeExtractor = useCallback((range: Range): number[] => {
    const indexes = defaultRangeExtractor(range);
    const focused = focusedIndex.current;
    // A row removed while focused may never blur, so its index can outlive the list.
    if (focused === null || focused >= range.count || indexes.includes(focused))
      return indexes;
    return [...indexes, focused].sort((a, b) => a - b);
  }, []);
  const virtualizer = useVirtualizer({
    count: rows.count,
    getScrollElement: useCallback(() => viewport, [viewport]),
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: INITIAL_VIEWPORT,
    rangeExtractor,
  });
  const measure = useCallback(
    (element: HTMLDivElement | null): void => {
      virtualizer.measureElement(element);
    },
    [virtualizer],
  );
  // Rows sit at their own offsets: the focused row can be far from the rest.
  return (
    <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          ref={measure}
          className="absolute inset-x-0 top-0"
          style={{ transform: `translateY(${String(item.start)}px)` }}
          onFocus={() => {
            focusedIndex.current = item.index;
          }}
          onBlur={() => {
            focusedIndex.current = null;
          }}
        >
          {rows.renderRow(item.index)}
        </div>
      ))}
    </div>
  );
}

function ChangedFileList({ rows }: { rows: TurnChangedFileRows }): JSX.Element {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  if (rows.count <= MOUNT_ALL_ROWS_UP_TO) {
    return <FileList label="Changed files">{renderAllRows(rows)}</FileList>;
  }
  return (
    <FileList label="Changed files" focusable viewportRef={setViewport}>
      <VirtualRows rows={rows} viewport={viewport} />
    </FileList>
  );
}

function renderAllRows(rows: TurnChangedFileRows | undefined): ReactNode[] {
  return Array.from({ length: rows?.count ?? 0 }, (_, index) =>
    rows?.renderRow(index),
  );
}

function SummaryFiles({
  changedFiles,
  children,
  inline,
}: {
  changedFiles: TurnChangedFileRows | undefined;
  children: ReactNode;
  inline: boolean;
}): JSX.Element {
  const hasChanges = (changedFiles?.count ?? 0) > 0;
  const hasOutputs = Children.toArray(children).length > 0;
  return (
    <>
      {changedFiles && hasChanges && <ChangedFileList rows={changedFiles} />}
      {hasOutputs && (
        <div className={hasChanges ? 'border-t' : undefined}>
          <FileList label="Saved files" inline={inline}>
            {children}
          </FileList>
        </div>
      )}
    </>
  );
}

function SummaryToggle({
  heading,
  detail,
  expanded,
  onToggle,
  id,
  hasActions,
}: Pick<
  TurnFilesSummaryViewProps,
  'heading' | 'detail' | 'expanded' | 'onToggle'
> & {
  id: string;
  hasActions: boolean;
}): JSX.Element {
  return (
    <DisclosureToggle
      variant={hasActions ? 'summary-wrapping' : 'summary'}
      open={expanded}
      bodyId={id}
      onClick={onToggle}
      aria-label={expanded ? 'Collapse changed files' : 'Expand changed files'}
    >
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-fg-primary/[0.06] fg-secondary [&_svg]:size-4"
      >
        <FileDiff size="md" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <span className="truncate fg-primary" data-turn-files-title="">
          {heading}
        </span>
        {detail && (
          <span className="truncate text-2xs fg-tertiary">{detail}</span>
        )}
      </span>
      <span
        aria-hidden="true"
        className="absolute right-1 top-3 flex size-7 shrink-0 items-center justify-center fg-secondary [&_svg]:size-4"
      >
        {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
      </span>
    </DisclosureToggle>
  );
}

/** Shared summary chrome; file authorization, diff policy and actions stay in hosts. */
export function TurnFilesSummaryView({
  heading,
  detail,
  actions,
  expanded,
  onToggle,
  showFiles,
  turnId,
  singleFile,
  changedFiles,
  changedFileCount,
  children,
}: TurnFilesSummaryViewProps): JSX.Element {
  const id = useId();
  const changeCount = changedFileCount ?? changedFiles?.count ?? 0;
  const singleOutput =
    !singleFile && changeCount === 0 && Children.toArray(children).length === 1;
  const canDisclose = !singleFile && !singleOutput;
  const visible = singleOutput || (!singleFile && (showFiles ?? expanded));
  const [hasOpened, setHasOpened] = useState(visible);
  const [headerHovered, setHeaderHovered] = useState(false);
  useEffect(() => {
    if (visible) setHasOpened(true);
  }, [visible]);
  // Embedded browsers may retain CSS :hover on exit. Listen only while this
  // header is hovered; historical transcript cards add no global listeners.
  useEffect(() => {
    if (!headerHovered) return;
    const clearHover = (): void => setHeaderHovered(false);
    const clearOutsideHover = (event: MouseEvent): void => {
      if (event.relatedTarget === null) clearHover();
    };
    window.addEventListener('blur', clearHover);
    window.addEventListener('mouseout', clearOutsideHover);
    document.addEventListener('visibilitychange', clearHover);
    return (): void => {
      window.removeEventListener('blur', clearHover);
      window.removeEventListener('mouseout', clearOutsideHover);
      document.removeEventListener('visibilitychange', clearHover);
    };
  }, [headerHovered]);
  return (
    <div
      data-testid="turn-files"
      data-turn-id={turnId}
      onPointerEnter={(event): void => {
        if (
          singleOutput &&
          event.pointerType !== 'touch' &&
          event.currentTarget.querySelector('button[aria-disabled="false"]')
        )
          setHeaderHovered(true);
      }}
      onPointerLeave={(): void => setHeaderHovered(false)}
      onPointerCancel={(): void => setHeaderHovered(false)}
      className={`@container/turn-files cursor-default select-none overflow-hidden rounded-xl border bg-base ${singleOutput ? `group/turn-file relative isolate grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 pl-3 pr-1 py-3 before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:content-[''] ${headerHovered ? 'before:bg-subtle' : ''}` : ''}`}
    >
      <div className={singleOutput ? 'contents' : 'p-1'}>
        <div
          onPointerEnter={(event): void => {
            if (canDisclose && event.pointerType !== 'touch')
              setHeaderHovered(true);
          }}
          onPointerLeave={(): void => {
            if (!singleOutput) setHeaderHovered(false);
          }}
          onPointerCancel={(): void => {
            if (!singleOutput) setHeaderHovered(false);
          }}
          className={
            singleOutput
              ? 'contents group/turn-file'
              : `group/turn-file relative flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg ${singleFile ? 'pr-2' : actions ? 'pr-10' : 'pr-8'} ${canDisclose && headerHovered ? 'bg-subtle' : ''}`
          }
        >
          {singleOutput && (
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-md bg-fg-primary/[0.06] fg-secondary [&_svg]:size-4"
            >
              <FileDiff size="md" />
            </span>
          )}
          {singleFile ? (
            <span
              className={`flex min-w-0 flex-1 items-center gap-3 px-2 py-2 ${actions ? 'basis-full @min-[32rem]/turn-files:basis-0' : ''}`}
            >
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-md bg-fg-primary/[0.06] fg-secondary [&_svg]:size-4"
              >
                <FileDiff size="md" />
              </span>
              {singleFile}
            </span>
          ) : !singleOutput ? (
            <SummaryToggle
              heading={heading}
              detail={detail}
              expanded={expanded}
              onToggle={onToggle}
              id={id}
              hasActions={Boolean(actions)}
            />
          ) : null}
          {actions && (
            <span
              className={`relative z-10 ml-auto flex shrink-0 ${singleOutput ? 'col-start-3 row-start-1' : 'pb-2 @min-[32rem]/turn-files:pb-0'}`}
            >
              {actions}
            </span>
          )}
        </div>
      </div>
      <div
        id={id}
        hidden={!visible}
        className={
          !visible
            ? 'hidden'
            : singleOutput
              ? `col-start-2 ${actions ? 'col-end-3' : 'col-end-4'} row-start-1 min-w-0`
              : 'border-t'
        }
      >
        {!singleFile && (visible || hasOpened) && (
          <SummaryFiles changedFiles={changedFiles} inline={singleOutput}>
            {children}
          </SummaryFiles>
        )}
      </div>
    </div>
  );
}
