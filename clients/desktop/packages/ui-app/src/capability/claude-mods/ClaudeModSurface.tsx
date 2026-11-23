'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type JSX,
} from 'react';
import type { CanopyClient, ClaudeModSurfaceEvent } from '@canopy/app-core';
import { useCanopyClient, useCapabilities } from '@canopy/app-state';
import {
  CLAUDE_MOD_PANE_CELLS,
  EMPTY_CLAUDE_MOD_PANE_ROSTER,
  splitClaudeModBand,
  type ClaudeModComposerAnswer,
  type ClaudeModComposerRequest,
  type ClaudeModPaneRoster,
  type ClaudeModSurfaceCommand,
  type ClaudeModSurfaceUpdate,
  type ExtensionUiNode,
} from '@canopy/protocol/extension-ui';
import { isChannelUnavailableRejection } from '@canopy/protocol/remote-control';
import {
  ComposerDrawer,
  ComposerDrawerSection,
  EmptyState,
} from '@canopy/ui-shared/components';
import { recordSurfacedError } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  ExtensionTreeView,
  findExtensionUiControl,
  focusExtensionUiControl,
  focusFirstExtensionUiControl,
} from '../../extension-ui';
import type { ComposerWorkExtraKind } from '../../code/ComposerWorkDrawer';
import { CLAUDE_MODS_COPY } from './claudeModsCopy';

/** The chat a Mod surface belongs to. */
export interface ClaudeModSurfaceChat {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

export interface ClaudeModSurfaceLine {
  readonly plugin: string;
  readonly text: string;
}

export interface ClaudeModSurfaceLogLine extends ClaudeModSurfaceLine {
  readonly id: number;
}

/** A Mod toast for the host to show through its own toast surface. */
export interface ClaudeModSurfaceToast extends ClaudeModSurfaceLine {
  readonly timeoutMs: number;
}

/**
 * A chat's pane roster changed: what it lists now, and before. `reset` means
 * the session's surface ended, so missing panes were not closed by a Mod.
 */
export type ClaudeModPaneRosterListener = (
  chat: ClaudeModSurfaceChat,
  roster: ClaudeModPaneRoster,
  previous: ClaudeModPaneRoster,
  reset: boolean,
) => void;

/**
 * A chat's composer, as its host lets a Mod read and fill it (site group M3).
 * Only the window showing the chat registers one, so only it answers.
 */
export interface ClaudeModComposerAnswerer {
  /** The draft and its caret, as a UTF-16 offset; `null` when unavailable. */
  readonly read: () => {
    readonly text: string;
    readonly cursor: number;
  } | null;
  /**
   * Places a Mod's text as the person's draft, as one undoable change, and
   * never sends it; false while a dialog holds the keys or the composer is
   * unavailable.
   */
  readonly fill: (
    fill: Extract<ClaudeModComposerRequest, { kind: 'fill' }>,
  ) => boolean;
  /** The selection in the chat's own transcript, `null` for none. */
  readonly selection: () => string | null;
}

const COPY_TOAST_MS = 4000;
/** How many withdrawn composer requests a store remembers, newest kept. */
const WITHDRAWN_KEPT = 64;

/** A Mod moved a site's window or focus ring, or its host gave it the keyboard. */
type SiteEvent =
  | Extract<ClaudeModSurfaceUpdate, { kind: 'scroll' | 'focus' }>
  | { readonly kind: 'take-focus'; readonly instanceId: string };

export interface ChatSurface {
  readonly statuses: readonly ClaudeModSurfaceLine[];
  readonly logs: readonly ClaudeModSurfaceLogLine[];
  /** The panes the session's Mods have open. */
  readonly roster: ClaudeModPaneRoster;
  /** The band above the composer, or `null` while no Mod draws one. */
  readonly band: ExtensionUiNode | null;
  /** Each open pane's last tree, by pane id. */
  readonly panes: Readonly<Record<string, ExtensionUiNode | null>>;
}

// shortcut: a chat keeps its newest 100 log lines for the app's life, never
// persisted; drop a chat's lines when the chat closes if that grows.
const LOG_LIMIT = 100;
const EMPTY: ChatSurface = {
  statuses: [],
  logs: [],
  roster: EMPTY_CLAUDE_MOD_PANE_ROSTER,
  band: null,
  panes: {},
};

function chatKey(chat: ClaudeModSurfaceChat): string {
  return `${chat.projectId}\u0000${chat.worktreeId}\u0000${chat.chatId}`;
}

/**
 * One subscription per client for the app's life, so a chat's status lines
 * and log lines survive switching chats; pushes do not replay.
 */
class SurfaceStore {
  private readonly chats = new Map<string, ChatSurface>();
  private readonly listeners = new Set<() => void>();
  private readonly toastListeners = new Map<
    string,
    Set<(toast: ClaudeModSurfaceToast) => void>
  >();
  private readonly rosterListeners = new Set<ClaudeModPaneRosterListener>();
  private readonly siteListeners = new Map<
    string,
    Set<(event: SiteEvent) => void>
  >();
  /** Panes given the keyboard before their view mounted, by chat. */
  private readonly focusWaiting = new Map<string, string>();
  /** Chats whose session was asked for its current surface, by attempt. */
  private readonly asked = new Map<string, object>();
  /** Each chat's composer, while a view in this window shows it. */
  private readonly composers = new Map<string, ClaudeModComposerAnswerer>();
  /** Composer requests their asker withdrew. */
  private readonly withdrawn = new Set<string>();
  /** Chats a mounted view draws, and how many views draw each. */
  private readonly mounted = new Map<
    string,
    { readonly chat: ClaudeModSurfaceChat; count: number }
  >();
  private nextLogId = 0;

