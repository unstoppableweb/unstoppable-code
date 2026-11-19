/**
 * Derived, in-memory index of which chat turns each pipeline run belongs to
 * (CAN-3619). Portal `pipeline_run` entities carry these links as
 * `chatTurns` so remote clients can show a run under the same turns as the
 * desktop transcript's Agent activity panel.
 *
 * This is not a persisted writer. The index is built lazily per worktree
 * scope from canonical persisted transcripts (never Portal's truncated chat
 * text) through the retained `chat-tabs-reader` compatibility reads, using
 * the same pure attribution over the same persisted messages as the renderer
 * (`@canopy/desktop-shared/lib/agent-artifact-projection`). Like the
 * renderer, it reads tool results as persisted (externalized outputs keep
 * their inline preview), so both surfaces attribute identically.
 * After durable chat commits the post-commit projection marks changed chats
 * dirty; the next lookup recomputes only those chats. Projection failures are
 * logged and never affect chat commits. A chat whose transcript
 * has never been read leaves the index incomplete: lookups reject (callers
 * omit the links, which clients keep) until a retry reads it.
 */
import type { RemoteControlPipelineRunChatTurn } from '@canopy/protocol/remote-control/shell';
import type {
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  isArtifactDispatchTool,
  projectAgentArtifactsWithCarry,
  projectPipelineRunTurnLinks,
  type PipelineRunTurnLink,
} from '@canopy/desktop-shared/lib/agent-artifact-projection';
import { logMainProcessError } from '../lib/main-process-logging';
import { readChatTabsFile, readChatTranscript } from '../lib/chat-tabs-reader';

export interface PipelineRunChatLinksScope {
  projectId: string;
  worktreeId: string;
}

/** Canonical chat reads the index consumes; injectable for tests. */
export interface PipelineRunChatLinksReader {
  /** Live chat tab metadata in tab order. Must not select transcript bodies. */
  listChatTabs(
    scope: PipelineRunChatLinksScope,
  ): Promise<readonly PersistedChatTab[]>;
  /** One chat's complete persisted transcript, in order. */
  readTranscript(
    scope: PipelineRunChatLinksScope,
    chatId: string,
  ): Promise<readonly PersistedChatMessage[]>;
}

interface ChatLinksEntry {
  /** Undefined when the tab has no transcript descriptor to compare. */
  fingerprint: string | undefined;
  links: readonly PipelineRunTurnLink[];
}

interface ScopeState {
  /** Every live chat has been read; `byExecution` is complete. */
  built: boolean;
  chats: Map<string, ChatLinksEntry>;
  /** Links as of the last complete recompute. */
  byExecution: Map<string, RemoteControlPipelineRunChatTurn[]>;
  dirtyAll: boolean;
  dirtyChats: Set<string>;
  queue: Promise<void>;
}

const canonicalChatReader: PipelineRunChatLinksReader = {
  async listChatTabs(scope) {
    // Metadata only: an empty selection hydrates no transcript bodies.
    return (
      await readChatTabsFile(scope.projectId, scope.worktreeId, {
        chatIds: [],
      })
    ).tabs;
  },
  readTranscript(scope, chatId) {
    return readChatTranscript(scope.projectId, scope.worktreeId, chatId);
  },
};

function scopeKey(scope: PipelineRunChatLinksScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId]);
}

function isChatTab(tab: PersistedChatTab): boolean {
  return (tab.kind ?? 'chat') === 'chat';
}

/**
 * Cheap change detector from durable metadata. Every transcript write bumps
 * `transcriptRevision`; carry changes are compared by value.
 */
function chatFingerprint(tab: PersistedChatTab): string | undefined {
  const transcript = tab.transcript;
  if (!transcript) return undefined;
  return JSON.stringify([
    transcript.transcriptRevision,
    transcript.committedMessageCount,
    transcript.committedDigest ?? null,
    transcript.messageCount ?? null,
    transcript.hasActiveSidecar,
    tab.agentArtifactCarryByTurn ?? null,
  ]);
}

/**
 * Keep only what the attribution reads: every message's identity/role and
 * tool_use/tool_result blocks. Unrecognized tool calls keep their owner slot
 * with an empty input (their results never participate), and results whose
 * owner is not a recognized dispatch call are dropped, so the projection is
 * identical while large unrelated bodies are not retained.
 */
function attributionMessage(
  message: PersistedChatMessage,
  recognized: Set<string>,
): PersistedChatMessage | undefined {
  const blocks: PersistedChatBlock[] = [];
  for (const block of message.blocks) {
    if (block.type === 'tool_use') {
      if (isArtifactDispatchTool(block.toolName)) {
        recognized.add(block.toolUseId);
        blocks.push(block);
      } else {
        recognized.delete(block.toolUseId);
        blocks.push({ ...block, input: '' });
      }
      continue;
    }
    if (
      block.type === 'tool_result' &&
      !block.isError &&
      recognized.has(block.toolUseId)
    ) {
      blocks.push(block);
    }
  }
  if (message.role !== 'user' && blocks.length === 0) return undefined;
  return { ...message, blocks };
}

export class PipelineRunChatLinksService {
  private readonly scopes = new Map<string, ScopeState>();

  public constructor(
    private readonly reader: PipelineRunChatLinksReader = canonicalChatReader,
  ) {}

