import {
  createContext,
  Fragment,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { Button } from '../primitives/Button';
import { DetailFact, DetailFactList } from './DetailFact';
import { ItemStateMark, useItemStateMarks } from './ItemStateMark';
import { RefreshSpinner } from './RefreshSpinner';
import { Tooltip } from '../primitives/Tooltip';
import {
  DetailActionBarIntoShell,
  useDetailHeaderActionsClaim,
} from './DetailActionBar';
import { Heading } from '../primitives/Heading';
import { DetailEntityType } from './MarketplaceTypeLabel';
import { Stack } from '../primitives/Stack';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { TextLink } from '../primitives/TextLink';

/**
 * A detail page's fact rows, named so every entity lists them in one order
 * (New Customize): Status, Health, Marketplace or Source, Website, Other
 * versions, Updated, Version, then the entity's own rows. Each slot is
 * `DetailFact` rows (Status is its own status row); an empty slot draws
 * nothing, so a row shows only when it applies.
 */
export interface CapabilityDetailFacts {
  /** The installed item's Status row, with the tile's picker and icons. */
  readonly status?: ReactNode;
  readonly health?: ReactNode;
  /** Marketplace, or Source for workflows. */
  readonly source?: ReactNode;
  readonly website?: ReactNode;
  readonly otherVersions?: ReactNode;
  /** Only where the date is reliable. */
  readonly updated?: ReactNode;
  /** Only while an update is available: "1.1.1 · Update available · Update". */
  readonly version?: ReactNode;
  /** Rows only this entity has (Connection, Plugin, Triggers…). */
  readonly entity?: ReactNode;
}

export interface CapabilityDetailLayoutProps {
  /** The 40px rounded-square logo, from the tile's logo chain. */
  readonly logo?: ReactNode;
  readonly title: ReactNode;
  readonly titleId?: string;
  /**
   * The type label beside the title, for a page outside Customize's kinds
   * (a marketplace). Customize items take theirs from the page's
   * `DetailEntityTypeProvider`.
   */
  readonly typeLabel?: ReactNode;
  /** The tile's line 2: publisher, "Built-in", "You" or "Shared by X". */
  readonly publisher?: ReactNode;
  /**
   * The page's own action bar, `[⋯] [Secondary] [Share] [Primary]`. A page
   * shell's actions join it on the title row.
   */
  readonly actions?: ReactNode;
  /**
   * A header action's feedback (one from the ⋯ menu): its failure, or a
   * check in progress, said under the title row beside the actions instead
   * of in a page banner.
   */
  readonly actionsNotice?: ReactNode;
  /** Plain text, clamped to three lines with "Show more". */
  readonly description?: string;
  /**
   * Session replay keeps a placeholder for a description that is file
   * content (a SKILL.md's frontmatter).
   */
  readonly descriptionReplay?: 'block' | 'mask';
  readonly facts?: CapabilityDetailFacts;
  /** Under the facts: a row-level note that belongs to no single row. */
  readonly factsFooter?: ReactNode;
  readonly worksWith?: ReactNode;
  /** The entity's one contents table (Tools, Skills, Jobs, Members…). */
  readonly contents?: ReactNode;
  /** Entity settings blocks, such as an MCP server's Configuration. */
  readonly settings?: ReactNode;
  /** Collapsible documents: README, SKILL.md, YAML, Instructions. */
  readonly docs?: ReactNode;
  /** The entity's own related lists (a skill's workflows), above Related. */
  readonly related?: ReactNode;
  /** Header-only callers render the host section at the end of their body. */
  readonly includeHostRelated?: boolean;
  readonly dataTestId?: string;
}

const DetailRelatedContext = createContext<ReactNode>(null);

/** Renders the host's Related section after the detail's own content. */
export function DetailHostRelated(): ReactNode {
  return useContext(DetailRelatedContext);
}

/**
 * The page's Related section, which its host builds once (the item and the
 * host's list of entries), so every entity's layout shows it last.
 */
export function DetailRelatedProvider({
  related,
  children,
}: {
  related: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <DetailRelatedContext.Provider value={related}>
      {children}
    </DetailRelatedContext.Provider>
  );
}

/**
 * The one detail page of New Customize (desktop and Portal): the item's logo,
 * title and type, publisher and actions on the title row, its description,
 * then facts in a fixed order, Works with, Contents, Settings, Docs and
 * Related. Entities fill slots; none draws its own header.
 */
export function CapabilityDetailLayout({
  logo,
  title,
  titleId,
  typeLabel,
  publisher,
  actions,
  actionsNotice,
  description,
  descriptionReplay,
  facts,
  factsFooter,
  worksWith,
  contents,
  settings,
  docs,
  related,
  includeHostRelated = true,
  dataTestId = 'capability-detail',
}: CapabilityDetailLayoutProps): JSX.Element {
  // A page shell's own actions (Share, its ⋯ rows) join this title row.
  const shellActions = useDetailHeaderActionsClaim();
  // Named keys, so a row that appears late doesn't take another's state.
  const listed = facts
    ? (
        [
          ['health', facts.health],
          ['source', facts.source],
          ['website', facts.website],
          ['otherVersions', facts.otherVersions],
          ['updated', facts.updated],
          ['version', facts.version],
          ['entity', facts.entity],
        ] satisfies [string, ReactNode][]
      ).filter(([, row]) => present(row))
    : [];
  const hasFacts =
    facts !== undefined && (present(facts.status) || listed.length > 0);
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid={dataTestId}>
      <header
        className="flex min-w-0 flex-col gap-3"
        data-testid={`${dataTestId}-header`}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {logo}
            <div className="flex min-w-0 flex-col gap-0.5">
              <Heading
                level={1}
                variant="page"
                id={titleId}
                className="min-w-0 break-words"
                data-testid={`${dataTestId}-title`}
              >
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  {title}
                  {typeLabel ?? <DetailEntityType />}
                </span>
              </Heading>
              {present(publisher) && (
                <p
                  // A publisher can be a person ("Shared by X").
                  className={`truncate text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
                  data-testid={`${dataTestId}-publisher`}
                >
                  {publisher}
                </p>
              )}
            </div>
          </div>
          {(present(shellActions) || present(actions)) && (
            <div
              className="flex shrink-0 flex-wrap items-center justify-end gap-2"
              data-testid={`${dataTestId}-actions`}
            >
              {shellActions}
              {present(shellActions) ? (
                <DetailActionBarIntoShell>{actions}</DetailActionBarIntoShell>
              ) : (
                actions
              )}
            </div>
          )}
        </div>
        {present(actionsNotice) && (
          <div
            className="flex justify-end text-s"
            data-testid={`${dataTestId}-actions-notice`}
          >
            {actionsNotice}
          </div>
        )}
        {description && (
          <ClampedDescription
            text={description}
            testId={`${dataTestId}-description`}
            replay={descriptionReplay}
          />
        )}
      </header>
      {(hasFacts || present(factsFooter)) && (
        <section aria-label="Details" data-testid={`${dataTestId}-facts`}>
          <Stack gap="tight">
            {present(facts?.status) && <div>{facts?.status}</div>}
            {listed.length > 0 && (
              <DetailFactList>
                {listed.map(([key, row]) => (
                  <Fragment key={key}>{row}</Fragment>
                ))}
              </DetailFactList>
            )}
            {factsFooter}
          </Stack>
        </section>
      )}
      {worksWith}
      {contents}
      {settings}
      {docs}
      {related}
      {includeHostRelated && <DetailHostRelated />}
    </div>
  );
}

function present(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

/** Three lines, then "Show more"; the toggle shows only when text overflows. */
export function ClampedDescription({
  text,
  testId,
  replay,
}: {
  readonly text: string;
  readonly testId?: string;
  readonly replay?: 'block' | 'mask';
}): JSX.Element {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // Another item's description opens clamped again.
  const [shownText, setShownText] = useState(text);
  if (shownText !== text) {
    setShownText(text);
    setExpanded(false);
  }
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || expanded) return;
    const measure = (): void =>
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return (): void => observer.disconnect();
  }, [text, expanded]);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <p
        ref={ref}
        className={`max-w-2xl whitespace-pre-line break-words text-pretty text-s fg-secondary${expanded ? '' : ' line-clamp-3'}${replay === 'block' ? ` ${REPLAY_BLOCK_CLASS}` : replay === 'mask' ? ` ${REPLAY_MASK_CLASS}` : ''}`}
        data-testid={testId}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <Button
          variant="link"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  );
}

/**
 * One update state, for the Version row of every entity (skill, plugin,
 * automation): `available` (the icon updates), `current` or `unknown` (the
 * icon checks, where the host can), and `checking` or `applying` (it spins).
 */
export type DetailUpdateState =
  | 'available'
  | 'current'
  | 'unknown'
  | 'checking'
  | 'applying';

/** An update state for the Version row; omit actions when unsupported. */
export interface DetailVersionUpdate {
  readonly version?: string;
  /** Defaults to `available`, the only state before there was a status. */
  readonly state?: DetailUpdateState;
  /** "Checked 5m ago", from a host that knows when its check ran. */
  readonly checked?: string;
  readonly busy?: boolean;
  /** Applies the available update. */
  readonly run?: () => void;
  /** Looks for an update. */
  readonly check?: () => void;
  /** The last update's failure, said on this row. */
  readonly error?: string;
  /** A failure with its tone and the row's "Try again"; wins as `error` does. */
  readonly failure?: {
    readonly text: string;
    /** A diagnostic that may name the item: kept under replay's block. */
    readonly detail?: string;
    readonly tone?: 'failed' | 'attention';
    readonly retry?: {
      readonly label: string;
      readonly run: () => void;
      readonly disabled: boolean;
    };
  };
  /** Why it can't be updated here, said after the state. */
  readonly note?: string;
  /**
   * The version is file content (a SKILL.md's frontmatter): session replay
   * keeps a placeholder for it.
   */
  readonly versionReplay?: 'block';
}

/** What each state says, and its icon's accessible name (never the item's). */
const UPDATE_STATE_PARTS: Record<
  DetailUpdateState,
  {
    readonly text: string;
    readonly label: string;
    readonly mark?: 'update' | 'installed';
    readonly working?: true;
  }
> = {
  available: { text: 'Update available', label: 'Update', mark: 'update' },
  current: {
    text: 'Up to date',
    label: 'Check for updates',
    mark: 'installed',
  },
  unknown: { text: 'Update status unknown', label: 'Check for updates' },
  checking: {
    text: 'Checking for updates…',
    label: 'Checking for updates…',
    working: true,
  },
  applying: { text: 'Updating…', label: 'Updating…', working: true },
};

/**
 * "Version 1.1.1 · ✓ Up to date ↻": the one place every entity says whether
 * it is current, with a reload icon that checks or updates. With the flag
 * off it is the older "Version 1.1.1 · ↻ Update available · Update" row.
 */
export function DetailVersionUpdateFact({
  update,
  name,
  testId = 'detail-version-update',
}: {
  readonly update: DetailVersionUpdate;
  /** The flag-off row's Update name; New Customize never names the item. */
  readonly name?: string;
  readonly testId?: string;
}): JSX.Element {
  const marks = useItemStateMarks();
  // `busy` is the older callers' way of saying the state's work runs.
  const idle = update.state ?? 'available';
  const state: DetailUpdateState =
    !update.busy || idle === 'checking' || idle === 'applying'
      ? idle
      : idle === 'available'
        ? 'applying'
        : 'checking';
  const { text, label, mark, working } = UPDATE_STATE_PARTS[state];
  const action =
    state === 'available'
      ? update.run
      : state === 'current' || state === 'unknown'
        ? update.check
        : undefined;
  // No icon for a caller with nothing to run.
  const showIcon =
    action !== undefined ||
    (working && (update.run !== undefined || update.check !== undefined));
  const failure =
    update.failure ?? (update.error ? { text: update.error } : undefined);
  return (
    <DetailFact label="Version" testId={testId}>
      <span
        className="inline-flex min-w-0 flex-wrap items-center gap-1.5"
        data-state={marks ? state : undefined}
      >
        {update.version && (
          <span
            className={
              update.versionReplay === 'block' ? REPLAY_BLOCK_CLASS : undefined
            }
          >
            {update.version}
          </span>
        )}
        {update.version && <span aria-hidden>·</span>}
        {!marks && <ItemStateMark tone="update" />}
        {!marks && <span>Update available</span>}
        {!marks && update.run !== undefined && (
          <>
            <span aria-hidden>·</span>
            <Button
              variant="link"
              onClick={update.run}
              disabled={update.busy}
              aria-busy={update.busy || undefined}
              aria-label={name === undefined ? 'Update' : `Update ${name}`}
              data-testid={`${testId}-run`}
            >
              {update.busy ? 'Updating…' : 'Update'}
            </Button>
          </>
        )}
        {marks && (
          <>
            {/* A failure wins over every state, beside the same icon. */}
            {failure ? (
              <DetailFactError
                error={failure.text}
                {...(failure.detail ? { detail: failure.detail } : {})}
                tone={failure.tone}
                testId={`${testId}-error`}
              />
            ) : (
              <span
                role="status"
                className="inline-flex min-w-0 items-center gap-1.5"
              >
                {/* The icon after an available update is its own glyph. */}
                {mark && !(showIcon && state === 'available') && (
                  <ItemStateMark tone={mark} />
                )}
                {text}
              </span>
            )}
            {showIcon && (
              // One tree for every state, so the focused control survives
              // its click: busy is `aria-disabled` (focusable, runs nothing).
              <Tooltip label={label} suppressed={working}>
                <Button
                  iconOnly
                  variant="ghost"
                  size="compact"
                  busyAppearance="preserved"
                  onClick={action}
                  aria-busy={working || undefined}
                  aria-disabled={working || undefined}
                  aria-label={label}
                  data-testid={`${testId}-run`}
                >
                  <RefreshSpinner spinning={working} />
                </Button>
              </Tooltip>
            )}
            {failure?.retry && (
              <>
                <span aria-hidden>·</span>
                <Button
                  variant="link"
                  onClick={failure.retry.run}
                  disabled={failure.retry.disabled}
                  data-testid={`${testId}-retry`}
                >
                  {failure.retry.label}
                </Button>
              </>
            )}
            {update.checked !== undefined && (
              <>
                <span aria-hidden>·</span>
                <span className="fg-tertiary" data-testid={`${testId}-checked`}>
                  {update.checked}
                </span>
              </>
            )}
          </>
        )}
        {update.note && (
          <span className="fg-tertiary" data-testid={`${testId}-note`}>
            {update.note}
          </span>
        )}
        {!marks && update.error && (
          <DetailFactError error={update.error} testId={`${testId}-error`} />
        )}
      </span>
    </DetailFact>
  );
}

/** A fact row's failure: "⚠ reason", plain text with a colored icon. */
export function DetailFactError({
  error,
  detail,
  testId,
  tone = 'failed',
}: {
  readonly error: string;
  /** After the reason, under replay's block; never in the tooltip. */
  readonly detail?: string;
  readonly testId?: string;
  /** Red when it failed; amber when a retry or another step may fix it. */
  readonly tone?: 'failed' | 'attention';
}): JSX.Element {
  return (
    <span
      role="status"
      className={`inline-flex min-w-0 ${detail ? 'items-start' : 'items-center'} gap-1 fg-secondary`}
      data-testid={testId}
    >
      <ItemStateMark tone={tone === 'failed' ? 'failed' : 'sign-in'} />
      {/* A diagnostic wraps so a long path stays readable: it can't go in a
          tooltip, which replay could record. */}
      <span
        className={detail ? 'min-w-0 break-words' : 'truncate'}
        title={error}
      >
        {error}
        {detail && (
          <>
            {': '}
            <span className={REPLAY_BLOCK_CLASS}>{detail}</span>
          </>
        )}
      </span>
    </span>
  );
}

/** The Website row: the site's host name, opening it in the browser. */
export function DetailWebsiteFact({
  href,
  testId = 'detail-website',
}: {
  readonly href: string;
  readonly testId?: string;
}): JSX.Element {
  return (
    <DetailFact label="Website" testId={testId}>
      <TextLink href={href} size="xs" target="_blank" rel="noopener noreferrer">
        {detailWebsiteHost(href)}
      </TextLink>
    </DetailFact>
  );
}

/** A URL's host without "www.", or "Website" when it doesn't parse. */
export function detailWebsiteHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return 'Website';
  }
}
