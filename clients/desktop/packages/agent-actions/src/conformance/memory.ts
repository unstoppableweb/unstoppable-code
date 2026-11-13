import { AgentPortError } from '../port/environment-port';
import type {
  AgentMemoryPort,
  AgentMemorySearchHit,
} from '../port/memory-port';

/**
 * An in-memory synced user memory, as a cloud chat reaches it: one user
 * scope of notes, no workspace memory. A note saved under an idempotency
 * key it already saved answers that note again. Hosts with no memory store
 * of their own run the conformance suite over it.
 */
export function createInMemoryAgentMemoryPort<H>(): AgentMemoryPort<H> & {
  /** How many notes were saved. */
  saveCount(): number;
} {
  const notes = new Map<string, string>();
  const byKey = new Map<string, string>();
  const noWorkspace = (): AgentPortError =>
    new AgentPortError(
      'invalid_target',
      'Cloud chats have no workspace memory. Use scope "user".',
    );
  return {
    saveCount: () => notes.size,
    save: (input) => {
      if (input.memory !== 'user') return Promise.reject(noWorkspace());
      const known = byKey.get(input.idempotencyKey);
      const fileKey = known ?? `inbox/note-${String(notes.size + 1)}.md`;
      if (known === undefined) {
        notes.set(fileKey, `${input.text.trim()}\n`);
        byKey.set(input.idempotencyKey, fileKey);
      }
      return Promise.resolve({ memory: 'user', fileKey });
    },
    search: (query) => {
      const needle = query.trim().toLowerCase();
      const hits: AgentMemorySearchHit[] = [...notes]
        .filter(([, content]) => content.toLowerCase().includes(needle))
        .map(([fileKey, content]) => ({
          memory: 'user',
          fileKey,
          heading: null,
          snippet: content.trim(),
        }));
      return Promise.resolve(hits);
    },
    read: (input) => {
      if (input.memory !== 'user') return Promise.reject(noWorkspace());
      const content = notes.get(input.fileKey);
      return content === undefined
        ? Promise.reject(
            new AgentPortError(
              'not_found',
              `Memory file not found: [${input.memory}] ${input.fileKey}.`,
            ),
          )
        : Promise.resolve(content);
    },
  };
}
