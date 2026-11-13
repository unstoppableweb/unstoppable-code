// ---------------------------------------------------------------------------
// Capability bundle — wire contract (protocol layer).
//
// One contract that BOTH desktop and cloud consume: user capability
// selections (collections / skills / plugins / MCP servers) are resolved by a
// producer into an immutable, digested bundle, and the harness runtime
// consumes that bundle verbatim. The pipeline is always:
//
//   selections  →  CapabilityBundleV1 (immutable, digested)  →  harness runtime
//
// The bundle maps selections onto the AI SDK HarnessAgent surface:
//   - `skills` are structurally identical to `HarnessV1Skill`, so runners
//     pass them through unmodified.
//   - `mcpServers` are http-only with PROXIED URLs; provider tokens never
//     enter the bundle, so a bundle is secret-free by construction.
//   - `fileTrees` carry content-addressed manifests for plugin trees that do
//     not reduce to skills/MCP; the runtime materializes them in the sandbox.
//
// Dependency-direction rule: this module depends only on pure protocol file
// primitives, so every consumer can use it without pulling in zod, Node
// built-ins, Prisma, or application modules.
// Where a shape mirrors another module (the provenance snapshot mirrors
// `PortalChatTabPluginSelections` in `packages/protocol/src/portal`), the
// fields are declared inline with a doc comment naming the source.
// ---------------------------------------------------------------------------

import {
  isTryItCapabilityArray,
  normalizeTryItCapabilities,
  type TryItCapability,
} from '../try-it';
import {
  CAPABILITY_FILE_SHA256_PATTERN,
  isPortableCapabilityPathSegment,
  isSafeCapabilityRelativePath,
} from '../capability-files';

/**
 * Wire version of the capability bundle contract. Bump only on breaking shape
 * changes; additive optional fields do not require a bump.
 */
export const CAPABILITY_BUNDLE_API_VERSION = 1;

/**
 * Skill names accepted by the harness SDK. Mirrors the Claude Agent SDK's
 * skill-name check exactly (`/^[A-Za-z0-9._-]+$/`), which means `/` is
 * forbidden: plugin-namespaced names must be pre-flattened by producers
 * before they enter a bundle. `.` and `..` pass this regex but are rejected
 * separately by {@link validateCapabilityBundle}.
 */
export const CAPABILITY_BUNDLE_SKILL_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Reserved skill name. Runners write a digest sentinel alongside the
 * materialized skills; a skill claiming this name would shadow that sentinel's
 * path, so it is rejected at production time rather than failing during
 * materialization.
 */
export const CAPABILITY_BUNDLE_RESERVED_SKILL_NAME =
  '.capability-bundle-digest';

/** Fallback used when sanitization leaves no valid bundle skill name. */
const FALLBACK_CAPABILITY_SKILL_NAME = 'skill';

/** Ordered input to {@link resolveCapabilitySkillNames}. */
export interface CapabilitySkillNameDraft {
  preferredName: string;
}

/**
 * Flattens a preferred skill name to the harness-safe bundle charset. Every
 * invalid character becomes `-`; empty and dot-only names use a stable
 * fallback because `.` and `..` are invalid materialization paths.
 */
export function sanitizeCapabilitySkillName(name: string): string {
  const flattened = name.replace(/[^A-Za-z0-9._-]/g, '-');
  if (
    flattened.length === 0 ||
    flattened === '.' ||
    flattened === '..' ||
    // Skill names are user-controlled, and bundle validation is all-or-nothing:
    // letting the reserved name reach the validator would fail the WHOLE
    // bundle over one skill, dropping every other skill, instruction, and MCP
    // server for that chat. Collapse it here so the validator branch stays
    // defense-in-depth for externally supplied bundles only. Note the flatten
    // above can CREATE the reserved name (`.capability bundle digest`), so
    // this check must come after it.
    flattened.toLowerCase() === CAPABILITY_BUNDLE_RESERVED_SKILL_NAME ||
    !CAPABILITY_BUNDLE_SKILL_NAME_PATTERN.test(flattened)
  ) {
    return FALLBACK_CAPABILITY_SKILL_NAME;
  }
  return flattened;
}

/**
 * Incremental variant of {@link resolveCapabilitySkillNames}: an allocator
 * over one growing set of taken names. `claim` resolves AND reserves the next
 * name; `preview` resolves the name a draft WOULD get without reserving it,
 * so a menu can show, for each candidate row independently, the exact name it
 * would receive if appended to the already-claimed selection.
 *
 * This is the single home of the sanitize+suffix algorithm —
 * {@link resolveCapabilitySkillNames} is implemented on top of it so bundle
 * producers and name-previewing menus cannot drift.
 */
export interface CapabilitySkillNameAllocator {
  /** Resolves and reserves the final name for the next draft in order. */
  claim(preferredName: string): string;
  /** Resolves the name the draft would get next, without reserving it. */
  preview(preferredName: string): string;
}

/** Creates an empty {@link CapabilitySkillNameAllocator}. */
export function createCapabilitySkillNameAllocator(): CapabilitySkillNameAllocator {
  const used = new Set<string>();
  const resolve = (preferredName: string): string => {
    const base = sanitizeCapabilitySkillName(preferredName);
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) {
      name = `${base}-${String(suffix)}`;
    }
    return name;
  };
  return {
    claim(preferredName: string): string {
      const name = resolve(preferredName);
      used.add(name);
      return name;
    },
    preview: resolve,
  };
}

/**
 * Resolves final bundle skill names in stable input order. Sanitized
 * collisions receive `-2`, `-3`, … suffixes, matching bundle production and
 * every menu that previews the resulting invocation name.
 */
export function resolveCapabilitySkillNames(
  drafts: readonly CapabilitySkillNameDraft[],
): string[] {
  const allocator = createCapabilitySkillNameAllocator();
  return drafts.map((draft) => allocator.claim(draft.preferredName));
}

/**
 * MCP server name reserved by the harness bridge for its own tool transport.
 * A bundle must never declare a server with this name.
 */
export const CAPABILITY_BUNDLE_RESERVED_MCP_SERVER_NAME = 'harness-tools';

/**
 * Filename of the skill entrypoint every harness adapter generates from
 * `skill.name`/`description`/`content` at the skill directory root. Supporting
 * files materialize NEXT TO it, so no `skill.files[].path` may collide with
 * this name (compared casefolded — adapters materialize onto case-insensitive
 * filesystems too); {@link validateCapabilityBundle} enforces that.
 */
export const CAPABILITY_BUNDLE_SKILL_ENTRYPOINT_FILENAME = 'SKILL.md';

/**
 * Lowercase hex sha256 required for file-tree entry hashes. Enforced
 * structurally by {@link isCapabilityBundleFileTreeEntry} so a malformed
 * digest fails fast at the protocol boundary instead of surfacing later as an
 * opaque content-addressed blob lookup miss at bootstrap.
 */
export const CAPABILITY_BUNDLE_SHA256_PATTERN = CAPABILITY_FILE_SHA256_PATTERN;

/**
 * Maximum number of content-addressed file entries across every tree in one
 * bundle. The byte cap alone does not bound work for many empty or tiny files;
 * this ceiling also bounds blob reconciliation and sandbox filesystem writes.
 */
export const CAPABILITY_BUNDLE_MAX_FILE_TREE_ENTRIES = 1024;

/** Maximum number of MCP servers in one bundle. */
export const CAPABILITY_BUNDLE_MAX_MCP_SERVERS = 16;

/** One supporting file shipped alongside a bundled skill. */
export interface CapabilityBundleSkillFile {
  /**
   * Relative POSIX path under the skill directory. No `..`, no leading `/`,
   * and no collision with the generated
   * {@link CAPABILITY_BUNDLE_SKILL_ENTRYPOINT_FILENAME} entrypoint or with
   * another file of the same skill.
   */
  path: string;
  content: string;
}

/**
 * One skill in the bundle. Structurally identical to the AI SDK's
 * `HarnessV1Skill` (`{ name, description, content, files? }`) so runners pass
 * skills through to the harness unmodified.
 *
 * `content` is the COMPLETE `SKILL.md` document, not just the body: producers
 * send the stored file verbatim so any extra frontmatter of the source skill
 * survives. `name` and `description` remain authoritative for addressing —
 * consumers materialize `content` as-is but normalize its frontmatter `name`
 * (and a blank `description`) to these fields, so the name a runner discovers
 * always matches the name the UI advertises for invocation.
 */
export interface CapabilityBundleSkill {
  /** Harness-safe name; see {@link CAPABILITY_BUNDLE_SKILL_NAME_PATTERN}. */
  name: string;
  description: string;
  content: string;
  files?: CapabilityBundleSkillFile[];
}

