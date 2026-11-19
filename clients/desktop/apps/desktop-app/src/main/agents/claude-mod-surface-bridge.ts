import { randomUUID } from 'node:crypto';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  EMPTY_CLAUDE_MOD_PANE_ROSTER,
  parseClaudeModComposerRequest,
  parseClaudeModPaneRoster,
  parseClaudeModSitePush,
  parseClaudeModSurfacePush,
  validateExtensionUiTree,
  type ClaudeModComposerAnswer,
  type ClaudeModComposerRequest,
  type ClaudeModPaneRoster,
  type ClaudeModSurfaceCommand,
  type ClaudeModSurfaceCommandArgs,
  type ClaudeModSurfaceUpdate,
} from '@canopy/protocol/extension-ui';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { validateId } from '../lib/validation';
import { sendToAllWindows } from '../lib/window-send';

export interface ClaudeModSurfaceChat {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/** Sends one surface control request to the session's CLI. */
export type ClaudeModSurfaceRequest = (
  request: Record<string, unknown>,
) => Promise<unknown>;

/** Answers one of the CLI's requests to this client (`Query.setUiHost`). */
type ClaudeModUiAnswer = (
  request: Record<string, unknown>,
  options: { readonly signal: AbortSignal },
) => Promise<Record<string, unknown>>;

/** The SDK UI host the bridge installs on the session's query. */
export interface ClaudeModUiHost {
  readonly copy: ClaudeModUiAnswer;
  readonly promptRead: ClaudeModUiAnswer;
  readonly promptFill: ClaudeModUiAnswer;
  readonly readSelection: ClaudeModUiAnswer;
}

/** Installs (or, with `undefined`, removes) the session query's UI host. */
export type ClaudeModSetUiHost = (host: ClaudeModUiHost | undefined) => void;

/** The requests this client answers, as `ui_attach.answers` names them. */
const COMPOSER_ANSWERS = [
  'ui_copy',
  'ui_prompt_read',
  'ui_prompt_fill',
  'ui_read_selection',
] as const;
/** A window's answer must reach the CLI inside its 5 s. */
const COMPOSER_ANSWER_MS = 3000;
/**
 * A window drops a request it gets after this long, so a fill the bridge
 * has already answered as refused never lands.
 */
const COMPOSER_DEADLINE_MS = 2000;
/** Reads show at most once in this long, so a Mod polling the draft is one line. */
const READ_NOTICE_MS = 60_000;
/** How many of this client's presses a fill can name, newest kept. */
const PRESS_IDS_KEPT = 32;

// A Mod's `session.start` hook can push before the root init arrives.
const EARLY_PUSH_LIMIT = 50;
const CLIENT_ID = 'canopy-desktop';
// The band and panes lay out in cells; until a pane's panel reports its own
// size, Canopy reports a roomy fixed grid.
const VIEWPORT = { columns: 100, rows: 40, isFullscreen: true } as const;
const PANE_BODY_COLUMNS = 80;
export const CLAUDE_MOD_BAND_INSTANCE = 'above-prompt';
// Invalidations within one frame draw once.
const RENDER_DELAY_MS = 16;
const SITE_SEPARATOR = '\u0000';

const bridges = new Map<string, ClaudeModSurfaceBridge>();

function chatKey(chat: ClaudeModSurfaceChat): string {
  return [chat.projectId, chat.worktreeId, chat.chatId].join(SITE_SEPARATOR);
}

/** The live bridge of a chat's Claude session, for the person's commands. */
export function claudeModSurfaceBridgeFor(
  chat: ClaudeModSurfaceChat,
): ClaudeModSurfaceBridge | undefined {
  return bridges.get(chatKey(chat));
}

/**
 * Runs what a person did on a chat's Mod surface, from a window or a Remote
 * Control client. A chat whose session is gone, or not drawing its surface, ignores
 * it.
 */
export async function runClaudeModSurfaceCommand(
  args: ClaudeModSurfaceCommandArgs,
): Promise<void> {
  const { command, ...chat } = args;
  validateId(chat.projectId, 'project id');
  validateId(chat.worktreeId, 'worktree id');
  validateId(chat.chatId, 'chat id');
  await claudeModSurfaceBridgeFor(chat)?.command(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One Claude session's Mod surface. The session hands it every `ui_*`
 * message, which never reaches the transcript. While both flags are on and
 * the CLI speaks `ui_surface_v1`, it forwards a Mod's toasts, status lines
 * and log lines (site group M1). Given the session's request channel it also
 * attaches as the `desktop` surface and draws the band above the composer
 * and the Mod's panes (M2); a failed request drops the session back to M1.
 */
export class ClaudeModSurfaceBridge {
  private attached = false;
  /** Pushes before the root init; `null` once init has decided. */
  private early: ClaudeModSurfaceUpdate[] | null = [];
  /** `ui_attach` succeeded and no request has failed since (M2). */
  private surface = false;
  private roster: ClaudeModPaneRoster = EMPTY_CLAUDE_MOD_PANE_ROSTER;
  /** Sites that answered `hooked: false`, skipped until invalidated. */
  private readonly unhooked = new Set<string>();
  private readonly dirty = new Set<string>();
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped when a surface ends, so a late answer to it draws nothing. */
  private generation = 0;
  /** Each site's latest render, so an older answer never replaces a newer one. */
  private readonly revisions = new Map<string, number>();
  /** This CLI process sent its first root init; one follows every turn. */
  private initialized = false;
  /** Each site's content height in rows, as the person's last scroll reported. */
  private readonly contentRows = new Map<string, number>();
  /** How many scroll and focus reports each site has sent, by kind. */
  private readonly reports = new Map<string, number>();
  /** Each Mod's status line, for a client that asks for the surface again. */
  private readonly statuses = new Map<string, string>();
  /** Each site's last tree, for the same. */
  private readonly trees = new Map<
    string,
    Extract<ClaudeModSurfaceUpdate, { kind: 'tree' }>
  >();
  /** Each pane's panel body, in cells, as the renderer measured it. */
  private readonly paneCells = new Map<
    string,
    { readonly columns: number; readonly rows: number }
  >();
  /** Composer requests a window has yet to answer, by request id. */
  private readonly asks = new Map<
    string,
    {
      readonly kind: ClaudeModComposerRequest['kind'];
      readonly finish: (answer: ClaudeModComposerAnswer | null) => void;
    }
  >();
  /** The plugin of each of this client's recent presses, by `press_id`. */
  private readonly pressPlugins = new Map<string, string>();
  /** When a Mod's read of the draft last showed. */
  private lastReadNotice = Number.NEGATIVE_INFINITY;
  /** `attach` installed the UI host, so `close` removes it. */
  private hostInstalled = false;

  constructor(
    private readonly chat: ClaudeModSurfaceChat,
    /** Admission is on for this launch, so only allowed Mods run. */
    private readonly admissionOn: boolean,
    private readonly request?: ClaudeModSurfaceRequest,
    /** Answers the CLI's composer requests through the chat's window. */
    private readonly setUiHost?: ClaudeModSetUiHost,
  ) {
    bridges.get(chatKey(chat))?.close();
    bridges.set(chatKey(chat), this);
  }

  /**
   * The root `system/init` message: attach when both flags are on and the
   * CLI speaks the surface protocol. Under admission a push can come only from
   * an allowed Mod, so the bridge needs no list of the Mods that loaded.
   * Claude Code sends one every turn; only a process's first one counts.
   */
  init(message: Record<string, unknown>): void {
    if (this.initialized) return;
    this.initialized = true;
    const { capabilities } = message;
    this.attached =
      this.admissionOn &&
      Array.isArray(capabilities) &&
      capabilities.includes('ui_surface_v1') &&
      getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModSurface.key,
      );
    const early = this.early ?? [];
    this.early = null;
    if (!this.attached) return;
    for (const push of early) this.send(push);
    if (this.request) void this.attach();
  }

  /** A `ui_*` message the session took out of the stream. */
  receive(message: Record<string, unknown>): void {
    if (this.early === null && !this.attached) return;
    if (message.subtype === 'ui_panes') {
      if (this.surface) this.setRoster(parseClaudeModPaneRoster(message));
      return;
    }
    if (message.subtype === 'ui_invalidate') {
      if (this.surface) this.invalidate(message.instances);
      return;
    }
    if (message.subtype === 'ui_scroll' || message.subtype === 'ui_focus') {
      const update = this.surface
        ? parseClaudeModSitePush(message, CLIENT_ID)
        : null;
      if (update !== null) this.send(update);
      return;
    }
    const push = parseClaudeModSurfacePush(message);
    if (push === null) return;
    if (this.early === null) this.send(push);
    else if (this.early.length < EARLY_PUSH_LIMIT) this.early.push(push);
  }

  /** What the person did on the chat's surface; ignored outside M2. */
  async command(command: ClaudeModSurfaceCommand): Promise<void> {
    if (command.kind === 'composer-answer') {
      const ask = this.asks.get(command.requestId);
      if (ask?.kind === command.answer.kind) ask.finish(command.answer);
      return;
    }
    if (command.kind === 'pane-resize') {
      this.resizePane(command.paneId, command.columns, command.rows);
      return;
    }
    if (command.kind === 'resend') {
      this.resend();
      return;
    }
    if (!this.surface) return;
    const target = { surface: 'desktop', client_id: CLIENT_ID };
    switch (command.kind) {
      case 'press': {
        // A fill this press's handler makes names it, and so its Mod.
        const pressId = randomUUID();
        this.pressPlugins.set(pressId, command.press.plugin);
        for (const old of this.pressPlugins.keys()) {
          if (this.pressPlugins.size <= PRESS_IDS_KEPT) break;
          this.pressPlugins.delete(old);
        }
        await this.call(false, {
          subtype: 'ui_press',
          ...command.press,
          key: command.key,
          ...(command.href === undefined ? {} : { href: command.href }),
          press_id: pressId,
          ...target,
        });
        return;
      }
      case 'input':
        await this.call(false, {
          subtype: 'ui_input',
          ...command.press,
          kind: command.event,
          value: command.value,
          key: command.key,
          ...target,
        });
        return;
      case 'select':
        await this.call(false, {
          subtype: 'ui_select',
          ...command.press,
          value: command.value,
          key: command.key,
          ...target,
        });
        return;
      case 'pane-show':
        await this.call(false, {
          subtype: 'ui_pane_show',
          id: command.paneId,
          ...target,
        });
        return;
      case 'pane-focus':
        await this.call(false, {
          subtype: 'ui_pane_focus',
          id: command.paneId,
          ...target,
        });
        return;
      case 'pane-close':
        await this.call(false, {
          subtype: 'ui_close',
          id: command.paneId,
          client_id: CLIENT_ID,
        });
        return;
      case 'scroll': {
        const key = [
          command.site === 'pane' ? 'Pane' : 'AbovePrompt',
          command.instanceId,
        ].join(SITE_SEPARATOR);
        this.contentRows.set(key, command.contentRows);
        const isLatest = this.report(`scroll${SITE_SEPARATOR}${key}`);
        const answer = await this.call(false, {
          subtype: 'ui_scroll',
          component: command.site === 'pane' ? 'Pane' : 'AbovePrompt',
          instance_id: command.instanceId,
          offset: command.offset,
          by: command.by,
          body_rows: command.bodyRows,
          content_rows: command.contentRows,
          ...target,
        });
        // A hook may land the window elsewhere, or keep it on the end; an
        // answer the person has scrolled past since moves nothing.
        if (
          answer !== null &&
          isLatest() &&
          typeof answer.offset === 'number' &&
          (answer.offset !== command.offset || answer.follow_end === true)
        ) {
          this.send({
            kind: 'scroll',
            site: command.site,
            instanceId: command.instanceId,
            offset: answer.offset,
            followEnd: answer.follow_end === true,
          });
        }
        return;
      }
      case 'focus': {
        const isLatest = this.report(
          [
            'focus',
            command.site === 'pane' ? 'Pane' : 'AbovePrompt',
            command.instanceId,
          ].join(SITE_SEPARATOR),
        );
        const answer = await this.call(false, {
          subtype: 'ui_focus',
          component: command.site === 'pane' ? 'Pane' : 'AbovePrompt',
          instance_id: command.instanceId,
          is_held: command.isHeld,
          // Without `element`, a release moves no ring.
          ...(command.isHeld ? { element: command.element } : {}),
          ...target,
        });
        // A hook may redirect the ring to another control; an answer the
        // person has moved past moves nothing.
        const element = isRecord(answer?.element) ? answer.element : null;
        if (
          element !== null &&
          isLatest() &&
          typeof element.plugin === 'string' &&
          typeof element.key === 'string' &&
          (element.plugin !== command.element?.plugin ||
            element.key !== command.element.key)
        ) {
          this.send({
            kind: 'focus',
            site: command.site,
            instanceId: command.instanceId,
            element: { plugin: element.plugin, key: element.key },
          });
        }
        return;
      }
    }
  }

  /** Counts a site's report; the answer lands only while it is the latest. */
  private report(key: string): () => boolean {
    const sent = (this.reports.get(key) ?? 0) + 1;
    this.reports.set(key, sent);
    return (): boolean => this.reports.get(key) === sent;
  }

  /** A new CLI process starts: its surface starts over at its first init. */
  restart(): void {
    this.fallBack();
    this.initialized = false;
  }

  /** The session ended: stop drawing and forget the chat's bridge. */
  /**
   * Asks the window showing the chat to answer a Mod's composer request;
   * `null` when no window answers in time, or the surface ends meanwhile.
   */
  private askComposer(
    request: ClaudeModComposerRequest,
    signal: AbortSignal,
  ): Promise<ClaudeModComposerAnswer | null> {
    if (!this.surface || signal.aborted) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const finish = (answer: ClaudeModComposerAnswer | null): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abandon);
        this.asks.delete(requestId);
        // Given up: a window that has not acted on it yet must not.
        if (answer === null) {
          this.send({ kind: 'composer-withdraw', requestId });
        }
        resolve(answer);
      };
      const abandon = (): void => finish(null);
      const timer = setTimeout(abandon, COMPOSER_ANSWER_MS);
      signal.addEventListener('abort', abandon, { once: true });
      this.asks.set(requestId, { kind: request.kind, finish });
      this.send({
        kind: 'composer-request',
        requestId,
        request,
        expiresAt: Date.now() + COMPOSER_DEADLINE_MS,
      });
    });
  }

  /** The SDK UI host: each answer comes from the chat's composer. */
  private readonly uiHost: ClaudeModUiHost = {
    promptRead: async (_request, { signal }) => {
      const answer = await this.askComposer({ kind: 'read' }, signal);
      if (answer?.kind !== 'read') return { text: '', cursor: 0 };
      const now = Date.now();
      if (now - this.lastReadNotice >= READ_NOTICE_MS) {
        this.lastReadNotice = now;
        this.send({ kind: 'composer-activity', action: 'read', plugin: null });
      }
      return { text: answer.text, cursor: answer.cursor };
    },
    promptFill: async (request, { signal }) => {
      const fill = parseClaudeModComposerRequest({
        ...request,
        subtype: 'ui_prompt_fill',
      });
      const answer =
        fill === null ? null : await this.askComposer(fill, signal);
      const filled = answer?.kind === 'fill' && answer.filled;
      if (filled) {
        const { answers_press: pressId } = request;
        this.send({
          kind: 'composer-activity',
          action: 'fill',
          plugin:
            typeof pressId === 'string'
              ? (this.pressPlugins.get(pressId) ?? null)
              : null,
        });
      }
      return { filled };
    },
    copy: async (request, { signal }) => {
      const copy = parseClaudeModComposerRequest({
        ...request,
        subtype: 'ui_copy',
      });
      const answer =
        copy === null ? null : await this.askComposer(copy, signal);
      const copied = answer?.kind === 'copy' && answer.copied;
      if (copied && copy?.kind === 'copy') {
        this.send({
          kind: 'composer-activity',
          action: 'copy',
          plugin: copy.plugin,
        });
      }
      return { copied };
    },
    readSelection: async (_request, { signal }) => {
      const answer = await this.askComposer({ kind: 'selection' }, signal);
      return answer?.kind === 'selection' && answer.text
        ? { text: answer.text }
        : {};
    },
  };

  close(): void {
    if (bridges.get(chatKey(this.chat)) === this) {
      bridges.delete(chatKey(this.chat));
    }
    this.fallBack();
    this.attached = false;
    // Only a host `attach` installed: before then the session may have no
    // query to remove it from.
    if (this.hostInstalled) {
      this.hostInstalled = false;
      this.setUiHost?.(undefined);
    }
  }

  private async attach(): Promise<void> {
    const { generation } = this;
    if (this.setUiHost) {
      this.setUiHost(this.uiHost);
      this.hostInstalled = true;
    }
    const attached = await this.call(true, {
      subtype: 'ui_attach',
      surface: 'desktop',
      client_id: CLIENT_ID,
      viewport: VIEWPORT,
      answers: this.setUiHost ? COMPOSER_ANSWERS : [],
    });
    if (attached === null || generation !== this.generation) return;
    this.surface = true;
    const roster = await this.call(true, {
      subtype: 'ui_panes',
      client_id: CLIENT_ID,
    });
    if (roster === null || generation !== this.generation) return;
    this.setRoster(parseClaudeModPaneRoster(roster));
    this.markDirty(['AbovePrompt', CLAUDE_MOD_BAND_INSTANCE]);
  }

  /**
   * A request's `response`, or `null` when it failed. A failed attach, roster
   * or render drops the session back to M1; a failed press, input or pick
   * (a stale handle, say) changes nothing.
   */
  private async call(
    fallBack: boolean,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (!this.request) return null;
    const { generation } = this;
    try {
      // The SDK rejects an error response, so a settled request succeeded.
      const envelope = await this.request(request);
      return isRecord(envelope) && isRecord(envelope.response)
        ? envelope.response
        : {};
    } catch {
      // A failure from a surface that has since ended leaves the new one be.
      if (fallBack && generation === this.generation) this.fallBack();
      return null;
    }
  }

  /** Sends the chat's current surface again, for a client that joined late. */
  private resend(): void {
    if (!this.attached) return;
    for (const [plugin, text] of this.statuses) {
      this.send({ kind: 'status', plugin, text });
    }
    if (!this.surface) return;
    this.send({ kind: 'panes', roster: this.roster });
    for (const push of [...this.trees.values()]) {
      this.send(push);
    }
  }

  private fallBack(): void {
    this.generation += 1;
    for (const { finish } of [...this.asks.values()]) finish(null);
    if (!this.surface) return;
    this.surface = false;
    if (this.renderTimer !== null) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.dirty.clear();
    this.unhooked.clear();
    this.revisions.clear();
    this.send({
      kind: 'tree',
      site: 'band',
      instanceId: CLAUDE_MOD_BAND_INSTANCE,
      tree: null,
    });
    this.roster = EMPTY_CLAUDE_MOD_PANE_ROSTER;
    this.send({ kind: 'panes', roster: this.roster, reset: true });
    this.trees.clear();
  }

  private setRoster(roster: ClaudeModPaneRoster): void {
    const open = new Set(this.roster.panes.map((pane) => pane.id));
    this.roster = roster;
    this.send({ kind: 'panes', roster });
    for (const pane of roster.panes) {
      if (!open.has(pane.id)) this.markDirty(['Pane', pane.id]);
    }
  }

  /** A pane's panel changed size: draw the pane again for its new grid. */
  private resizePane(paneId: string, columns: number, rows: number): void {
    const before = this.paneCells.get(paneId);
    if (before?.columns === columns && before.rows === rows) return;
    this.paneCells.set(paneId, { columns, rows });
    if (this.roster.panes.some((pane) => pane.id === paneId)) {
      this.markDirty(['Pane', paneId]);
    }
  }

  private invalidate(instances: unknown): void {
    // Without `instances` the engine redraws everything mounted (a Mod
    // loaded or reloaded): ask every site again, `hooked: false` ones too.
    if (instances === undefined) {
      this.unhooked.clear();
      this.markDirty(['AbovePrompt', CLAUDE_MOD_BAND_INSTANCE]);
      for (const pane of this.roster.panes) this.markDirty(['Pane', pane.id]);
      return;
    }
    for (const instance of Array.isArray(instances) ? instances : []) {
      if (!isRecord(instance)) continue;
      const { surface, component, instance_id: instanceId } = instance;
      if (surface !== undefined && surface !== 'desktop') continue;
      if (
        (component === 'Pane' || component === 'AbovePrompt') &&
        typeof instanceId === 'string'
      ) {
        this.unhooked.delete([component, instanceId].join(SITE_SEPARATOR));
        this.markDirty([component, instanceId]);
      }
    }
  }

  private markDirty(site: ['Pane' | 'AbovePrompt', string]): void {
    if (!this.surface) return;
    this.dirty.add(site.join(SITE_SEPARATOR));
    this.renderTimer ??= setTimeout(() => {
      this.renderTimer = null;
      const sites = [...this.dirty];
      this.dirty.clear();
      for (const key of sites) void this.render(key);
    }, RENDER_DELAY_MS);
  }

  private async render(key: string): Promise<void> {
    if (!this.surface || this.unhooked.has(key)) return;
    const [component, instanceId] = key.split(SITE_SEPARATOR);
    const pane = this.roster.panes.find((open) => open.id === instanceId);
    if (component === 'Pane' && pane === undefined) return;
    const size = pane === undefined ? undefined : this.paneCells.get(pane.id);
    const { generation } = this;
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    const response = await this.call(true, {
      subtype: 'ui_render',
      surface: 'desktop',
      client_id: CLIENT_ID,
      component,
      instance_id: instanceId,
      props:
        pane === undefined
          ? {}
          : {
              title: pane.title,
              isFocused: this.roster.focusedId === pane.id,
              bodyColumns: size?.columns ?? PANE_BODY_COLUMNS,
              placement: 'dock',
            },
      viewport: size === undefined ? VIEWPORT : { ...size, isFullscreen: true },
      // Lets a Mod's `$.ui.scroll` to the end land; left out before a report.
      ...(this.contentRows.has(key)
        ? { content_rows: this.contentRows.get(key) }
        : {}),
    });
    if (
      response === null ||
      generation !== this.generation ||
      revision !== this.revisions.get(key)
    ) {
      return;
    }
    if (response.hooked === false) this.unhooked.add(key);
    const cliTree = response.tree ?? null;
    this.send({
      kind: 'tree',
      site: component === 'Pane' ? 'pane' : 'band',
      instanceId,
      tree: cliTree === null ? null : validateExtensionUiTree(cliTree).tree,
    });
  }

  /**
   * Sends one update to the chat's windows.
   */
  private send(push: ClaudeModSurfaceUpdate): void {
    if (push.kind === 'status') {
      if (push.text === null) this.statuses.delete(push.plugin);
      else this.statuses.set(push.plugin, push.text);
    } else if (push.kind === 'tree') {
      this.trees.set([push.site, push.instanceId].join(SITE_SEPARATOR), push);
    } else if (push.kind === 'panes') {
      const open = new Set(push.roster.panes.map((pane) => pane.id));
      for (const [key, tree] of this.trees) {
        if (tree.site === 'pane' && !open.has(tree.instanceId)) {
          this.trees.delete(key);
        }
      }
    }
    sendToAllWindows(IPC_CHANNELS.claudeModSurfacePush, { ...this.chat, push });
  }
}