  constructor(private readonly client: CanopyClient) {
    client.subscribe('claudeMods.surface', (event) => this.receive(event));
  }

  /** A view draws the chat's surface: ask for it, and track it till unmount. */
  mount(chat: ClaudeModSurfaceChat): () => void {
    const key = chatKey(chat);
    const entry = this.mounted.get(key) ?? { chat, count: 0 };
    entry.count += 1;
    this.mounted.set(key, entry);
    this.ask(chat);
    return (): void => {
      entry.count -= 1;
      if (entry.count === 0) this.mounted.delete(key);
    };
  }

  /**
   * Asks a chat's session once for its current surface: pushes do not
   * replay, so a window or page that mounts after the Mod drew would miss it.
   */
  private ask(chat: ClaudeModSurfaceChat): void {
    const key = chatKey(chat);
    if (this.asked.has(key)) return;
    const attempt = {};
    this.asked.set(key, attempt);
    this.client
      .command('claudeMods.surfaceCommand', {
        ...chat,
        command: { kind: 'resend' },
      })
      .catch((error: unknown): void => {
        // Asked again on the chat's next mount. The surface stays as it was,
        // so this records with no surface; a session that no longer draws one
        // resolves instead.
        // Only this chat's current attempt, while a view still draws the
        // chat, is news: a rejection that arrives after the last view left,
        // or after a newer resend replaced this one, is not recorded.
        if (this.asked.get(key) !== attempt) return;
        this.asked.delete(key);
        if (!this.mounted.has(key)) return;
        // An older paired desktop refuses the channel: expected, not a defect.
        if (isChannelUnavailableRejection(error, 'claude-mods:surface-command'))
          return;
        recordSurfacedError({
          chokePoint: 'notice',
          identifier: 'claude-mod-surface-resend',
          error,
        });
      });
  }

  chat(key: string): ChatSurface {
    return this.chats.get(key) ?? EMPTY;
  }

  /** A chat's composer answers its Mods' requests until the return is called. */
  registerComposer(
    key: string,
    answerer: ClaudeModComposerAnswerer,
  ): () => void {
    this.composers.set(key, answerer);
    return (): void => {
      if (this.composers.get(key) === answerer) this.composers.delete(key);
    };
  }