/**
 * One MCP server in the bundle. Http-only and PROXIED URLs only — the URL
 * points at a Canopy-operated proxy, and `headers` never carry provider
 * tokens, so the bundle stays secret-free by construction.
 * {@link validateCapabilityBundle} enforces the secret-free half of that
 * contract by rejecting credential-bearing header names unconditionally; the
 * proxy-only half is enforced when the producer passes its
 * {@link CapabilityBundleValidationPolicy.allowedMcpOrigins} policy, which
 * producers MUST do (this dependency-free module cannot hardcode
 * environment-specific proxy origins). Per-harness native formats are
 * derived by the projection helpers below.
 */
export interface CapabilityBundleMcpServer {
  /** Unique within the bundle; `harness-tools` is reserved and rejected. */
  name: string;
  /** http(s) endpoint of the proxied server. */
  url: string;
  /** Non-secret transport headers (e.g. a proxy session id). */
  headers?: Record<string, string>;
  /** Human-readable label, such as "Linear". */
  displayName?: string;
  /** Informative tool allow-list; enforcement belongs to consumers. */
  enabledTools?: string[];
}

/** One file entry of a content-addressed plugin tree manifest. */
export interface CapabilityBundleFileTreeEntry {
  /**
   * Relative POSIX path under {@link CapabilityBundleFileTree.root}. No `..`,
   * no leading `/`.
   */
  path: string;
  /**
   * Lowercase hex sha256 of the file content; must match
   * {@link CAPABILITY_BUNDLE_SHA256_PATTERN}.
   */
  sha256: string;
  /** File size in bytes. */
  size: number;
}

/**
 * Content-addressed manifest for a plugin tree that does not reduce to
 * skills/MCP entries. The bundle carries only the manifest; the runtime
 * fetches the blobs and materializes the tree into the sandbox at bootstrap
 * (the bundle digest doubles as the bootstrap hash).
 */
export interface CapabilityBundleFileTree {
  /**
   * Sandbox-relative root directory the entries materialize under. Relative
   * POSIX; no `..`, no leading `/`.
   */
  root: string;
  entries: CapabilityBundleFileTreeEntry[];
}

/**
 * Where a session's synced memory files materialize; mirrors
 * `MEMORY_CLOUD_SESSION_FILE_TREE_ROOT` in `@canopy/protocol/memory-sync`.
 */
export const CAPABILITY_BUNDLE_MEMORY_TREE_ROOT = '.canopy/memory';

/**
 * A session's synced memory (CAN-5193). Mirrors `MemoryCloudSessionPayload`
 * in `@canopy/protocol/memory-sync` structurally; that module's schema is
 * the strict reader. Its files are the entries of exactly one file tree
 * rooted at {@link CAPABILITY_BUNDLE_MEMORY_TREE_ROOT}, present exactly when
 * there are files.
 */
export interface CapabilityBundleMemory {
  schemaVersion: 1;
  renderedAt: string;
  renderedBlock: string;
  scopes: {
    scopeId: string;
    kind: 'user' | 'project';
    projectId: string | null;
    revision: number;
    cursor: string;
  }[];
  files: CapabilityBundleFileTreeEntry[];
}

/**
 * Reference to one selected shared skill. Mirrors the `skillRefs` element of
 * `PortalChatTabPluginSelections` (`packages/protocol/src/portal`).
 */
export interface CapabilityBundleSkillRef {
  sourceId: string;
  skillName: string;
}

/**
 * Reference to one selected plugin. Mirrors the `pluginRefs` element of
 * `PortalChatTabPluginSelections` (`packages/protocol/src/portal`).
 */
export interface CapabilityBundlePluginRef {
  marketplaceId: string;
  pluginName: string;
}

/**
 * Reference to one selected MCP server configuration. Mirrors the
 * `mcpServerRefs` element of `PortalChatTabPluginSelections`
 * (`packages/protocol/src/portal`).
 */
export interface CapabilityBundleMcpServerRef {
  serverId: string;
  configId: string;
}

/** One resolved capability recorded in the provenance snapshot. */
export interface CapabilityBundleResolvedEntry {
  kind: 'skill' | 'plugin' | 'mcp';
  /** Producer-defined stable identifier of the resolved capability. */
  ref: string;
  /** Optional content hash of the resolved payload, for auditing. */
  contentHash?: string;
}

/**
 * One account MCP server the producer left out because its connection was
 * not usable when the bundle was built (REG-3030), recorded beside the text
 * warning so a later connection can be matched without parsing prose. `via`
 * names the selected plugin that brought it, or `direct` for a server the
 * selection names itself. A connection the user turned off is recorded as
 * `not_connected`.
 */
export interface CapabilityBundleSkippedMcpServer {
  serverId: string;
  configId: string;
  via:
    | { kind: 'direct' }
    | { kind: 'plugin'; marketplaceId: string; pluginName: string };
  reason: 'not_connected' | 'needs_reconnect';
}

/**
 * Why a selected capability did not reach the bundle (REG-3042). Producers
 * emit only these ({@link validateCapabilityBundle} rejects anything else).
 * Readers tolerate a reason they do not know, which a newer producer may have
 * added, and read it as `degraded` ({@link capabilityUnavailableDisposition}),
 * so a new reason needs no reader deploy first.
 */
export const CAPABILITY_UNAVAILABLE_REASONS = [
  /** The capability's row no longer exists. */
  'deleted',
  /** It still exists, but its owner no longer shares it with this account. */
  'no_access',
  /** An operator took it out of the catalog this brand serves. */
  'removed_from_catalog',
  /** The catalog that serves it is switched off. */
  'catalog_disabled',
  /** Its marketplace's last sync failed. */
  'marketplace_sync_failed',
  /** Its content is being rebuilt for the current runtime. */
  'awaiting_rematerialization',
  /** An account server that has never been signed in to. */
  'not_connected',
  /** An account server whose sign-in has to be renewed. */
  'needs_reconnect',
  /** An account server the user turned off. */
  'turned_off',
  /** It needs an account connection, which is not available for the account. */
  'connections_unavailable',
  /** Only the desktop app can use it. */
  'desktop_only',
  /** Its document no longer parses as a skill. */
  'invalid_skill',
  /** The ref cannot name anything a cloud bundle can carry. */
  'invalid_ref',
  /** A bundle limit left it out. */
  'limit_exceeded',
  /** Its files could not be confirmed to exist. */
  'files_unavailable',
  /** It reached the bundle with reduced fidelity. */
  'partial',
] as const;

export type CapabilityUnavailableReason =
  (typeof CAPABILITY_UNAVAILABLE_REASONS)[number];

/**
 * What the reason means for the selection (REG-3042):
 *
 * - `gone`: confirmed absent for good. The selection drops it.
 * - `unavailable`: temporarily unusable, usually until the user acts (signs
 *   in, turns it on) or a catalog recovers. The selection keeps it.
 * - `unsupported`: this runtime can never use it. Kept, inert, until the user
 *   removes it.
 * - `degraded`: in the bundle, or partly so, with reduced fidelity.
 */
export const CAPABILITY_UNAVAILABLE_DISPOSITIONS = [
  'gone',
  'unavailable',
  'unsupported',
  'degraded',
] as const;

export type CapabilityUnavailableDisposition =
  (typeof CAPABILITY_UNAVAILABLE_DISPOSITIONS)[number];

/** How the selection reached the capability: itself, or through a plugin. */
export type CapabilityUnavailableVia =
  | { kind: 'direct' }
  | { kind: 'plugin'; marketplaceId: string; pluginName: string };

/** The selection ref an unavailability record is about. */
export type CapabilityUnavailableRef =
  | {
      kind: 'skill';
      sourceId: string;
      skillName: string;
      via: CapabilityUnavailableVia;
    }
  | {
      kind: 'plugin';
      marketplaceId: string;
      pluginName: string;
      via: CapabilityUnavailableVia;
    }
  | {
      kind: 'mcpServer';
      serverId: string;
      configId: string;
      via: CapabilityUnavailableVia;
    };

/**
 * One selected capability the producer could not fully bundle (REG-3042),
 * recorded as data so readers never parse `warnings`. `displayName` is the
 * last human name the producer could find; readers never show the raw ref in
 * its place.
 */
