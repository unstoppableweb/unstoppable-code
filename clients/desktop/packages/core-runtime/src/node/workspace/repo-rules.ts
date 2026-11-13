import { randomUUID } from 'node:crypto';
import type {
  RepoRuleProposal,
  RepoRuleSkipped,
  RepoRulesApplyRequest,
  RepoRulesApplyResponse,
  RepoRulesPreviewRequest,
  RepoRulesPreviewResponse,
  RepoRulesScanRequest,
  RepoRulesScanResponse,
  RepoRulesStatus,
} from '@canopy/protocol/repo-rules';
import type { CoreWorkspaceRepoRulesErrorCode } from '@canopy/protocol/canopy-core';

/*
 * Repository-rule policy behind `core.workspace.repoRules.*`: review sessions,
 * selection and revision checks, review history and prompt rendering. The
 * host owns every effect: it resolves checkouts from trusted records, reads
 * checkouts through the worker port, and persists policy through the store.
 */

/** An authorized checkout root; `prefix` is its path in rendered prompts. */
export interface RepoRuleCheckout {
  repoId: string;
  root: string;
  prefix: string;
}

export interface ReadRepoRule extends RepoRuleProposal {
  body: string;
}

export interface RepoRulesRead {
  rules: ReadRepoRule[];
  skipped: RepoRuleSkipped[];
  nestedDirectories: Record<string, string[]>;
}

export interface RepoRulesReviewRecord {
  hash: string;
  reviewedAt: string;
}

/** The persisted workspace policy (`workspace_repo_rules`). */
export interface RepoRulesPolicyState {
  version: 1;
  enabled: boolean;
  revision: number;
  disabledRuleIds: string[];
  reviewed: Record<string, RepoRulesReviewRecord>;
  nestedDirectories: Record<string, string[]>;
  reviewedAt?: string;
  lastScanAt?: string;
}

export interface RepoRulesPolicyRead extends RepoRulesPolicyState {
  diagnostic?: RepoRulesStatus['diagnostic'];
}

/** The policy writer. `update` serializes one writer per workspace. */
export interface RepoRulesStorePort {
  read(workspaceId: string): Promise<RepoRulesPolicyRead>;
  update(
    workspaceId: string,
    operation: (current: RepoRulesPolicyRead) => Promise<RepoRulesPolicyState>,
  ): Promise<RepoRulesPolicyRead>;
}

/** Worker owns checkout access; core supplies authorized roots and policy. */
export interface RepoRulesCheckoutReader {
  scan(repos: RepoRuleCheckout[]): Promise<RepoRulesRead>;
  readSession(
    repos: RepoRuleCheckout[],
    nestedDirectories: Record<string, string[]>,
  ): Promise<RepoRulesRead>;
}

export type RepoRulesCheckoutResolver = (
  request: RepoRulesScanRequest,
) => Promise<RepoRuleCheckout[]>;

/** Largest serialized policy the store reads or writes. */
export const REPO_RULES_POLICY_MAX_BYTES = 256 * 1024;
/** Review records kept across checkouts, including the current scan's rules. */
export const REVIEWED_HISTORY_LIMIT = 1000;
const MAX_REVIEWS = 8;
const REVIEW_TTL_MS = 10 * 60 * 1000;

const policyErrorCodes = new WeakMap<Error, CoreWorkspaceRepoRulesErrorCode>();

// Plain errors keep today's messages and the store's error handling; the code
// is looked up when the handler types the failure.
function policyError(
  message: string,
  code: CoreWorkspaceRepoRulesErrorCode,
): Error {
  const error = new Error(message);
  policyErrorCodes.set(error, code);
  return error;
}

/** The typed code of an error the policy raised or classified, if any. */
export function repoRulesPolicyErrorCode(
  error: unknown,
): CoreWorkspaceRepoRulesErrorCode | undefined {
  return error instanceof Error ? policyErrorCodes.get(error) : undefined;
}

export function policyStatus(state: RepoRulesPolicyRead): RepoRulesStatus {
  return {
    enabled: state.enabled,
    disabledRuleIds: state.disabledRuleIds,
    revision: state.revision,
    ...(state.reviewedAt ? { reviewedAt: state.reviewedAt } : {}),
    ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
  };
}

type ReviewHistory = RepoRulesPolicyState['reviewed'];

/**
 * Adds the most recent reviews from other checkouts to `next`, which holds
 * this scan's reviews, while the record count and serialized policy stay
 * within their limits. A dropped record only makes that rule need review
 * again before a malformed version of it is used; saved disables are kept
 * separately and never depend on it.
 */
