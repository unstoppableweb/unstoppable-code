import { hasAnySelections } from '../../types';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { CursorReportedUsage } from '@canopy/agent-transcript/lib/cursor-usage';
import { classifyAgentFailure } from '@canopy/execution-engine/agent-failures';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import {
  appendCodexSchemaInstruction,
  buildCodexStructuredOutputRetryPrompt,
  CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import { validateAgainstSchema } from '../../lib/ajv-schema-validator';
import { describeJsonParseFailure } from '@canopy/execution-engine/lib/redaction';
import { stepTimedOutMessage } from '@canopy/execution-engine/node/pipelines/step-timeout';
import { getRawCursorModelId } from '@canopy/execution-engine/lib/cursor-models';
import type { CursorRuntimeTarget } from '../../lib/cursor-runtime-targets';
import { buildPipelineGlobalInstructionsBlock } from '@canopy/execution-engine/lib/global-instructions';
import type { HelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import {
  getBundledRtkBinaryPath,
  getCursorRuntimeStateDir,
  getEnhancedEnv,
  getRtkManagedEnv,
} from '@canopy/execution-engine/pipelines/config-paths';
import {
  createHeadlessCursorHost,
  extractProposedPlan,
} from '../cursor/headless-policy';
import {
  prepareCursorRuntimeEnvironment,
  withheldCursorEnvironmentNames,
} from '../cursor/runtime-environment';
import type { CursorLaunch } from '../cursor/runtime-launch';
import { CURSOR_RUNTIME_VERSION } from '../cursor/runtime-metadata';
import {
  verifyCursorRuntimeVersion,
  type CursorProviderProcess,
} from '../cursor/runtime-process';
import type { ProviderProcessSpawner } from '../provider-process/spawn';
import { runCursorTurn } from '../cursor/turn-driver';
import {
  getPipelineExecutionCursorProfileDir,
  getPipelineExecutionCursorSessionEntryPath,
  getPipelineExecutionCursorSessionIndexDir,
} from '@canopy/execution-engine/node/lib/paths';
import type {
  CursorPromptRunnerRequest,
  CursorPromptRunnerResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';

export interface CursorPromptDriverOptions {
  launch: CursorLaunch;
  target: CursorRuntimeTarget;
  /** Base environment for the child (no Canopy secrets). */
  baseEnvironment: NodeJS.ProcessEnv;
  /**
   * Where this host's user reinstalls a runtime whose version is wrong.
   * Defaults to desktop Settings.
   */
  reinstallGuidance?: string;
  /** How this host starts Cursor children (CAN-4118). */
  spawner: ProviderProcessSpawner;
}

/** Canonical-home environment keys a pipeline-declared environment must never override. */
const CANONICAL_HOME_ENVIRONMENT_KEYS = new Set([
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOMESHARE',
]);

/**
 * Strips canonical-home overrides from a pipeline-declared environment before
 * it is merged into the Cursor spawn environment. prepareCursorRuntimeEnvironment
 * (below) is the sole authority for Cursor's private home directory overlay and
 * separately deletes every CURSOR_*-prefixed key from the merged object, so a
 * pipeline-declared CURSOR_API_KEY never reaches the spawned child either. This
 * is Cursor's own sanitizer (not a reused Codex helper) so Cursor spawn-state
 * scoping stays independent of Codex's runtime boundary.
 */
export function sanitizeCursorSpawnEnvironment(
  environment: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !CANONICAL_HOME_ENVIRONMENT_KEYS.has(key.toUpperCase()),
    ),
  );
}

function usageToHelperUsage(
  usage: CursorReportedUsage | undefined,
): HelperUsage {
  if (!usage) return { messageCount: 1, assistantMessageCount: 1 };
  // CursorReportedUsage.inputTokens already includes cache reads/writes
  // (see packages/agent-transcript/src/lib/cursor-usage.ts), unlike Claude,
  // where input and cache are independent counters. Subtract the cache
  // portion so HelperUsage's inputTokens stays additive with the cache
  // fields below, mirroring the fix in observability/service.ts.
  const cachePortion =
    (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return {
    inputTokens: usage.inputTokens - cachePortion,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadTokens }
      : {}),
    ...(usage.cacheWriteTokens !== undefined
      ? { cacheCreationInputTokens: usage.cacheWriteTokens }
      : {}),
    messageCount: 1,
    assistantMessageCount: 1,
  };
}

