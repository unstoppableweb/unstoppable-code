import { Fragment, memo, type JSX, type ReactNode } from 'react';
import { marketplaceTitleCase } from '../../lib/plugin-display-name';
import { Notice } from '../../primitives/Notice';
import { NoticeList } from '../NoticeList';

/** One plugin whose Mod a Claude launch skipped, as the transcript stores it. */
export interface ClaudeModsSkippedMod {
  /** The Claude plugin id, `<plugin>@<marketplace>`. */
  readonly pluginId: string;
  /** The launch decision's reason; unknown values read as unreadable. */
  readonly reason: string;
}

export interface ClaudeModsSkippedNoticeItem extends ClaudeModsSkippedMod {
  /** Host-supplied controls for this plugin (Open details, Allow switch). */
  readonly actions?: ReactNode;
}

export interface ClaudeModsSkippedNoticeProps {
  readonly mods: readonly ClaudeModsSkippedNoticeItem[];
  readonly dataTestId?: string;
}

type ClaudeModsSkippedReasonCopyKey =
  | 'not-admitted'
  | 'digest-changed'
  | 'kill-switch'
  | 'authority-unreadable'
  | 'install-list-unreadable'
  | 'unreadable';

export const CLAUDE_MODS_SKIPPED_COPY = {
  // Past tense: the notice records one launch, and a change made since then
  // applies from the chat's next message.
  title: (count: number): string =>
    count === 1
      ? "1 Mod didn't load in this chat"
      : `${count} Mods didn't load in this chat`,
  message: 'Changes apply from your next message.',
  // Once every Mod the launch skipped is allowed, the notice says so and that
  // they were off before, since the chat itself hasn't reloaded yet.
  allowedTitle: (count: number): string =>
    count === 1 ? '1 Mod is allowed now' : `${count} Mods are allowed now`,
  allowedMessage: (count: number): string =>
    count === 1
      ? 'It was off earlier in this chat and loads with your next message.'
      : 'They were off earlier in this chat and load with your next message.',
  // Above the composer, before a message is sent: what the next launch skips.
  composerTitle: (count: number): string =>
    count === 1
      ? "1 Mod won't load in this chat"
      : `${count} Mods won't load in this chat`,
  composerMessage: 'Allowed Mods load from your next message.',
  composerAllowedMessage: (count: number): string =>
    count === 1
      ? 'It loads with your next message.'
      : 'They load with your next message.',
  openDetails: 'Open details',
  allowedNextMessage: 'Allowed. It loads with your next message.',
  reasons: {
    'not-admitted': 'Not allowed in Claude chats',
    'digest-changed': 'Changed since you allowed it',
    'kill-switch': 'Every Mod is turned off',
    'authority-unreadable': "This app couldn't read its Mod settings",
    // The plugin may be fine: Claude's own record of installs is damaged, and
    // Claude loads no installed plugin until it is repaired.
    'install-list-unreadable':
      "Claude's list of installed plugins couldn't be read",
    unreadable: "This app couldn't read the plugin",
  } satisfies Record<ClaudeModsSkippedReasonCopyKey, string>,
  sources: {
    'skills-dir': 'From your skills folder',
    synced: 'From your claude.ai account',
    // Only the resumed session's own Mods reach its notice.
    'claude-session': 'Written by Claude in this chat',
  },
} as const;

/** Marketplaces whose plugins have no details page and allow in place. */
const INLINE_ALLOW_MARKETPLACES: ReadonlySet<string> = new Set([
  'skills-dir',
  'synced',
  'claude-session',
]);

function splitPluginId(pluginId: string): {
  readonly name: string;
  readonly marketplace: string | null;
} {
  const at = pluginId.lastIndexOf('@');
  if (at <= 0) return { name: pluginId, marketplace: null };
  return { name: pluginId.slice(0, at), marketplace: pluginId.slice(at + 1) };
}

/**
 * The mods of a Portal `mods_skipped` part (or any unknown value): entries
 * whose plugin id and reason are strings. Anything else reads as none.
 */
export function readClaudeModsSkippedMods(
  data: unknown,
): ClaudeModsSkippedMod[] {
  if (typeof data !== 'object' || data === null) return [];
  const mods: unknown = Reflect.get(data, 'mods');
  if (!Array.isArray(mods)) return [];
  const result: ClaudeModsSkippedMod[] = [];
  for (const entry of mods) {
    if (typeof entry !== 'object' || entry === null) continue;
    const pluginId: unknown = Reflect.get(entry, 'pluginId');
    const reason: unknown = Reflect.get(entry, 'reason');
    if (typeof pluginId !== 'string' || pluginId.trim() === '') continue;
    if (typeof reason !== 'string') continue;
    result.push({ pluginId, reason });
  }
  return result;
}

/** The plugin's name for display: the part before `@`, title-cased. */
export function claudeModsSkippedPluginName(pluginId: string): string {
  const { name } = splitPluginId(pluginId);
  return marketplaceTitleCase(name) || name;
}

/**
 * Where a plugin without a catalog entry comes from, in plain words. Catalog
 * plugins return null: their marketplace id is never shown.
 */
export function claudeModsSkippedSourceLabel(pluginId: string): string | null {
  const { marketplace } = splitPluginId(pluginId);
  if (marketplace === 'skills-dir') {
    return CLAUDE_MODS_SKIPPED_COPY.sources['skills-dir'];
  }
  if (marketplace === 'synced') return CLAUDE_MODS_SKIPPED_COPY.sources.synced;
  if (marketplace === 'claude-session') {
    return CLAUDE_MODS_SKIPPED_COPY.sources['claude-session'];
  }
  return null;
}