export interface CapabilityUnavailable {
  ref: CapabilityUnavailableRef;
  displayName?: string;
  /**
   * One of {@link CAPABILITY_UNAVAILABLE_REASONS} when produced; typed as a
   * string because a stored bundle may come from a newer producer.
   */
  reason: string;
  /**
   * One of {@link CAPABILITY_UNAVAILABLE_DISPOSITIONS} when produced. Readers
   * act on {@link capabilityUnavailableDisposition}, never on this directly.
   */
  disposition: string;
  /**
   * Opaque marker of what the cause depended on when the record was produced
   * (a row's revision, a catalog generation), for a record that may recover.
   * The producer's reader recomputes it to tell when a rebuild could carry
   * the capability; absent when nothing would. At most
   * {@link CAPABILITY_UNAVAILABLE_RECHECK_MAX_LENGTH} characters.
   */
  recheck?: string;
}

/** Longest `CapabilityUnavailable.recheck` a bundle may carry. */
export const CAPABILITY_UNAVAILABLE_RECHECK_MAX_LENGTH = 200;

/** Longest `CapabilityUnavailable.displayName` a bundle may carry. */
export const CAPABILITY_UNAVAILABLE_DISPLAY_NAME_MAX_LENGTH = 120;

/** Longest `CapabilityBundleProvenance.catalogBrand`, a brand key. */
export const CAPABILITY_BUNDLE_CATALOG_BRAND_MAX_LENGTH = 64;

/**
 * Snapshot of the input selections the bundle was produced from, plus the
 * list of capabilities the producer actually resolved. The selection fields
 * structurally mirror `PortalChatTabPluginSelections`
 * (`packages/protocol/src/portal`); runtime refs are declared inline to avoid
 * a dependency on the Portal transport. Catalog identities use the pure
 * shared Try it contract.
 */
export interface CapabilityBundleProvenance {
  /** Catalog identity retained for later explicit install/auth continuation. */
  unresolvedCapabilities?: TryItCapability[];
  collectionIds: string[];
  skillRefs: CapabilityBundleSkillRef[];
  pluginRefs: CapabilityBundlePluginRef[];
  mcpServerRefs: CapabilityBundleMcpServerRef[];
  resolved: CapabilityBundleResolvedEntry[];
  /**
   * Account MCP servers the producer skipped, in producer order. Omitted when
   * none was skipped, and by producers older than REG-3030, whose bundles
   * keep only the text warnings.
   */
  skippedMcpServers?: CapabilityBundleSkippedMcpServer[];
  /**
   * Every selected capability the producer could not fully bundle, in
   * producer order (REG-3042). Present exactly when the bundle has warnings,
   * even when empty: a bundle with warnings and no `unavailable` was built
   * before the field existed, and only its text describes what was skipped
   * ({@link isLegacyCapabilityBundleProvenance}). Omitted from a bundle
   * without warnings, so its bytes and digest stay what they were.
   */
  unavailable?: CapabilityUnavailable[];
  /**
   * The brand key whose catalog the producer resolved the selection against
   * and signed into proxied servers (REG-3042). A `gone` record is only
   * known gone for this brand. Omitted by producers before the field
   * existed, so their bytes and digests stay what they were.
   */
  catalogBrand?: string;
}

/**
 * The immutable capability bundle, version 1. Produced once from a selection
 * snapshot, digested (see {@link serializeCanonicalCapabilityBundle}), and
 * consumed by harness runtimes verbatim. `warnings` records non-fatal
 * producer-side drops (e.g. a plugin part that could not be bundled) so the
 * runtime can surface them without re-resolving anything.
 */
export interface CapabilityBundleV1 {
  version: 1;
  /** Extra system-prompt instruction blocks, in producer order. */
  instructions: string[];
  skills: CapabilityBundleSkill[];
  mcpServers: CapabilityBundleMcpServer[];
  fileTrees?: CapabilityBundleFileTree[];
  /** Synced memory for the session; omitted when it carries none. */
  memory?: CapabilityBundleMemory;
  provenance: CapabilityBundleProvenance;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Pure type guards.
//
// Mirror `packages/protocol/src/mcp-catalog`: object guards check every field
// structurally and NEVER throw — malformed input returns `false` so a corrupt
// payload is rejected rather than crashing a consumer. Guards check shape
// only; semantic rules (name charset, reserved names, URL scheme, duplicates)
// live in {@link validateCapabilityBundle}.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
  );
}

/** Validates one supporting skill file structurally. */
export function isCapabilityBundleSkillFile(
  value: unknown,
): value is CapabilityBundleSkillFile {
  return (
    isRecord(value) &&
    isNonEmptyString(value.path) &&
    typeof value.content === 'string'
  );
}

/** Validates one bundled skill structurally. */
export function isCapabilityBundleSkill(
  value: unknown,
): value is CapabilityBundleSkill {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    typeof value.description === 'string' &&
    typeof value.content === 'string' &&
    (value.files === undefined ||
      (Array.isArray(value.files) &&
        value.files.every(isCapabilityBundleSkillFile)))
  );
}

/** Validates one bundled MCP server structurally. */
export function isCapabilityBundleMcpServer(
  value: unknown,
): value is CapabilityBundleMcpServer {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.url) &&
    (value.headers === undefined || isStringRecord(value.headers)) &&
    (value.displayName === undefined ||
      typeof value.displayName === 'string') &&
    (value.enabledTools === undefined ||
      (Array.isArray(value.enabledTools) &&
        value.enabledTools.every(isNonEmptyString)))
  );
}

/** Validates one file-tree manifest entry structurally. */
export function isCapabilityBundleFileTreeEntry(
  value: unknown,
): value is CapabilityBundleFileTreeEntry {
  return (
    isRecord(value) &&
    isNonEmptyString(value.path) &&
    typeof value.sha256 === 'string' &&
    CAPABILITY_BUNDLE_SHA256_PATTERN.test(value.sha256) &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
  );
}

function isCapabilityBundleMemoryScope(
  value: unknown,
): value is CapabilityBundleMemory['scopes'][number] {
  return (
    isRecord(value) &&
    isNonEmptyString(value.scopeId) &&
    (value.kind === 'user' || value.kind === 'project') &&
    (value.projectId === null || isNonEmptyString(value.projectId)) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    isNonEmptyString(value.cursor)
  );
}

/** Validates a session's synced memory structurally. */
function isCapabilityBundleMemory(
  value: unknown,
): value is CapabilityBundleMemory {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isNonEmptyString(value.renderedAt) &&
    typeof value.renderedBlock === 'string' &&
    Array.isArray(value.scopes) &&
    value.scopes.every(isCapabilityBundleMemoryScope) &&
    Array.isArray(value.files) &&
    value.files.every(isCapabilityBundleFileTreeEntry)
  );
}

/** Validates one content-addressed file-tree manifest structurally. */
export function isCapabilityBundleFileTree(
  value: unknown,
): value is CapabilityBundleFileTree {
  return (
    isRecord(value) &&
    isNonEmptyString(value.root) &&
    Array.isArray(value.entries) &&
    value.entries.every(isCapabilityBundleFileTreeEntry)
  );
}

function isCapabilityBundleSkillRef(
  value: unknown,
): value is CapabilityBundleSkillRef {
  return (
    isRecord(value) &&
    isNonEmptyString(value.sourceId) &&
    isNonEmptyString(value.skillName)
  );
}

function isCapabilityBundlePluginRef(
  value: unknown,
): value is CapabilityBundlePluginRef {
  return (
    isRecord(value) &&
    isNonEmptyString(value.marketplaceId) &&
    isNonEmptyString(value.pluginName)
  );
}

function isCapabilityBundleMcpServerRef(
  value: unknown,
): value is CapabilityBundleMcpServerRef {
  return (
    isRecord(value) &&
    isNonEmptyString(value.serverId) &&
    isNonEmptyString(value.configId)
  );
}

/** Validates one resolved-capability provenance entry structurally. */
export function isCapabilityBundleResolvedEntry(
  value: unknown,
): value is CapabilityBundleResolvedEntry {
  return (
    isRecord(value) &&
    (value.kind === 'skill' ||
      value.kind === 'plugin' ||
      value.kind === 'mcp') &&
    isNonEmptyString(value.ref) &&
    (value.contentHash === undefined || typeof value.contentHash === 'string')
  );
}

/** Validates one skipped account MCP server structurally. */
export function isCapabilityBundleSkippedMcpServer(
  value: unknown,
): value is CapabilityBundleSkippedMcpServer {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.serverId) ||
    !isNonEmptyString(value.configId) ||
    (value.reason !== 'not_connected' && value.reason !== 'needs_reconnect') ||
    !isRecord(value.via)
  )
    return false;
  const via = value.via;
  return (
    via.kind === 'direct' ||
    (via.kind === 'plugin' &&
      isNonEmptyString(via.marketplaceId) &&
      isNonEmptyString(via.pluginName))
  );
}

function isCapabilityUnavailableVia(
  value: unknown,
): value is CapabilityUnavailableVia {
  return (
    isRecord(value) &&
    (value.kind === 'direct' ||
      (value.kind === 'plugin' &&
        isNonEmptyString(value.marketplaceId) &&
        isNonEmptyString(value.pluginName)))
  );
}