/**
 * Adds two usage snapshots.
 *
 * Within ONE attempt the runner REPLACES rather than sums, and that is the
 * repo's documented contract rather than a guess. `docs/desktop-instrumentation.md`
 * states that the integration "keeps the latest response snapshot in a
 * `canopy_cursor_usage` transcript event" and that replay "never adds duplicate
 * reports or interprets a response as a cumulative turn/session total", and
 * `docs/cursor-chat.md` states that a headless step is exactly one bounded turn
 * so its latest snapshot is applied directly. Summing successive reports of the
 * same response is the behaviour those sentences forbid.
 *
 * Across attempts summing is correct and is what this function exists for: a
 * structured-output retry spawns a new child process and sends a new prompt,
 * resuming the same ACP session when it can, so each attempt's final snapshot
 * is a DISTINCT turn's paid work, not a duplicate report of one response. Summing preserves the
 * `cacheRead + cacheWrite <= inputTokens` invariant `parseCursorReportedUsage`
 * enforces, since it holds for each addend.
 *
 * One question about the CONTRACT itself remains genuinely open, and it is not
 * a question about this function: if a single bounded turn can emit more than
 * one `afterAgentResponse` report whose counters cover only that response
 * (rather than the turn so far), then the documented latest-snapshot rule
 * undercounts that turn everywhere it is applied — interactive display,
 * transcript replay, and this runner alike. Answering it needs a live pinned
 * Cursor runtime driven through a multi-response turn with the hook attached;
 * nothing in this repository records that cadence. Behaviour here is deliberately
 * left matching the documented contract rather than changed on a guess, since
 * guessing wrong in the other direction double-counts numbers users read as
 * cost.
 */
function addCursorReportedUsage(
  carried: CursorReportedUsage | undefined,
  latest: CursorReportedUsage,
): CursorReportedUsage {
  if (!carried) return latest;
  const cacheReadTokens =
    (carried.cacheReadTokens ?? 0) + (latest.cacheReadTokens ?? 0);
  const cacheWriteTokens =
    (carried.cacheWriteTokens ?? 0) + (latest.cacheWriteTokens ?? 0);
  return {
    inputTokens: carried.inputTokens + latest.inputTokens,
    outputTokens: carried.outputTokens + latest.outputTokens,
    ...(carried.cacheReadTokens === undefined &&
    latest.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens }),
    ...(carried.cacheWriteTokens === undefined &&
    latest.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens }),
  };
}

/**
 * True for the ACP client's PROMPT deadline wording specifically — the one
 * bounded by this step's own remaining budget, and therefore the only one
 * that means "this step ran out of time". The driver surfaces it as a plain
 * turn failure, so matching it here is what lets the step report the
 * canonical timeout instead.
 *
 * Deliberately NOT matching the client's generic
 * `'ACP operation did not settle within its deadline'`: `bounded()` throws
 * that for any RPC hitting its own fixed 15s/30s window
 * (`initialize`/`newSession`/`loadSession`/`setSessionConfigOption`),
 * independent of the step budget. Reporting that as "Step timed out after N
 * minute(s)" told anyone debugging a 30-second hiccup that a multi-minute
 * budget had been exhausted. Both strings live in `node/acp/client.ts`.
 */
/**
 * How long the session index write may hold up a step that is already ending.
 *
 * Recording a created session matters enough to await, but a step whose budget
 * has just expired must not then wait out a stuck filesystem — that would turn
 * one enforced deadline back into an unbounded one.
 */
const SESSION_INDEX_WRITE_BUDGET_MS = 2_000;

/**
 * Awaits `work`, but never for longer than `budgetMs`.
 *
 * Returns rather than throws on expiry: the caller's own outcome — a timeout,
 * a cancellation, a success — is the thing being reported, and a slow index
 * write must not replace it.
 */
async function withBoundedWait(
  work: Promise<unknown>,
  budgetMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isAcpDeadlineMessage(message: string): boolean {
  return message === 'ACP prompt did not settle within its deadline';
}

function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text.trim());
  return match ? match[1] : text.trim();
}

interface CursorSessionEntry {
  version: 1;
  /** CURSOR_DATA_DIR the originating conversation used. */
  profileDir: string;
  /** Originating step id, for diagnostics only. */
  stepId: string;
  childId?: string;
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCursorSessionEntry(value: unknown): value is CursorSessionEntry {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.profileDir === 'string' &&
    typeof value.stepId === 'string' &&
    (value.childId === undefined || typeof value.childId === 'string') &&
    typeof value.createdAt === 'string'
  );
}