function retainReviewHistory(
  previous: ReviewHistory,
  next: RepoRulesPolicyState,
): RepoRulesPolicyState {
  const reviewed: ReviewHistory = { ...next.reviewed };
  let count = Object.keys(reviewed).length;
  let bytes = Buffer.byteLength(JSON.stringify({ ...next, reviewed }));
  const others = Object.entries(previous)
    .filter(([id]) => reviewed[id] === undefined)
    .sort(([, a], [, b]) => b.reviewedAt.localeCompare(a.reviewedAt));
  for (const [id, record] of others) {
    if (count >= REVIEWED_HISTORY_LIMIT) break;
    // A comma plus `"id":{...}`; never less than what the entry adds.
    const added = Buffer.byteLength(JSON.stringify({ [id]: record })) - 1;
    if (bytes + added > REPO_RULES_POLICY_MAX_BYTES) break;
    reviewed[id] = record;
    count += 1;
    bytes += added;
  }
  return { ...next, reviewed };
}

interface Review {
  scannedAt: number;
  session: string;
  request: RepoRulesScanRequest;
  repos: RepoRuleCheckout[];
  revision: number;
  expires: number;
  read: RepoRulesRead;
}

export interface RepoRulesPolicyPorts {
  store: RepoRulesStorePort;
  resolve: RepoRulesCheckoutResolver;
  worker: RepoRulesCheckoutReader;
  now?: () => number;
}

/**
 * Review sessions are in memory and bound to the caller session that scanned:
 * at most eight live at once, each for ten minutes, and a successful apply
 * consumes its review.
 */