export function isCapabilityUnavailableRef(
  value: unknown,
): value is CapabilityUnavailableRef {
  if (!isRecord(value) || !isCapabilityUnavailableVia(value.via)) return false;
  switch (value.kind) {
    case 'skill':
      return (
        isNonEmptyString(value.sourceId) && isNonEmptyString(value.skillName)
      );
    case 'plugin':
      return (
        isNonEmptyString(value.marketplaceId) &&
        isNonEmptyString(value.pluginName)
      );
    case 'mcpServer':
      return (
        isNonEmptyString(value.serverId) && isNonEmptyString(value.configId)
      );
    default:
      return false;
  }
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.some((candidate) => candidate === value);
}

/**
 * Validates one unavailability record structurally (REG-3042). Any non-empty
 * reason and disposition pass, so a record from a newer producer never
 * invalidates the provenance or the bundle that carries it; see
 * {@link capabilityUnavailableDisposition} for how readers treat one.
 */
export function isCapabilityUnavailable(
  value: unknown,
): value is CapabilityUnavailable {
  return (
    isRecord(value) &&
    isCapabilityUnavailableRef(value.ref) &&
    (value.displayName === undefined ||
      typeof value.displayName === 'string') &&
    isNonEmptyString(value.reason) &&
    isNonEmptyString(value.disposition) &&
    (value.recheck === undefined || typeof value.recheck === 'string')
  );
}

/** Whether `reason` is one this module defines. */
export function isKnownCapabilityUnavailableReason(
  reason: string,
): reason is CapabilityUnavailableReason {
  return isOneOf(CAPABILITY_UNAVAILABLE_REASONS, reason);
}

/**
 * What a reader does with a record: its disposition when both its reason and
 * its disposition are ones this module defines, else `degraded`, which keeps
 * the selection and never prunes it. That is what lets a producer add a reason
 * or disposition without a reader deploy first.
 */
export function capabilityUnavailableDisposition(
  record: Pick<CapabilityUnavailable, 'reason' | 'disposition'>,
): CapabilityUnavailableDisposition {
  return isKnownCapabilityUnavailableReason(record.reason) &&
    isOneOf(CAPABILITY_UNAVAILABLE_DISPOSITIONS, record.disposition)
    ? record.disposition
    : 'degraded';
}

/**
 * True for a bundle built before producers recorded unavailability as data:
 * it has warnings but no `provenance.unavailable`, so only its text says
 * what was skipped. A bundle without warnings skipped nothing either way.
 */
export function isLegacyCapabilityBundleProvenance(bundle: {
  readonly warnings: readonly string[];
  readonly provenance: Pick<CapabilityBundleProvenance, 'unavailable'>;
}): boolean {
  return (
    bundle.warnings.length > 0 && bundle.provenance.unavailable === undefined
  );
}

/** Validates the provenance snapshot structurally. */
export function isCapabilityBundleProvenance(
  value: unknown,
): value is CapabilityBundleProvenance {
  return (
    isRecord(value) &&
    isStringArray(value.collectionIds) &&
    (value.unresolvedCapabilities === undefined ||
      isTryItCapabilityArray(value.unresolvedCapabilities)) &&
    Array.isArray(value.skillRefs) &&
    value.skillRefs.every(isCapabilityBundleSkillRef) &&
    Array.isArray(value.pluginRefs) &&
    value.pluginRefs.every(isCapabilityBundlePluginRef) &&
    Array.isArray(value.mcpServerRefs) &&
    value.mcpServerRefs.every(isCapabilityBundleMcpServerRef) &&
    Array.isArray(value.resolved) &&
    value.resolved.every(isCapabilityBundleResolvedEntry) &&
    (value.skippedMcpServers === undefined ||
      (Array.isArray(value.skippedMcpServers) &&
        value.skippedMcpServers.every(isCapabilityBundleSkippedMcpServer))) &&
    (value.unavailable === undefined ||
      (Array.isArray(value.unavailable) &&
        value.unavailable.every(isCapabilityUnavailable))) &&
    (value.catalogBrand === undefined || typeof value.catalogBrand === 'string')
  );
}

/**
 * Validates a full v1 bundle structurally. Shape only — run
 * {@link validateCapabilityBundle} afterwards for the semantic rules.
 */
export function isCapabilityBundleV1(
  value: unknown,
): value is CapabilityBundleV1 {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isStringArray(value.instructions) &&
    Array.isArray(value.skills) &&
    value.skills.every(isCapabilityBundleSkill) &&
    Array.isArray(value.mcpServers) &&
    value.mcpServers.every(isCapabilityBundleMcpServer) &&
    (value.fileTrees === undefined ||
      (Array.isArray(value.fileTrees) &&
        value.fileTrees.every(isCapabilityBundleFileTree))) &&
    (value.memory === undefined || isCapabilityBundleMemory(value.memory)) &&
    isCapabilityBundleProvenance(value.provenance) &&
    isStringArray(value.warnings)
  );
}

// ---------------------------------------------------------------------------
// Semantic validation.
// ---------------------------------------------------------------------------

/**
 * Windows reserved device names, standalone or with any extension (`CON`,
 * `con.txt`, …) — per Windows semantics the extension does not un-reserve the
 * name. Case-insensitive.
 */
/**
 * Whether one path segment materializes portably on both POSIX and Windows.
 * Rejects, beyond the empty/`.`/`..` normalization hazards: Windows reserved
 * device names, the full Windows-invalid character set
 * ({@link WINDOWS_INVALID_SEGMENT_CHARS} plus control characters 0x00-0x1F),
 * and trailing `.` or space (Windows strips them, aliasing two spellings to
 * one on-disk name).
 */
export function isPortableCapabilityBundlePathSegment(
  segment: string,
): boolean {
  return isPortableCapabilityPathSegment(segment);
}

/**
 * Shared error-message suffix for every {@link isSafeRelativePosixPath} call
 * site, so all three surfaces (skill files, file-tree roots, file-tree entry
 * paths) report the same contract.
 */
const SAFE_RELATIVE_PATH_REQUIREMENT =
  'must be a relative POSIX path with no empty, "." or ".." segment, no ' +
  'leading "/", no "\\", no drive prefix, and no Windows-hostile segment ' +
  '(reserved device name, a <>:"|?* or control character, or trailing "." ' +
  'or space)';

/**
 * Whether a materialized path (skill file, file-tree root, file-tree entry) is
 * relative POSIX and materializes to exactly the path it spells on every
 * supported platform. Empty (`a//b`, trailing `/`) and `.` segments are
 * rejected alongside `..`: they normalize away at materialization time, so
 * two entries that differ only by them would collide, and a trailing `/`
 * would target a directory rather than a file. Windows-hostile spellings
 * (reserved device names, `:`, NUL, trailing `.`/space) are rejected per
 * segment — see {@link isPortablePathSegment} — because desktop bundles
 * materialize on Windows too.
 */
function isSafeRelativePosixPath(path: string): boolean {
  return isSafeCapabilityRelativePath(path);
}

/**
 * Collision between a candidate destination and a previously accepted one.
 * `existing` is the case-preserved spelling of the accepted destination.
 */
export interface DestinationConflict {
  kind:
    | 'duplicate' // Same destination (casefolded) accepted before.
    | 'directory-prefix' // Candidate is a directory prefix of `existing`.
    | 'nested-under-file'; // Candidate is nested under file `existing`.
  existing: string;
}

/**
 * Tracks accepted materialization destinations and reports collisions: exact
 * duplicates, and pairs where one destination is a strict directory prefix of
 * the other (`a` vs `a/b`), which cannot coexist in a filesystem tree.
 *
 * Storage is case-preserving but comparison is CASEFOLDED: bundles
 * materialize on case-insensitive filesystems too (default macOS, Windows),
 * where `A/b` and `a/B` alias the same on-disk path, so case-only variants
 * must collide here rather than silently overwrite at bootstrap.
 */
