import type { ApprovalRuleTarget, SafetyDenyReason } from './approvals';

export type ApprovalMode = 'ask' | 'auto' | 'full-access';
export const APPROVAL_MODES: readonly ApprovalMode[] = [
  'ask',
  'auto',
  'full-access',
];

export type ApprovalRuleOrigin = 'prompt' | 'settings' | 'canopy-json';

export interface ApprovalRule {
  id: string;
  behavior: 'allow' | 'deny';
  target: ApprovalRuleTarget;
  createdAt: string;
  origin: ApprovalRuleOrigin;
}

export type ApprovalCheck =
  | {
      kind: 'command';
      command: string;
      /** Shell parsing rules used for command-boundary safety checks. */
      shellPlatform?: 'posix' | 'windows';
      /** Effective working directory supplied by the provider for this command. */
      cwd?: string;
      /** Canonical command operands resolved by the main process. */
      resolvedPaths?: string[];
      /** Canonical roots protected by the destructive-command safety deny. */
      protectedRoots?: string[];
      /** A command operand or its effective working directory was ambiguous. */
      pathResolutionFailed?: boolean;
    }
  | {
      kind: 'file-write';
      path: string;
      /** Canonical main-process path used for containment and rule matching. */
      resolvedPath?: string;
      /**
       * The path describes a filesystem authority grant (root/glob/subtree),
       * not one concrete write. Deny rules that fall within the grant must
       * therefore block it even when they do not match the literal path.
       */
      isGrant?: boolean;
    }
  | { kind: 'mcp'; server: string; tool: string }
  | {
      kind: 'network';
      host: string;
      /** The host describes a network authority grant such as all hosts. */
      isGrant?: boolean;
    }
  | {
      /**
       * A tool without `readPath` has no path semantics: only rules and the
       * mode answer it, and Auto never allows it on its own.
       */
      kind: 'tool';
      toolName: string;
      /**
       * Absolute target of a read tool (Read, NotebookRead, Glob, Grep), set
       * by the adapter only when the provider named an absolute path with no
       * `~` or `..` segment, or a Glob or Grep omitted `path` and targets the
       * launch cwd.
       */
      readPath?: string;
      /**
       * Canonical `readPath`, filled in by the main process only and never by
       * adapters. Auto read containment uses this field alone.
       */
      resolvedReadPath?: string;
    }
  | {
      kind: 'browser-upload';
      /** Origin of the frame that owns the file input. */
      origin: string;
      /** Origin of the page, shown as context. */
      topOrigin: string;
      /**
       * `displayPath` is the file itself after links, which every rule
       * matches; `requestedPath` is the path asked for when a link made it
       * differ, which deny rules match too.
       */
      files: Array<{
        displayPath: string;
        requestedPath?: string;
        sizeBytes: number;
      }>;
    }
  | {
      /**
       * `browser.request_files`: the user picks the files, so no rule or mode
       * answers it; the user chooses or declines.
       */
      kind: 'browser-file-request';
      /** Origin of the frame that owns the file input. */
      origin: string;
      /** Origin of the page, shown as context. */
      topOrigin: string;
      multiple: boolean;
    }
  | {
      /**
       * RunWithSecrets or WriteSecretsFile about to hand chat secrets to a
       * command or file. Full Access allows it; every other mode prompts, and
       * no rule answers it, so an "always allow" never covers a use of
       * secrets (agent secret requests, v1).
       */
      kind: 'agent-secret-use';
      tool: 'RunWithSecrets' | 'WriteSecretsFile';
      /** The secret names the command or file receives; never values. */
      secretNames: string[];
    };

export interface ApprovalRuleSets {
  session: ApprovalRule[];
  project: ApprovalRule[];
  global: ApprovalRule[];
}

