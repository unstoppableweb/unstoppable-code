import {
  agentActionIdempotencyKey,
  runIdempotentWrite,
} from '../action-support';
import type { AgentActionReceiptStore } from '../receipts';
import type { AgentActionCall } from '../surface/family';
import type { AgentActionToolResult } from '../tools/definition';
import type {
  AgentMemoryScope,
  ReadMemoryInput,
  SaveMemoryInput,
  SearchMemoryInput,
} from '../tools/memory';
import { AgentPortError } from './environment-port';

/** One file a memory search matched. */
export interface AgentMemorySearchHit {
  memory: AgentMemoryScope;
  fileKey: string;
  heading: string | null;
  /** Archived hits carry their save date at the start of the snippet. */
  snippet: string;
}

/**
 * Host-side memory behind SaveMemory, SearchMemory and ReadMemory, for the
 * calling chat's owner. Each call resolves which memory the chat may use;
 * a refusal is an `AgentPortError` whose message the agent reads.
 */
export interface AgentMemoryPort<H> {
  /**
   * Saves a note into the named memory and returns its file key. The same
   * `idempotencyKey` saves at most one note.
   */
  save(
    input: {
      memory: AgentMemoryScope;
      text: string;
      idempotencyKey: string;
    },
    call: AgentActionCall<H>,
  ): Promise<{ memory: AgentMemoryScope; fileKey: string }>;
  search(
    query: string,
    call: AgentActionCall<H>,
  ): Promise<readonly AgentMemorySearchHit[]>;
  /** One file's content, or a `not_found` refusal. */
  read(
    input: { memory: AgentMemoryScope; fileKey: string },
    call: AgentActionCall<H>,
  ): Promise<string>;
}

/** The memory tools the surface runs, after their inputs are validated. */
export interface AgentActionMemoryTools<H> {
  save(
    input: SaveMemoryInput,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult>;
  search(
    input: SearchMemoryInput,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult>;
  read(
    input: ReadMemoryInput,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult>;
}

function refusal(error: unknown, fallback: string): AgentActionToolResult {
  return {
    text: error instanceof AgentPortError ? error.message : fallback,
    isError: true,
  };
}

function formatHit(hit: AgentMemorySearchHit, index: number): string {
  const context = hit.heading ? ` > ${hit.heading}` : '';
  return `${index + 1}. [${hit.memory}] ${hit.fileKey}${context}\n${hit.snippet}`;
}

/**
 * The memory tools over a host port. Results read as desktop's do: a saved
 * note's scope and file key, numbered hits with their scope, file key,
 * heading and snippet, and a file's content. SaveMemory is a write behind
 * the host's receipts, keyed by the tool call, so a retried call replays the
 * note it saved instead of saving another; it takes no agent action limits
 * slot, since it starts no work, and the port applies the memory store's
 * own rate limits.
 */
export function createMemoryTools<H>(options: {
  port: AgentMemoryPort<H>;
  receipts: AgentActionReceiptStore<H>;
}): AgentActionMemoryTools<H> {
  const { port, receipts } = options;
  return {
    save: async (input, call) => {
      const idempotencyKey = agentActionIdempotencyKey(
        'save_memory',
        call,
        input,
      );
      try {
        return await runIdempotentWrite({
          receipts,
          limits: null,
          kind: 'save_memory',
          call,
          idempotencyKey,
          payload: input,
          prepare: () =>
            Promise.resolve({
              ok: true,
              parentDepth: 0,
              write: async (): Promise<AgentActionToolResult> => {
                const saved = await port.save(
                  { memory: input.scope, text: input.text, idempotencyKey },
                  call,
                );
                return {
                  text: `Saved ${saved.memory} memory to ${saved.fileKey}`,
                };
              },
            }),
        });
      } catch (error) {
        return refusal(error, 'Memory could not be saved. Try again.');
      }
    },
    search: async (input, call) => {
      try {
        const hits = await port.search(input.query, call);
        if (hits.length === 0) {
          return { text: `No memory found for "${input.query}".` };
        }
        return {
          text: ['Memory search results:', '', ...hits.map(formatHit)].join(
            '\n',
          ),
        };
      } catch (error) {
        return refusal(error, 'Memory could not be searched. Try again.');
      }
    },
    read: async (input, call) => {
      try {
        return {
          text: await port.read(
            { memory: input.scope, fileKey: input.file },
            call,
          ),
        };
      } catch (error) {
        return refusal(error, 'Memory could not be read. Try again.');
      }
    },
  };
}