export function createDestinationCollisionTracker(): {
  add(destination: string): DestinationConflict | null;
} {
  // Casefolded destination → case-preserved accepted destination.
  const fileDestinations = new Map<string, string>();
  // Casefolded directory prefix implied by an accepted destination → that
  // destination, so prefix-collision errors can name the conflicting entry.
  const directoryDestinations = new Map<string, string>();
  return {
    add(destination: string): DestinationConflict | null {
      const folded = destination.toLowerCase();
      const duplicate = fileDestinations.get(folded);
      if (duplicate !== undefined) {
        return { kind: 'duplicate', existing: duplicate };
      }
      const nestedEntry = directoryDestinations.get(folded);
      if (nestedEntry !== undefined) {
        return { kind: 'directory-prefix', existing: nestedEntry };
      }
      const segments = folded.split('/');
      let prefix = '';
      for (let i = 0; i < segments.length - 1; i += 1) {
        prefix = i === 0 ? segments[0] : `${prefix}/${segments[i]}`;
        const ancestorFile = fileDestinations.get(prefix);
        if (ancestorFile !== undefined) {
          return { kind: 'nested-under-file', existing: ancestorFile };
        }
      }
      fileDestinations.set(folded, destination);
      prefix = '';
      for (let i = 0; i < segments.length - 1; i += 1) {
        prefix = i === 0 ? segments[0] : `${prefix}/${segments[i]}`;
        if (!directoryDestinations.has(prefix)) {
          directoryDestinations.set(prefix, destination);
        }
      }
      return null;
    },
  };
}

/**
 * Whether a URL string is http(s) with a non-empty host. Parsed with the
 * `URL` global (no import, so the module stays dependency-free; same approach
 * as `packages/protocol/src/profile`) so invalid hosts — spaces, bad
 * percent-escapes — are rejected rather than string-matched past.
 */
function isHttpUrlWithHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.host.length === 0) return false;
  // The parser rewrites some inputs: it collapses extra authority slashes
  // (`http:///path` parses with `path` as the host) and drops userinfo from
  // the origin. Requiring the origin to appear literally keeps the accepted
  // set to URLs that mean what they say.
  return url.startsWith(parsed.origin);
}

/**
 * Header names that carry credentials. A bundle is secret-free by contract —
 * provider auth lives at the Canopy proxy, never in bundle data — so these
 * are rejected case-insensitively regardless of value.
 */
const CREDENTIAL_HEADER_NAMES: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
];

/**
 * Api-key-style header names: `api-key`, `apikey`, `x-api-key`,
 * `x-goog-api-key`, and similar `…-api-key`/`…_api_key` spellings.
 */
const API_KEY_HEADER_NAME_PATTERN = /(?:^|[-_])api[-_]?key$/;

/**
 * Token/secret-style header names: bare `token`/`secret` plus any name whose
 * final `-`/`_` component is one of them — `x-auth-token`, `x-access-token`,
 * `x-vault-token`, `private-token`, `x-client-secret`. Suffix-anchored so
 * multi-component words that merely contain the letters (`x-tokenizer-mode`)
 * are not caught.
 */
const TOKEN_OR_SECRET_HEADER_NAME_PATTERN = /(?:^|[-_])(?:token|secret)$/;

/**
 * Header names carrying `auth` as a standalone `-`/`_`-delimited component:
 * `auth`, `auth-token`, `x-auth-token`, `x-auth`. Component-anchored so
 * benign words that only start with the letters (`x-author-id`) pass;
 * `authorization` spellings are covered by {@link CREDENTIAL_HEADER_NAMES}.
 */
const AUTH_COMPONENT_HEADER_NAME_PATTERN = /(?:^|[-_])auth(?:[-_]|$)/;

function isCredentialHeaderName(name: string): boolean {
  const lowered = name.toLowerCase();
  return (
    CREDENTIAL_HEADER_NAMES.includes(lowered) ||
    API_KEY_HEADER_NAME_PATTERN.test(lowered) ||
    TOKEN_OR_SECRET_HEADER_NAME_PATTERN.test(lowered) ||
    AUTH_COMPONENT_HEADER_NAME_PATTERN.test(lowered)
  );
}

/**
 * Producer-supplied policy for {@link validateCapabilityBundle}.
 *
 * This module is dependency-free and environment-neutral, so it cannot
 * hardcode which origins are Canopy-operated proxies — that policy is the
 * producer's. Producers MUST pass their proxy origin policy via
 * {@link allowedMcpOrigins} so direct vendor endpoints are rejected instead
 * of being enforced by convention only.
 */
export interface CapabilityBundleValidationPolicy {
  /**
   * When provided, every MCP server URL's origin must be one of these
   * origins (compared after `URL` normalization; unparseable entries never
   * match). An empty list rejects every MCP server. When omitted, no origin
   * restriction is applied — credential-bearing headers are still rejected
   * unconditionally.
   */
  allowedMcpOrigins?: readonly string[];
}

function normalizeAllowedOrigins(origins: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const origin of origins) {
    try {
      normalized.add(new URL(origin).origin);
    } catch {
      // An unparseable policy entry can never match a parsed URL origin.
    }
  }
  return normalized;
}

/**
 * Validates the semantic rules a structurally-valid bundle must satisfy
 * before a harness runtime may consume it. Returns human-readable errors; an
 * empty array means the bundle is valid.
 *
 * Producers MUST pass their proxy origin policy via
 * `policy.allowedMcpOrigins` (see {@link CapabilityBundleValidationPolicy})
 * so the proxy-only MCP contract is enforced in code, not by convention.
 *
 * Validation is ALL-OR-NOTHING at the consumer: a bundle with any error must
 * be rejected atomically — consumers never drop the offending entry and run
 * the rest, because a partially-applied bundle would no longer match its
 * digest or its provenance.
 */
