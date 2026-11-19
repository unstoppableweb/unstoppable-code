import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  BACKGROUND_HELPER_PRIORITIES,
  enqueueBackgroundHelperTask,
} from '../../lib/background-helper-queue';
import { localMemoryScopeDir } from './scope-resolver';
import { readPreferencesFile } from '../../lib/preferences-store';
import { broadcastLocalMemoryChanged } from './change-events';
import {
  prepareChatHistoryProfileInput,
  readChatHistoryProfileState,
  renderChatHistoryProfileIndexLine,
  renderChatHistoryProfileTopic,
  saveChatHistoryProfile,
  validateChatHistoryProfile,
  type ChatHistoryProfileGeneration,
  type ChatHistoryProfileGenerator,
  type ChatHistoryProfileInput,
  type PreparedChatHistoryProfile,
} from './chat-history-profile';
import { isLocalMemoryConsolidationRunning } from './consolidation-run-tracker';
import { recordConsolidationRun } from './consolidation-state';
import { resolveLocalMemoryRunModel } from './helper-model';
import { isHelperNoBillingSourceError } from '../../agents/helper-no-billing-source';

export type ChatHistoryProfileRefreshResult =
  | { status: 'updated' | 'unchanged' | 'no-titles' | 'disabled' | 'no-facts' }
  | {
      status: 'invalid-output' | 'failed' | 'model-unavailable';
      reason: string;
    };

export interface ChatHistoryProfileRefreshOptions {
  /** Replaces the model call; tests supply a canned generation. */
  generate?: ChatHistoryProfileGenerator;
  now?: () => Date;
}

const INVALID_OUTPUT_REASON =
  'The chat history profile did not match the expected format';

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readEnabledPreferences(): Promise<PreferencesData | null> {
  const preferences = await readPreferencesFile().catch(() => null);
  return preferences?.localMemoryEnabled === true ? preferences : null;
}

const generateWithLocalMemoryModel: ChatHistoryProfileGenerator = async (
  prepared,
  helperModel,
) => {
  // Keep the structured-helper/provider stack off Electron's startup import
  // path, like consolidation-scheduler.ts: it is only needed once a scan
  // brings new titles. Local dynamic imports are safe in packaged main.
  const { generateChatHistoryProfile } =
    await import('./chat-history-profile-generator');
  return generateChatHistoryProfile(prepared, helperModel);
};

/**
 * Fails closed when the chosen memory model cannot run or the organization
 * blocks it: the titles are never sent to another model, nothing is saved
 * (so a later scan retries), and the user memory status line says why
 * unless a run there owns the status.
 */
async function skipForUnavailableModel(
  scopeDir: string,
  reason: string,
): Promise<ChatHistoryProfileRefreshResult> {
  if (!isLocalMemoryConsolidationRunning(scopeDir)) {
    await recordConsolidationRun(scopeDir, { result: 'skipped', reason })
      .then(() => broadcastLocalMemoryChanged({ scope: 'user' }))
      .catch(() => undefined);
  }
  return { status: 'model-unavailable', reason };
}

async function summarizeAndSave(
  prepared: PreparedChatHistoryProfile,
  scopeDir: string,
  options: ChatHistoryProfileRefreshOptions,
): Promise<ChatHistoryProfileRefreshResult> {
  // The queue may have held this task while the user turned memory off.
  const preferences = await readEnabledPreferences();
  if (!preferences) return { status: 'disabled' };

  const run = await resolveLocalMemoryRunModel(preferences);
  if ('refusal' in run) {
    const reason = run.refusal.reason ?? run.refusal.result;
    if (run.refusal.result === 'skipped') {
      return skipForUnavailableModel(scopeDir, reason);
    }
    process.emitWarning(reason, { code: 'LOCAL_MEMORY_CHAT_PROFILE_FAILED' });
    return { status: 'failed', reason };
  }
  const { helperModel } = run;

  let generation: ChatHistoryProfileGeneration;
  try {
    generation = await (options.generate ?? generateWithLocalMemoryModel)(
      prepared,
      helperModel,
    );
  } catch (error) {
    // Refused before any spawn: the provider is signed out with no billing
    // source (CAN-7062). Nothing is saved, so a later scan retries.
    if (isHelperNoBillingSourceError(error)) {
      return skipForUnavailableModel(scopeDir, error.message);
    }
    const reason = failureReason(error);
    process.emitWarning(reason, { code: 'LOCAL_MEMORY_CHAT_PROFILE_FAILED' });
    return { status: 'failed', reason };
  }

  const facts = validateChatHistoryProfile(generation.output, prepared);
  if (facts === null) {
    generation.finalize('failure', INVALID_OUTPUT_REASON);
    process.emitWarning(INVALID_OUTPUT_REASON, {
      code: 'LOCAL_MEMORY_CHAT_PROFILE_INVALID_OUTPUT',
    });
    return { status: 'invalid-output', reason: INVALID_OUTPUT_REASON };
  }

  const refreshedAt = (options.now ?? ((): Date => new Date()))();
  try {
    // Titles that support nothing leave an earlier profile in place: it was
    // grounded when written, and a thin rescan is no reason to erase it.
    await saveChatHistoryProfile(scopeDir, {
      ...(facts.length > 0
        ? {
            profile: {
              topic: renderChatHistoryProfileTopic(
                facts,
                prepared,
                refreshedAt,
              ),
              indexLine: renderChatHistoryProfileIndexLine(facts),
            },
          }
        : {}),
      state: {
        version: 1,
        inputHash: prepared.inputHash,
        refreshedAt: refreshedAt.toISOString(),
        result: facts.length > 0 ? 'updated' : 'no-facts',
      },
    });
  } catch (error) {
    const reason = failureReason(error);
    generation.finalize('failure', reason);
    process.emitWarning(reason, { code: 'LOCAL_MEMORY_CHAT_PROFILE_FAILED' });
    return { status: 'failed', reason };
  }
  generation.finalize('success');
  if (facts.length === 0) return { status: 'no-facts' };
  broadcastLocalMemoryChanged({ scope: 'user' });
  return { status: 'updated' };
}