  /** Answers a Mod's request of a composer this window shows; silent otherwise. */
  private async answerComposer(
    event: ClaudeModSurfaceEvent,
    push: Extract<ClaudeModSurfaceUpdate, { kind: 'composer-request' }>,
  ): Promise<void> {
    // One task later, so a withdrawal already queued behind it is seen.
    await new Promise((settle) => setTimeout(settle, 0));
    const composer = this.composers.get(chatKey(event));
    const { requestId, request } = push;
    // The asker has stopped waiting: a late fill must not land unannounced.
    if (
      composer === undefined ||
      this.withdrawn.has(requestId) ||
      Date.now() > push.expiresAt
    ) {
      return;
    }
    let answer: ClaudeModComposerAnswer;
    switch (request.kind) {
      case 'read': {
        const draft = composer.read();
        if (draft === null) return;
        answer = { kind: 'read', ...draft };
        break;
      }
      case 'fill':
        answer = { kind: 'fill', filled: composer.fill(request) };
        break;
      case 'selection':
        answer = { kind: 'selection', text: composer.selection() };
        break;
      case 'copy':
        answer = {
          kind: 'copy',
          copied: await navigator.clipboard.writeText(request.text).then(
            () => true,
            () => false,
          ),
        };
        break;
    }
    await this.client
      .command('claudeMods.surfaceCommand', {
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        chatId: event.chatId,
        command: { kind: 'composer-answer', requestId, answer },
      })
      .catch((error: unknown): void => {
        // A session that no longer waits resolves, so a rejection is the
        // transport's. It is only news while the asker still waits: once it
        // withdrew or its request expired, the answer had nowhere to land.
        if (this.withdrawn.has(requestId) || Date.now() > push.expiresAt)
          return;
        // An older paired desktop refuses the channel: expected, not a defect.
        if (isChannelUnavailableRejection(error, 'claude-mods:surface-command'))
          return;
        recordSurfacedError({
          chokePoint: 'notice',
          identifier: 'claude-mod-composer-answer',
          error,
        });
      });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  onToast(
    key: string,
    listener: (toast: ClaudeModSurfaceToast) => void,
  ): () => void {
    const listeners = this.toastListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.toastListeners.set(key, listeners);
    return (): void => {
      listeners.delete(listener);
    };
  }

  onSite(key: string, listener: (event: SiteEvent) => void): () => void {
    const listeners = this.siteListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.siteListeners.set(key, listeners);
    return (): void => {
      listeners.delete(listener);
    };
  }

  /** Gives a pane the keyboard now, or as soon as its view mounts. */
  takeFocus(key: string, paneId: string): void {
    this.focusWaiting.set(key, paneId);
    this.emitSite(key, { kind: 'take-focus', instanceId: paneId });
  }

  /** Whether a pane was given the keyboard and has yet to take it. */
  claimFocus(key: string, paneId: string): boolean {
    if (this.focusWaiting.get(key) !== paneId) return false;
    this.focusWaiting.delete(key);
    return true;
  }

  /** What the client held of a chat's surface is stale: drop it, ask again. */
  private forget(key: string, chat: ClaudeModSurfaceChat): void {
    const current = this.chat(key);
    this.chats.delete(key);
    this.asked.delete(key);
    this.focusWaiting.delete(key);
    if (current.roster.panes.length > 0) {
      for (const listener of this.rosterListeners) {
        listener(chat, EMPTY_CLAUDE_MOD_PANE_ROSTER, current.roster, true);
      }
    }
    for (const listener of this.listeners) listener();
    const entry = this.mounted.get(key);
    if (entry !== undefined) this.ask(entry.chat);
  }

  private emitSite(key: string, event: SiteEvent): void {
    for (const listener of this.siteListeners.get(key) ?? []) listener(event);
  }

  onRoster(listener: ClaudeModPaneRosterListener): () => void {
    this.rosterListeners.add(listener);
    return (): void => {
      this.rosterListeners.delete(listener);
    };
  }

  private receive(event: ClaudeModSurfaceEvent): void {
    const key = chatKey(event);
    const { push } = event;
    if (push.kind === 'toast') {
      for (const listener of this.toastListeners.get(key) ?? []) {
        listener({
          plugin: push.plugin,
          text: push.text,
          timeoutMs: push.timeoutMs,
        });
      }
      return;
    }
    if (push.kind === 'scroll' || push.kind === 'focus') {
      this.emitSite(key, push);
      return;
    }
    if (push.kind === 'composer-request') {
      void this.answerComposer(event, push);
      return;
    }
    if (push.kind === 'composer-withdraw') {
      this.withdrawn.add(push.requestId);
      for (const id of this.withdrawn) {
        if (this.withdrawn.size <= WITHDRAWN_KEPT) break;
        this.withdrawn.delete(id);
      }
      return;
    }
    if (push.kind === 'composer-activity' && push.action === 'copy') {
      for (const listener of this.toastListeners.get(key) ?? []) {
        listener({
          plugin: push.plugin ?? CLAUDE_MODS_COPY.unnamedMod,
          text: CLAUDE_MODS_COPY.composerCopy,
          timeoutMs: COPY_TOAST_MS,
        });
      }
      return;
    }
    if (push.kind === 'ended') {
      this.forget(key, {
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        chatId: event.chatId,
      });
      return;
    }
    const current = this.chat(key);
    if (push.kind === 'panes') {
      const open = new Set(push.roster.panes.map((pane) => pane.id));
      // A keyboard grant is for the pane its ask was for, not a later one.
      const waiting = this.focusWaiting.get(key);
      if (
        waiting !== undefined &&
        (push.reset === true || !open.has(waiting))
      ) {
        this.focusWaiting.delete(key);
      }
      const panes = Object.fromEntries(
        Object.entries(current.panes).filter(([id]) => open.has(id)),
      );
      this.chats.set(key, { ...current, roster: push.roster, panes });
      const chat = {
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        chatId: event.chatId,
      };
      for (const listener of this.rosterListeners) {
        listener(chat, push.roster, current.roster, push.reset === true);
      }
    } else if (push.kind === 'tree') {
      if (push.site === 'band') {
        this.chats.set(key, { ...current, band: push.tree });
      } else if (
        current.roster.panes.some((pane) => pane.id === push.instanceId)
      ) {
        this.chats.set(key, {
          ...current,
          panes: { ...current.panes, [push.instanceId]: push.tree },
        });
      }
    } else if (push.kind === 'status') {
      const others = current.statuses.filter(
        (line) => line.plugin !== push.plugin,
      );
      const statuses =
        push.text === null
          ? others
          : [...others, { plugin: push.plugin, text: push.text }];
      this.chats.set(key, { ...current, statuses });
    } else {
      // A Mod's log line, or a read or fill of the draft shown as one.
      const line =
        push.kind === 'log'
          ? { plugin: push.plugin, text: push.text }
          : {
              plugin: push.plugin ?? CLAUDE_MODS_COPY.unnamedMod,
              text:
                push.action === 'read'
                  ? CLAUDE_MODS_COPY.composerRead
                  : CLAUDE_MODS_COPY.composerFill,
            };
      this.nextLogId += 1;
      const logs = [...current.logs, { id: this.nextLogId, ...line }].slice(
        -LOG_LIMIT,
      );
      this.chats.set(key, { ...current, logs });
    }
    for (const listener of this.listeners) listener();
  }
}

const stores = new WeakMap<CanopyClient, SurfaceStore>();

function storeFor(client: CanopyClient): SurfaceStore {
  let store = stores.get(client);
  if (!store) {
    store = new SurfaceStore(client);
    stores.set(client, store);
  }
  return store;
}

/**
 * Lets a chat's Mods read and fill its composer, and read the selection in
 * its transcript, while the calling view shows the chat and the surface is
 * on. A host composer mounts this once per chat.
 */
export function useClaudeModComposerAnswerer(
  chat: ClaudeModSurfaceChat | null,
  answerer: ClaudeModComposerAnswerer,
): void {
  const client = useCanopyClient();
  const store =
    useCapabilities().claudeModSurface === true ? storeFor(client) : null;
  const key = chat === null ? null : chatKey(chat);
  useEffect(
    () =>
      store === null || key === null
        ? undefined
        : store.registerComposer(key, answerer),
    [store, key, answerer],
  );
}

/**
 * Every chat's pane roster changes, for a host that opens a panel for each
 * pane a Mod opens and closes it when the Mod does.
 */
export function watchClaudeModPaneRosters(
  client: CanopyClient,
  listener: ClaudeModPaneRosterListener,
): () => void {
  return storeFor(client).onRoster(listener);
}

/**
 * Gives one pane of a chat the keyboard: its view focuses its first control,
 * now or when it next mounts. For a host honoring the pane's focus request.
 */
export function focusClaudeModPane(
  client: CanopyClient,
  chat: ClaudeModSurfaceChat,
  paneId: string,
): void {
  storeFor(client).takeFocus(chatKey(chat), paneId);
}

/** What a chat's Mod surface shows now, outside React. */
export function readClaudeModSurface(
  client: CanopyClient,
  chat: ClaudeModSurfaceChat,
): ChatSurface {
  return storeFor(client).chat(chatKey(chat));
}

/** A chat's Mod status lines and log lines, empty without the capability. */
export function useClaudeModSurface(
  chat: ClaudeModSurfaceChat | null,
): ChatSurface {
  const client = useCanopyClient();
  const enabled = useCapabilities().claudeModSurface === true && chat !== null;
  const store = enabled ? storeFor(client) : null;
  const key = chat === null ? '' : chatKey(chat);
  const projectId = chat?.projectId;
  const worktreeId = chat?.worktreeId;
  const chatId = chat?.chatId;
  useEffect(() => {
    if (
      store === null ||
      projectId === undefined ||
      worktreeId === undefined ||
      chatId === undefined
    ) {
      return undefined;
    }
    return store.mount({ projectId, worktreeId, chatId });
  }, [store, projectId, worktreeId, chatId]);
  return useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? ((): void => undefined),
    () => store?.chat(key) ?? EMPTY,
    // A server render draws no Mod surface; the client fills it in.
    () => EMPTY,
  );
}

/** Hands a chat's Mod toasts to the host's toast surface. */
export function useClaudeModSurfaceToasts(
  chat: ClaudeModSurfaceChat | null,
  onToast: (toast: ClaudeModSurfaceToast) => void,
): void {
  const client = useCanopyClient();
  const enabled = useCapabilities().claudeModSurface === true && chat !== null;
  const latest = useRef(onToast);
  latest.current = onToast;
  const key = chat === null ? '' : chatKey(chat);
  useEffect(() => {
    if (!enabled) return undefined;
    return storeFor(client).onToast(key, (toast) => latest.current(toast));
  }, [client, enabled, key]);
}

function SurfaceLine({
  line,
}: {
  readonly line: ClaudeModSurfaceLine;
}): JSX.Element {
  return (
    <>
      <span className="shrink-0 font-medium fg-secondary">{line.plugin}</span>
      {/* A Mod's text can hold conversation content. */}
      <span className={`min-w-0 truncate fg-primary ${REPLAY_BLOCK_CLASS}`}>
        {line.text}
      </span>
    </>
  );
}

/**
 * The chat's Mod status lines, one per plugin, in the composer's bottom
 * drawer. Draws nothing while no Mod has a line.
 */
export function ClaudeModStatusDrawer({
  chat,
}: {
  readonly chat: ClaudeModSurfaceChat | null;
}): JSX.Element | null {
  const { statuses } = useClaudeModSurface(chat);
  if (statuses.length === 0) return null;
  return (
    <ComposerDrawer edge="bottom" data-testid="claude-mod-status-drawer">
      <ComposerDrawerSection>
        <ul className="flex flex-col px-2 py-1 text-xs">
          {statuses.map((line) => (
            <li key={line.plugin} className="flex min-w-0 gap-2">
              <SurfaceLine line={line} />
            </li>
          ))}
        </ul>
      </ComposerDrawerSection>
    </ComposerDrawer>
  );
}

/**
 * The chat's Mod log lines as dim notices at the transcript's end: shown
 * here only, never sent to a model and never saved.
 */
export function ClaudeModLogNotices({
  chat,
}: {
  readonly chat: ClaudeModSurfaceChat | null;
}): JSX.Element | null {
  const { logs } = useClaudeModSurface(chat);
  if (logs.length === 0) return null;
  return (
    <ul
      className="flex flex-col gap-1 py-2 text-xs"
      data-testid="claude-mod-log-notices"
    >
      {logs.map((line) => (
        <li key={line.id} className="flex min-w-0 gap-2 fg-tertiary">
          <span className="shrink-0 font-medium">{line.plugin}</span>
          <span
            className={`min-w-0 whitespace-pre-wrap break-words ${REPLAY_BLOCK_CLASS}`}
          >
            {line.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Sends what the person did on a chat's Mod surface to its session. */
function useClaudeModSurfaceCommand(
  chat: ClaudeModSurfaceChat | null,
): (command: ClaudeModSurfaceCommand) => void {
  const client = useCanopyClient();
  const projectId = chat?.projectId;
  const worktreeId = chat?.worktreeId;
  const chatId = chat?.chatId;
  return useCallback(
    (command: ClaudeModSurfaceCommand): void => {
      if (
        projectId === undefined ||
        worktreeId === undefined ||
        chatId === undefined
      ) {
        return;
      }
      // A press the session no longer answers changes nothing: the host
      // resolves it. A rejection is the transport's, recorded with no surface
      // since nothing shows.
      client
        .command('claudeMods.surfaceCommand', {
          projectId,
          worktreeId,
          chatId,
          command,
        })
        .catch((error: unknown): void => {
          // An older paired desktop refuses the channel: expected.
          if (
            isChannelUnavailableRejection(error, 'claude-mods:surface-command')
          )
            return;
          recordSurfacedError({
            chokePoint: 'notice',
            identifier: 'claude-mod-surface-command',
            error,
          });
        });
    },
    [client, projectId, worktreeId, chatId],
  );
}

/** One Mod's part of the band, drawn in its pill's card. */
function ClaudeModBandPart({
  chat,
  plugin,
  tree,
}: {
  readonly chat: ClaudeModSurfaceChat | null;
  readonly plugin: string;
  readonly tree: ExtensionUiNode;
}): JSX.Element {
  const client = useCanopyClient();
  const onCommand = useClaudeModSurfaceCommand(chat);
  const onOpenLink = useCallback(
    (url: string): void => {
      client.openExternalUrl?.(url);
    },
    [client],
  );
  return (
    <div
      className="px-2.75 py-1"
      data-testid="claude-mod-band"
      data-mod-plugin={plugin}
    >
      <ExtensionTreeView
        tree={tree}
        onCommand={onCommand}
        onOpenLink={onOpenLink}
      />
    </div>
  );
}

/**
 * The band Mods draw above the composer (`AbovePrompt`), as work pills: one
 * per Mod whose part of the band draws something, labeled with the Mod's
 * name, whose card draws that part. None while no Mod draws a band.
 */
export function useClaudeModBandKinds(
  chat: ClaudeModSurfaceChat | null,
): readonly ComposerWorkExtraKind[] {
  const { band } = useClaudeModSurface(chat);
  return useMemo(
    () =>
      splitClaudeModBand(band).map(({ plugin, tree }) => ({
        key: `mod:${plugin}`,
        label: plugin,
        content: <ClaudeModBandPart chat={chat} plugin={plugin} tree={tree} />,
      })),
    [band, chat],
  );
}

// A probe this many code-font cells wide measures one cell.
const PROBE_CELLS = 10;

/**
 * Whether an event target is an element. Realm-safe: a pane popped out into
 * another window gets that window's elements, which fail `instanceof Element`
 * from this one.
 */
function isElementNode(target: EventTarget | null): target is Element {
  return (
    target !== null &&
    'nodeType' in target &&
    target.nodeType === 1 &&
    'closest' in target
  );
}

function clampCells(
  value: number,
  bounds: { min: number; max: number },
): number {
  return Math.min(Math.max(Math.floor(value), bounds.min), bounds.max);
}

/**
 * One pane a Claude Mod opened in a chat, drawn with the shared tree view.
 * It reports its body to the session in cells of the code font, so the Mod
 * lays out for the space it has, and shows the pane closed while the chat's
 * session does not list it (a restored tab, or a session that ended).
 */
export function ClaudeModPaneView({
  chat,
  paneId,
}: {
  readonly chat: ClaudeModSurfaceChat;
  readonly paneId: string;
}): JSX.Element {
  const client = useCanopyClient();
  const { roster, panes } = useClaudeModSurface(chat);
  const send = useClaudeModSurfaceCommand(chat);
  const open = roster.panes.some((pane) => pane.id === paneId);
  const tree = panes[paneId] ?? null;
  const body = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  /** The first content row the person last saw, as last reported. */
  const offset = useRef(0);
  /** Where a Mod's move put the window, so its scroll event is not reported. */
  const landed = useRef<number | null>(null);
  /** A Mod keeps the window on the tree's last rows. */
  const following = useRef(false);
  const onOpenLink = useCallback(
    (url: string): void => {
      client.openExternalUrl?.(url);
    },
    [client],
  );

  useLayoutEffect(() => {
    const element = body.current;
    const cell = probe.current;
    if (!open || element === null || cell === null) return undefined;
    let reported = '';
    const report = (): void => {
      const width = cell.offsetWidth / PROBE_CELLS;
      const height = cell.offsetHeight;
      if (width <= 0 || height <= 0) return;
      // The tree draws inside the body's padding.
      const style = getComputedStyle(element);
      const inner = (size: number, start: string, end: string): number =>
        size - (parseFloat(start) || 0) - (parseFloat(end) || 0);
      const columns = clampCells(
        inner(element.clientWidth, style.paddingLeft, style.paddingRight) /
          width,
        CLAUDE_MOD_PANE_CELLS.columns,
      );
      const rows = clampCells(
        inner(element.clientHeight, style.paddingTop, style.paddingBottom) /
          height,
        CLAUDE_MOD_PANE_CELLS.rows,
      );
      const size = `${String(columns)}x${String(rows)}`;
      if (size === reported) return;
      reported = size;
      send({ kind: 'pane-resize', paneId, columns, rows });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [open, paneId, send]);

  // The person's scrolls and keyboard moves go to the session; the Mod's
  // own moves come back as site events.
  const store =
    useCapabilities().claudeModSurface === true ? storeFor(client) : null;
  const key = chatKey(chat);
  useEffect(() => {
    const element = body.current;
    const cell = probe.current;
    if (!open || element === null || cell === null) return undefined;
    const rows = (size: number, start: string, end: string): number =>
      (size - (parseFloat(start) || 0) - (parseFloat(end) || 0)) /
      cell.offsetHeight;
    let frame: number | null = null;
    const reportScroll = (): void => {
      frame = null;
      const lineHeight = cell.offsetHeight;
      if (lineHeight <= 0) return;
      if (
        landed.current !== null &&
        Math.abs(element.scrollTop - landed.current) < 1
      ) {
        landed.current = null;
        return;
      }
      landed.current = null;
      const next = Math.round(element.scrollTop / lineHeight);
      const by = next - offset.current;
      if (by === 0) return;
      offset.current = next;
      following.current = false;
      const style = getComputedStyle(element);
      send({
        kind: 'scroll',
        site: 'pane',
        instanceId: paneId,
        offset: next,
        by,
        bodyRows: Math.max(
          0,
          Math.floor(
            rows(element.clientHeight, style.paddingTop, style.paddingBottom),
          ),
        ),
        contentRows: Math.max(
          0,
          Math.ceil(
            rows(element.scrollHeight, style.paddingTop, style.paddingBottom),
          ),
        ),
      });
    };
    // Throttled to the frame, as the session asks.
    const onScroll = (): void => {
      frame ??= requestAnimationFrame(reportScroll);
    };
    let held = '';
    const reportFocus = (isHeld: boolean, target: Element | null): void => {
      const control = isHeld ? findExtensionUiControl(target) : null;
      const now = isHeld
        ? `held:${control?.plugin ?? ''}:${control?.key ?? ''}`
        : '';
      if (now === held) return;
      const wasHeld = held !== '';
      held = now;
      if (isHeld !== wasHeld) {
        send({ kind: 'pane-focus', paneId: isHeld ? paneId : null });
      }
      send({
        kind: 'focus',
        site: 'pane',
        instanceId: paneId,
        isHeld,
        element: control,
      });
    };
    const onFocusIn = (event: FocusEvent): void => {
      reportFocus(true, isElementNode(event.target) ? event.target : null);
    };
    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget;
      if (isElementNode(next) && element.contains(next)) return;
      reportFocus(false, null);
    };
    // The Mod's first control, else the pane itself.
    const takeFocus = (): void => {
      if (!focusFirstExtensionUiControl(element)) element.focus();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('focusin', onFocusIn);
    element.addEventListener('focusout', onFocusOut);
    const unsubscribe = store?.onSite(key, (event): void => {
      if (event.instanceId !== paneId) return;
      if (event.kind === 'take-focus') {
        if (store.claimFocus(key, paneId)) takeFocus();
        return;
      }
      if (event.kind === 'focus') {
        // Only within the pane: a Mod moves the ring, never takes the keyboard.
        // The pane's own document: a popped-out pane is in another window.
        if (
          event.site !== 'pane' ||
          !element.contains(element.ownerDocument.activeElement)
        ) {
          return;
        }
        focusExtensionUiControl(element, event.element);
        return;
      }
      if (event.site !== 'pane') return;
      following.current = event.followEnd;
      element.scrollTop = event.followEnd
        ? element.scrollHeight
        : event.offset * cell.offsetHeight;
      landed.current = element.scrollTop;
      offset.current = Math.round(
        element.scrollTop / Math.max(1, cell.offsetHeight),
      );
    });
    if (store?.claimFocus(key, paneId) === true) takeFocus();
    return (): void => {
      if (frame !== null) cancelAnimationFrame(frame);
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('focusin', onFocusIn);
      element.removeEventListener('focusout', onFocusOut);
      unsubscribe?.();
      // A focused element removed with the view fires no focusout.
      reportFocus(false, null);
    };
  }, [open, paneId, send, store, key]);

  // A followed end stays in view as the tree grows; the person's next scroll
  // counts from there.
  useLayoutEffect(() => {
    const element = body.current;
    const lineHeight = probe.current?.offsetHeight ?? 0;
    if (!following.current || element === null || lineHeight <= 0) return;
    element.scrollTop = element.scrollHeight;
    landed.current = element.scrollTop;
    offset.current = Math.round(element.scrollTop / lineHeight);
  }, [tree]);

  if (!open) {
    return (
      <EmptyState
        testId="claude-mod-pane-closed"
        title="This pane is closed"
        subtitle="It opens here again when its Mod opens it in this chat."
      />
    );
  }
  return (
    <div
      ref={body}
      className="relative h-full min-h-0 overflow-auto p-3"
      data-testid="claude-mod-pane"
      // Takes the keyboard when its Mod asks and it draws no control.
      tabIndex={-1}
    >
      <span
        ref={probe}
        aria-hidden
        className="invisible absolute left-0 top-0 whitespace-pre font-mono text-s"
      >
        {'M'.repeat(PROBE_CELLS)}
      </span>
      {tree === null ? null : (
        <ExtensionTreeView
          tree={tree}
          onCommand={send}
          onOpenLink={onOpenLink}
        />
      )}
    </div>
  );
}