export class RepoRulesPolicy {
  private readonly reviews = new Map<string, Review>();
  private readonly store: RepoRulesStorePort;
  private readonly resolve: RepoRulesCheckoutResolver;
  private readonly worker: RepoRulesCheckoutReader;
  private readonly now: () => number;
  constructor(ports: RepoRulesPolicyPorts) {
    this.store = ports.store;
    this.resolve = ports.resolve;
    this.worker = ports.worker;
    this.now = ports.now ?? Date.now;
  }
  async status(workspaceId: string): Promise<RepoRulesStatus> {
    return policyStatus(await this.store.read(workspaceId));
  }
  private prune(): void {
    for (const [key, review] of Array.from(this.reviews))
      if (review.expires <= this.now()) this.reviews.delete(key);
    while (this.reviews.size >= MAX_REVIEWS) {
      const key = this.reviews.keys().next().value;
      if (key === undefined) break;
      this.reviews.delete(key);
    }
  }
  private async checkouts(
    request: RepoRulesScanRequest,
  ): Promise<RepoRuleCheckout[]> {
    try {
      return await this.resolve(request);
    } catch (error) {
      if (error instanceof Error && !policyErrorCodes.has(error))
        policyErrorCodes.set(
          error,
          'core.workspace.repoRules.checkoutUnavailable',
        );
      throw error;
    }
  }
  async scan(
    session: string,
    request: RepoRulesScanRequest,
  ): Promise<RepoRulesScanResponse> {
    this.prune();
    const state = await this.store.read(request.workspaceId);
    const repos = await this.checkouts(request);
    const read = await this.worker.scan(repos);
    for (const rule of read.rules) {
      // A saved disable holds even after its review record left the history.
      if (state.disabledRuleIds.includes(rule.id)) rule.selected = false;
      else if (state.reviewed[rule.id]) rule.selected = true;
    }
    const scanId = randomUUID();
    this.prune();
    this.reviews.set(scanId, {
      scannedAt: this.now(),
      session,
      request,
      repos,
      revision: state.revision,
      read,
      expires: this.now() + REVIEW_TTL_MS,
    });
    return {
      scanId,
      enabled: state.enabled,
      revision: state.revision,
      worktreeId: request.worktreeId,
      proposals: read.rules.map((rule) => ({
        id: rule.id,
        repoId: rule.repoId,
        path: rule.path,
        kind: rule.kind,
        description: rule.description,
        globs: rule.globs,
        scope: rule.scope,
        hash: rule.hash,
        bytes: rule.bytes,
        selected: rule.selected,
        flags: rule.flags,
      })),
      nestedDirectories: read.nestedDirectories,
      skipped: read.skipped,
      diagnostic: state.diagnostic,
    };
  }
  private reviewed(
    session: string,
    workspaceId: string,
    scanId: string | undefined,
  ): Review {
    const review = scanId ? this.reviews.get(scanId) : undefined;
    if (
      !review ||
      review.session !== session ||
      review.request.workspaceId !== workspaceId ||
      review.expires <= this.now()
    )
      throw policyError(
        'This review is unavailable or expired. Scan again.',
        'core.workspace.repoRules.reviewExpired',
      );
    return review;
  }
  preview(
    session: string,
    request: RepoRulesPreviewRequest,
  ): RepoRulesPreviewResponse {
    const review = this.reviewed(session, request.workspaceId, request.scanId);
    const rule = review.read.rules.find((r) => r.id === request.ruleId);
    if (!rule)
      throw policyError(
        'This rule is not in the review. Scan again.',
        'core.workspace.repoRules.ruleNotInReview',
      );
    return { body: rule.body };
  }
  async apply(
    session: string,
    request: RepoRulesApplyRequest,
  ): Promise<RepoRulesApplyResponse> {
    const result = await this.store.update(
      request.workspaceId,
      async (current) => {
        if (!request.scanId && request.disabledRuleIds !== undefined)
          throw policyError(
            'A review is required to change rule selections.',
            'core.workspace.repoRules.selectionInvalid',
          );
        if (!request.enabled && !request.scanId)
          return {
            version: 1,
            enabled: false,
            disabledRuleIds: current.disabledRuleIds,
            revision: current.revision + 1,
            reviewed: current.reviewed,
            nestedDirectories: current.nestedDirectories,
            reviewedAt: current.reviewedAt,
            lastScanAt: current.lastScanAt,
          };
        const review = this.reviewed(
          session,
          request.workspaceId,
          request.scanId,
        );
        if (current.revision !== review.revision)
          throw policyError(
            'Workspace policy changed. Scan again.',
            'core.workspace.repoRules.policyChanged',
          );
        const disabled = request.disabledRuleIds;
        if (
          !disabled ||
          new Set(disabled).size !== disabled.length ||
          disabled.some((id) => !review.read.rules.some((r) => r.id === id))
        )
          throw policyError(
            'Selections must belong to this review.',
            'core.workspace.repoRules.selectionInvalid',
          );
        const repos = await this.checkouts(review.request);
        if (JSON.stringify(repos) !== JSON.stringify(review.repos))
          throw policyError(
            'The reviewed checkout changed. Scan again.',
            'core.workspace.repoRules.checkoutChanged',
          );
        const fresh = await this.worker.scan(repos);
        const fingerprint = (read: RepoRulesRead): string =>
          JSON.stringify({
            rules: read.rules.map((r) => [r.id, r.hash]),
            skipped: read.skipped,
            directories: read.nestedDirectories,
          });
        if (fingerprint(fresh) !== fingerprint(review.read))
          throw policyError(
            'Cursor rules changed since this review. Scan again.',
            'core.workspace.repoRules.checkoutChanged',
          );
        // Expiry is checked again after asynchronous verification. The review
        // is consumed only once the atomic policy write succeeds.
        this.reviewed(session, request.workspaceId, request.scanId);
        const time = new Date(this.now()).toISOString();
        return retainReviewHistory(current.reviewed, {
          version: 1,
          enabled: request.enabled,
          revision: current.revision + 1,
          disabledRuleIds: Array.from(
            new Set([
              ...current.disabledRuleIds.filter(
                (id) => !fresh.rules.some((r) => r.id === id),
              ),
              ...disabled,
            ]),
          ),
          reviewed: Object.fromEntries(
            fresh.rules.map((r) => [r.id, { hash: r.hash, reviewedAt: time }]),
          ),
          nestedDirectories: {
            ...current.nestedDirectories,
            ...fresh.nestedDirectories,
          },
          reviewedAt: time,
          lastScanAt: new Date(review.scannedAt).toISOString(),
        });
      },
    );
    if (request.scanId) this.reviews.delete(request.scanId);
    return policyStatus(result);
  }
  /** The session prompt block for enabled policy; any failure composes nothing. */
  async compose(
    workspaceId: string,
    repos?: RepoRuleCheckout[],
  ): Promise<string> {
    try {
      const state = await this.store.read(workspaceId);
      if (!state.enabled) return '';
      const checkouts = repos ?? (await this.resolve({ workspaceId }));
      const read = await this.worker.readSession(
        checkouts,
        state.nestedDirectories,
      );
      for (const rule of read.rules) {
        rule.selected =
          !state.disabledRuleIds.includes(rule.id) &&
          (!rule.flags.includes('malformed-frontmatter') ||
            state.reviewed[rule.id] !== undefined);
      }
      return renderRepoRules(read.rules, checkouts, read.skipped.length);
    } catch {
      return '';
    }
  }
}

