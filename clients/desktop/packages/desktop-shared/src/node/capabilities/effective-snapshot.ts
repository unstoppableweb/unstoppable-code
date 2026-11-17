import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  ListToolsResultSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { selectionEntryIds } from '@canopy/protocol/canopy-core';

/*
 * Effective capability snapshot (CAN-6684, CAP-09): what one harness turn
 * was actually given, persisted content-addressed and bound to the native
 * conversation it ran in.
 *
 * It is evidence, never authorization. A reader that inherits from it, such
 * as a delegated child or a resumed pipeline step, must re-derive and recheck
 * its own grants, revocation and owner at execution time. It stores entry
 * ids, digests and tool schemas only: no URLs, bearer tokens, environment
 * values, file contents or credentials.
 */

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_BINDING_BYTES = 4096;
const DIGEST = /^[a-f0-9]{64}$/;

export const EFFECTIVE_CAPABILITY_SNAPSHOT_VERSION = 1;

/** Where a selected entry came from. */
export type EffectiveCapabilityOrigin = 'chat' | 'default';

export interface EffectiveCapabilitySelections {
  /** The chat's own selections, as catalog entry ids. */
  readonly chat: readonly string[];
  /** Every entry the turn resolved: chat ∪ inherited defaults − opt-outs. */
  readonly effective: readonly {
    readonly entryId: string;
    readonly origin: EffectiveCapabilityOrigin;
  }[];
  /** Defaults the chat turned off. */
  readonly optedOut: readonly string[];
  /** A workflow package overlay applied to the turn, by digest. */
  readonly packageOverlayDigest: string | null;
}

/** Which app capabilities the turn's route advertised, after every gate. */
export interface EffectiveCapabilityGrants {
  readonly toolSurface: string;
  /** Canonical injected tool keys the route could list. */
  readonly appTools: readonly string[];
  readonly codeGraph: boolean;
  readonly feed: boolean;
  readonly deferredTools: boolean;
  readonly delegation: boolean;
  readonly planMode: boolean;
  readonly approvalMode: string;
  /** Children never inherit the parent's selections automatically. */
  readonly childInheritance: 'none';
}

export interface EffectiveCapabilityContent {
  /** Skills whose text was delivered, by projection id. */
  readonly skills: readonly string[];
  /** Commands the turn could expand, by projection id. */
  readonly commands: readonly string[];
  /** sha256 of each delivered private copy, keyed by relative path. */
  readonly files: Readonly<Record<string, string>>;
  /** sha256 over the delivered instructions and copies. */
  readonly fingerprint: string;
}

export interface EffectiveCapabilityMcpServer {
  readonly name: string;
  readonly role: 'app' | 'selected';
  readonly transport: 'http' | 'stdio';
  /** Catalog entry id, or a digest of the non-secret definition. */
  readonly identity: string;
  /** The listed tools, or null when discovery failed. */
  readonly tools: readonly Tool[] | null;
  readonly unavailable?: string;
}

export interface EffectiveCapabilityOmission {
  /** What was not delivered: a facet (hooks, agents) or a named entry. */
  readonly subject: string;
  readonly reason: string;
}

export interface EffectiveCapabilitySnapshot {
  readonly version: typeof EFFECTIVE_CAPABILITY_SNAPSHOT_VERSION;
  readonly harness: string;
  readonly runtimeVersion: string;
  readonly selections: EffectiveCapabilitySelections;
  readonly grants: EffectiveCapabilityGrants;
  readonly content: EffectiveCapabilityContent;
  readonly mcp: readonly EffectiveCapabilityMcpServer[];
  readonly omitted: readonly EffectiveCapabilityOmission[];
  /** False when any MCP catalog could not be read: never inherit from it. */
  readonly complete: boolean;
}

/** Binds a snapshot to one native conversation. */
export interface EffectiveCapabilityBinding {
  readonly version: 1;
  readonly harness: string;
  readonly nativeSessionId: string;
  readonly digest: string;
  /**
   * Starts at 1; increments when the bound digest changes. A digest also
   * changes when evidence is incomplete (a server's tools/list timed out), so
   * a generation change alone is not a capability change: readers load the
   * bound snapshot, require its `complete`, and compare digests of complete
   * snapshots before relying on one.
   */
  readonly generation: number;
  /**
   * The digest this generation replaced. It may name an incomplete snapshot,
   * so it is not necessarily the last complete one.
   */
  readonly previousDigest: string | null;
  /**
   * True when this binding replaced a damaged or unreadable one, so a reader
   * can tell the reset from a new conversation.
   */
  readonly reset?: true;
}

interface SelectionRefs {
  collectionIds?: readonly string[];
  skillRefs?: readonly { sourceId: string; skillName: string }[];
  pluginRefs?: readonly { marketplaceId: string; pluginName: string }[];
  mcpServerRefs?: readonly { serverId: string; configId: string }[];
}