/** The scan's input, or a function that collects it once memory is on. */
export type ChatHistoryProfileSource =
  | ChatHistoryProfileInput
  | (() => ChatHistoryProfileInput | Promise<ChatHistoryProfileInput>);

/**
 * Summarizes the chat titles a Claude/Codex history scan found into the
 * user's memory profile. Does nothing when local memory is off, when no chat
 * has a usable title, or when the same titles were already summarized (even
 * if the user has deleted the profile since: it comes back only when a later
 * scan finds new titles); the model run itself waits its turn on the
 * background helper queue.
 *
 * Call it through {@link requestChatHistoryProfileRefresh}, which runs one
 * refresh at a time.
 */
export async function refreshChatHistoryProfile(
  source: ChatHistoryProfileSource,
  options: ChatHistoryProfileRefreshOptions = {},
): Promise<ChatHistoryProfileRefreshResult> {
  // Checked first: with memory off the titles are never read, and the await
  // moves collection and preparation off the scan request that triggered it.
  if (!(await readEnabledPreferences())) return { status: 'disabled' };
  const input = typeof source === 'function' ? await source() : source;
  const prepared = prepareChatHistoryProfileInput(input);
  if (!prepared) return { status: 'no-titles' };
  const scopeDir = localMemoryScopeDir({ scope: 'user' });
  const state = await readChatHistoryProfileState(scopeDir);
  if (state?.inputHash === prepared.inputHash) return { status: 'unchanged' };
  return enqueueBackgroundHelperTask({
    priority: BACKGROUND_HELPER_PRIORITIES.memoryImport,
    task: () => summarizeAndSave(prepared, scopeDir, options),
  });
}

interface RefreshRequest {
  input: ChatHistoryProfileSource;
  options: ChatHistoryProfileRefreshOptions;
}

let activeRefresh: Promise<void> | null = null;
let queuedRefresh: { request: RefreshRequest; done: Promise<void> } | null =
  null;

async function runRefresh(request: RefreshRequest): Promise<void> {
  try {
    await refreshChatHistoryProfile(request.input, request.options);
  } catch (error) {
    process.emitWarning(failureReason(error), {
      code: 'LOCAL_MEMORY_CHAT_PROFILE_FAILED',
    });
  }
}

function startRefresh(request: RefreshRequest): Promise<void> {
  const run = runRefresh(request).finally(() => {
    if (activeRefresh === run) activeRefresh = null;
  });
  activeRefresh = run;
  return run;
}

/**
 * Fire-and-forget entry point for a finished scan. One refresh runs at a
 * time; scans that finish meanwhile fold into a single follow-up refresh of
 * the newest titles. Never rejects; resolves once the refresh covering this
 * request has finished.
 *
 * The follow-up is chained on `activeRefresh`, which is the promise returned
 * by `.finally()` in {@link startRefresh}: it settles only after that handler
 * cleared `activeRefresh`, so the follow-up always starts from a clear slot
 * and `queuedRefresh` is emptied before a new request can see it.
 */
export function requestChatHistoryProfileRefresh(
  input: ChatHistoryProfileSource,
  options: ChatHistoryProfileRefreshOptions = {},
): Promise<void> {
  if (queuedRefresh) {
    queuedRefresh.request.input = input;
    queuedRefresh.request.options = options;
    return queuedRefresh.done;
  }
  if (activeRefresh) {
    const request: RefreshRequest = { input, options };
    const done = activeRefresh.then(() => {
      queuedRefresh = null;
      return startRefresh(request);
    });
    queuedRefresh = { request, done };
    return done;
  }
  return startRefresh({ input, options });
}