/** Skills-folder, synced and session-written Mods have no details page; allow them inline. */
export function isClaudeModsInlineAllowPluginId(pluginId: string): boolean {
  const { marketplace } = splitPluginId(pluginId);
  return marketplace !== null && INLINE_ALLOW_MARKETPLACES.has(marketplace);
}

/** Why the launch skipped the plugin's Mod, in plain words. */
export function claudeModsSkippedReasonText(reason: string): string {
  const { reasons } = CLAUDE_MODS_SKIPPED_COPY;
  switch (reason) {
    case 'not-admitted':
      return reasons['not-admitted'];
    case 'digest-changed':
      return reasons['digest-changed'];
    case 'kill-switch':
      return reasons['kill-switch'];
    case 'authority-unreadable':
      return reasons['authority-unreadable'];
    case 'install-list-unreadable':
      return reasons['install-list-unreadable'];
    default:
      return reasons.unreadable;
  }
}

function Separator(): JSX.Element {
  return <span aria-hidden="true"> · </span>;
}

export interface ClaudeModsSkippedRowProps extends ClaudeModsSkippedNoticeItem {
  /** A line under the row: the plugin's current state or a failed change. */
  readonly detail?: ReactNode;
  /**
   * Replaces the launch reason, for a plugin whose state has changed since;
   * null shows none. Omit for the reason the launch recorded.
   */
  readonly reasonText?: string | null;
}

/** One skipped plugin: its name, where it comes from, why, and its controls. */
export function ClaudeModsSkippedRow({
  pluginId,
  reason,
  actions,
  detail,
  reasonText,
}: ClaudeModsSkippedRowProps): JSX.Element {
  const source = claudeModsSkippedSourceLabel(pluginId);
  const shownReason =
    reasonText === undefined ? claudeModsSkippedReasonText(reason) : reasonText;
  return (
    <span
      role="listitem"
      data-testid="claude-mods-skipped-row"
      data-plugin-id={pluginId}
      className="flex min-w-0 flex-col gap-1 py-1"
    >
      <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 break-words text-pretty">
          <span className="font-medium fg-primary">
            {claudeModsSkippedPluginName(pluginId)}
          </span>
          {source !== null ? (
            <Fragment>
              <Separator />
              {source}
            </Fragment>
          ) : null}
          {shownReason !== null ? (
            <Fragment>
              <Separator />
              {shownReason}
            </Fragment>
          ) : null}
        </span>
        {actions ? (
          <span className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </span>
        ) : null}
      </span>
      {detail ? (
        <span className="block min-w-0 text-pretty">{detail}</span>
      ) : null}
    </span>
  );
}

export interface ClaudeModsSkippedNoticeFrameProps {
  /** How many plugins' Mods were skipped. */
  readonly count: number;
  /** One {@link ClaudeModsSkippedRow} per plugin. */
  readonly children: ReactNode;
  readonly dataTestId?: string;
  /** Every skipped Mod is allowed now: a success notice instead. */
  readonly allowed?: boolean;
  /**
   * `transcript` records a launch that skipped Mods; `composer` sits above
   * the composer and says what the next message's launch will skip.
   */
  readonly placement?: 'transcript' | 'composer';
  readonly onDismiss?: () => void;
}

/**
 * The notice around the rows: how many Mods didn't load, and when changes
 * apply, or, once all of them are allowed, that they load from the next
 * message. Transcript prose, so it is read in place rather than announced.
 */
export function ClaudeModsSkippedNoticeFrame({
  count,
  children,
  dataTestId = 'claude-mods-skipped-notice',
  allowed = false,
  placement = 'transcript',
  onDismiss,
}: ClaudeModsSkippedNoticeFrameProps): JSX.Element {
  const copy = CLAUDE_MODS_SKIPPED_COPY;
  const composer = placement === 'composer';
  const title = allowed
    ? copy.allowedTitle(count)
    : composer
      ? copy.composerTitle(count)
      : copy.title(count);
  const message = allowed
    ? composer
      ? copy.composerAllowedMessage(count)
      : copy.allowedMessage(count)
    : composer
      ? copy.composerMessage
      : copy.message;
  return (
    <Notice
      intent={allowed ? 'positive' : 'neutral'}
      role="none"
      data-testid={dataTestId}
      // Takes the message width; a shrink-to-fit message wraps it per letter.
      data-chat-notice=""
      title={title}
      {...(onDismiss ? { onDismiss } : {})}
    >
      {message}
      <NoticeList>{children}</NoticeList>
    </Notice>
  );
}

/**
 * A transcript notice where a Claude launch skipped plugins' Mods (Claude
 * Mods safety phase 05b): each plugin, why, and the host's controls for it.
 * Pure display: every host renders the persisted `claude_mods_skipped` block
 * or the Portal `mods_skipped` part with it and supplies its own actions.
 */
function ClaudeModsSkippedNoticeComponent({
  mods,
  dataTestId = 'claude-mods-skipped-notice',
}: ClaudeModsSkippedNoticeProps): JSX.Element | null {
  if (mods.length === 0) return null;
  return (
    <ClaudeModsSkippedNoticeFrame count={mods.length} dataTestId={dataTestId}>
      {mods.map((mod, index) => (
        <ClaudeModsSkippedRow
          // A launch lists a plugin once; the index keeps keys unique if a
          // malformed record repeats one.
          key={`${mod.pluginId}:${index}`}
          pluginId={mod.pluginId}
          reason={mod.reason}
          {...(mod.actions !== undefined ? { actions: mod.actions } : {})}
        />
      ))}
    </ClaudeModsSkippedNoticeFrame>
  );
}

export const ClaudeModsSkippedNotice = memo(ClaudeModsSkippedNoticeComponent);