function ids(value: SelectionRefs | null | undefined): string[] {
  return selectionEntryIds({
    collectionIds: [...(value?.collectionIds ?? [])],
    skillRefs: [...(value?.skillRefs ?? [])],
    pluginRefs: [...(value?.pluginRefs ?? [])],
    mcpServerRefs: [...(value?.mcpServerRefs ?? [])],
  });
}

/** The exact selection layers, as catalog entry ids. */
export function effectiveCapabilitySelections(input: {
  chat: SelectionRefs | null | undefined;
  effective: SelectionRefs | null | undefined;
  optedOut: SelectionRefs | null | undefined;
  packageOverlay: unknown;
}): EffectiveCapabilitySelections {
  const chat = ids(input.chat);
  const own = new Set(chat);
  return {
    chat,
    effective: ids(input.effective).map((entryId) => ({
      entryId,
      origin: own.has(entryId) ? 'chat' : 'default',
    })),
    optedOut: ids(input.optedOut),
    packageOverlayDigest:
      input.packageOverlay === undefined || input.packageOverlay === null
        ? null
        : effectiveCapabilityDigest(input.packageOverlay),
  };
}

/** Canonical JSON: array order kept, record keys sorted, non-JSON refused. */
export function canonicalEffectiveCapability(
  value: unknown,
  depth = 0,
): string {
  if (depth > 64) throw new Error('Capability snapshot is too deeply nested.');
  if (value === null || value === undefined) return 'null';
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalEffectiveCapability(item, depth + 1)).join(',')}]`;
  if (typeof value !== 'object')
    throw new Error('Capability snapshot contains unsupported data.');
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalEffectiveCapability(item, depth + 1)}`,
    )
    .join(',')}}`;
}

export function effectiveCapabilityDigest(value: unknown): string {
  const text = canonicalEffectiveCapability(value);
  if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES)
    throw new Error('Capability snapshot exceeds the size limit.');
  return createHash('sha256').update(text).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function bindingName(harness: string, nativeSessionId: string): string {
  return `${effectiveCapabilityDigest({ harness, nativeSessionId })}.json`;
}

async function atomicJson(
  directory: string,
  name: string,
  value: unknown,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Capability snapshot storage is invalid.');
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, canonicalEffectiveCapability(value), {
      mode: 0o600,
      flag: 'wx',
    });
    signal.throwIfAborted();
    await rename(temporary, join(directory, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readBounded(
  file: string,
  limit: number,
): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
      throw new Error('Capability snapshot record is invalid.');
    return await readFile(file, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function parseBinding(
  text: string,
  harness: string,
  nativeSessionId: string,
): EffectiveCapabilityBinding {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.harness !== harness ||
    value.nativeSessionId !== nativeSessionId ||
    typeof value.digest !== 'string' ||
    !DIGEST.test(value.digest) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !(
      value.previousDigest === null ||
      (typeof value.previousDigest === 'string' &&
        DIGEST.test(value.previousDigest))
    ) ||
    (value.reset !== undefined && value.reset !== true)
  )
    throw new Error('Capability snapshot binding is invalid.');
  return {
    version: 1,
    harness,
    nativeSessionId,
    digest: value.digest,
    generation: value.generation,
    previousDigest: value.previousDigest,
    ...(value.reset === true ? { reset: true } : {}),
  };
}

/** The binding and verified snapshot for a native conversation, if any. */
export async function readEffectiveCapabilitySnapshot(
  root: string,
  harness: string,
  nativeSessionId: string,
): Promise<
  | {
      binding: EffectiveCapabilityBinding;
      snapshot: EffectiveCapabilitySnapshot;
    }
  | undefined
> {
  const bindingText = await readBounded(
    join(root, 'capability-bindings', bindingName(harness, nativeSessionId)),
    MAX_BINDING_BYTES,
  );
  if (bindingText === undefined) return undefined;
  const binding = parseBinding(bindingText, harness, nativeSessionId);
  const text = await readBounded(
    join(root, 'capability-snapshots', `${binding.digest}.json`),
    MAX_SNAPSHOT_BYTES,
  );
  if (text === undefined)
    throw new Error('Capability snapshot is missing for its binding.');
  const raw: unknown = JSON.parse(text);
  // Verify content against its address before any reader trusts it.
  if (effectiveCapabilityDigest(raw) !== binding.digest)
    throw new Error('Capability snapshot changed on disk.');
  const snapshot = parseEffectiveCapabilitySnapshot(raw);
  if (snapshot.harness !== harness)
    throw new Error('Capability snapshot belongs to another harness.');
  return { binding, snapshot };
}

const IdsSchema = z.array(z.string().min(1).max(1024)).max(4096);
const SnapshotSchema = z.strictObject({
  version: z.literal(EFFECTIVE_CAPABILITY_SNAPSHOT_VERSION),
  harness: z.string().min(1).max(64),
  runtimeVersion: z.string().max(128),
  selections: z.strictObject({
    chat: IdsSchema,
    effective: z
      .array(
        z.strictObject({
          entryId: z.string().min(1).max(1024),
          origin: z.enum(['chat', 'default']),
        }),
      )
      .max(4096),
    optedOut: IdsSchema,
    packageOverlayDigest: z.string().regex(DIGEST).nullable(),
  }),
  grants: z.strictObject({
    toolSurface: z.string().max(128),
    appTools: IdsSchema,
    codeGraph: z.boolean(),
    feed: z.boolean(),
    deferredTools: z.boolean(),
    delegation: z.boolean(),
    planMode: z.boolean(),
    approvalMode: z.string().max(64),
    childInheritance: z.literal('none'),
  }),
  content: z.strictObject({
    skills: IdsSchema,
    commands: IdsSchema,
    files: z.record(z.string().max(4096), z.string().regex(DIGEST)),
    fingerprint: z.string().regex(DIGEST),
  }),
  mcp: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(256),
        role: z.enum(['app', 'selected']),
        transport: z.enum(['http', 'stdio']),
        identity: z.string().min(1).max(1024),
        tools: z.array(z.unknown()).max(5000).nullable(),
        unavailable: z.string().max(1024).optional(),
      }),
    )
    .max(64),
  omitted: z
    .array(
      z.strictObject({
        subject: z.string().max(1024),
        reason: z.string().max(4096),
      }),
    )
    .max(4096),
  complete: z.boolean(),
});

/** Validate a persisted snapshot, including each MCP tool against the SDK schema. */
export function parseEffectiveCapabilitySnapshot(
  value: unknown,
): EffectiveCapabilitySnapshot {
  const parsed = SnapshotSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('Capability snapshot version is unavailable.');
  const mcp = parsed.data.mcp.map((server): EffectiveCapabilityMcpServer => {
    if (server.tools === null) return { ...server, tools: null };
    const tools = ListToolsResultSchema.safeParse({ tools: server.tools });
    if (!tools.success)
      throw new Error('Capability snapshot MCP tools are invalid.');
    return { ...server, tools: tools.data.tools };
  });
  return { ...parsed.data, mcp };
}

/**
 * Persist a turn's snapshot and bind it to its native conversation. The
 * generation advances only when the digest changes. A repeated turn with the
 * same complete evidence keeps its generation; a reader that needs to know
 * whether capabilities changed compares the digests of complete snapshots.
 */
export function saveEffectiveCapabilitySnapshot(
  root: string,
  nativeSessionId: string,
  snapshot: EffectiveCapabilitySnapshot,
  signal: AbortSignal,
): Promise<EffectiveCapabilityBinding> {
  if (!nativeSessionId)
    return Promise.reject(
      new Error('A capability snapshot needs a native conversation.'),
    );
  // One writer at a time per binding: a deferred restart can overlap the
  // turn it replaced, and both must not derive the same next generation.
  const key = `${root}\0${bindingName(snapshot.harness, nativeSessionId)}`;
  const previousSave = pendingSaves.get(key) ?? Promise.resolve();
  const save = previousSave
    .catch(() => undefined)
    .then(() => writeSnapshot(root, nativeSessionId, snapshot, signal));
  const settled = save.then(
    () => undefined,
    () => undefined,
  );
  pendingSaves.set(key, settled);
  void settled.then(() => {
    if (pendingSaves.get(key) === settled) pendingSaves.delete(key);
  });
  return save;
}

const pendingSaves = new Map<string, Promise<void>>();

async function writeSnapshot(
  root: string,
  nativeSessionId: string,
  snapshot: EffectiveCapabilitySnapshot,
  signal: AbortSignal,
): Promise<EffectiveCapabilityBinding> {
  // Never persist a record this module's reader would reject.
  parseEffectiveCapabilitySnapshot(
    JSON.parse(canonicalEffectiveCapability(snapshot)),
  );
  const digest = effectiveCapabilityDigest(snapshot);
  let previous: EffectiveCapabilityBinding | undefined;
  let reset = false;
  try {
    // Only the binding is needed; readers verify the snapshot it names.
    const text = await readBounded(
      join(
        root,
        'capability-bindings',
        bindingName(snapshot.harness, nativeSessionId),
      ),
      MAX_BINDING_BYTES,
    );
    previous =
      text === undefined
        ? undefined
        : parseBinding(text, snapshot.harness, nativeSessionId);
  } catch {
    // A damaged record is replaced: the new turn's snapshot is the evidence,
    // and the binding says it restarted the generation count.
    previous = undefined;
    reset = true;
  }
  const changed = previous?.digest !== digest;
  const binding: EffectiveCapabilityBinding = {
    version: 1,
    harness: snapshot.harness,
    nativeSessionId,
    digest,
    generation: previous ? previous.generation + Number(changed) : 1,
    previousDigest: previous
      ? changed
        ? previous.digest
        : previous.previousDigest
      : null,
    ...(reset || (previous?.reset === true && !changed) ? { reset: true } : {}),
  };
  await atomicJson(
    join(root, 'capability-snapshots'),
    `${digest}.json`,
    snapshot,
    signal,
  );
  await atomicJson(
    join(root, 'capability-bindings'),
    bindingName(snapshot.harness, nativeSessionId),
    binding,
    signal,
  );
  return binding;
}