/**
 * Best-effort read of one session's durable entry file (see
 * `getPipelineExecutionCursorSessionEntryPath`). Absent, corrupt, or
 * unreadable entries are treated as "no entry" rather than a hard failure —
 * a resume step still runs, just from the legacy step-keyed profile dir
 * instead of the originating one. Exported only for direct unit testing
 * (concurrency, tmp-file exclusion); every production call site still goes
 * through `runCursorPromptWithDriver`.
 */
export async function readCursorSessionEntry(
  executionsDir: string,
  executionId: string,
  sessionId: string,
): Promise<string | undefined> {
  const entryPath = getPipelineExecutionCursorSessionEntryPath(
    executionsDir,
    executionId,
    sessionId,
  );
  try {
    const raw = await readFile(entryPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isCursorSessionEntry(parsed)) return undefined;
    // Defence in depth, not a remote-input boundary: writing this file already
    // requires write access to the data directory. But the value becomes
    // `CURSOR_DATA_DIR` and gets a `hooks.json` with a live bearer token
    // written into it, so it is worth confirming it is one of THIS execution's
    // own profile directories. Every legitimate value — including another
    // step's or another child's, which is exactly what cross-step resume needs
    // — lives under the same `cursor-sessions` root as the index itself.
    const root = resolve(
      dirname(
        getPipelineExecutionCursorSessionIndexDir(executionsDir, executionId),
      ),
    );
    const resolved = resolve(parsed.profileDir);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
      return undefined;
    return parsed.profileDir;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort write of one session's durable entry file. Written to a
 * uniquely-named temp file and moved into place with `rename` (atomic on the
 * same filesystem), so a concurrent reader of this exact session's file
 * always sees either nothing or a complete, valid file — never a partial
 * write. Because every session has its own file (see
 * `getPipelineExecutionCursorSessionEntryPath`), concurrent writes for
 * *different* sessions never contend with each other; there is no shared
 * file to read-modify-write. A failed write only means a later resume of
 * this session falls back to its own step-keyed profile dir (and says so in
 * its transcript); it must never fail the step that just successfully
 * created the session. Exported only for direct unit testing (see
 * `readCursorSessionEntry` above).
 */
export async function writeCursorSessionEntry(
  executionsDir: string,
  executionId: string,
  sessionId: string,
  profileDir: string,
  stepId: string,
  childId: string | undefined,
): Promise<void> {
  const entryPath = getPipelineExecutionCursorSessionEntryPath(
    executionsDir,
    executionId,
    sessionId,
  );
  const tempPath = `${entryPath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(entryPath), { recursive: true });
    const entry: CursorSessionEntry = {
      version: 1,
      profileDir,
      stepId,
      ...(childId ? { childId } : {}),
      createdAt: new Date().toISOString(),
    };
    await writeFile(tempPath, JSON.stringify(entry, null, 2), 'utf8');
    await rename(tempPath, entryPath);
  } catch {
    await rm(tempPath, { force: true }).catch(() => {
      /* Best-effort cleanup of an orphaned temp file. */
    });
    /* Best-effort — see doc comment above. */
  }
}

/**
 * Parses a structured response, failing with an input-INDEPENDENT diagnostic.
 *
 * V8's `JSON.parse` message embeds a shortened excerpt of the text it choked
 * on. That fragment reached two durable surfaces unmasked — `agent-failure.json`
 * plus the step's `error` output, and the structured-output RETRY prompt, which
 * sends it straight back to the vendor. A configured value straddling the
 * excerpt's cut is no longer an exact match, so no later masking pass can
 * recognise it. See `describeJsonParseFailure`.
 */
function parseStructuredResponseText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw new Error(
      `Response was not valid JSON (${describeJsonParseFailure(error)}).`,
    );
  }
}

/**
 * One turn at a time per Cursor conversation profile.
 *
 * A resume step resolves its `CURSOR_DATA_DIR` from the session index, so two
 * parallel steps resuming the same session id get the same profile directory and
 * the same `projects/<cwd>/.cursor/hooks.json`, which each turn rewrites with its
 * own bearer token. Turns on DIFFERENT profiles stay fully parallel.
 *
 * Ownership is tracked by entry identity and a waiter count, because cleanup that
 * simply deleted the map key could delete a NEWER chain: with A running and B
 * queued, finishing A attached cleanup to the chain that then included C, and the
 * delete let D start while C was still running. An entry is removed only when the
 * map still holds THIS entry and nobody is waiting on it, and each waiter
 * releases only its own turn — never a predecessor's.
 */
interface ProfileTurnQueueEntry {
  tail: Promise<void>;
  waiting: number;
}

const profileTurnQueue = new Map<string, ProfileTurnQueueEntry>();

/**
 * Runs `run` with exclusive use of `profileDir`.
 *
 * `canRun` is consulted after the wait and before starting: a waiter whose caller
 * cancelled, or whose step deadline elapsed while it was queued, must not start a
 * turn afterwards. It still releases its own place so the queue drains.
 */
/**
 * Number of profiles currently holding a queue entry.
 *
 * Exported only so tests can assert the ENTRY LIFECYCLE directly — that a
 * withdrawing waiter does not delete an entry a running predecessor still owns,
 * and that the entry is reclaimed once nobody is left. Reading the map through
 * behaviour alone cannot distinguish "leaked entry" from "correctly retained".
 */
export function profileTurnQueueSize(): number {
  return profileTurnQueue.size;
}

async function withExclusiveProfile<T>(
  profileDir: string,
  run: () => Promise<T>,
  /**
   * Aborted when this caller withdraws — cancelled by its own caller, or its own
   * step budget elapsed. A withdrawn waiter must settle IMMEDIATELY rather than
   * inherit the predecessor's remaining budget.
   */
  withdrawal: AbortSignal,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const entry = profileTurnQueue.get(profileDir) ?? {
    tail: Promise.resolve(),
    waiting: 0,
  };
  const previous = entry.tail;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A rejected or cancelled predecessor must not break the chain for later waiters.
  entry.tail = previous.then(
    () => held,
    () => held,
  );
  entry.waiting += 1;
  profileTurnQueue.set(profileDir, entry);
  let onWithdraw: (() => void) | undefined;
  try {
    // Waiting on `previous` ALONE made a cancelled or expired caller sit here
    // for however long the predecessor's own (possibly much larger) budget ran
    // — a 20ms step could be held for a 60s one, and a cancelled caller could
    // not settle at all. Race the wait instead.
    //
    // Releasing `held` early is safe and is the whole point: successors await
    // `entry.tail`, which is `previous.then(() => held)`, so they still cannot
    // start until the PREDECESSOR finishes. Withdrawing therefore gives up this
    // caller's own place without releasing anyone else's ownership and without
    // letting a successor overlap the predecessor.
    if (!withdrawal.aborted) {
      await Promise.race([
        previous.catch(() => undefined),
        new Promise<void>((resolve) => {
          onWithdraw = (): void => resolve();
          withdrawal.addEventListener('abort', onWithdraw, { once: true });
        }),
      ]);
    }
    // Withdrawn — either before queueing or while waiting. Start no turn now,
    // and (because this returns) start none later either.
    if (withdrawal.aborted) return { ran: false };
    return { ran: true, value: await run() };
  } finally {
    // The listener is on a signal that outlives this call on the success path,
    // so it is removed explicitly rather than left for the attempt to drop.
    if (onWithdraw) withdrawal.removeEventListener('abort', onWithdraw);
    release();
    entry.waiting -= 1;
    // Only when nobody is left. A still-running predecessor is itself a waiter
    // that has not reached this `finally`, so a withdrawing waiter can never
    // delete the entry out from under it and let a fresh caller start beside it.
    if (entry.waiting === 0 && profileTurnQueue.get(profileDir) === entry)
      profileTurnQueue.delete(profileDir);
  }
}

const CURSOR_STEP_CANCELLED_MESSAGE = 'Cursor workflow turn was cancelled.';

export async function runCursorPromptWithDriver(
  request: CursorPromptRunnerRequest,
  driver: CursorPromptDriverOptions,
): Promise<CursorPromptRunnerResult> {
  // The step clock starts at the HOST RUNNER's entry when it told us when that
  // was, not at this function's first line: on the desktop path the connection
  // probe and the full runtime digest have already happened by the time we get
  // here, and that time belongs to the step the user gave a timeout to.
  const stepDeadline =
    (request.budgetStartedAt ?? Date.now()) + request.totalTimeoutMs;
  const transcript: string[] = [];
  const transcriptEvents: unknown[] = [];
  const pushTranscriptLine = (line: string): void => {
    transcript.push(line);
    try {
      request.onTranscriptLine?.(line);
    } catch {
      /* Live forwarding is best-effort. */
    }
  };
  let sessionId = request.resumeSessionId;
  let lastUsage: CursorReportedUsage | undefined;
  let hadActivity = false;
  const signal = request.signal ?? new AbortController().signal;
  // One withdrawal boundary for everything before the first turn: the caller's
  // cancellation and the step's own deadline. Environment preparation, the
  // version probe and the session-index read used to run before either was
  // looked at, so a held filesystem or probe kept a step past its budget and a
  // cancellation waited for setup to finish. Work that cannot be interrupted
  // keeps running when the step withdraws — its outcome is observed, never
  // awaited, and nothing after it reaches the provider.
  const setupStop = new AbortController();
  const stopSetup = (): void => {
    setupStop.abort();
  };
  signal.addEventListener('abort', stopSetup, { once: true });
  if (signal.aborted) setupStop.abort();
  let setupTimedOut = false;
  const setupTimer = setTimeout(
    () => {
      setupTimedOut = true;
      setupStop.abort();
    },
    Math.max(0, stepDeadline - Date.now()),
  );
  const endSetup = (): void => {
    clearTimeout(setupTimer);
    signal.removeEventListener('abort', stopSetup);
  };
  const withinSetup = async <T>(work: Promise<T>): Promise<T> => {
    void work.catch(() => undefined);
    let onStop: (() => void) | undefined;
    const withdrawn = new Promise<never>((_resolve, reject) => {
      onStop = (): void => {
        reject(
          new Error(
            setupTimedOut
              ? stepTimedOutMessage(request.totalTimeoutMs)
              : CURSOR_STEP_CANCELLED_MESSAGE,
          ),
        );
      };
      if (setupStop.signal.aborted) onStop();
      else setupStop.signal.addEventListener('abort', onStop, { once: true });
    });
    try {
      return await Promise.race([work, withdrawn]);
    } finally {
      if (onStop) setupStop.signal.removeEventListener('abort', onStop);
    }
  };
  try {
    const rawModelId = getRawCursorModelId(request.model);
    if (!rawModelId)
      throw new Error(`"${request.model}" is not a Cursor model.`);
    if (
      (request.pluginSelections &&
        hasAnySelections(request.pluginSelections)) ||
      request.packageOverlay
    )
      throw new Error(
        'Selected capabilities cannot be prepared safely for this Cursor step. Start a new step without selections.',
      );

    // A pipeline can declare names this runtime refuses to forward to the
    // vendor process (code-injection vectors, git config overrides, GitHub
    // tokens). They stay refused — but saying nothing meant the same step
    // silently behaved differently on Cursor than on Claude or Codex, which the
    // plugin/MCP seam already gets a warning for.
    const withheld = withheldCursorEnvironmentNames(request.environment);
    if (withheld.length > 0)
      pushTranscriptLine(
        JSON.stringify({
          type: 'warning',
          message: `Cursor does not receive these step environment variables: ${withheld.join(', ')}. They are withheld from the vendor process on purpose; use a step that runs on Claude or Codex if the agent needs them.`,
        }),
      );

    const env = await withinSetup(
      prepareCursorRuntimeEnvironment(getCursorRuntimeStateDir(), {
        ...driver.baseEnvironment,
        // sanitizeCursorSpawnEnvironment only blocks canonical-home
        // overrides; prepareCursorRuntimeEnvironment (below) separately
        // deletes every CURSOR_*-prefixed key from this merged object, so a
        // pipeline-declared CURSOR_API_KEY never reaches the spawned child.
        ...sanitizeCursorSpawnEnvironment(request.environment),
        NO_OPEN_BROWSER: '1',
        ELECTRON_RUN_AS_NODE: '1',
      }),
    );
    const providerProcess: CursorProviderProcess = {
      spawner: driver.spawner,
      owner: { kind: 'pipeline', id: request.executionId },
    };
    // The probe's own child is stopped by the same boundary, not just
    // abandoned.
    await withinSetup(
      verifyCursorRuntimeVersion(
        providerProcess,
        driver.launch,
        env,
        setupStop.signal,
        CURSOR_RUNTIME_VERSION,
        driver.reinstallGuidance,
        (diagnostic) =>
          pushTranscriptLine(
            JSON.stringify({ type: 'cursor_version_check', ...diagnostic }),
          ),
      ),
    );
    const hookRuntime = join(
      dirname(driver.launch.command),
      driver.target.hookRuntime,
    );
    const legacyProfileDir = getPipelineExecutionCursorProfileDir(
      request.executionsDir,
      request.executionId,
      request.jobId,
      request.stepId,
      request.childId,
    );
    let profileDir = legacyProfileDir;
    if (request.resumeSessionId) {
      const indexedProfileDir = await withinSetup(
        readCursorSessionEntry(
          request.executionsDir,
          request.executionId,
          request.resumeSessionId,
        ),
      );
      if (indexedProfileDir) {
        profileDir = indexedProfileDir;
      } else {
        pushTranscriptLine(
          JSON.stringify({
            type: 'warning',
            message: `Cursor session ${request.resumeSessionId} was not found in the session index; resuming from the step-local profile instead.`,
          }),
        );
      }
    }
    let indexedSessionId: string | undefined;
    /** Sum of every COMPLETED attempt's final usage snapshot. */
    let completedAttemptsUsage: CursorReportedUsage | undefined;
    /** Latest snapshot within the attempt currently running. */
    let currentAttemptUsage: CursorReportedUsage | undefined;
    const globalInstructions = request.resumeSessionId
      ? ''
      : buildPipelineGlobalInstructionsBlock(
          getBrandEnv(
            request.environment,
            'PREF_GLOBAL_INSTRUCTIONS_PIPELINES',
          ),
          { harness: 'cursor', model: request.model },
        );
    const instructions = [globalInstructions, request.systemPrompt]
      .filter(Boolean)
      .join('\n\n');
    const rtkEnv = {
      ...getEnhancedEnv({ includeCanopySecrets: false, environment: false }),
      ...getRtkManagedEnv(),
    };
    const emitHostEvent = (event: Record<string, unknown>): void => {
      const tagged = { ...event, provider: 'cursor' };
      transcriptEvents.push(tagged);
      // Host-authored guidance (the plugin warning, the context-loss
      // warning) goes through CursorEventProjection.notice(), which emits
      // `canopy_assistant_patch` with `role: 'system'` — a different
      // `type` than the plain `'system'` init event excluded below, so it
      // must be excluded on its own. Otherwise a step that fails before
      // the agent does anything real (e.g. right after `newSession`)
      // reports `had_agent_activity: true`, and recovery resumes a
      // session that never received the prompt. Mirrors the same
      // `role !== 'system'` guard in observability/service.ts.
      if (
        event.type !== 'canopy_cursor_usage' &&
        event.type !== 'system' &&
        event.role !== 'system'
      )
        hadActivity = true;
      pushTranscriptLine(JSON.stringify(tagged));
    };
    const host = createHeadlessCursorHost({
      preset: request.permissionPreset,
      secretValues: request.secretValues,
      instructions,
      clientName: 'canopy-cursor-pipeline',
      emit: emitHostEvent,
      onUsage: (usage) => {
        // Each report is a per-RESPONSE snapshot (see
        // `@canopy/agent-transcript/lib/cursor-usage` and
        // `docs/cursor-chat.md`), and the durable observer ASSIGNS the
        // newest one rather than summing. That is right for one turn, but a
        // structured-output retry runs several turns on several child
        // processes, so assigning would report only the final attempt and
        // silently drop every paid attempt before it. Accumulate the
        // per-attempt totals HERE — the only place that can see attempt
        // boundaries — and keep emitting a running total so the observer's
        // snapshot semantics stay correct downstream.
        currentAttemptUsage = usage;
        lastUsage = addCursorReportedUsage(completedAttemptsUsage, usage);
        const turnUsage = lastUsage;
        // Interactive Cursor chat (agents/cursor-session.ts) streams a
        // `canopy_cursor_usage` line through this same emit path so
        // observePipelineOutput/observeChatEvent can attribute tokens;
        // pipeline steps must do the same, or a Cursor pipeline step's
        // Audit Trail / Usage entry silently reports 0 input/output tokens
        // even though its message/tool counts are non-zero.
        emitHostEvent({ type: 'canopy_cursor_usage', usage: turnUsage });
      },
      rtk: { binaryPath: getBundledRtkBinaryPath(), env: rtkEnv },
    });
    const maxAttempts = request.schema
      ? CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS + 1
      : 1;
    const taskPrompt = appendCodexSchemaInstruction(
      request.prompt,
      request.schema,
    );
    let prompt = taskPrompt;
    let lastError: Error | undefined;
    // A structured retry asks the model to fix its previous answer "using the
    // original task from this thread". It is sent into the conversation that
    // holds that answer, and must not silently land in a new one that has
    // never seen the task: when that conversation cannot be restored, the
    // retry is resent once in a fresh conversation with the task itself.
    let retryInSession = false;
    let retriedWithTask = false;
    // ONE deadline for the whole step, not one per attempt. A structured
    // step used to hand every retry the full `timeout_minutes` afresh, so a
    // step declaring 30 minutes could spend ~90 in prompts alone before
    // failing — the declared timeout is a bound on the step, not on each
    // internal attempt the runner happens to make.
    // Already started, above, BEFORE runtime preparation and the version
    // probe. `timeout_minutes` is a bound on the STEP, and setup happens inside
    // the step: measuring from after it let a slow prepare/verify add to the
    // wall clock on top of the declared budget .
    const deadline = stepDeadline;
    // Setup is over; each attempt below arms its own deadline and listens to
    // the caller's signal.
    endSetup();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (currentAttemptUsage) {
        // The previous attempt is finished: bank its final snapshot so this
        // attempt's reports add to it instead of replacing it.
        completedAttemptsUsage = addCursorReportedUsage(
          completedAttemptsUsage,
          currentAttemptUsage,
        );
        currentAttemptUsage = undefined;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0)
        throw new Error(stepTimedOutMessage(request.totalTimeoutMs));
      // `promptTimeoutMs` bounds only `client.prompt()`. Each attempt also
      // re-does the ACP setup RPCs, which carry their own fixed 15s/30s
      // windows inside the client, so before this nothing actually enforced
      // the step's DECLARED budget end to end. This timer is that enforcement: whatever the turn
      // is doing, the remaining budget ends it, and the step reports the
      // canonical timeout rather than the cancellation the abort looks like
      // from inside the driver.
      const attemptAbort = new AbortController();
      const propagateCallerAbort = (): void => attemptAbort.abort();
      signal.addEventListener('abort', propagateCallerAbort, { once: true });
      // `addEventListener` is a no-op on a signal that has ALREADY aborted, and
      // the work between the entry check and here includes an awaited session
      // lookup on the resume path. Without this re-check an abort landing in
      // that window would run a full write-capable turn and only then report
      // cancellation. Same pattern the driver uses for its own composite signal.
      if (signal.aborted) attemptAbort.abort();
      let deadlineFired = false;
      const deadlineTimer = setTimeout(() => {
        deadlineFired = true;
        attemptAbort.abort();
      }, remainingMs);
      let outcome;
      try {
        // Exclusive per conversation profile: the turn writes this profile's
        // `hooks.json` with its own bearer token, so overlapping turns on one
        // profile must not interleave.
        const queued = await withExclusiveProfile(
          profileDir,
          () =>
            runCursorTurn(
              {
                cwd: request.cwd,
                text: prompt,
                launch: driver.launch,
                providerProcess,
                env,
                hookRuntime,
                profileDir,
                rawModelId,
                model: request.model,
                sessionId,
                // A resume step must fail BEFORE a fresh write-capable turn runs
                // in place of the session it asked for; the post-turn
                // `contextLost` check below stays as defence in depth.
                requireExistingSession:
                  Boolean(request.resumeSessionId) || retryInSession,
                signal: attemptAbort.signal,
                promptTimeoutMs: remainingMs,
              },
              host,
            ),
          // Cancelled, or the step deadline elapsed: withdraw from the queue and
          // settle now rather than waiting out the predecessor's budget.
          attemptAbort.signal,
        );
        outcome = queued.ran
          ? queued.value
          : {
              ...(sessionId ? { sessionId } : {}),
              isError: false,
              cancelled: true,
              message: 'Turn cancelled',
              contextLost: false,
              inheritedContextDelivered: false,
              responseText: '',
            };
      } finally {
        clearTimeout(deadlineTimer);
        signal.removeEventListener('abort', propagateCallerAbort);
      }
      // Recovery metadata is recorded BEFORE any of the exits below, because
      // a turn that created a session and did work in it is exactly the case a
      // deadline should leave recoverable. The deadline throw used to run
      // first, so the id was assigned and indexed only on the paths that did
      // not need it.
      if (outcome.sessionId) sessionId = outcome.sessionId;
      // Key on WHICH session was indexed, not on whether anything was. A
      // structured retry whose `loadSession` fails mints a brand-new session
      // id, and a latched boolean left that new id — the one this step
      // actually returns — absent from the index, so a later
      // `builtin/agent-resume` could not find its profile and hard-failed.
      if (
        !request.resumeSessionId &&
        outcome.sessionId &&
        outcome.sessionId !== indexedSessionId
      ) {
        indexedSessionId = outcome.sessionId;
        // Bounded. This runs on the timeout path too now, and a step that has
        // already exhausted its budget must not then wait out a stuck
        // filesystem: the write is given a short window of its own and the
        // step settles either way. Its rejection is observed so a slow write
        // that fails later cannot surface as an unhandled rejection.
        const indexing = writeCursorSessionEntry(
          request.executionsDir,
          request.executionId,
          outcome.sessionId,
          profileDir,
          request.stepId,
          request.childId,
        );
        void indexing.catch(() => undefined);
        await withBoundedWait(indexing, SESSION_INDEX_WRITE_BUDGET_MS);
      }
      // Only the runner knows the abort came from its own deadline rather
      // than from the caller, so only the runner can tell the two apart.
      if (deadlineFired)
        throw new Error(stepTimedOutMessage(request.totalTimeoutMs));
      if (
        retryInSession &&
        !request.resumeSessionId &&
        outcome.isError &&
        outcome.contextLost &&
        !retriedWithTask
      ) {
        // Nothing ran: the conversation with the first answer is gone.
        retriedWithTask = true;
        retryInSession = false;
        sessionId = undefined;
        prompt = `${taskPrompt}\n\n${prompt}`;
        attempt -= 1;
        continue;
      }
      if (request.resumeSessionId && outcome.contextLost) {
        // Keep the driver's specific reason when it has one. Replacing it with
        // the generic sentence discarded the only text that said WHY the
        // resume failed
        throw new Error(
          outcome.message ||
            `Cursor session ${request.resumeSessionId} could not be resumed.`,
        );
      }
      if (outcome.cancelled || signal.aborted) {
        return {
          status: 'cancelled',
          transcript: `${transcript.join('\n')}\n`,
          failure: {
            version: 1,
            provider: 'cursor',
            agent_harness: 'cursor',
            ...(sessionId ? { session_id: sessionId } : {}),
            had_agent_activity: hadActivity,
            message: CURSOR_STEP_CANCELLED_MESSAGE,
          },
        };
      }
      if (outcome.isError)
        throw new Error(
          isAcpDeadlineMessage(outcome.message)
            ? stepTimedOutMessage(request.totalTimeoutMs)
            : outcome.message || 'Cursor workflow turn failed.',
        );
      try {
        const structured = request.schema
          ? parseStructuredResponseText(stripCodeFence(outcome.responseText))
          : undefined;
        if (request.schema && structured !== undefined) {
          const validation = validateAgainstSchema(request.schema, structured);
          if (!validation.ok) {
            throw new Error(
              validation.error ||
                'Response did not match the requested schema.',
            );
          }
        }
        const proposedPlan =
          request.permissionPreset === 'plan'
            ? extractProposedPlan(outcome.responseText)
            : undefined;
        return {
          status: 'success',
          sessionId: sessionId ?? '',
          rawText: outcome.responseText,
          ...(structured !== undefined ? { structured } : {}),
          transcript: `${transcript.join('\n')}\n`,
          ...(proposedPlan ? { proposedPlan } : {}),
          usage: usageToHelperUsage(lastUsage),
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (request.schema && attempt < maxAttempts) {
          prompt = buildCodexStructuredOutputRetryPrompt(
            request.schema,
            lastError.message,
          );
          retryInSession = Boolean(sessionId);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error('Cursor workflow turn failed.');
  } catch (error) {
    endSetup();
    const message = error instanceof Error ? error.message : String(error);
    const classification = classifyAgentFailure({
      provider: 'cursor',
      accountScope: 'native',
      model: request.model,
      events: transcriptEvents,
      error,
    });
    return {
      status: signal.aborted ? 'cancelled' : 'failure',
      transcript: `${transcript.join('\n')}\n`,
      failure: {
        version: 1,
        provider: 'cursor',
        agent_harness: 'cursor',
        ...(sessionId ? { session_id: sessionId } : {}),
        had_agent_activity: hadActivity,
        ...(classification ? { classification } : {}),
        message,
      },
    };
  }
}
