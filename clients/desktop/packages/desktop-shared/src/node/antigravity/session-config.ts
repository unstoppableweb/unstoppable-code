import {
  antigravityLiveConfig,
  antigravityModelsFromConfig,
  type AntigravityLiveConfig,
  type AntigravityModelEntry,
} from '@canopy/execution-engine/lib/antigravity-models';
import {
  clampThinkingLevelToDeclared,
  THINKING_LEVEL_LABELS,
  normalizeThinkingForUi,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';
import type { AcpClient } from '@canopy/desktop-shared/node/acp';
// Imported directly: the ACP index also loads the ESM-only SDK client.
import { AcpClientError } from '../acp/errors';

export type AntigravitySessionConfigErrorCode =
  | 'model'
  | 'thinking-unsupported'
  | 'thinking'
  | 'mode';

/** A setting the runtime refused or resolved differently from the request. */
export class AntigravitySessionConfigError extends Error {
  constructor(
    readonly code: AntigravitySessionConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AntigravitySessionConfigError';
  }
}

export type AntigravitySessionMode = 'default' | 'plan';

export interface AntigravitySessionConfigRequest {
  /** Native model ID, without the Canopy namespace. */
  model: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * Levels the caller showed for this model. When present, the requested
   * level is resolved against them and the runtime must still offer it.
   * Without them, the runtime's live levels are the only declared set.
   */
  declaredThinkingLevels?: readonly ThinkingLevel[];
  mode: AntigravitySessionMode;
}

export interface AntigravityAppliedSessionConfig {
  model: string;
  /**
   * The caller showed no thinking control, but the live model now has one.
   * Nothing was sent; the caller's catalog is out of date.
   */
  thinkingControlAdded?: true;
  /** Absent when the model has no thinking control. */
  thinkingLevel?: ThinkingLevel;
  supportedThinkingLevels: ThinkingLevel[];
  mode: AntigravitySessionMode;
}

export interface AntigravitySessionConfigFence {
  signal?: AbortSignal;
  /** Throws when the caller no longer owns the session. Runs between steps. */
  assertCurrent?: () => void;
}

type ConfigClient = Pick<AcpClient, 'setSessionConfigOption'>;

/**
 * ACP failures that end the connection, so no later model can succeed. The
 * client closes the connection when a request times out, so a timeout ends
 * discovery too; the caller treats it as transient.
 */
const CONNECTION_FAILURES: ReadonlySet<string> = new Set([
  'closed',
  'stale-generation',
  'cancelled',
  'timeout',
]);

// The shared UI labels alias Low to Medium. Google declares Low as its own
// level, so errors name it as the runtime does.
function levelLabel(level: ThinkingLevel): string {
  return level === 'low'
    ? 'Low'
    : THINKING_LEVEL_LABELS[normalizeThinkingForUi(level)];
}

async function set(
  client: ConfigClient,
  sessionId: string,
  configId: string,
  value: string,
  fence: AntigravitySessionConfigFence,
): Promise<AntigravityLiveConfig> {
  fence.signal?.throwIfAborted();
  fence.assertCurrent?.();
  const response = await client.setSessionConfigOption(
    { sessionId, configId, value },
    fence.signal,
  );
  fence.signal?.throwIfAborted();
  fence.assertCurrent?.();
  return antigravityLiveConfig(response.configOptions);
}

/**
 * Resolves the level to send, or `undefined` when nothing should be sent. An
 * absent thinking control is not an error unless the caller offered levels; a
 * level the live model does not offer always is.
 */
function resolveThinkingLevel(
  request: AntigravitySessionConfigRequest,
  live: readonly ThinkingLevel[] | undefined,
): ThinkingLevel | undefined {
  // No request, or a picker that showed no thinking control for this model:
  // send nothing, whatever the runtime now offers.
  if (!request.thinkingLevel || request.declaredThinkingLevels?.length === 0)
    return undefined;
  const declared = request.declaredThinkingLevels;
  // A select with no recognised levels is recorded by discovery as no
  // control, so it is treated the same way here.
  if (!live || live.length === 0) {
    if (declared)
      throw new AntigravitySessionConfigError(
        'thinking-unsupported',
        "Couldn't apply the thinking level because this Google model no longer offers one. Refresh Google models, then choose again.",
      );
    return undefined;
  }
  const target = clampThinkingLevelToDeclared(
    request.thinkingLevel,
    declared ?? live,
  );
  if (!live.includes(target))
    throw new AntigravitySessionConfigError(
      'thinking-unsupported',
      `Couldn't apply ${levelLabel(target)} thinking because this Google model doesn't offer it now. Refresh Google models, then choose a level.`,
    );
  return target;
}

function modeError(
  mode: AntigravitySessionMode,
  reason: 'unsupported' | 'different',
): AntigravitySessionConfigError {
  const action = mode === 'plan' ? 'turn on plan mode' : 'turn off plan mode';
  return new AntigravitySessionConfigError(
    'mode',
    reason === 'unsupported'
      ? `Couldn't ${action} because this Google runtime doesn't offer it.`
      : `Couldn't ${action} because Google kept a different setting.`,
  );
}

/**
 * A runtime without a mode option runs in its default mode. Plan mode is
 * never assumed: it must be offered and confirmed, with the model and the
 * thinking level unchanged.
 */
async function applyMode(
  client: ConfigClient,
  sessionId: string,
  request: AntigravitySessionConfigRequest,
  thinkingLevel: ThinkingLevel | undefined,
  current: AntigravityLiveConfig,
  fence: AntigravitySessionConfigFence,
): Promise<void> {
  if (current.modes.length === 0 && request.mode === 'default') return;
  if (!current.modes.includes(request.mode))
    throw modeError(request.mode, 'unsupported');
  const afterMode = await set(client, sessionId, 'mode', request.mode, fence);
  if (afterMode.mode !== request.mode || afterMode.model !== request.model)
    throw modeError(request.mode, 'different');
  // Mode applied, but the runtime changed the confirmed level with it.
  if (thinkingLevel && afterMode.thinkingLevel !== thinkingLevel)
    throw new AntigravitySessionConfigError(
      'thinking',
      `Couldn't apply ${levelLabel(thinkingLevel)} thinking because Google changed the level when it changed mode.`,
    );
}

/**
 * Applies a turn's model, thinking level and mode, then checks what the
 * runtime confirmed. Thinking levels are read from the selected model's own
 * live options, never from another model's. A request the runtime cannot
 * honour fails before any prompt is sent.
 */
export async function applyAntigravitySessionConfig(
  client: ConfigClient,
  sessionId: string,
  request: AntigravitySessionConfigRequest,
  fence: AntigravitySessionConfigFence = {},
): Promise<AntigravityAppliedSessionConfig> {
  const afterModel = await set(
    client,
    sessionId,
    'model',
    request.model,
    fence,
  );
  if (afterModel.model !== request.model)
    throw new AntigravitySessionConfigError(
      'model',
      "Couldn't switch Google to the selected model. Refresh Google models, then choose an available model.",
    );
  const live = afterModel.thinkingLevels;
  const thinkingLevel = resolveThinkingLevel(request, live);
  let afterThinking = afterModel;
  if (thinkingLevel) {
    afterThinking = await set(
      client,
      sessionId,
      'thought_level',
      thinkingLevel,
      fence,
    );
    if (
      afterThinking.thinkingLevel !== thinkingLevel ||
      afterThinking.model !== request.model
    )
      throw new AntigravitySessionConfigError(
        'thinking',
        `Couldn't apply ${levelLabel(thinkingLevel)} thinking because Google kept a different level.`,
      );
  }
  await applyMode(
    client,
    sessionId,
    request,
    thinkingLevel,
    afterThinking,
    fence,
  );
  const thinkingControlAdded =
    request.declaredThinkingLevels?.length === 0 && (live?.length ?? 0) > 0;
  return {
    model: request.model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(thinkingControlAdded ? { thinkingControlAdded: true } : {}),
    supportedThinkingLevels: live ? [...live] : [],
    mode: request.mode,
  };
}

/**
 * Lists the account's models with each model's own thinking levels. Run only
 * against a disposable discovery session: it switches the session's model.
 * A model the runtime will not select is left out rather than guessed.
 */
export async function discoverAntigravityModels(
  client: ConfigClient,
  sessionId: string,
  configOptions: unknown,
  fence: AntigravitySessionConfigFence = {},
): Promise<{
  entries: AntigravityModelEntry[];
  skipped: { model: string; reason: string }[];
}> {
  const listed = antigravityModelsFromConfig(configOptions);
  const entries: AntigravityModelEntry[] = [];
  const skipped: { model: string; reason: string }[] = [];
  for (const entry of listed) {
    let live: AntigravityLiveConfig;
    try {
      live = await set(client, sessionId, 'model', entry.rawModelId, fence);
    } catch (error) {
      // Cancellation, supersession, a timeout and a lost connection end
      // discovery. Anything else (a refusal, a busy or malformed reply)
      // concerns this model only: leave it out and keep discovering.
      fence.signal?.throwIfAborted();
      fence.assertCurrent?.();
      if (
        error instanceof AcpClientError &&
        CONNECTION_FAILURES.has(error.code)
      )
        throw error;
      skipped.push({
        model: entry.rawModelId,
        reason: error instanceof AcpClientError ? error.code : 'invalid-reply',
      });
      continue;
    }
    if (live.model !== entry.rawModelId) {
      skipped.push({ model: entry.rawModelId, reason: 'not-selected' });
      continue;
    }
    entries.push({
      ...entry,
      supportedThinkingLevels: [...(live.thinkingLevels ?? [])],
    });
  }
  return { entries, skipped };
}