  /**
   * Post-commit hook: mark changed chats of an already-indexed scope dirty.
   * Synchronous and allocation-light; unindexed scopes cost nothing.
   */
  public noteChatsMaterialized(
    scope: PipelineRunChatLinksScope,
    delta:
      | {
          changedTabIds: readonly string[];
          removedTabIds: readonly string[];
        }
      | undefined,
  ): void {
    const state = this.scopes.get(scopeKey(scope));
    if (!state) return;
    if (!delta) {
      state.dirtyAll = true;
      return;
    }
    for (const chatId of delta.changedTabIds) state.dirtyChats.add(chatId);
    for (const chatId of delta.removedTabIds) state.dirtyChats.add(chatId);
  }

  /**
   * Links for one execution, building the scope index on first use and
   * applying pending commits first. An empty array means "no links".
   */
  public async chatTurnsFor(
    scope: PipelineRunChatLinksScope,
    executionId: string,
  ): Promise<RemoteControlPipelineRunChatTurn[]> {
    const key = scopeKey(scope);
    let state = this.scopes.get(key);
    if (!state) {
      state = {
        built: false,
        chats: new Map(),
        byExecution: new Map(),
        dirtyAll: true,
        dirtyChats: new Set(),
        queue: Promise.resolve(),
      };
      this.scopes.set(key, state);
    }
    if (this.isDirty(state)) await this.enqueue(scope, state);
    else await state.queue;
    if (!state.built) {
      throw new Error('Pipeline run chat links are unavailable');
    }
    return (state.byExecution.get(executionId) ?? []).map((link) => ({
      ...link,
    }));
  }

  private isDirty(state: ScopeState): boolean {
    return state.dirtyAll || state.dirtyChats.size > 0;
  }

  private enqueue(
    scope: PipelineRunChatLinksScope,
    state: ScopeState,
  ): Promise<void> {
    const run = state.queue.then(() => this.recompute(scope, state));
    state.queue = run.catch(() => undefined);
    return run;
  }

  private async recompute(
    scope: PipelineRunChatLinksScope,
    state: ScopeState,
  ): Promise<void> {
    if (!this.isDirty(state)) return;
    const dirtyAll = state.dirtyAll;
    const dirtyChats = state.dirtyChats;
    state.dirtyAll = false;
    state.dirtyChats = new Set();
    let tabs: readonly PersistedChatTab[];
    try {
      tabs = (await this.reader.listChatTabs(scope)).filter(isChatTab);
    } catch (error) {
      state.dirtyAll ||= dirtyAll;
      dirtyChats.forEach((chatId) => state.dirtyChats.add(chatId));
      throw error;
    }
    const nextChats = new Map<string, ChatLinksEntry>();
    for (const tab of tabs) {
      const previous = state.chats.get(tab.id);
      if (previous && !dirtyAll && !dirtyChats.has(tab.id)) {
        nextChats.set(tab.id, previous);
        continue;
      }
      const fingerprint = chatFingerprint(tab);
      if (
        previous &&
        fingerprint !== undefined &&
        previous.fingerprint === fingerprint
      ) {
        nextChats.set(tab.id, previous);
        continue;
      }
      try {
        nextChats.set(tab.id, {
          fingerprint,
          links: await this.computeChatLinks(scope, tab),
        });
      } catch (error) {
        logMainProcessError(
          'Pipeline run chat links: failed to project chat transcript',
          error,
        );
        // Keep the last good links and retry on the next lookup.
        if (previous) nextChats.set(tab.id, previous);
        state.dirtyChats.add(tab.id);
      }
    }
    const hadChats = state.chats.size > 0;
    state.chats = nextChats;
    if (tabs.some((tab) => !nextChats.has(tab.id))) {
      // A never-read chat could hold any run's links; an index without it
      // must not answer, or its empty lists would clear clients' links.
      state.built = false;
      return;
    }
    const nextByExecution = new Map<
      string,
      RemoteControlPipelineRunChatTurn[]
    >();
    nextChats.forEach((entry, chatId) => {
      for (const link of entry.links) {
        const links = nextByExecution.get(link.executionId) ?? [];
        links.push({
          chatId,
          userMessageId: link.userMessageId,
          relation: link.relation,
        });
        nextByExecution.set(link.executionId, links);
      }
    });
    state.byExecution = nextByExecution;
    state.built = true;
    // A scope whose last chat was removed (including scope deletion) drops
    // its derived state; it rebuilds on use.
    if (
      hadChats &&
      nextChats.size === 0 &&
      !this.isDirty(state) &&
      this.scopes.get(scopeKey(scope)) === state
    ) {
      this.scopes.delete(scopeKey(scope));
    }
  }

  private async computeChatLinks(
    scope: PipelineRunChatLinksScope,
    tab: PersistedChatTab,
  ): Promise<PipelineRunTurnLink[]> {
    const recognized = new Set<string>();
    const messages: PersistedChatMessage[] = [];
    for (const message of await this.reader.readTranscript(scope, tab.id)) {
      const projected = attributionMessage(message, recognized);
      if (projected) messages.push(projected);
    }
    const projection = projectAgentArtifactsWithCarry(
      messages,
      tab.agentArtifactCarryByTurn,
    );
    const turnOrder = messages
      .filter((message) => message.role === 'user' && !message.hidden)
      .map((message) => message.id);
    return projectPipelineRunTurnLinks(projection, turnOrder, scope);
  }
}

let service: PipelineRunChatLinksService | null = null;

export function getPipelineRunChatLinks(): PipelineRunChatLinksService {
  service ??= new PipelineRunChatLinksService();
  return service;
}