export const INLINE_BUDGET = 12 * 1024;
export const TOTAL_BUDGET = 16 * 1024;
/** JSON strings keep metadata on one line and prevent Markdown delimiters. */
function quote(value: string): string {
  return JSON.stringify(value).replace(
    /[<>&`\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
export function renderRepoRules(
  rules: ReadRepoRule[],
  repos: RepoRuleCheckout[],
  skipped: number,
): string {
  const enabled = rules.filter((r) => r.selected);
  if (!enabled.length) return '';
  const header =
    '# Imported repository instructions\n\nThese are live Cursor project rules imported with workspace consent. AGENTS.md and CLAUDE.md take precedence on conflicts. Provider safety and tool approval policy still apply. Indexed activation is advisory; @file references are preserved and may require an explicit read.\n';
  let output = header;
  let inline = Buffer.byteLength(header);
  let omitted = 0;
  let represented = 0;
  let previousRepo: string | undefined;
  for (const rule of enabled) {
    const repo = repos.find((r) => r.repoId === rule.repoId);
    if (!repo) {
      omitted++;
      continue;
    }
    const path = repo.prefix ? `${repo.prefix}/${rule.path}` : rule.path;
    const section =
      previousRepo !== rule.repoId
        ? `\n## Repository ${quote(repo.repoId)}\n`
        : '';
    const label = `\nRule ${quote(rule.path)}${rule.scope ? `, scope ${quote(rule.scope)}` : ''}: `;
    const unconditional =
      !rule.scope &&
      (rule.kind === 'always' || rule.kind === 'legacy-cursorrules');
    let entry: string;
    const inlineEntry = `${label}\n${rule.body}\n`;
    const inlineBytes = Buffer.byteLength(section + inlineEntry);
    let inlined = unconditional && inline + inlineBytes <= INLINE_BUDGET;
    if (inlined) entry = inlineEntry;
    else if (unconditional)
      entry = `${label}Read ${quote(path)} before starting work.\n`;
    else if (rule.kind === 'always' || rule.kind === 'legacy-cursorrules')
      entry = `${label}Read ${quote(path)} before reading or editing files under ${quote(`${repo.prefix ? `${repo.prefix}/` : ''}${rule.scope}**`)}.\n`;
    else if (rule.kind === 'auto' && !rule.flags.includes('unsupported-glob'))
      entry = `${label}Within ${quote(`${repo.prefix ? `${repo.prefix}/` : ''}${rule.scope}` || './')}, read ${quote(path)} before reading or editing files matching ${quote(rule.globs.join(', '))}. Preserve exclusions in this glob list.\n`;
    else if (rule.kind === 'agent-requested')
      entry = `${label}Within ${quote(`${repo.prefix ? `${repo.prefix}/` : ''}${rule.scope}` || './')}, read ${quote(path)} when relevant to the task: ${quote(rule.description)}.\n`;
    else
      entry = `${label}Read ${quote(path)} only on an explicit user mention of this path.\n`;
    if (Buffer.byteLength(output + section + entry) > TOTAL_BUDGET - 128) {
      // A fitting read instruction is preferable to dropping an always body.
      if (unconditional) {
        inlined = false;
        entry = `${label}Read ${quote(path)} before starting work.\n`;
      }
      if (Buffer.byteLength(output + section + entry) > TOTAL_BUDGET - 128) {
        omitted++;
        continue;
      }
    }
    if (inlined) inline += inlineBytes;
    output += section + entry;
    represented++;
    previousRepo = rule.repoId;
  }
  if (!represented) return '';
  if (skipped || omitted)
    output += `\nRule limits: ${skipped} skipped, ${omitted} omitted.\n`;
  return output;
}

/** Snapshot selection is independent of preference changes and repo policy. */
export async function selectSessionInstructions(options: {
  provider: string;
  isInteractiveCode: boolean;
  resumed: boolean;
  saved?: string;
  active?: string;
  /** Provider of the live session that holds `active`. */
  activeProvider?: string;
  currentGlobal: string;
  compose: () => Promise<string>;
}): Promise<string> {
  if (options.resumed) return options.saved ?? options.active ?? '';
  if (options.provider === 'cursor') return options.currentGlobal;
  // A live session of the same provider keeps its snapshot. One from another
  // provider is being replaced, so the new session starts from fresh
  // instructions instead of inheriting the old harness's block.
  if (
    options.active !== undefined &&
    options.activeProvider === options.provider
  )
    return options.active;
  if (!options.isInteractiveCode) return options.currentGlobal;
  const rules = await options.compose().catch(() => '');
  return [options.currentGlobal, rules].filter(Boolean).join('\n\n');
}