export interface ApprovalEvaluationContext {
  mode: ApprovalMode;
  rules: ApprovalRuleSets;
  /** Absolute workspace/worktree root used by 'auto' mode file-write auto-approval. */
  workspaceRoot?: string;
  /**
   * Whether filesystem paths and executable lookup in this evaluation are
   * case-insensitive. The desktop main process probes the canonical workspace
   * path once per approval session and supplies the result.
   */
  pathCaseInsensitive?: boolean;
  /**
   * Canonical policy files that governed agents must never silently modify.
   * A `*` in an entry matches any characters within one path segment, so one
   * entry can name files created later, such as timestamped backups. A final
   * `**` segment protects the folder before it and everything below it.
   */
  protectedFileWritePaths?: readonly string[];
  /**
   * Canonical folders inside a protected tree that agents work in: a path at
   * or below one is not protected. A `*` matches within one path segment.
   */
  protectedFileExemptPaths?: readonly string[];
}

export type ApprovalEvaluation =
  | { outcome: 'allow'; matchedRule?: ApprovalRule }
  | {
      outcome: 'deny';
      matchedRule?: ApprovalRule;
      safety?: false;
      safetyReason?: never;
    }
  | {
      outcome: 'deny';
      safety: true;
      safetyReason: SafetyDenyReason;
      matchedRule?: never;
    }
  | { outcome: 'prompt' };

export interface ApprovalsFile {
  version: 1;
  rules: ApprovalRule[];
  /** Optional per-workspace default mode override. */
  defaultMode?: ApprovalMode;
}

/** Per-surface default approval modes (`worktree` | `cowork` | `appAdvisor`). */
export interface ApprovalDefaults {
  worktree: ApprovalMode;
  cowork: ApprovalMode;
  appAdvisor: ApprovalMode;
}

/**
 * The shipped product posture for a surface whose `approvalDefaults` key is
 * absent (CAN-3055). Browser-safe and declared once so the main-process
 * `DEFAULT_PREFERENCES`, the Settings fallback, the composer display fallback,
 * and the renderer test fixtures all derive from ONE value.
 *
 * A hand-maintained copy per renderer mirror is exactly how
 * `git-tab-fallback-preferences.ts` silently went stale on Ask while the
 * product default had already moved to Full Access. Do not reintroduce a
 * literal; import this instead.
 *
 * This is the *product default*, not a fail-closed fallback. A read that
 * failed must resolve to Ask instead — see `UNRESOLVABLE_TARGET_APPROVAL_MODE`
 * and `approvalDefaultsFromPreferences` in the desktop app.
 */
export const DEFAULT_APPROVAL_DEFAULTS: Readonly<ApprovalDefaults> =
  Object.freeze({
    worktree: 'full-access',
    cowork: 'full-access',
    appAdvisor: 'full-access',
  });

/** Fresh mutable copy of {@link DEFAULT_APPROVAL_DEFAULTS}. */
export function createDefaultApprovalDefaults(): ApprovalDefaults {
  return { ...DEFAULT_APPROVAL_DEFAULTS };
}

/**
 * Fail-closed approval mode for a decision made on evidence we do not have —
 * an unresolvable target, or persisted state that could not be read or parsed.
 * Deliberately separate from {@link DEFAULT_APPROVAL_DEFAULTS}: that one tracks
 * the shipped product posture, this one is what a *failure* must resolve to.
 * Do not collapse them.
 */
export const FAIL_CLOSED_APPROVAL_MODE: ApprovalMode = 'ask';

/**
 * The approval surface keys, in one place. Runtime validators must derive from
 * this rather than repeating the literals: `SetApprovalDefaultPreferenceRequest`
 * types `surface` as `keyof ApprovalDefaults`, so a hardcoded check would let a
 * newly added surface type-check everywhere and then be rejected at runtime.
 */
export const APPROVAL_DEFAULT_SURFACES = Object.freeze(
  Object.keys(DEFAULT_APPROVAL_DEFAULTS) as (keyof ApprovalDefaults)[],
);