export function validateCapabilityBundle(
  bundle: CapabilityBundleV1,
  policy: CapabilityBundleValidationPolicy = {},
): string[] {
  const errors: string[] = [];

  const seenSkillNames = new Set<string>();
  for (const skill of bundle.skills) {
    if (skill.name === '.' || skill.name === '..') {
      errors.push(`skill name "${skill.name}" is not a valid name`);
    } else if (
      skill.name.toLowerCase() === CAPABILITY_BUNDLE_RESERVED_SKILL_NAME
    ) {
      errors.push(
        `skill name "${skill.name}" is reserved by the runner digest sentinel`,
      );
    } else if (!CAPABILITY_BUNDLE_SKILL_NAME_PATTERN.test(skill.name)) {
      errors.push(
        `skill name "${skill.name}" must match ${String(
          CAPABILITY_BUNDLE_SKILL_NAME_PATTERN,
        )} (plugin-namespaced names must be pre-flattened; "/" is forbidden)`,
      );
    }
    if (seenSkillNames.has(skill.name)) {
      errors.push(`duplicate skill name "${skill.name}"`);
    }
    seenSkillNames.add(skill.name);

    // Supporting files materialize into ONE directory per skill, next to the
    // generated SKILL.md entrypoint, so their paths get the same collision
    // checks as file-tree destinations — with root-level SKILL.md reserved so
    // no supporting file can overwrite (or nest under) the generated
    // instructions.
    const fileDestinations = createDestinationCollisionTracker();
    fileDestinations.add(CAPABILITY_BUNDLE_SKILL_ENTRYPOINT_FILENAME);
    for (const file of skill.files ?? []) {
      if (!isSafeRelativePosixPath(file.path)) {
        errors.push(
          `skill "${skill.name}" file path "${file.path}" ` +
            SAFE_RELATIVE_PATH_REQUIREMENT,
        );
        continue;
      }
      const conflict = fileDestinations.add(file.path);
      if (conflict === null) continue;
      if (conflict.existing === CAPABILITY_BUNDLE_SKILL_ENTRYPOINT_FILENAME) {
        errors.push(
          `skill "${skill.name}" file path "${file.path}" collides with the ` +
            `generated ${CAPABILITY_BUNDLE_SKILL_ENTRYPOINT_FILENAME} ` +
            'entrypoint',
        );
      } else if (conflict.kind === 'duplicate') {
        errors.push(
          `skill "${skill.name}" duplicate file path "${file.path}"` +
            (conflict.existing === file.path
              ? ''
              : ` (collides with "${conflict.existing}" on case-insensitive ` +
                'filesystems)'),
        );
      } else if (conflict.kind === 'directory-prefix') {
        errors.push(
          `skill "${skill.name}" file path "${file.path}" is a directory ` +
            `prefix of "${conflict.existing}"`,
        );
      } else {
        errors.push(
          `skill "${skill.name}" file path "${file.path}" is nested under ` +
            `file path "${conflict.existing}"`,
        );
      }
    }
  }

  const allowedOrigins =
    policy.allowedMcpOrigins === undefined
      ? undefined
      : normalizeAllowedOrigins(policy.allowedMcpOrigins);
  if (bundle.mcpServers.length > CAPABILITY_BUNDLE_MAX_MCP_SERVERS) {
    errors.push(
      `mcp servers exceed ${String(CAPABILITY_BUNDLE_MAX_MCP_SERVERS)} entries`,
    );
  }
  const seenServerNames = new Set<string>();
  for (const server of bundle.mcpServers) {
    if (server.name === CAPABILITY_BUNDLE_RESERVED_MCP_SERVER_NAME) {
      errors.push(
        `mcp server name "${CAPABILITY_BUNDLE_RESERVED_MCP_SERVER_NAME}" is ` +
          'reserved by the harness bridge',
      );
    }
    if (seenServerNames.has(server.name)) {
      errors.push(`duplicate mcp server name "${server.name}"`);
    }
    seenServerNames.add(server.name);
    if (server.displayName !== undefined && server.displayName.length > 120) {
      errors.push(
        `mcp server "${server.name}" displayName exceeds 120 characters`,
      );
    }
    const seenTools = new Set<string>();
    for (const tool of server.enabledTools ?? []) {
      if (tool.length === 0) {
        errors.push(
          `mcp server "${server.name}" enabledTools contains an empty string`,
        );
      }
      if (seenTools.has(tool)) {
        errors.push(
          `mcp server "${server.name}" duplicate enabledTools entry "${tool}"`,
        );
      }
      seenTools.add(tool);
    }

    if (!isHttpUrlWithHost(server.url)) {
      errors.push(
        `mcp server "${server.name}" url "${server.url}" must be an http(s) ` +
          'URL with a non-empty host',
      );
    } else if (
      allowedOrigins !== undefined &&
      !allowedOrigins.has(new URL(server.url).origin)
    ) {
      errors.push(
        `mcp server "${server.name}" url "${server.url}" origin is not an ` +
          'allowed MCP proxy origin',
      );
    }

    for (const headerName of Object.keys(server.headers ?? {})) {
      if (isCredentialHeaderName(headerName)) {
        errors.push(
          `mcp server "${server.name}" header "${headerName}" is a ` +
            'credential-bearing header; bundles are secret-free — provider ' +
            'auth belongs at the proxy, never in bundle data',
        );
      }
    }
  }

  // `root` and `entries[].path` are materialized into the sandbox, so they get
  // the same path check as `skill.files[].path` — otherwise a traversing root
  // or entry would pass validation and write outside the sandbox root.
  //
  // All trees materialize into ONE filesystem, so full destinations
  // (`root/path`) are also checked for collisions across every tree via
  // {@link createDestinationCollisionTracker} (casefolded comparison — see
  // its doc for the case-insensitive-filesystem rationale).
  const treeDestinations = createDestinationCollisionTracker();
  // The memory tree has its own file limit, so plugin trees keep their cap.
  const fileTreeEntryCount = (bundle.fileTrees ?? [])
    .filter((tree) => tree.root !== CAPABILITY_BUNDLE_MEMORY_TREE_ROOT)
    .reduce((total, tree) => total + tree.entries.length, 0);
  if (fileTreeEntryCount > CAPABILITY_BUNDLE_MAX_FILE_TREE_ENTRIES) {
    errors.push(
      `file trees exceed ${String(CAPABILITY_BUNDLE_MAX_FILE_TREE_ENTRIES)} aggregate entries`,
    );
  }
  for (const tree of bundle.fileTrees ?? []) {
    const rootOk = isSafeRelativePosixPath(tree.root);
    if (!rootOk) {
      errors.push(
        `file tree root "${tree.root}" ${SAFE_RELATIVE_PATH_REQUIREMENT}`,
      );
    }
    for (const entry of tree.entries) {
      if (!isSafeRelativePosixPath(entry.path)) {
        errors.push(
          `file tree "${tree.root}" entry path "${entry.path}" ` +
            SAFE_RELATIVE_PATH_REQUIREMENT,
        );
        continue;
      }
      // Collision tracking needs a well-formed full destination; an invalid
      // root already produced its own error above.
      if (!rootOk) continue;

      const destination = `${tree.root}/${entry.path}`;
      const conflict = treeDestinations.add(destination);
      if (conflict === null) continue;
      if (conflict.kind === 'duplicate') {
        errors.push(
          `duplicate file tree destination "${destination}"` +
            (conflict.existing === destination
              ? ''
              : ` (collides with "${conflict.existing}" on case-insensitive ` +
                'filesystems)'),
        );
      } else if (conflict.kind === 'directory-prefix') {
        errors.push(
          `file tree destination "${destination}" is a directory prefix of ` +
            `"${conflict.existing}"`,
        );
      } else {
        errors.push(
          `file tree destination "${destination}" is nested under file ` +
            `destination "${conflict.existing}"`,
        );
      }
    }
  }

  errors.push(...validateCapabilityBundleMemory(bundle));
  errors.push(...validateCapabilityUnavailable(bundle));
  const catalogBrand = bundle.provenance.catalogBrand;
  if (catalogBrand !== undefined) {
    if (catalogBrand.length === 0)
      errors.push('provenance.catalogBrand is empty');
    else if (catalogBrand.length > CAPABILITY_BUNDLE_CATALOG_BRAND_MAX_LENGTH)
      errors.push(
        `provenance.catalogBrand is over ${String(CAPABILITY_BUNDLE_CATALOG_BRAND_MAX_LENGTH)} characters`,
      );
  }

  return errors;
}

function memoryEntryKey(entry: CapabilityBundleFileTreeEntry): string {
  return `${entry.path}\0${entry.sha256}\0${String(entry.size)}`;
}

/**
 * The memory file tree is exactly the memory's file list: one tree rooted at
 * {@link CAPABILITY_BUNDLE_MEMORY_TREE_ROOT} with the same path, hash and
 * size set, present exactly when there are files, and no such tree without
 * memory.
 */
function validateCapabilityBundleMemory(bundle: CapabilityBundleV1): string[] {
  const trees = (bundle.fileTrees ?? []).filter(
    (tree) => tree.root === CAPABILITY_BUNDLE_MEMORY_TREE_ROOT,
  );
  const memory = bundle.memory;
  if (memory === undefined) {
    return trees.length === 0
      ? []
      : [`file tree "${CAPABILITY_BUNDLE_MEMORY_TREE_ROOT}" has no memory`];
  }
  const errors: string[] = [];
  if (trees.length > 1) {
    errors.push(`more than one "${CAPABILITY_BUNDLE_MEMORY_TREE_ROOT}" tree`);
  }
  const tree = trees.length === 0 ? undefined : trees[0];
  if (memory.files.length === 0) {
    if (tree !== undefined) errors.push('memory has a file tree but no files');
    return errors;
  }
  if (tree === undefined) {
    errors.push('memory files have no file tree');
    return errors;
  }
  const expected = new Set(memory.files.map(memoryEntryKey));
  const actual = new Set(tree.entries.map(memoryEntryKey));
  if (
    expected.size !== memory.files.length ||
    actual.size !== tree.entries.length ||
    expected.size !== actual.size ||
    [...expected].some((key) => !actual.has(key))
  ) {
    errors.push('memory files and their file tree differ');
  }
  return errors;
}

/** `kind "identity"` for a record, as validation errors name it. */
function describeCapabilityUnavailableRef(
  ref: CapabilityUnavailableRef,
): string {
  switch (ref.kind) {
    case 'skill':
      return `skill "${ref.sourceId}/${ref.skillName}"`;
    case 'plugin':
      return `plugin "${ref.marketplaceId}/${ref.pluginName}"`;
    case 'mcpServer':
      return `mcpServer "${ref.serverId}/${ref.configId}"`;
  }
}

function selectsCapabilityUnavailableRef(
  provenance: CapabilityBundleProvenance,
  ref: CapabilityUnavailableRef,
): boolean {
  switch (ref.kind) {
    case 'skill':
      return provenance.skillRefs.some(
        (entry) =>
          entry.sourceId === ref.sourceId && entry.skillName === ref.skillName,
      );
    case 'plugin':
      return provenance.pluginRefs.some(
        (entry) =>
          entry.marketplaceId === ref.marketplaceId &&
          entry.pluginName === ref.pluginName,
      );
    case 'mcpServer':
      return provenance.mcpServerRefs.some(
        (entry) =>
          entry.serverId === ref.serverId && entry.configId === ref.configId,
      );
  }
}

/**
 * Record invariants: every record comes with a warning, names each ref once
 * (and via), names a ref (or, through a plugin, a plugin) the selection
 * names, keeps its display name short, and uses only the reasons and
 * dispositions this module defines. Producers run this, so they stay strict
 * while readers tolerate what a newer producer adds.
 */
