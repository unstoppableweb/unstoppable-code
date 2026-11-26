import { z } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../common';
import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyRetryDirectiveSchema,
} from '../errors';

const ID = z.string().min(1).max(512);
/**
 * Legacy files never bounded IDs; capping references would strand readable
 * history. These are opaque record lookups, never path components. New IDs
 * still use ID; transport admission and frame limits remain host-owned.
 */
const STORED_TERMINAL_ID = z.string();

export const WORKER_TERMINAL_GRANTS = {
  read: 'worker.terminal.read',
  write: 'worker.terminal.write',
} as const;

export const WORKER_TERMINAL_STATES = [
  'starting',
  'running',
  'exited',
  'killed',
  'released',
] as const;

export type WorkerTerminalState = (typeof WORKER_TERMINAL_STATES)[number];

export const WORKER_TERMINAL_PROFILE_IDS = [
  'default',
  'zsh',
  'bash',
  'cmd',
  'powershell',
  'git-bash',
] as const;

export const WORKER_TERMINAL_ERROR_CODES = [
  'worker.terminal.invalidState',
  'worker.terminal.revisionConflict',
  'worker.terminal.notFound',
] as const;

export type WorkerTerminalErrorCode =
  (typeof WORKER_TERMINAL_ERROR_CODES)[number];

const PROFILE_ID = z.enum(WORKER_TERMINAL_PROFILE_IDS).nullable();
const INITIAL_COMMAND = z.string().min(1).max(4000).nullable();

/**
 * The minor schema revision (protocol rule 5) of `create`, `restore`, `kill`
 * and `release` that carries the terminal record's attribution and exit
 * reasons (CAN-7051). A client sends `revision: 2` and the added fields only
 * when the runtime advertises it; a runtime that predates it rejects them.
 */
export const WORKER_TERMINAL_RECORD_SCHEMA_REVISION = 2;

/** Revision metadata for a binding that integrates records, not an advertisement. */
export const WORKER_TERMINAL_SCHEMA_REVISIONS: Readonly<
  Record<string, number>
> = {
  'worker.terminal.create': WORKER_TERMINAL_RECORD_SCHEMA_REVISION,
  'worker.terminal.restore': WORKER_TERMINAL_RECORD_SCHEMA_REVISION,
  'worker.terminal.kill': WORKER_TERMINAL_RECORD_SCHEMA_REVISION,
  'worker.terminal.release': WORKER_TERMINAL_RECORD_SCHEMA_REVISION,
};

const REVISION = z.literal(WORKER_TERMINAL_RECORD_SCHEMA_REVISION).optional();

/**
 * Why a terminal ended, as its client names it (`app-quit`, `user-close`,
 * `worktree-cleanup`): separate from the OS `signal`, and a bounded token
 * rather than a closed list, so a newer reason never fails an older runtime.
 */
export const WorkerTerminalExitSignalSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/);

/** Where main's legacy terminal state lives for a worktree (CAN-7051). */
export const WORKER_TERMINAL_RECORD_LEGACY_LAYOUTS = [
  'workspaces',
  'app-workspaces',
] as const;

export type WorkerTerminalRecordLegacyLayout =
  (typeof WORKER_TERMINAL_RECORD_LEGACY_LAYOUTS)[number];

/**
 * The client's worktree a terminal record belongs to (CAN-7051): its own
 * ids, which can differ from the worker scope after alias resolution, the
 * trusted layout of its legacy state, and the worktree's incarnation (its
 * creation time), so a reused worktree id never inherits an older record.
 * The incarnation only tells a reused worktree apart; `generation` orders
 * lifetimes.
 */
export const WorkerTerminalRecordClientSchema = z.strictObject({
  projectId: ID,
  worktreeId: ID,
  legacyLayout: z.enum(WORKER_TERMINAL_RECORD_LEGACY_LAYOUTS),
  /** Producer scope identity, allocated before its first record request. */
  lifetimeId: z.string().min(1).max(512).optional(),
  incarnation: z.string().min(1).max(512).nullable(),
  /**
   * The record generation this client last saw. A request of an older
   * generation is stale: its reads are empty and its writes are dropped.
   */
  generation: z.number().int().min(1).optional(),
});

export type WorkerTerminalRecordClient = z.output<
  typeof WorkerTerminalRecordClientSchema
>;

const TERMINAL_KINDS = [
  'shell',
  'script',
  'claude-code',
  'claude-worker',
] as const;
const HOST_PATH = z.string().min(1).max(4096);

/**
 * The longest initial command or title a record session carries: the 64 KiB
 * a terminal's creation accepts, which no string of it exceeds in chars.
 */
export const WORKER_TERMINAL_RECORD_COMMAND_MAX_CHARS = 64 * 1024;