export function isApprovalDefaultSurface(
  value: unknown,
): value is keyof ApprovalDefaults {
  return (
    typeof value === 'string' &&
    APPROVAL_DEFAULT_SURFACES.includes(value as keyof ApprovalDefaults)
  );
}

/**
 * All surfaces at {@link FAIL_CLOSED_APPROVAL_MODE}. Used when persisted state
 * exists but is corrupt: resolving corruption *upward* to the product default
 * would silently escalate a user who had chosen Ask.
 */
export function createFailClosedApprovalDefaults(): ApprovalDefaults {
  const defaults = createDefaultApprovalDefaults();
  for (const surface of APPROVAL_DEFAULT_SURFACES) {
    defaults[surface] = FAIL_CLOSED_APPROVAL_MODE;
  }
  return defaults;
}

/** Type guard for {@link ApprovalMode}. */
export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (
    typeof value === 'string' && APPROVAL_MODES.some((mode) => mode === value)
  );
}

const VALID_BEHAVIORS: ReadonlySet<string> = new Set(['allow', 'deny']);
const VALID_ORIGINS: ReadonlySet<string> = new Set([
  'prompt',
  'settings',
  'canopy-json',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isApprovalRuleBehavior(
  value: unknown,
): value is ApprovalRule['behavior'] {
  return typeof value === 'string' && VALID_BEHAVIORS.has(value);
}

function isApprovalRuleOrigin(value: unknown): value is ApprovalRuleOrigin {
  return typeof value === 'string' && VALID_ORIGINS.has(value);
}

function normalizeApprovalRuleTarget(
  value: unknown,
): ApprovalRuleTarget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = value.kind;
  if (kind === 'command') {
    return typeof value.pattern === 'string'
      ? { kind: 'command', pattern: value.pattern }
      : undefined;
  }
  if (kind === 'file-write') {
    return typeof value.path === 'string'
      ? { kind: 'file-write', path: value.path }
      : undefined;
  }
  if (kind === 'mcp') {
    if (typeof value.server !== 'string') {
      return undefined;
    }
    if (value.tool !== undefined && typeof value.tool !== 'string') {
      return undefined;
    }
    if (value.tool === undefined) {
      return { kind: 'mcp', server: value.server };
    }
    return { kind: 'mcp', server: value.server, tool: value.tool };
  }
  if (kind === 'network') {
    return typeof value.host === 'string'
      ? { kind: 'network', host: value.host }
      : undefined;
  }
  if (kind === 'tool') {
    return typeof value.toolName === 'string'
      ? { kind: 'tool', toolName: value.toolName }
      : undefined;
  }
  if (kind === 'browser-upload') {
    if (typeof value.origin !== 'string') return undefined;
    if (value.path === undefined)
      return { kind: 'browser-upload', origin: value.origin };
    return typeof value.path === 'string'
      ? { kind: 'browser-upload', origin: value.origin, path: value.path }
      : undefined;
  }
  return undefined;
}

function normalizeApprovalRule(value: unknown): ApprovalRule | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isApprovalRuleBehavior(value.behavior)) {
    return undefined;
  }
  const target = normalizeApprovalRuleTarget(value.target);
  if (!target) {
    return undefined;
  }
  const id = typeof value.id === 'string' ? value.id : '';
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : '';
  const origin = isApprovalRuleOrigin(value.origin) ? value.origin : 'settings';
  return {
    id,
    behavior: value.behavior,
    target,
    createdAt,
    origin,
  };
}

/**
 * Leniently validates and normalizes unknown persisted/imported input into
 * an array of {@link ApprovalRule}. Invalid entries are dropped rather than
 * throwing; missing `origin` coerces to `'settings'` and missing
 * `createdAt` coerces to `''`.
 */
export function normalizeApprovalRules(value: unknown): ApprovalRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: ApprovalRule[] = [];
  for (const entry of value) {
    const rule = normalizeApprovalRule(entry);
    if (rule) {
      result.push(rule);
    }
  }
  return result;
}