function validateCapabilityUnavailable(bundle: CapabilityBundleV1): string[] {
  const records = bundle.provenance.unavailable;
  if (records === undefined) return [];
  const errors: string[] = [];
  if (bundle.warnings.length === 0) {
    errors.push(
      'provenance.unavailable is present but the bundle has no warnings',
    );
  }
  const seen = new Set<string>();
  for (const record of records) {
    const label = describeCapabilityUnavailableRef(record.ref);
    const identity = JSON.stringify(
      serializeCanonicalCapabilityUnavailableRef(record.ref),
    );
    if (seen.has(identity)) {
      errors.push(`provenance.unavailable has a duplicate record for ${label}`);
    }
    seen.add(identity);
    if (
      record.displayName !== undefined &&
      record.displayName.length > CAPABILITY_UNAVAILABLE_DISPLAY_NAME_MAX_LENGTH
    ) {
      errors.push(
        `provenance.unavailable record for ${label} has a displayName over ${String(CAPABILITY_UNAVAILABLE_DISPLAY_NAME_MAX_LENGTH)} characters`,
      );
    }
    if (
      record.recheck !== undefined &&
      record.recheck.length > CAPABILITY_UNAVAILABLE_RECHECK_MAX_LENGTH
    ) {
      errors.push(
        `provenance.unavailable record for ${label} has a recheck marker over ${String(CAPABILITY_UNAVAILABLE_RECHECK_MAX_LENGTH)} characters`,
      );
    }
    if (!isKnownCapabilityUnavailableReason(record.reason)) {
      errors.push(
        `provenance.unavailable record for ${label} has an unknown reason "${record.reason}"`,
      );
    }
    if (!isOneOf(CAPABILITY_UNAVAILABLE_DISPOSITIONS, record.disposition)) {
      errors.push(
        `provenance.unavailable record for ${label} has an unknown disposition "${record.disposition}"`,
      );
    }
    const via = record.ref.via;
    if (via.kind === 'plugin') {
      if (
        !bundle.provenance.pluginRefs.some(
          (entry) =>
            entry.marketplaceId === via.marketplaceId &&
            entry.pluginName === via.pluginName,
        )
      ) {
        errors.push(
          `provenance.unavailable record for ${label} names a plugin the selection does not`,
        );
      }
    } else if (
      !selectsCapabilityUnavailableRef(bundle.provenance, record.ref)
    ) {
      errors.push(
        `provenance.unavailable record for ${label} names a ref the selection does not`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Canonical serialization and digest format.
// ---------------------------------------------------------------------------

/**
 * Serializes a bundle to canonical JSON: every object level is rebuilt as a
 * plain literal in a FIXED explicit key order (optional keys are omitted when
 * absent, and `headers` record keys are sorted), then stringified. Arrays
 * keep producer order EXCEPT `provenance.resolved`, which is sorted by
 * `(kind, ref)` so the digest does not depend on resolution order.
 *
 * The bundle digest is DEFINED as sha256 over exactly this string. Two
 * bundles are "the same" iff their canonical serializations are equal.
 */
export function serializeCanonicalCapabilityBundle(
  bundle: CapabilityBundleV1,
): string {
  const canonical = {
    version: bundle.version,
    instructions: bundle.instructions,
    skills: bundle.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      ...(skill.files === undefined
        ? {}
        : {
            files: skill.files.map((file) => ({
              path: file.path,
              content: file.content,
            })),
          }),
    })),
    mcpServers: bundle.mcpServers.map((server) => ({
      name: server.name,
      url: server.url,
      ...(server.headers === undefined
        ? {}
        : { headers: sortRecordKeys(server.headers) }),
      ...(server.displayName === undefined
        ? {}
        : { displayName: server.displayName }),
      ...(server.enabledTools === undefined
        ? {}
        : { enabledTools: Array.from(new Set(server.enabledTools)).sort() }),
    })),
    ...(bundle.fileTrees === undefined
      ? {}
      : {
          fileTrees: bundle.fileTrees.map((tree) => ({
            root: tree.root,
            entries: tree.entries.map((entry) => ({
              path: entry.path,
              sha256: entry.sha256,
              size: entry.size,
            })),
          })),
        }),
    // Omitted when absent, so a bundle without memory keeps its digest.
    ...(bundle.memory === undefined
      ? {}
      : {
          memory: {
            schemaVersion: bundle.memory.schemaVersion,
            renderedAt: bundle.memory.renderedAt,
            renderedBlock: bundle.memory.renderedBlock,
            scopes: bundle.memory.scopes.map((scope) => ({
              scopeId: scope.scopeId,
              kind: scope.kind,
              projectId: scope.projectId,
              revision: scope.revision,
              cursor: scope.cursor,
            })),
            files: bundle.memory.files.map((file) => ({
              path: file.path,
              sha256: file.sha256,
              size: file.size,
            })),
          },
        }),
    provenance: {
      collectionIds: bundle.provenance.collectionIds,
      ...(bundle.provenance.unresolvedCapabilities?.length
        ? {
            unresolvedCapabilities: normalizeTryItCapabilities(
              bundle.provenance.unresolvedCapabilities,
            ),
          }
        : {}),
      skillRefs: bundle.provenance.skillRefs.map((ref) => ({
        sourceId: ref.sourceId,
        skillName: ref.skillName,
      })),
      pluginRefs: bundle.provenance.pluginRefs.map((ref) => ({
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
      })),
      mcpServerRefs: bundle.provenance.mcpServerRefs.map((ref) => ({
        serverId: ref.serverId,
        configId: ref.configId,
      })),
      resolved: [...bundle.provenance.resolved]
        .sort(
          (a, b) =>
            compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.ref, b.ref),
        )
        .map((entry) => ({
          kind: entry.kind,
          ref: entry.ref,
          ...(entry.contentHash === undefined
            ? {}
            : { contentHash: entry.contentHash }),
        })),
      // Omitted when absent, so bundles that skipped nothing keep the bytes
      // (and digests) they had before the field existed.
      ...(bundle.provenance.skippedMcpServers === undefined
        ? {}
        : {
            skippedMcpServers: bundle.provenance.skippedMcpServers.map(
              (entry) => ({
                serverId: entry.serverId,
                configId: entry.configId,
                via:
                  entry.via.kind === 'plugin'
                    ? {
                        kind: entry.via.kind,
                        marketplaceId: entry.via.marketplaceId,
                        pluginName: entry.via.pluginName,
                      }
                    : { kind: entry.via.kind },
                reason: entry.reason,
              }),
            ),
          }),
      // Same omission rule: a bundle without warnings carries no records.
      ...(bundle.provenance.unavailable === undefined
        ? {}
        : {
            unavailable: bundle.provenance.unavailable.map((record) => ({
              ref: serializeCanonicalCapabilityUnavailableRef(record.ref),
              ...(record.displayName === undefined
                ? {}
                : { displayName: record.displayName }),
              reason: record.reason,
              disposition: record.disposition,
              ...(record.recheck === undefined
                ? {}
                : { recheck: record.recheck }),
            })),
          }),
      // Same omission rule: a bundle from before the field keeps its digest.
      ...(bundle.provenance.catalogBrand === undefined
        ? {}
        : { catalogBrand: bundle.provenance.catalogBrand }),
    },
    warnings: bundle.warnings,
  };
  return JSON.stringify(canonical);
}

function serializeCanonicalCapabilityUnavailableVia(
  via: CapabilityUnavailableVia,
): CapabilityUnavailableVia {
  return via.kind === 'plugin'
    ? {
        kind: via.kind,
        marketplaceId: via.marketplaceId,
        pluginName: via.pluginName,
      }
    : { kind: via.kind };
}

function serializeCanonicalCapabilityUnavailableRef(
  ref: CapabilityUnavailableRef,
): CapabilityUnavailableRef {
  const via = serializeCanonicalCapabilityUnavailableVia(ref.via);
  switch (ref.kind) {
    case 'skill':
      return {
        kind: ref.kind,
        sourceId: ref.sourceId,
        skillName: ref.skillName,
        via,
      };
    case 'plugin':
      return {
        kind: ref.kind,
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
        via,
      };
    case 'mcpServer':
      return {
        kind: ref.kind,
        serverId: ref.serverId,
        configId: ref.configId,
        via,
      };
  }
}

/**
 * Code-unit string ordering. Deliberately NOT `localeCompare`: the bundle
 * digest is defined over this ordering, so it must be byte-identical in every
 * runtime, while `localeCompare` varies with locale and ICU data.
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Builds a record from entries whose keys come from bundle data. Uses
 * `Object.fromEntries`, which DEFINES each own property: plain `map[key] = …`
 * assignment routes a `__proto__` key through the inherited
 * `Object.prototype.__proto__` setter instead, which silently drops the entry
 * (string value) or reassigns the record's own prototype (object value). Both
 * header keys and MCP server names are unconstrained bundle data, so every
 * record keyed by them is built here.
 */
function recordFromEntries<T>(
  entries: readonly (readonly [string, T])[],
): Record<string, T> {
  return Object.fromEntries(entries);
}