/**
 * A terminal session as its record keeps it. `shell` and `cwd` are trusted
 * host-local paths of the machine the daemon runs on, accepted only on these
 * daemon-only record operations, as the restore snapshot's launch inputs are.
 * This is the host-path exception recorded in the protocol README's
 * `worker.terminal` section (CAN-7051 plan §13 risk 7): it follows the
 * restore snapshot precedent, under the same grant as those launch inputs.
 */
export const WorkerTerminalRecordSessionSchema = z.strictObject({
  id: ID,
  projectId: ID,
  worktreeId: ID,
  shell: HOST_PATH,
  shellBasename: z.string().max(4096),
  cwd: HOST_PATH,
  createdAt: z.number().finite(),
  running: z.boolean().optional(),
  processName: z.string().max(4096).nullable().optional(),
  initialCommand: z
    .string()
    .max(WORKER_TERMINAL_RECORD_COMMAND_MAX_CHARS)
    .optional(),
  kind: z.enum(TERMINAL_KINDS).optional(),
  focusOnSpawn: z.boolean().optional(),
  title: z.string().max(WORKER_TERMINAL_RECORD_COMMAND_MAX_CHARS).optional(),
  chatId: ID.optional(),
  sessionKey: ID.optional(),
});

/**
 * A session as `open` reads it back. A record imported from main's legacy
 * state holds it as main wrote it, so reads take any lengths, and drop
 * fields this schema does not know, to keep every record readable.
 */
export const WorkerTerminalRecordStoredSessionSchema = z.object({
  id: STORED_TERMINAL_ID,
  projectId: z.string(),
  worktreeId: z.string(),
  shell: z.string(),
  shellBasename: z.string(),
  cwd: z.string(),
  createdAt: z.number().finite(),
  running: z.boolean().optional(),
  processName: z.string().nullable().optional(),
  initialCommand: z.string().optional(),
  kind: z.enum(TERMINAL_KINDS).optional(),
  focusOnSpawn: z.boolean().optional(),
  title: z.string().optional(),
  chatId: z.string().optional(),
  sessionKey: z.string().optional(),
});

export type WorkerTerminalRecordStoredSession = z.output<
  typeof WorkerTerminalRecordStoredSessionSchema
>;

export type WorkerTerminalRecordSession = z.output<
  typeof WorkerTerminalRecordSessionSchema
>;

/**
 * The client-side session fields a revision 2 `create` or `restore` carries,
 * so the record attributes the terminal before it is observable. The worker
 * assigns the id; `client` supplies the ids.
 *
 * A recorded exception to host-path-free DTOs: `shell` and `cwd` are the
 * same host-local paths the call's own `shell` and the restore snapshot's
 * launch inputs already carry under the same grant. They are kept as the
 * client resolved them, so a later restore projects `cwd` against the same
 * worktree root it was computed from.
 */
export const WorkerTerminalRecordAttributionSchema =
  WorkerTerminalRecordSessionSchema.omit({
    id: true,
    projectId: true,
    worktreeId: true,
    running: true,
    processName: true,
  });

export type WorkerTerminalRecordAttribution = z.output<
  typeof WorkerTerminalRecordAttributionSchema
>;

/** A terminal as `get`, `list`, `kill` and `resize` describe it. */
const TerminalFields = {
  terminalId: ID,
  scope: CanopyWorkspaceScopeSchema,
  state: z.enum(WORKER_TERMINAL_STATES),
  cwdRootId: ID,
  cwdRelativePath: z.string(),
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  outputOffset: z.number().int().min(0),
};

export const WorkerTerminalSchema = z
  .object(TerminalFields)
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminal = z.output<typeof WorkerTerminalSchema>;

export const WorkerTerminalCreateParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  cwdRootId: ID,
  cwdRelativePath: z.string(),
  shell: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  env: z.object({}).catchall(CanopyJsonValueSchema).optional(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  kind: z.enum(['interactive', 'auth', 'managed', 'preset']),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
  profileId: PROFILE_ID.optional(),
  initialCommand: INITIAL_COMMAND.optional(),
  /** Revision 2 (CAN-7051): the record's attribution; ignored without it. */
  revision: REVISION,
  client: WorkerTerminalRecordClientSchema.optional(),
  session: WorkerTerminalRecordAttributionSchema.optional(),
});

export type WorkerTerminalCreateParams = z.output<
  typeof WorkerTerminalCreateParamsSchema
>;

export const WorkerTerminalCreateResultSchema = z
  .object({
    ...TerminalFields,
    profileId: PROFILE_ID,
    initialCommand: INITIAL_COMMAND,
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalCreateResult = z.output<
  typeof WorkerTerminalCreateResultSchema
>;

/** The params of the operations that name one terminal. */
const TerminalTarget = {
  scope: CanopyWorkspaceScopeSchema.optional(),
  terminalId: ID,
};

export const WorkerTerminalGetParamsSchema = z.strictObject({
  ...TerminalTarget,
});

export type WorkerTerminalGetParams = z.output<
  typeof WorkerTerminalGetParamsSchema
>;

export const WorkerTerminalListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  states: z.array(z.enum(WORKER_TERMINAL_STATES)).max(32).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  pageSize: z.number().int().min(1).max(500).default(100),
});

export type WorkerTerminalListParams = z.output<
  typeof WorkerTerminalListParamsSchema
>;

export const WorkerTerminalListResultSchema = z
  .object({
    items: z.array(WorkerTerminalSchema),
    nextCursor: z.string().max(2048).nullable(),
    revision: z.number().int().min(0),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalListResult = z.output<
  typeof WorkerTerminalListResultSchema
>;

export const WorkerTerminalKillParamsSchema = z.strictObject({
  ...TerminalTarget,
  signal: z
    .string()
    .regex(/^SIG[A-Z0-9]+$/)
    .optional(),
  graceMs: z.number().int().min(0).max(60_000).optional(),
  /** Revision 2 (CAN-7051): the exit reason the terminal reports. */
  revision: REVISION,
  exitSignal: WorkerTerminalExitSignalSchema.optional(),
});

export type WorkerTerminalKillParams = z.output<
  typeof WorkerTerminalKillParamsSchema
>;

export const WorkerTerminalReleaseParamsSchema = z.strictObject({
  ...TerminalTarget,
  /**
   * Revision 2 (CAN-7051): the exit reason, unless one was already set;
   * `worktree-cleanup` otherwise.
   */
  revision: REVISION,
  exitSignal: WorkerTerminalExitSignalSchema.optional(),
});

export type WorkerTerminalReleaseParams = z.output<
  typeof WorkerTerminalReleaseParamsSchema
>;

export const WorkerTerminalReleaseResultSchema = z
  .object({ released: z.boolean() })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalReleaseResult = z.output<
  typeof WorkerTerminalReleaseResultSchema
>;

export const WORKER_TERMINAL_ENCODINGS = ['utf8', 'base64'] as const;

export type WorkerTerminalEncoding = (typeof WORKER_TERMINAL_ENCODINGS)[number];

/**
 * The exit signal a terminal reports when the process hosting it ended
 * under it (CAN-5088). The terminal is gone; restoring it recreates its
 * shell from its persisted record. It is the shared `connection-lost`
 * signal (`TERMINAL_CONNECTION_LOST_SIGNAL`), so every client already
 * explains it and offers a restart.
 */
export const WORKER_TERMINAL_LOST_SIGNAL = 'connection-lost';

/** The largest input one `worker.terminal.write` carries, before encoding. */
export const WORKER_TERMINAL_WRITE_MAX_BYTES = 1024 * 1024;

export const WorkerTerminalAttachParamsSchema = z.strictObject({
  ...TerminalTarget,
  fromOffset: z.number().int().min(0),
  maxReplayBytes: z.number().int().min(0).max(1_048_576).optional(),
  cursor: CanopyStreamCursorSchema.nullable().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export type WorkerTerminalAttachParams = z.output<
  typeof WorkerTerminalAttachParamsSchema
>;

export const WorkerTerminalAttachOpenResultSchema = z
  .object({
    subscriptionId: ID,
    acceptedCursor: CanopyStreamCursorSchema.nullable(),
  })
  .catchall(CanopyJsonValueSchema);

export const WorkerTerminalExitSchema = z
  .object({
    code: z.number().int().nullable(),
    signal: z.string().max(256).nullable(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalExit = z.output<typeof WorkerTerminalExitSchema>;

/**
 * One delivery: output bytes from `fromOffset` to `toOffset`, a change of
 * the foreground process (`running`, with no output; local workers only), or,
 * last and on its own, the terminal's `exit` after every byte it wrote.
 */
export const WorkerTerminalAttachItemSchema = z
  .object({
    terminalId: ID,
    fromOffset: z.number().int().min(0),
    toOffset: z.number().int().min(0),
    data: z.string(),
    encoding: z.enum(WORKER_TERMINAL_ENCODINGS),
    truncatedBefore: z.boolean(),
    exit: WorkerTerminalExitSchema.nullable(),
    running: z
      .strictObject({
        running: z.boolean(),
        processName: z.string().max(4096).nullable(),
        /** The command became idle because its user interrupted it. */
        interruptedByUser: z.boolean().optional(),
      })
      .optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalAttachItem = z.output<
  typeof WorkerTerminalAttachItemSchema
>;

export const WorkerTerminalAttachErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([...WORKER_TERMINAL_ERROR_CODES, 'worker.terminal.snapshotRequired'])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const WorkerTerminalAttachEndSchema = CanopyStreamEndSchema.extend({
  error: WorkerTerminalAttachErrorSchema.nullable(),
});

export const WorkerTerminalWriteParamsSchema = z.strictObject({
  ...TerminalTarget,
  input: z.string().max(WORKER_TERMINAL_WRITE_MAX_BYTES),
  encoding: z.enum(WORKER_TERMINAL_ENCODINGS),
});

export type WorkerTerminalWriteParams = z.output<
  typeof WorkerTerminalWriteParamsSchema
>;

export const WorkerTerminalWriteResultSchema = z
  .object({
    acceptedBytes: z.number().int().min(0),
    outputOffset: z.number().int().min(0),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalWriteResult = z.output<
  typeof WorkerTerminalWriteResultSchema
>;

export const WorkerTerminalResizeParamsSchema = z.strictObject({
  ...TerminalTarget,
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export type WorkerTerminalResizeParams = z.output<
  typeof WorkerTerminalResizeParamsSchema
>;

/**
 * The persisted record a client supplies to recreate a terminal that is no
 * longer live on this worker. The worker resolves `cwdRootId` and
 * `cwdRelativePath` itself and falls back to the root when the directory is
 * gone. Under revision 2 with `historyFrom: 'record'`, `scrollback` is empty
 * and the daemon replays the newest 1 MiB of the terminal's own record
 * (CAN-7051), so the client never carries its output.
 */
export const WorkerTerminalRestoreSnapshotSchema = z.strictObject({
  cwdRootId: ID,
  cwdRelativePath: z.string().max(4096),
  /**
   * The launch inputs `worker.terminal.create` already takes from its client:
   * the shell executable, its arguments and the whole environment, resolved
   * by the trusted host adapter for the machine this worker runs on (the
   * user's shell setting lives with the client). They are launch inputs for
   * this one start, never stored by the worker or returned by it; the
   * directory, the only path the worker uses as state, is resolved by the
   * worker from `cwdRootId`.
   */
  shell: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64),
  initialCommand: INITIAL_COMMAND.optional(),
  env: z.object({}).catchall(CanopyJsonValueSchema),
  /** The terminal's persisted output, replayed before the restore marker. */
  scrollback: z.string().max(WORKER_TERMINAL_WRITE_MAX_BYTES),
});

export type WorkerTerminalRestoreSnapshot = z.output<
  typeof WorkerTerminalRestoreSnapshotSchema
>;

export const WorkerTerminalRestoreParamsSchema = z.strictObject({
  ...TerminalTarget,
  restoreMode: z.enum(['reattach_if_live', 'recreate_if_exited']),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
  snapshot: WorkerTerminalRestoreSnapshotSchema.optional(),
  /** Revision 2 (CAN-7051): the record's attribution and history source. */
  revision: REVISION,
  client: WorkerTerminalRecordClientSchema.optional(),
  session: WorkerTerminalRecordAttributionSchema.optional(),
  historyFrom: z.literal('record').optional(),
});

export type WorkerTerminalRestoreParams = z.output<
  typeof WorkerTerminalRestoreParamsSchema
>;

export const WorkerTerminalRestoreResultSchema = z
  .object({
    terminalId: ID,
    state: z.enum(['running', 'exited']),
    restored: z.boolean(),
    recreated: z.boolean(),
    outputOffset: z.number().int().min(0),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalRestoreResult = z.output<
  typeof WorkerTerminalRestoreResultSchema
>;

const CODE = z.enum(WORKER_TERMINAL_ERROR_CODES).optional();

export const WorkerTerminalErrorSchema = CanopyErrorPayloadSchema.extend({
  code: CODE,
  retry: CanopyQueryRetryDirectiveSchema,
});

// Write is idempotency `none`: an unknown outcome is never replayed blindly.
export const WorkerTerminalWriteErrorSchema = CanopyErrorPayloadSchema.extend({
  code: CODE,
  retry: z.discriminatedUnion('kind', [
    CanopyRetryDirectiveSchema.options[0],
    CanopyRetryDirectiveSchema.options[3],
  ]),
});

export const WorkerTerminalCreateErrorSchema = CanopyErrorPayloadSchema.extend({
  code: CODE,
  retry: CanopyKeyedRetryDirectiveSchema,
});

const BASE = {
  plane: 'worker',
  domain: 'terminal',
  version: 1,
  placement: 'target-selectable',
} as const;

// Served by the web core (CAN-4160) over a cloud chat's durable sandbox
// terminals, and by the daemon's terminal module (CAN-5088) on macOS and
// Linux. Kept out of the composed worker registries: the desktop dispatcher
// does not serve them, and the daemon composes them only with its terminal
// module.
export const WORKER_TERMINAL_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.terminal.get': defineCanopyQuery({
      ...BASE,
      params: WorkerTerminalGetParamsSchema,
      result: WorkerTerminalSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.read],
    }),
    'worker.terminal.list': defineCanopyQuery({
      ...BASE,
      params: WorkerTerminalListParamsSchema,
      result: WorkerTerminalListResultSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.read],
    }),
  },
);

export const WORKER_TERMINAL_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.terminal.create': defineCanopyInstruction({
      ...BASE,
      // Slice 1 is inert: bindings opt into the full schema only with record integration.
      params: WorkerTerminalCreateParamsSchema.omit({
        revision: true,
        client: true,
        session: true,
      }),
      result: WorkerTerminalCreateResultSchema,
      error: WorkerTerminalCreateErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.kill': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalKillParamsSchema.omit({
        revision: true,
        exitSignal: true,
      }),
      result: WorkerTerminalSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.release': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalReleaseParamsSchema.omit({
        revision: true,
        exitSignal: true,
      }),
      result: WorkerTerminalReleaseResultSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.write': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalWriteParamsSchema,
      result: WorkerTerminalWriteResultSchema,
      error: WorkerTerminalWriteErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.resize': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalResizeParamsSchema,
      result: WorkerTerminalSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
  });

/**
 * Recreates a terminal that is no longer live on this worker (CAN-5088).
 * The daemon serves it whole; the web core serves only its reattach
 * (CAN-5708), since Core cannot restart a shell under the same id, so it
 * stays out of the shared definitions above.
 */
export const WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.terminal.restore': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalRestoreParamsSchema.omit({
        revision: true,
        client: true,
        session: true,
        historyFrom: true,
      }),
      result: WorkerTerminalRestoreResultSchema,
      error: WorkerTerminalCreateErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
  });