function sortRecordKeys(
  record: Record<string, string>,
): Record<string, string> {
  const entries: [string, string][] = Object.keys(record)
    .sort()
    .map((key) => [key, record[key]]);
  return recordFromEntries(entries);
}

/**
 * Prefix of a formatted capability bundle digest. The full digest string is
 * this prefix followed by the base64url sha256 of the canonical
 * serialization.
 *
 * Protocol deliberately does NOT compute sha256 — this module is Node-free
 * and dependency-free, so hashing stays with producers (desktop/web), which
 * hash {@link serializeCanonicalCapabilityBundle}'s output with their own
 * crypto and format the result via {@link formatCapabilityBundleDigest}.
 */
export const CAPABILITY_BUNDLE_DIGEST_PREFIX = 'cb:v1:';

const CAPABILITY_BUNDLE_DIGEST_BODY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Formats a producer-computed base64url sha256 as a bundle digest string. */
export function formatCapabilityBundleDigest(sha256Base64Url: string): string {
  return `${CAPABILITY_BUNDLE_DIGEST_PREFIX}${sha256Base64Url}`;
}

/** Whether `value` is a well-formed bundle digest (prefix + base64url body). */
export function isCapabilityBundleDigest(value: string): boolean {
  if (!value.startsWith(CAPABILITY_BUNDLE_DIGEST_PREFIX)) return false;
  const body = value.slice(CAPABILITY_BUNDLE_DIGEST_PREFIX.length);
  return CAPABILITY_BUNDLE_DIGEST_BODY_PATTERN.test(body);
}

// ---------------------------------------------------------------------------
// Per-harness MCP projections.
//
// The bundle itself is harness-neutral; these pure helpers emit each
// adapter's NATIVE config map so runners never hand-translate entries.
// ---------------------------------------------------------------------------

/**
 * Projects the bundle's MCP servers into the Claude Agent SDK's
 * `mcpServers` map format used by the Claude Code adapter:
 * `{ [name]: { type: 'http', url, headers? } }`. Bundle display labels and tool
 * allow-lists are intentionally omitted: the Claude SDK accepts neither key.
 */
export function projectMcpServersForClaudeCode(
  bundle: CapabilityBundleV1,
): Record<
  string,
  { type: 'http'; url: string; headers?: Record<string, string> }
> {
  const entries: [
    string,
    { type: 'http'; url: string; headers?: Record<string, string> },
  ][] = bundle.mcpServers.map((server) => [
    server.name,
    {
      type: 'http',
      url: server.url,
      ...(server.headers === undefined ? {} : { headers: server.headers }),
    },
  ]);
  return recordFromEntries(entries);
}

/**
 * Projects the bundle's MCP servers into Codex's `config.toml`
 * `mcp_servers` table format (snake_case):
 * `{ [name]: { url, http_headers?, enabled_tools? } }`.
 */
export function projectMcpServersForCodex(bundle: CapabilityBundleV1): Record<
  string,
  {
    url: string;
    http_headers?: Record<string, string>;
    enabled_tools?: string[];
  }
> {
  const entries: [
    string,
    {
      url: string;
      http_headers?: Record<string, string>;
      enabled_tools?: string[];
    },
  ][] = bundle.mcpServers.map((server) => [
    server.name,
    {
      url: server.url,
      ...(server.headers === undefined ? {} : { http_headers: server.headers }),
      ...(server.enabledTools === undefined
        ? {}
        : { enabled_tools: server.enabledTools }),
    },
  ]);
  return recordFromEntries(entries);
}

// ---------------------------------------------------------------------------
// Hot-swap wire types — adoption notes.
//
// (Protocol subpaths have no README precedent, so these adoption notes live
// here as module docs, next to the wire types they describe.)
//
// Desktop adoption path. Desktop already resolves selections locally:
// `resolvePlugins` in `packages/desktop-shared/src/node/plugins/
// plugin-resolver.ts` produces `ResolvedPluginRuntime`, and the Codex
// capability-fingerprint flow (`packages/desktop-shared/src/node/
// codex-runtime/capability-fingerprint.ts`) already digests the effective
// capability set to decide when a thread's capabilities changed. The plan is
// for those flows to later EMIT this same bundle shape for local
// materialization — an extension of the existing resolver, not a fork: the
// resolver keeps owning resolution, and the bundle becomes its serialized,
// digested output.
//
// Relationship to the desktop-core-daemon plan (docs/planning/
// 2026-07-31-desktop-core-daemon/18-cloud-runtimes-and-multi-daemon-
// orchestration.md). The capability bundle is the "plugin, skill, MCP
// configuration snapshot or content-addressed reference plus schema version +
// digest" slot of that plan's `ExecutorActivationBundle`. It is embeddable by
// VALUE (the full `CapabilityBundleV1` JSON) or by digest REFERENCE
// (`CapabilityBundleRef`), and it is activation-only: an immutable executor
// input handed over at activation, never a settings-sync domain or a second
// runtime API.
//
// Transport into agentic-core. The bundle travels as an OPAQUE,
// digest-verified JSON blob: the producer serializes canonically, hashes,
// and sends `{ digest, payload }`; the runtime re-serializes with
// `serializeCanonicalCapabilityBundle`, re-hashes, and rejects on mismatch.
// agentic-core mirrors a minimal versioned reader type in its own contracts
// lib rather than depending on `@canopy/protocol`, so the dependency
// direction stays app → protocol and cloud runtimes stay decoupled from this
// repo's release cadence.
//
// Turn-boundary hot-swap semantics. A session tracks
// `CapabilityBundleSessionState`: the ACTIVE bundle is what the current turn
// runs with; setting a PENDING bundle never interrupts a turn in flight.
// At the next turn boundary the runtime atomically applies the pending
// bundle (validate → activate → clear pending) and emits
// `CapabilityBundleAppliedEvent`. There is NO mid-turn interrupt in v1. The
// future mid-turn extension path is the desktop deferred-tools reload
// (`packages/desktop-shared/src/types/deferred-tools.ts`), which already
// hot-enables capabilities by stopping and resuming the active turn; a later
// version can reuse that stop/resume seam to apply a pending bundle mid-turn
// instead of waiting for the boundary.
// ---------------------------------------------------------------------------

/**
 * Reference to a produced bundle by digest. `version` echoes the bundle's
 * `version` field so consumers can gate before fetching the payload;
 * `digest` is a {@link formatCapabilityBundleDigest}-formatted string.
 */
export interface CapabilityBundleRef {
  version: number;
  digest: string;
}

/**
 * Per-session bundle state for turn-boundary hot-swap. `activeBundle` is
 * what the current/next turn runs with. A `pendingBundle` applies at the
 * NEXT turn boundary — there is no mid-turn interrupt in v1 (see the
 * hot-swap adoption notes above for the future mid-turn path).
 */
export interface CapabilityBundleSessionState {
  activeBundle?: CapabilityBundleRef;
  pendingBundle?: CapabilityBundleRef;
}

/**
 * Emitted when a runtime applies a bundle to a session at a turn boundary.
 * `previousDigest` is absent for the first activation; `appliedAtTurn` is
 * the ordinal of the first turn that runs with the new bundle.
 */
export interface CapabilityBundleAppliedEvent {
  sessionId: string;
  digest: string;
  previousDigest?: string;
  appliedAtTurn: number;
}

/** Validates a bundle digest reference structurally. */
export function isCapabilityBundleRef(
  value: unknown,
): value is CapabilityBundleRef {
  return (
    isRecord(value) &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    value.version >= 1 &&
    typeof value.digest === 'string' &&
    isCapabilityBundleDigest(value.digest)
  );
}

/** Validates per-session hot-swap state structurally. */
export function isCapabilityBundleSessionState(
  value: unknown,
): value is CapabilityBundleSessionState {
  return (
    isRecord(value) &&
    (value.activeBundle === undefined ||
      isCapabilityBundleRef(value.activeBundle)) &&
    (value.pendingBundle === undefined ||
      isCapabilityBundleRef(value.pendingBundle))
  );
}

/** Validates a bundle-applied event structurally. */
export function isCapabilityBundleAppliedEvent(
  value: unknown,
): value is CapabilityBundleAppliedEvent {
  return (
    isRecord(value) &&
    isNonEmptyString(value.sessionId) &&
    typeof value.digest === 'string' &&
    isCapabilityBundleDigest(value.digest) &&
    (value.previousDigest === undefined ||
      (typeof value.previousDigest === 'string' &&
        isCapabilityBundleDigest(value.previousDigest))) &&
    typeof value.appliedAtTurn === 'number' &&
    Number.isSafeInteger(value.appliedAtTurn) &&
    value.appliedAtTurn >= 0
  );
}