// ---------------------------------------------------------------------------
// The worktree terminal record (CAN-7051)
// ---------------------------------------------------------------------------

/**
 * Opt-in lifecycle schemas for bindings that integrate the terminal record.
 * Non-integrating bindings keep the strict revision-1 definitions above.
 * Record-only fields require explicit revision 2; legacy calls omit both.
 * Strict branches keep that dependency representable in JSON Schema.
 */
export const WORKER_TERMINAL_RECORD_LIFECYCLE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.terminal.create': defineCanopyInstruction({
      ...BASE,
      params: z.union([
        WORKER_TERMINAL_INSTRUCTION_DEFINITIONS['worker.terminal.create']
          .params,
        WorkerTerminalCreateParamsSchema.required({ revision: true }),
      ]),
      result: WorkerTerminalCreateResultSchema,
      error: WorkerTerminalCreateErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.kill': defineCanopyInstruction({
      ...BASE,
      params: z.union([
        WORKER_TERMINAL_INSTRUCTION_DEFINITIONS['worker.terminal.kill'].params,
        WorkerTerminalKillParamsSchema.required({ revision: true }),
      ]),
      result: WorkerTerminalSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.release': defineCanopyInstruction({
      ...BASE,
      params: z.union([
        WORKER_TERMINAL_INSTRUCTION_DEFINITIONS['worker.terminal.release']
          .params,
        WorkerTerminalReleaseParamsSchema.required({ revision: true }),
      ]),
      result: WorkerTerminalReleaseResultSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.restore': defineCanopyInstruction({
      ...BASE,
      params: z.union([
        WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS[
          'worker.terminal.restore'
        ].params,
        WorkerTerminalRestoreParamsSchema.required({ revision: true })
          .refine(
            (params): boolean =>
              params.historyFrom !== 'record' || params.client !== undefined,
            {
              path: ['client'],
              message: 'Record history requires a terminal record client',
            },
          )
          .refine(
            (params): boolean =>
              params.historyFrom !== 'record' ||
              params.snapshot === undefined ||
              params.snapshot.scrollback === '',
            {
              path: ['snapshot', 'scrollback'],
              message: 'Record history requires empty snapshot scrollback',
            },
          )
          // Zod refinements do not emit JSON Schema; publish the same wire rule.
          .meta({
            if: {
              properties: { historyFrom: { const: 'record' } },
              required: ['historyFrom'],
            },
            then: {
              required: ['client'],
              properties: {
                snapshot: { properties: { scrollback: { const: '' } } },
              },
            },
          }),
      ]),
      result: WorkerTerminalRestoreResultSchema,
      error: WorkerTerminalCreateErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
  });

/** The most output one `history.read` page returns. */
export const WORKER_TERMINAL_RECORD_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
/** The most output one `output.append` op carries. */
export const WORKER_TERMINAL_RECORD_TEXT_MAX_CHARS = 1024 * 1024;
/** The most ops one `apply` carries; a producer splits larger batches. */
export const WORKER_TERMINAL_RECORD_MAX_OPS = 512;
/** The response key `<producerId>/<runId>`; each component escapes `%` and `/`. */
export const WORKER_TERMINAL_RECORD_WATERMARK_KEY_MAX_LENGTH = 1024;
const SCROLLBACK_MAX_LINES = 5000;
const CUSTOM_NAME_MAX_LENGTH = 64;
/** Zod's record parser omits __proto__; terminal IDs are opaque dictionary keys. */
function terminalNames(
  valueSchema: z.ZodString,
): z.ZodType<Record<string, string>> {
  const shape = z.toJSONSchema(z.record(STORED_TERMINAL_ID, valueSchema));
  return z
    .unknown()
    .transform((value, ctx): Record<string, string> => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Expected terminal names dictionary',
        });
        return z.NEVER;
      }
      const entries: [string, string][] = [];
      for (const [key, entry] of Object.entries(value)) {
        const name = valueSchema.safeParse(entry);
        if (!STORED_TERMINAL_ID.safeParse(key).success || !name.success) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Invalid terminal name',
          });
          return z.NEVER;
        }
        entries.push([key, name.data]);
      }
      return Object.fromEntries(entries);
    })
    .meta({
      type: shape.type,
      propertyNames: shape.propertyNames,
      additionalProperties: shape.additionalProperties,
    });
}
const NAMES = terminalNames(z.string().max(CUSTOM_NAME_MAX_LENGTH));

export const WorkerTerminalRecordBindingSchema = z.strictObject({
  key: ID,
  groupId: ID,
  members: z
    .array(z.strictObject({ key: ID, terminalId: STORED_TERMINAL_ID }))
    .max(SCROLLBACK_MAX_LINES),
});

export type WorkerTerminalRecordBinding = z.output<
  typeof WorkerTerminalRecordBindingSchema
>;

const EXIT_CODE = z.number().int().nullable();
const EXIT_SIGNAL = z.string().max(256).nullable();

/** One change to a worktree's record, as an in-process producer reports it. */
export const WorkerTerminalRecordOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('session.upsert'),
    session: WorkerTerminalRecordSessionSchema,
  }),
  z.strictObject({
    op: z.literal('output.append'),
    terminalId: STORED_TERMINAL_ID,
    text: z.string().max(WORKER_TERMINAL_RECORD_TEXT_MAX_CHARS),
  }),
  /** The terminal's whole retained output, newest last. */
  z.strictObject({
    op: z.literal('output.replace'),
    terminalId: STORED_TERMINAL_ID,
    lines: z
      .array(z.string().max(WORKER_TERMINAL_RECORD_TEXT_MAX_CHARS))
      .max(SCROLLBACK_MAX_LINES),
  }),
  z.strictObject({
    op: z.literal('exit'),
    terminalId: STORED_TERMINAL_ID,
    exitCode: EXIT_CODE,
    signal: EXIT_SIGNAL,
  }),
  z.strictObject({ op: z.literal('forget'), terminalId: STORED_TERMINAL_ID }),
  z.strictObject({
    op: z.literal('rename'),
    terminalId: STORED_TERMINAL_ID,
    name: z.string().max(CUSTOM_NAME_MAX_LENGTH).nullable(),
  }),
  /**
   * A drawer layout save. The record forgets only terminals the client was
   * served and no longer references; terminals created since are kept.
   */
  z.strictObject({
    op: z.literal('layout.save'),
    servedIds: z.array(STORED_TERMINAL_ID).max(4096),
    referencedIds: z.array(STORED_TERMINAL_ID).max(4096),
    bindings: z.array(WorkerTerminalRecordBindingSchema).max(4096),
    terminalCustomNames: NAMES,
  }),
]);

export type WorkerTerminalRecordOp = z.output<
  typeof WorkerTerminalRecordOpSchema
>;

export const WorkerTerminalRecordOpenParamsSchema = z.strictObject({
  client: WorkerTerminalRecordClientSchema,
});

export type WorkerTerminalRecordOpenParams = z.output<
  typeof WorkerTerminalRecordOpenParamsSchema
>;

export const WORKER_TERMINAL_RECORD_IMPORT_SOURCES = [
  'none',
  'v1',
  'v2',
  'damaged',
  'newer',
  'fenced',
] as const;

export const WorkerTerminalRecordEntrySchema = z
  .object({
    session: WorkerTerminalRecordStoredSessionSchema,
    exitCode: EXIT_CODE,
    signal: EXIT_SIGNAL,
    historyBytes: z.number().int().min(0),
    historyRevision: z.number().int().min(0),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalRecordEntry = z.output<
  typeof WorkerTerminalRecordEntrySchema
>;

/** The record without output; `history.read` pages each terminal's output. */
export const WorkerTerminalRecordOpenResultSchema = z
  .object({
    generation: z.number().int().min(1),
    lineage: ID,
    revision: z.number().int().min(0),
    // Read back as stored, as sessions are: legacy imports hold any lengths.
    bindings: z.array(
      z.object({
        key: z.string(),
        groupId: z.string(),
        members: z.array(
          z.object({ key: z.string(), terminalId: STORED_TERMINAL_ID }),
        ),
      }),
    ),
    terminalCustomNames: terminalNames(z.string()),
    terminals: z.array(WorkerTerminalRecordEntrySchema),
    import: z
      .object({
        from: z.enum(WORKER_TERMINAL_RECORD_IMPORT_SOURCES),
        sourceSha256: z.string().max(128).nullable(),
        /**
         * Import is incomplete, recovery durability is unconfirmed, or the
         * open was stale and confirmed nothing. A reader shows the visible
         * record but never fences legacy state until a later current open
         * confirms the import's durability.
         */
        pending: z.boolean().optional(),
      })
      .catchall(CanopyJsonValueSchema),
    /**
     * The last batch the record holds from each producer run
     * (`<producerId>/<runId>`, escaping `%` as `%25` and `/` as `%2F` within
     * each component). Only durable batches appear here: this map permits
     * replay-copy release, not overlay selection for an unconfirmed snapshot.
     */
    producerWatermarks: z
      .record(
        z.string().min(1).max(WORKER_TERMINAL_RECORD_WATERMARK_KEY_MAX_LENGTH),
        z.number().int().min(0),
      )
      .optional(),
    /**
     * Batches reflected in the served snapshot, even before durability is
     * confirmed. Overlay only later batches; never release replay copies
     * using this map. Keys use the same escaping as producerWatermarks.
     */
    snapshotProducerWatermarks: z
      .record(
        z.string().min(1).max(WORKER_TERMINAL_RECORD_WATERMARK_KEY_MAX_LENGTH),
        z.number().int().min(0),
      )
      .optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalRecordOpenResult = z.output<
  typeof WorkerTerminalRecordOpenResultSchema
>;

export const WorkerTerminalRecordHistoryReadParamsSchema = z.strictObject({
  client: WorkerTerminalRecordClientSchema,
  terminalId: STORED_TERMINAL_ID,
  /**
   * Which of the terminal's entries, in record order, when an imported
   * legacy record holds its id more than once; the first when omitted.
   */
  occurrence: z.number().int().min(0).max(4096).optional(),
  /** Restarts from the first page when the history changed since. */
  historyRevision: z.number().int().min(0).optional(),
  cursor: z.string().min(1).max(64).optional(),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(WORKER_TERMINAL_RECORD_HISTORY_MAX_BYTES)
    .optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export type WorkerTerminalRecordHistoryReadParams = z.output<
  typeof WorkerTerminalRecordHistoryReadParamsSchema
>;

export const WorkerTerminalRecordHistoryReadResultSchema = z
  .object({
    text: z.string(),
    nextCursor: z.string().max(64).nullable(),
    historyRevision: z.number().int().min(0),
    /** The page restarted at the beginning: the history changed meanwhile. */
    restarted: z.boolean(),
    /** Durably published batches; permits replay-copy release only. */
    producerWatermarks: z
      .record(
        z.string().min(1).max(WORKER_TERMINAL_RECORD_WATERMARK_KEY_MAX_LENGTH),
        z.number().int().min(0),
      )
      .optional(),
    /**
     * Batches reflected in this page's snapshot, including unconfirmed effects.
     * Suppress their overlays but retain replay copies until acknowledged.
     */
    snapshotProducerWatermarks: z
      .record(
        z.string().min(1).max(WORKER_TERMINAL_RECORD_WATERMARK_KEY_MAX_LENGTH),
        z.number().int().min(0),
      )
      .optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalRecordHistoryReadResult = z.output<
  typeof WorkerTerminalRecordHistoryReadResultSchema
>;

export const WorkerTerminalRecordApplyParamsSchema = z.strictObject({
  client: WorkerTerminalRecordClientSchema,
  producer: z.strictObject({ id: ID, runId: ID }),
  /** Per producer run, increasing; at most once under the record's watermark. */
  seq: z.number().int().min(1),
  /** The record generation the producer last saw; older ones are dropped. */
  generation: z.number().int().min(1).optional(),
  /** The producer run ended under this reason: its terminals have exited. */
  sealed: z.strictObject({ reason: WorkerTerminalExitSignalSchema }).optional(),
  ops: z
    .array(WorkerTerminalRecordOpSchema)
    .max(WORKER_TERMINAL_RECORD_MAX_OPS),
});

export type WorkerTerminalRecordApplyParams = z.output<
  typeof WorkerTerminalRecordApplyParamsSchema
>;

export const WorkerTerminalRecordApplyResultSchema = z
  .object({
    outcome: z.enum(['applied', 'duplicate', 'dropped']),
    revision: z.number().int().min(0),
    generation: z.number().int().min(1),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalRecordApplyResult = z.output<
  typeof WorkerTerminalRecordApplyResultSchema
>;

export const WorkerTerminalRecordShutdownParamsSchema = z.strictObject({
  signal: z.enum(['app-quit', 'fatal-exit']),
});

export type WorkerTerminalRecordShutdownParams = z.output<
  typeof WorkerTerminalRecordShutdownParamsSchema
>;

export const WorkerTerminalRecordShutdownResultSchema = z
  .object({ stamped: z.number().int().min(0) })
  .catchall(CanopyJsonValueSchema);

export const WorkerTerminalRecordRetireParamsSchema = z
  .strictObject({
    projectId: ID,
    /** Producer lifetimes being retired, including requests not yet admitted. */
    lifetimeIds: z.array(z.string().min(1).max(512)).optional(),
    /** Worktrees to retire, including those whose first write is still pending. */
    worktreeIds: z.array(ID).optional(),
    /**
     * A worktree to retire, alongside any `worktreeIds`. A cutoff request
     * naming no worktree retires the project's worktree records on disk that
     * started before `requestedAt` (CAN-7704).
     */
    worktreeId: ID.optional(),
    /**
     * Also retires the project's worktree records on disk that started before
     * `requestedAt`, as a request naming no worktree does; named `worktreeIds`
     * stay retired as named. Without it, named worktrees are the whole set.
     */
    projectWide: z.literal(true).optional(),
    /** Narrows a retirement selector to this incarnation, when both are known. */
    incarnation: z.string().min(1).max(512).nullable().optional(),
    /**
     * Retires only a record of this generation or older: one a reused
     * worktree id started since is left alone.
     */
    generation: z.number().int().min(1).optional(),
    /**
     * Legacy fallback when identities or generation cannot identify the record:
     * a record started after this request is left alone.
     */
    requestedAt: z.number().int().min(0).optional(),
  })
  .refine(
    (params) =>
      params.generation !== undefined ||
      (params.lifetimeIds?.length ?? 0) > 0 ||
      params.requestedAt !== undefined,
    {
      message:
        'Retirement requires a generation, non-empty lifetimeIds, or requestedAt.',
    },
  )
  .refine(
    (params) =>
      params.projectWide === undefined ||
      (params.requestedAt !== undefined && params.worktreeId === undefined),
    {
      message:
        'A project-wide retirement requires requestedAt and names no worktreeId.',
    },
  );

export type WorkerTerminalRecordRetireParams = z.output<
  typeof WorkerTerminalRecordRetireParamsSchema
>;

export const WorkerTerminalRecordRetireResultSchema = z
  .object({ retired: z.number().int().min(0) })
  .catchall(CanopyJsonValueSchema);

// Daemon only, composed only by its terminal module: the record is the local
// daemon's custody, never a selectable target, and the web core and the
// desktop dispatcher serve none of it.
const RECORD = { ...BASE, placement: 'worker-only' } as const;

export const WORKER_TERMINAL_RECORD_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('worker', {
    'worker.terminal.record.history.read': defineCanopyQuery({
      ...RECORD,
      params: WorkerTerminalRecordHistoryReadParamsSchema,
      result: WorkerTerminalRecordHistoryReadResultSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.read],
    }),
  });

export const WORKER_TERMINAL_RECORD_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.terminal.record.open': defineCanopyInstruction({
      ...RECORD,
      params: WorkerTerminalRecordOpenParamsSchema,
      result: WorkerTerminalRecordOpenResultSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.record.apply': defineCanopyInstruction({
      ...RECORD,
      params: WorkerTerminalRecordApplyParamsSchema,
      result: WorkerTerminalRecordApplyResultSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.record.shutdown': defineCanopyInstruction({
      ...RECORD,
      params: WorkerTerminalRecordShutdownParamsSchema,
      result: WorkerTerminalRecordShutdownResultSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.record.retire': defineCanopyInstruction({
      ...RECORD,
      params: WorkerTerminalRecordRetireParamsSchema,
      result: WorkerTerminalRecordRetireResultSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
  });

export const WORKER_TERMINAL_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'worker',
  {
    'worker.terminal.attach': defineCanopyStream({
      ...BASE,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.read],
      params: WorkerTerminalAttachParamsSchema,
      openResult: WorkerTerminalAttachOpenResultSchema,
      item: WorkerTerminalAttachItemSchema,
      end: WorkerTerminalAttachEndSchema,
      error: WorkerTerminalAttachErrorSchema,
    }),
  },
);
