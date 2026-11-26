// LLM surface for the shared UI-automation mock server (Doc 5 — WP-MOCK-LLM).
//
// Speaks BOTH the Anthropic Messages wire format (`/v1/messages`) and the OpenAI
// Responses (`/v1/responses`) + Chat Completions (`/v1/chat/completions`) wire
// formats, so Canopy's real Claude Agent SDK and Codex app-server paths run
// end-to-end against deterministic, predefined responses. The app is redirected
// here only under an `__CANOPY_E2E__` build (see
// docs/ui-automation-coverage/11-build-time-gating-principle.md) via
// `CANOPY_MOCK_LLM_BASE_URL`.
//
// Legacy step selection is STATELESS over full history (Doc 5 §2). Native
// Responses WS deltas are expanded by responsesWs.mjs before selection.
// Optional C1 v2 attempts, barriers and observations use per-scenario state:
//
//   1. Conversation id — scan user-role message text for a `[Canopy-C<id>]`
//      marker. If present, look up that conversation script (from
//      ./conversations/*.json|yaml or a registered scenario).
//   2. Helper fingerprint — if no marker, match the distinctive helper system
//      prompts (branch naming / commit message / PR / summary) to a canned
//      structured output (Doc 5 §3).
//   3. Default fallback — a benign single text turn + `end_turn` so any
//      unscripted request still completes.
//
//   Step index = count of assistant turns already present in the request, so
//   the Nth call returns scripted step N and multi-step tool loops are
//   reproducible without server-side session memory.
//
// A `CannedStep` (Doc 5 §4) is the provider-agnostic unit rendered to whichever
// surface the caller hit:
//   { text?, thinking?, toolCalls?: [{name,input,id?}], stopReason?, usage?,
//     streamMs?, chunkChars?, error? }
// A tool call's optional `id` keeps tool-use ids unique across the steps of
// one multi-step turn; without it the id derives from the block index.
// A `Write` call marked `writesPlanModePlanFile: true` takes its `file_path`
// from the plan-mode reminder in the request.
// A scenario may set
// `llm.openAiStepCursor: 'completed-scenario-tool-calls'` when a real client
// adds synthetic assistant bootstrap items before the first marker-bearing
// request. The cursor then advances only after a scripted function call has a
// matching function-call output in history.

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  DEFAULT_SCENARIO,
  getScenario,
  keyFromApiKey,
  keyFromBearer,
  markerFromText,
  recordInferenceJournalEntry,
  recordRequest,
  recordScenarioActivity,
  resolveStepAttempt,
  waitForBarrier,
} from '../control-plane.mjs';

const require = createRequire(import.meta.url);

const CONVERSATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'conversations',
);

// ── Conversation script loading ───────────────────────────────────────────

/** @type {Map<string, object> | null} */
let fileConversationsCache = null;

function loadYamlText(text) {
  // YAML support is best-effort. JSON is the primary format and needs no
  // dependency; YAML is parsed via js-yaml only when a `.yaml` file is present.
  const yaml = require('js-yaml');
  return yaml.load(text);
}

function parseConversationFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const ext = extname(filePath).toLowerCase();
  if (ext === '.json') {
    return JSON.parse(text);
  }
  if (ext === '.yaml' || ext === '.yml') {
    return loadYamlText(text);
  }
  return undefined;
}

function loadFileConversations() {
  if (fileConversationsCache) {
    return fileConversationsCache;
  }
  const map = new Map();
  if (existsSync(CONVERSATIONS_DIR)) {
    for (const entry of readdirSync(CONVERSATIONS_DIR)) {
      const ext = extname(entry).toLowerCase();
      if (!['.json', '.yaml', '.yml'].includes(ext)) {
        continue;
      }
      try {
        const parsed = parseConversationFile(join(CONVERSATIONS_DIR, entry));
        if (parsed && typeof parsed.id === 'string') {
          // Marker ids in prompts look like `Canopy-C0123`; conversation files
          // declare the bare id (`C0123`). Index by both so either resolves.
          map.set(parsed.id, parsed);
          map.set(`Canopy-${parsed.id}`, parsed);
        }
      } catch {
        // Skip malformed conversation files; the default fallback still works.
      }
    }
  }
  fileConversationsCache = map;
  return map;
}

/** Test-only: drop the cache so freshly written conversation files reload. */
export function resetConversationCache() {
  fileConversationsCache = null;
}

function mockRequestTagFromText(text) {
  const matches = Array.from(
    text.matchAll(/\[Canopy-Mock-Request:([A-Za-z0-9_-]+)\]/g),
  );
  return matches.at(-1)?.[1];
}

// ── Helper-fingerprint library (Doc 5 §3.2) ─────────────────────────────────
//
// Background flows (branch naming, commit message, PR, summaries) the test
// cannot author. Matched by distinctive substrings of their system prompt /
// wrapper and answered with structurally-valid canned output so worktree
// creation, commit, PR, and summary flows complete deterministically.

const HELPER_FINGERPRINTS = [
  {
    id: 'branch-naming',
    matches: (text) =>
      /expert at generating concise git branch names/i.test(text) ||
      /<task_description>/i.test(text),
    step: {
      text: JSON.stringify({ branchName: 'canopy/mock-branch' }),
      stopReason: 'end_turn',
    },
  },
  {
    id: 'commit-message',
    matches: (text) =>
      /You generate git commit messages from the supplied diff/i.test(text),
    step: {
      text: JSON.stringify({
        message: {
          subject: 'chore: mock commit',
          body: 'Deterministic mock commit body.',
        },
      }),
      stopReason: 'end_turn',
    },
  },
  {
    id: 'pr-generation',
    matches: (text) =>
      /You generate GitHub pull request titles and bodies/i.test(text),
    step: {
      text: JSON.stringify({
        title: 'Mock PR',
        body: 'Deterministic mock pull request body.',
      }),
      stopReason: 'end_turn',
    },
  },
  {
    // Claude Agent SDK session titles wrap the chat's own message, marker and
    // request tag included, so they would otherwise take the chat's script.
    id: 'session-title',
    matches: (text) => /You are naming a coding session/i.test(text),
    step: { text: 'Mock session title', stopReason: 'end_turn' },
  },
  {
    id: 'topic-summary',
    matches: (text) =>
      /expert at providing concise topic summaries/i.test(text),
    step: { text: 'Mock topic summary', stopReason: 'end_turn' },
  },
  {
    // Local memory consolidation (consolidation-task.ts) validates the reply
    // against its JSON schema, so the canned index must be a plain string
    // and topicFiles an array of {filename, content}.
    id: 'local-memory-consolidation',
    matches: (text) =>
      /You consolidate a bounded local memory index/i.test(text),
    step: {
      text: JSON.stringify({
        memoryMd: '# Personal preferences\n\n- Mock consolidated memory.\n',
        topicFiles: [],
      }),
      stopReason: 'end_turn',
    },
  },
  {
    // Chat history profile (chat-history-profile.ts, CAN-3079). Facts must
    // cite the numbered titles in the prompt, so the canned reply records
    // nothing; a spec supplies cited facts through `helperStepsById`.
    id: 'local-memory-chat-profile',
    matches: (text) =>
      /You summarize what a person's own chat titles reveal about them/i.test(
        text,
      ),
    step: { text: JSON.stringify({ facts: [] }), stopReason: 'end_turn' },
  },
  {
    id: 'archive-handoff-summary',
    matches: (text) =>
      /summarizing a chat conversation/i.test(text) ||
      /handoff summary/i.test(text),
    step: {
      text: '# Mock Summary\n\nDeterministic archival summary for UI automation.',
      stopReason: 'end_turn',
    },
  },
];

function matchHelperFingerprint(systemText) {
  if (!systemText) {
    return undefined;
  }
  for (const fingerprint of HELPER_FINGERPRINTS) {
    if (fingerprint.matches(systemText)) {
      return fingerprint;
    }
  }
  return undefined;
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_USAGE = {
  inputTokens: 1200,
  outputTokens: 24,
  cacheReadInputTokens: 800,
};

const DEFAULT_STEP = {
  text: 'Mock response from the Canopy UI-automation LLM surface.',
  stopReason: 'end_turn',
};

const MODEL_FALLBACK = 'canopy-mock-model';

// Wire fixture for noBillingSourceResponse. llm.test.mjs checks these values
// against @canopy/protocol so the plain-Node mock stays in sync with the host.
const NO_BILLING_SOURCE_ERROR = {
  canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
  code: 'no_billing_source',
  message: 'AI Credits are unavailable for this request.',
};

// User-message text the app injects when a deferred-tools reload resumes an
// interrupted turn. The resume step cursor must be anchored to this message:
// the number of assistant turns recorded *before* it is nondeterministic,
// because an interrupt can persist the partial streamed turn and/or a
// synthetic "No response requested." acknowledgment turn depending on timing.
// Must stay in sync with DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE in
// packages/desktop-shared/src/types/deferred-tools.ts; llm.test.mjs asserts
// the two match so drift fails loudly instead of silently re-flaking
// deferred-tools-reload.spec.mjs through the arithmetic fallback.
export const DEFERRED_TOOLS_RESUME_MARKER =
  'Requested items now enabled, continue the interrupted request.';

// ── Request parsing (provider-agnostic extraction) ──────────────────────────

function collectAnthropicUserText(body) {
  const parts = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message.role !== 'user') {
      continue;
    }
    parts.push(extractTextFromContent(message.content));
  }
  return parts.join('\n');
}

function collectAnthropicSystemText(body) {
  if (typeof body.system === 'string') {
    return body.system;
  }
  if (Array.isArray(body.system)) {
    return body.system.map((block) => block?.text ?? '').join('\n');
  }
  return '';
}

function countAnthropicAssistantTurns(body) {
  let count = 0;
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message.role === 'assistant') {
      count += 1;
    }
  }
  return count;
}

function collectAnthropicAssistantToolNames(body) {
  const names = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        names.push(block.name);
      }
    }
  }
  return names;
}

/**
 * Count assistant turns after the last deferred-tools resume user message, or
 * `null` when the history contains no resume marker.
 *
 * @param {object} body - Anthropic `/v1/messages` request body
 * @returns {number | null}
 */
function countAnthropicAssistantTurnsAfterResume(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let lastResumeIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (
      message.role === 'user' &&
      extractTextFromContent(message.content).includes(
        DEFERRED_TOOLS_RESUME_MARKER,
      )
    ) {
      lastResumeIndex = i;
    }
  }
  if (lastResumeIndex === -1) {
    return null;
  }
  let count = 0;
  for (let i = lastResumeIndex + 1; i < messages.length; i += 1) {
    if (messages[i].role === 'assistant') {
      count += 1;
    }
  }
  return count;
}

function countAnthropicAssistantTurnsAfterRequestTag(body, requestTag) {
  if (!requestTag) return null;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const marker = `[Canopy-Mock-Request:${requestTag}]`;
  let lastRequestIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (
      message.role === 'user' &&
      extractTextFromContent(message.content).includes(marker)
    ) {
      lastRequestIndex = i;
    }
  }
  if (lastRequestIndex === -1) return null;
  let count = 0;
  for (let i = lastRequestIndex + 1; i < messages.length; i += 1) {
    if (messages[i].role === 'assistant') count += 1;
  }
  return count;
}

function extractTextFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') {
          return block;
        }
        if (block && typeof block.text === 'string') {
          return block.text;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

// OpenAI Responses / Chat Completions share enough shape that one extractor
// handles both `input` (Responses) and `messages` (Chat Completions).
function collectOpenAiUserText(body) {
  const parts = [];
  const items = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : [];
  for (const item of items) {
    const role = item.role ?? item.type;
    // MultiAgentV2 encrypts the spawned task payload before sending the child
    // turn to the Responses API. The stable, plaintext task route remains in
    // the agent-message recipient, so recover a Canopy marker from that route
    // for deterministic child-agent fixtures.
    if (item?.type === 'agent_message') {
      const route = [item.author, item.recipient]
        .filter((value) => typeof value === 'string')
        .join('\n');
      const routeMarker = /(Canopy-C[A-Za-z0-9_-]+)/.exec(route)?.[1];
      if (routeMarker) {
        parts.push(`[${routeMarker}]`);
      } else {
        const encodedMarker = /(?:^|\/)canopy_(c[a-z0-9_]+)/i.exec(route)?.[1];
        if (encodedMarker) {
          parts.push(`[Canopy-${encodedMarker.toUpperCase()}]`);
        }
      }
    }
    if (role && role !== 'user' && role !== 'message') {
      continue;
    }
    if (typeof item.content === 'string') {
      parts.push(item.content);
    } else if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (typeof part === 'string') {
          parts.push(part);
        } else if (typeof part?.text === 'string') {
          parts.push(part.text);
        }
      }
    }
  }
  return parts.join('\n');
}

function collectOpenAiSystemText(body) {
  const parts = [];
  if (typeof body.instructions === 'string') {
    parts.push(body.instructions);
  }
  const items = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : [];
  for (const item of items) {
    const role = item.role ?? item.type;
    if (role === 'system' || role === 'developer') {
      if (typeof item.content === 'string') {
        parts.push(item.content);
      } else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string') {
            parts.push(part.text);
          }
        }
      }
    }
  }
  return parts.join('\n');
}

function countOpenAiAssistantTurns(body) {
  let count = 0;
  const items = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : [];
  for (const item of items) {
    const role = item.role ?? item.type;
    if (
      role === 'assistant' ||
      (item.type === 'message' && item.role === 'assistant') ||
      item.type === 'function_call' ||
      item.type === 'tool_search_call' ||
      item.type === 'output_text'
    ) {
      count += 1;
    }
  }
  return count;
}

function openAiToolName(item) {
  if (typeof item?.name !== 'string') return undefined;
  return typeof item.namespace === 'string'
    ? `${item.namespace.replace(/\.$/, '')}.${item.name}`
    : item.name;
}

function openAiToolNamespace(item) {
  if (typeof item?.namespace !== 'string') return undefined;
  return item.namespace.replace(/\.$/, '');
}

function collectOpenAiAssistantToolNames(body) {
  const names = [];
  const items = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : [];
  for (const item of items) {
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const name = openAiToolName(item);
      if (name) names.push(name);
      continue;
    }
    if (item?.role === 'assistant' && Array.isArray(item.tool_calls)) {
      for (const call of item.tool_calls) {
        if (typeof call?.function?.name === 'string') {
          names.push(call.function.name);
        }
      }
    }
  }
  return names;
}

function collectOpenAiCompletedToolNames(body) {
  const items = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : [];
  const pendingNamesByCallId = new Map();
  const recordCall = (callId, name) => {
    const pending = pendingNamesByCallId.get(callId) ?? [];
    pending.push(name);
    pendingNamesByCallId.set(callId, pending);
  };
  const completedNames = [];
  for (const item of items) {
    if (
      item?.type === 'function_call' &&
      typeof item.call_id === 'string' &&
      typeof item.name === 'string'
    ) {
      recordCall(item.call_id, openAiToolName(item));
      continue;
    }
    if (
      item?.type === 'custom_tool_call' &&
      typeof item.call_id === 'string' &&
      typeof item.name === 'string'
    ) {
      recordCall(item.call_id, openAiToolName(item));
      continue;
    }
    if (item?.role === 'assistant' && Array.isArray(item.tool_calls)) {
      for (const call of item.tool_calls) {
        if (
          typeof call?.id === 'string' &&
          typeof call?.function?.name === 'string'
        ) {
          recordCall(call.id, call.function.name);
        }
      }
      continue;
    }
    const callId =
      item?.type === 'function_call_output' ||
      item?.type === 'custom_tool_call_output'
        ? item.call_id
        : item?.role === 'tool'
          ? item.tool_call_id
          : undefined;
    if (typeof callId !== 'string') continue;
    const pending = pendingNamesByCallId.get(callId);
    const name = pending?.shift();
    if (name) completedNames.push(name);
    if (pending?.length === 0) pendingNamesByCallId.delete(callId);
  }
  return completedNames;
}

// ── Step resolution (the three-tier matcher, Doc 5 §3) ──────────────────────

/**
 * Resolve the CannedStep for a request. Exported for in-process testing.
 *
 * @param {object} options
 * @param {string} options.userText - concatenated user-message text
 * @param {string} options.systemText - concatenated system/developer text
 * @param {number} options.assistantTurns - assistant turns already in history
 * @param {string[]} [options.assistantToolNames] - assistant tool calls already in history
 * @param {number | null} [options.assistantTurnsAfterResume] - assistant turns
 *   after the last deferred-tools resume message; `null`/absent when the
 *   history has no resume marker (or the caller cannot compute it)
 * @param {number | null} [options.assistantTurnsAfterRequestTag] - assistant
 *   turns after the latest tagged request, used by tagged multi-step schedules
 * @param {object} [options.scenario] - registered scenario (`{ llm?: {...} }`)
 * @param {string} [options.conversationKey] - `prompt:<line>` scenario key
 *   matched when the prompt carries no marker
 * @returns {{ step: object, usage: object, conversationId?: string }}
 */
export function resolveCannedStep(options) {
  const {
    userText,
    systemText,
    assistantTurns,
    assistantToolNames,
    assistantTurnsAfterResume,
    assistantTurnsAfterRequestTag,
    scenario,
    conversationKey,
  } = options;

  // Helper/background flows can include the user's marker-bearing message in a
  // wrapper prompt. Match those first so summaries, branch names, PR text, etc.
  // do not accidentally receive the live-turn script meant for the chat under
  // test.
  const helper = matchHelperFingerprint(systemText);
  if (helper) {
    const scenarioStep = scenario?.llm?.helperStepsById?.[helper.id];
    const step =
      scenarioStep && typeof scenarioStep === 'object'
        ? scenarioStep
        : helper.step;
    return {
      step,
      usage: { ...DEFAULT_USAGE, ...(step.usage ?? {}) },
    };
  }

  // Tier 1: marker conversation. Prefer a scenario-registered script, then a
  // file-based conversation, both keyed by the `[Canopy-C<id>]` marker (or by
  // a matched `prompt:<line>` scenario key).
  const marker = markerFromText(userText) ?? conversationKey;
  if (marker) {
    const conversation = resolveConversation(marker, scenario);
    if (conversation && Array.isArray(conversation.steps)) {
      // Contract tests gate scripted responses on instructions delivered by the
      // real provider request. User text must never satisfy this guard.
      const forbiddenInstruction = conversation.forbiddenSystemText?.find(
        (text) => systemText.includes(text),
      );
      if (forbiddenInstruction) {
        return {
          step: {
            text: `Forbidden system instruction: ${forbiddenInstruction}`,
            stopReason: 'end_turn',
          },
          usage: { ...DEFAULT_USAGE },
          conversationId: marker,
        };
      }
      const missingInstruction = conversation.requiredSystemText?.find(
        (text) => !systemText.includes(text),
      );
      if (missingInstruction) {
        return {
          step: {
            text: `Missing required system instruction: ${missingInstruction}`,
            stopReason: 'end_turn',
          },
          usage: { ...DEFAULT_USAGE },
          conversationId: marker,
        };
      }
      const missingUserInstruction = conversation.requiredUserText?.find(
        (text) => !userText.includes(text),
      );
      if (missingUserInstruction) {
        return {
          step: {
            text: `Missing required user instruction: ${missingUserInstruction}`,
            stopReason: 'end_turn',
          },
          usage: { ...DEFAULT_USAGE },
          conversationId: marker,
        };
      }
      const requestTag = mockRequestTagFromText(userText);
      const taggedStep =
        requestTag &&
        conversation.stepsByRequestTag &&
        typeof conversation.stepsByRequestTag === 'object'
          ? conversation.stepsByRequestTag[requestTag]
          : undefined;
      if (Array.isArray(taggedStep)) {
        const index = Math.min(
          assistantTurnsAfterRequestTag ?? 0,
          taggedStep.length - 1,
        );
        const step = taggedStep[index] ?? DEFAULT_STEP;
        const usage = {
          ...DEFAULT_USAGE,
          ...(conversation.defaultUsage ?? {}),
          ...(step.usage ?? {}),
        };
        return { step, usage, conversationId: marker };
      }
      if (taggedStep && typeof taggedStep === 'object') {
        const usage = {
          ...DEFAULT_USAGE,
          ...(conversation.defaultUsage ?? {}),
          ...(taggedStep.usage ?? {}),
        };
        return { step: taggedStep, usage, conversationId: marker };
      }
      const isDeferredToolsReloadResume =
        userText.includes(DEFERRED_TOOLS_RESUME_MARKER) &&
        Array.isArray(conversation.resumeSteps);
      const steps = isDeferredToolsReloadResume
        ? conversation.resumeSteps
        : conversation.steps;
      const resumeToolNames = new Set(
        isDeferredToolsReloadResume
          ? steps.flatMap((step) =>
              Array.isArray(step.toolCalls)
                ? step.toolCalls.map((call) => call.name)
                : [],
            )
          : [],
      );
      const completedResumeToolCalls = Array.isArray(assistantToolNames)
        ? assistantToolNames.filter((name) => resumeToolNames.has(name)).length
        : null;
      // Prefer the resume-anchored count: the pre-resume assistant-turn total
      // varies with interrupt timing (partial streamed turn, synthetic
      // acknowledgment turn), so `assistantTurns - steps.length` is only a
      // fallback for callers that cannot compute the anchored count.
      const stepOffset = isDeferredToolsReloadResume
        ? completedResumeToolCalls && completedResumeToolCalls > 0
          ? completedResumeToolCalls
          : (assistantTurnsAfterResume ??
            completedResumeToolCalls ??
            Math.max(0, assistantTurns - conversation.steps.length))
        : assistantTurns;
      const index = Math.min(stepOffset, steps.length - 1);
      const step = steps[index] ?? DEFAULT_STEP;
      const usage = {
        ...DEFAULT_USAGE,
        ...(conversation.defaultUsage ?? {}),
        ...(step.usage ?? {}),
      };
      return { step, usage, conversationId: marker };
    }
  }

  // Tier 3: benign default.
  return { step: DEFAULT_STEP, usage: { ...DEFAULT_USAGE } };
}

// Demo videos script replies without a visible marker by registering the
// scenario under `prompt:<the exact typed prompt>`. Every user-message line,
// with XML-style wrapper tags removed, is tried as a key, so the chat turn and
// the helper requests it triggers (branch naming, chat titles) all resolve.
// Lines are tried newest first, so a later turn's prompt wins over an earlier
// prompt still in the history.
export const PROMPT_SCENARIO_KEY_PREFIX = 'prompt:';

function findPromptScenario(userText) {
  for (const rawLine of userText.split('\n').reverse()) {
    const line = rawLine.replace(/<\/?[A-Za-z_][\w-]*>/g, '').trim();
    if (!line) continue;
    const key = `${PROMPT_SCENARIO_KEY_PREFIX}${line}`;
    const scenario = getScenario(key);
    if (scenario?.llm || scenario?.strict === true) return { key, scenario };
  }
  return undefined;
}

/**
 * Resolve the scenario for a provider request: by `[Canopy-C<id>]` marker
 * first, then by a `prompt:<line>` key for marker-less prompts.
 *
 * @param {string} userText
 * @returns {{ scenario: object, conversationKey?: string }}
 */
function resolveScenarioForUserText(userText, fallbackKey) {
  const marker = markerFromText(userText);
  if (!marker) {
    const matched = findPromptScenario(userText);
    if (matched) {
      return {
        scenario: matched.scenario,
        conversationKey: matched.key,
        scenarioKey: matched.key,
      };
    }
    return {
      scenario: getScenario(fallbackKey),
      // A credential-keyed scenario can use the same inlined `llm.steps`
      // shape as a marker-keyed conversation, even when the prompt is opaque.
      conversationKey: fallbackKey,
      scenarioKey: fallbackKey,
    };
  }
  return resolveScenarioForMarker(marker);
}

function resolveScenarioForMarker(marker) {
  if (!marker) {
    return { scenario: getScenario(undefined), scenarioKey: undefined };
  }
  const direct = getScenario(marker);
  if (direct?.llm || direct?.strict === true) {
    return { scenario: direct, scenarioKey: marker };
  }
  const bare = marker.replace(/^Canopy-/, '');
  const scenario = getScenario(bare);
  if (scenario?.llm || scenario?.strict === true) {
    return { scenario, scenarioKey: bare };
  }
  return {
    scenario: direct !== DEFAULT_SCENARIO ? direct : scenario,
    scenarioKey:
      direct !== DEFAULT_SCENARIO
        ? marker
        : scenario !== DEFAULT_SCENARIO
          ? bare
          : marker,
  };
}

function resolveOpenAiStepCursor(assistantTurns, completedToolNames, scenario) {
  const llm = scenario?.llm;
  if (
    llm?.openAiStepCursor === 'completed-scenario-tool-calls' &&
    Array.isArray(llm.steps)
  ) {
    const remainingCompletions = new Map();
    for (const name of completedToolNames) {
      remainingCompletions.set(name, (remainingCompletions.get(name) ?? 0) + 1);
    }

    let completedSteps = 0;
    for (const step of llm.steps) {
      const expectedNames = Array.isArray(step?.toolCalls)
        ? step.toolCalls
            .map((call) => openAiToolName(call))
            .filter((name) => typeof name === 'string')
        : [];
      if (expectedNames.length === 0) break;

      const requiredCompletions = new Map();
      for (const name of expectedNames) {
        requiredCompletions.set(name, (requiredCompletions.get(name) ?? 0) + 1);
      }
      if (
        [...requiredCompletions].some(
          ([name, count]) => (remainingCompletions.get(name) ?? 0) < count,
        )
      ) {
        break;
      }
      for (const [name, count] of requiredCompletions) {
        remainingCompletions.set(name, remainingCompletions.get(name) - count);
      }
      completedSteps += 1;
    }
    return completedSteps;
  }
  return assistantTurns;
}

function isStrictScenario(scenario) {
  return scenario?.strict === true || scenario?.llm?.strict === true;
}

function unmatchedStep() {
  return {
    error: {
      code: 'mock_unmatched',
      type: 'mock_unmatched',
      message: 'No mock LLM step matched the request.',
    },
    stopReason: 'end_turn',
  };
}

/**
 * Apply request-scoped attempt resolution only when a transport context is
 * supplied. The context-free resolver remains a pure legacy projection.
 */
function resolveContextStep(step, usage, scenario, scenarioKey, context) {
  if (!context) {
    return { step, usage, attempt: undefined };
  }

  let selectedStep = step;
  let selectedUsage = usage;
  if (isStrictScenario(scenario) && selectedStep === DEFAULT_STEP) {
    selectedStep = unmatchedStep();
  }

  const resolution = resolveStepAttempt(scenarioKey, selectedStep);
  if (resolution?.step && typeof resolution.step === 'object') {
    selectedStep = resolution.step;
    if (selectedStep.usage && typeof selectedStep.usage === 'object') {
      selectedUsage = { ...selectedUsage, ...selectedStep.usage };
    }
  }
  return {
    step: selectedStep,
    usage: selectedUsage,
    attempt: resolution?.attempt,
  };
}

function toolDefinitionName(tool) {
  if (typeof tool?.name === 'string') return tool.name;
  if (typeof tool?.function?.name === 'string') return tool.function.name;
  return undefined;
}

// Namespaced tool lists (Codex `additional_tools`) nest their functions.
function toolDefinitionNames(tool) {
  const name = toolDefinitionName(tool);
  const nested = Array.isArray(tool?.tools)
    ? tool.tools.flatMap(toolDefinitionNames)
    : [];
  return typeof name === 'string' ? [name, ...nested] : nested;
}

function currentRequestToolNames(body) {
  return currentRequestTools(body).flatMap(toolDefinitionNames);
}

function collectToolResultIds(body, protocol) {
  const ids = [];
  if (protocol === 'anthropic') {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) {
        if (
          block?.type === 'tool_result' &&
          typeof block.tool_use_id === 'string'
        ) {
          ids.push(block.tool_use_id);
        }
      }
    }
    return ids;
  }

  const items = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : [];
  for (const item of items) {
    const id =
      item?.type === 'function_call_output' ||
      item?.type === 'custom_tool_call_output'
        ? (item.call_id ?? item.id)
        : item?.type === 'tool_result'
          ? (item.tool_use_id ?? item.call_id ?? item.id)
          : item?.role === 'tool'
            ? item.tool_call_id
            : undefined;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

function observationRoute(route) {
  if (typeof route !== 'string') return undefined;
  if (
    route === '/responses' ||
    route === 'responses' ||
    route.endsWith('/v1/responses') ||
    route.endsWith('/responses/responses')
  ) {
    return '/v1/responses';
  }
  return route;
}

function fixtureCredentialLabelFor(context) {
  const label = getScenario(context.key)?.cloud?.credentialLabel;
  return label === 'initial' || label === 'replacement' ? label : null;
}

// Every credential-bearing inference request, token counts included.
function journalInferenceRequest(body, protocol, context, requestTag) {
  recordInferenceJournalEntry({
    transport: context.transport,
    route: observationRoute(context.route),
    model: typeof body.model === 'string' ? body.model : null,
    tag: requestTag,
    helper: matchHelperFingerprint(
      protocol === 'anthropic'
        ? collectAnthropicSystemText(body)
        : collectOpenAiSystemText(body),
    )?.id,
    fixtureCredentialLabel: fixtureCredentialLabelFor(context),
    brokerAuthenticated: context.broker === true,
  });
}

function recordLlmRequest(body, protocol, context, scenarioKey, metadata) {
  if (!context) return undefined;
  const fixtureCredentialLabel = fixtureCredentialLabelFor(context);
  journalInferenceRequest(body, protocol, context, metadata.requestTag);
  const observation = recordRequest(scenarioKey, {
    transport: context.transport,
    route: observationRoute(context.route),
    stepId: metadata.stepId,
    tag: metadata.requestTag,
    ...(getScenario(scenarioKey)?.llm?.captureBrokerAuthentication === true
      ? {
          fixtureCredentialLabel,
          brokerAuthenticated: context.broker === true,
        }
      : {}),
    attempt: metadata.attempt,
    model: typeof body.model === 'string' ? body.model : null,
    toolNames: currentRequestToolNames(body),
    toolResultIds: collectToolResultIds(body, protocol),
  });
  // Opt in only for isolated synthetic fixtures; never capture auth headers.
  if (getScenario(scenarioKey)?.llm?.captureRequestBodies === true)
    observation.body = structuredClone(body);
  return observation;
}

function recordRequestTextObservers(
  scenarioKey,
  scenario,
  body,
  userText,
  systemText,
) {
  const requestText = `${systemText}\n${userText}\n${JSON.stringify(body)}`;
  const messages = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : [];
  for (const observer of scenario?.llm?.requestTextObservers ?? []) {
    if (
      observer &&
      typeof observer.key === 'string' &&
      observer.key.length > 0 &&
      typeof observer.text === 'string' &&
      observer.text.length > 0 &&
      (observer.requestTag === undefined ||
        observer.requestTag === mockRequestTagFromText(userText)) &&
      (observer.scope === 'tools'
        ? JSON.stringify(currentRequestTools(body))
        : typeof observer.lastMessageContaining === 'string'
          ? JSON.stringify(
              messages.findLast((message) =>
                JSON.stringify(message).includes(
                  observer.lastMessageContaining,
                ),
              ) ?? '',
            )
          : requestText
      ).includes(observer.text)
    ) {
      recordScenarioActivity(scenarioKey, `llmObserved:${observer.key}`);
    }
  }
}

// Resolve a canned reply for an OpenAI Responses-shaped request body. Shared by
// the HTTP `/v1/responses` route and the WebSocket `/responses` transport
// (`responsesWs.mjs`), so both surfaces honor the same marker/fingerprint tiers.
export function resolveResponsesReply(body, context) {
  const userText = collectOpenAiUserText(body);
  const systemText = collectOpenAiSystemText(body);
  const assistantTurns = countOpenAiAssistantTurns(body);
  const assistantToolNames = collectOpenAiAssistantToolNames(body);
  const completedToolNames = collectOpenAiCompletedToolNames(body);
  const { scenario, conversationKey, scenarioKey } = resolveScenarioForUserText(
    userText,
    context?.key,
  );
  const resolved = resolveCannedStep({
    userText,
    systemText,
    conversationKey,
    assistantTurns: resolveOpenAiStepCursor(
      assistantTurns,
      completedToolNames,
      scenario,
    ),
    assistantToolNames,
    scenario,
  });
  const { step, usage, attempt } = resolveContextStep(
    resolved.step,
    resolved.usage,
    scenario,
    scenarioKey,
    context,
  );
  const requestTag = mockRequestTagFromText(userText);
  const observation = recordLlmRequest(body, 'openai', context, scenarioKey, {
    stepId: step.stepId,
    attempt,
    requestTag,
  });
  if (context) {
    recordRequestTextObservers(
      resolved.conversationId ?? scenarioKey,
      scenario,
      body,
      userText,
      systemText,
    );
  }
  const model = typeof body.model === 'string' ? body.model : undefined;
  const reply = {
    step: materializeCannedStep(step, body),
    usage,
    model,
  };
  if (context) {
    reply.scenarioKey = scenarioKey;
    reply.observation = observation;
    reply.conversationId = resolved.conversationId;
  }
  return reply;
}

// Map a canned step's `error` directive to a Responses-style failure payload for
// the WebSocket transport. The HTTP route uses `maybeRenderError` + status codes
// instead; over a WS the failure must ride the stream as a `response.failed`
// event, so return the inner error shape (or `null` when the step is benign).
export function classifyResponsesStepError(step) {
  const error = step?.error;
  if (!error) {
    return null;
  }
  if (error.kind === 'disconnect' || error.kind === 'midstream') {
    return null;
  }
  if (error === 'no_billing_source' || error.type === 'no_billing_source') {
    return {
      code: NO_BILLING_SOURCE_ERROR.code,
      message: NO_BILLING_SOURCE_ERROR.message,
    };
  }
  if (typeof error.code === 'string' && error.code.length > 0) {
    return { code: error.code, message: error.message ?? 'Mock error.' };
  }
  if (error === 'usage_limit' || error.type === 'usage_limit') {
    return { code: 'usage_limit_exceeded', message: 'Usage limit reached.' };
  }
  if (error === 'rate_limit' || error.type === 'rate_limit') {
    return { code: 'rate_limit_exceeded', message: 'Rate limited.' };
  }
  return { code: 'server_error', message: error.message ?? 'Mock error.' };
}

function resolveConversation(marker, scenario) {
  // Scenario-registered conversation(s) win over files so a test can inline a
  // script via the control plane without writing a file.
  const llm = scenario?.llm;
  if (llm && typeof llm === 'object') {
    if (Array.isArray(llm.steps)) {
      return llm;
    }
    if (llm.conversations && typeof llm.conversations === 'object') {
      const inline =
        llm.conversations[marker] ??
        llm.conversations[marker.replace(/^Canopy-/, '')];
      if (inline) {
        return inline;
      }
    }
  }
  return loadFileConversations().get(marker);
}

function findFirstDeferredSearchRef(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstDeferredSearchRef(item);
      if (found) return found;
    }
    return undefined;
  }
  if (Array.isArray(value.results)) {
    for (const result of value.results) {
      for (const match of Array.isArray(result?.matches)
        ? result.matches
        : []) {
        if (typeof match?.ref === 'string' && match.ref.trim()) {
          return match.ref;
        }
      }
    }
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          const found = findFirstDeferredSearchRef(parsed);
          if (found) return found;
        } catch {
          // Non-JSON strings are ignored.
        }
      }
    } else if (candidate && typeof candidate === 'object') {
      const found = findFirstDeferredSearchRef(candidate);
      if (found) return found;
    }
  }
  return undefined;
}

// The plan file Claude Code names in its plan-mode reminder, e.g. "You should
// create your plan at /…/plans/<slug>.md using the Write tool." or "Read-only
// except plan file (/…/plans/<slug>.md)". The slug is generated per session,
// so a scripted step can only learn the path from the request. The path may
// contain spaces (a profile or temp directory), so it is read from the "at "
// or "(" that introduces it through to its `.md`.
const PLAN_MODE_PLAN_FILE_PATTERN =
  /(?:\bat:? |\()((?:[A-Za-z]:)?[\\/][^\n"'`<>()]*[\\/]plans[\\/][^\n"'`<>()\\/]+?\.md)/;

function findPlanModePlanFile(value) {
  if (typeof value === 'string') {
    return value.match(PLAN_MODE_PLAN_FILE_PATTERN)?.[1];
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  for (const candidate of Object.values(value)) {
    const found = findPlanModePlanFile(candidate);
    if (found) return found;
  }
  return undefined;
}

function materializeCannedStep(step, body) {
  if (!Array.isArray(step?.toolCalls)) {
    return step;
  }
  let changed = false;
  const searchRef = findFirstDeferredSearchRef(body);
  const toolCalls = step.toolCalls.map((toolCall) => {
    if (toolCall?.writesPlanModePlanFile === true) {
      // Claude Code reads a proposed plan only from its plan file, never from
      // the ExitPlanMode call, so a scripted plan turn writes that file first.
      const planFile = findPlanModePlanFile(body);
      if (!planFile) return toolCall;
      changed = true;
      return { ...toolCall, input: { ...toolCall.input, file_path: planFile } };
    }
    if (toolCall?.loadDeferredToolsFromPreviousSearch !== true) {
      return toolCall;
    }
    changed = true;
    return {
      ...toolCall,
      input: {
        items: [
          ...(searchRef ? [{ ref: searchRef }] : []),
          ...(Array.isArray(toolCall.extraItems) ? toolCall.extraItems : []),
        ],
      },
    };
  });
  return changed ? { ...step, toolCalls } : step;
}

// ── SSE rendering helpers ────────────────────────────────────────────────────

// Real providers never reuse a tool_use id within a conversation, and the app
// keeps only the latest result per id. Ids after the first tool-using step
// therefore carry the count of tool_use blocks already in the history.
function scriptedToolUseId(toolCall, index, priorToolUses = 0) {
  if (typeof toolCall?.id === 'string' && toolCall.id.length > 0) {
    return toolCall.id;
  }
  return priorToolUses > 0
    ? `toolu_mock_${priorToolUses}_${index}`
    : `toolu_mock_${index}`;
}

function countPriorToolUses(body) {
  let count = 0;
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block?.type === 'tool_use') count += 1;
    }
  }
  return count;
}

function sseWrite(response, event, data) {
  if (event) {
    response.write(`event: ${event}\n`);
  }
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function chunkText(text, chunkChars) {
  const size = Math.max(1, chunkChars ?? 24);
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks.length > 0 ? chunks : [''];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `streamMs` (CannedStep, Doc 5 §4) is the *total* wall-clock duration the
// scripted step should take to stream. We spread that budget evenly across the
// text-delta chunks so a slow step holds the chat in its `streaming` state long
// enough for UI automation to observe streaming-only affordances (the
// "Stop generation" interrupt control, the queued-message bubble) before the
// turn completes. With no `streamMs`, chunks are emitted back-to-back (the
// previous synchronous behavior). The pacing is applied between text-delta
// writes; structural events (start/stop/usage) are not delayed.
async function pacedTextDeltas(response, chunks, streamMs, writeDelta) {
  const totalMs = typeof streamMs === 'number' && streamMs > 0 ? streamMs : 0;
  const perChunkMs = totalMs > 0 ? totalMs / chunks.length : 0;
  for (const chunk of chunks) {
    writeDelta(chunk);
    if (perChunkMs > 0) {
      await delay(perChunkMs);
    }
  }
}

function startSseResponse(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function mapStopReasonAnthropic(stopReason) {
  if (stopReason === 'tool_use') return 'tool_use';
  if (stopReason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

// ── Anthropic Messages rendering ─────────────────────────────────────────────

async function renderAnthropicStream(
  response,
  step,
  usage,
  model,
  priorToolUses = 0,
) {
  startSseResponse(response);
  const messageId = `msg_mock_${Date.now()}`;

  sseWrite(response, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: model ?? MODEL_FALLBACK,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage.inputTokens ?? 0,
        cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
        cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
        output_tokens: 1,
      },
    },
  });

  let blockIndex = 0;

  if (step.thinking) {
    sseWrite(response, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'thinking', thinking: '' },
    });
    for (const chunk of chunkText(step.thinking, step.chunkChars)) {
      sseWrite(response, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: chunk },
      });
    }
    sseWrite(response, 'content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex,
    });
    blockIndex += 1;
  }

  if (step.text) {
    sseWrite(response, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
    await pacedTextDeltas(
      response,
      chunkText(step.text, step.chunkChars),
      step.streamMs,
      (chunk) => {
        sseWrite(response, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: chunk },
        });
      },
    );
    sseWrite(response, 'content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex,
    });
    blockIndex += 1;
  }

  for (const toolCall of Array.isArray(step.toolCalls) ? step.toolCalls : []) {
    const toolId = scriptedToolUseId(toolCall, blockIndex, priorToolUses);
    sseWrite(response, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: toolId,
        name: toolCall.name,
        input: {},
      },
    });
    const inputJson = JSON.stringify(toolCall.input ?? {});
    sseWrite(response, 'content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: inputJson },
    });
    sseWrite(response, 'content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex,
    });
    blockIndex += 1;
  }

  const stopReason = mapStopReasonAnthropic(
    step.stopReason ??
      (Array.isArray(step.toolCalls) && step.toolCalls.length > 0
        ? 'tool_use'
        : 'end_turn'),
  );

  sseWrite(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.outputTokens ?? 0 },
  });
  sseWrite(response, 'message_stop', { type: 'message_stop' });
  response.end();
}

function renderAnthropicJson(response, step, usage, model, priorToolUses = 0) {
  const content = [];
  if (step.thinking) {
    content.push({ type: 'thinking', thinking: step.thinking });
  }
  if (step.text) {
    content.push({ type: 'text', text: step.text });
  }
  for (const [i, toolCall] of (Array.isArray(step.toolCalls)
    ? step.toolCalls
    : []
  ).entries()) {
    content.push({
      type: 'tool_use',
      id: scriptedToolUseId(toolCall, i, priorToolUses),
      name: toolCall.name,
      input: toolCall.input ?? {},
    });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  jsonResponse(response, 200, {
    id: `msg_mock_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model ?? MODEL_FALLBACK,
    content,
    stop_reason: mapStopReasonAnthropic(step.stopReason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
    },
  });
}

// ── OpenAI Responses rendering ───────────────────────────────────────────────

// Build the ordered OpenAI Responses streaming event list for a canned step.
// Shared by the HTTP SSE renderer (`renderResponsesStream`) and the WebSocket
// transport (`responsesWs.mjs`), which speaks the same `response.*` events over
// the `responses_websockets` beta protocol. Each entry is `{ event, data }`;
// `paced: true` marks the text-delta events the SSE renderer spreads across
// `streamMs`.
export function buildResponsesEvents(step, usage, model) {
  const events = [];
  const responseId = `resp_mock_${randomUUID()}`;
  const base = {
    id: responseId,
    object: 'response',
    model: model ?? MODEL_FALLBACK,
    status: 'in_progress',
  };

  events.push({
    event: 'response.created',
    data: { type: 'response.created', response: base },
  });
  events.push({
    event: 'response.in_progress',
    data: { type: 'response.in_progress', response: base },
  });

  let outputIndex = 0;
  const outputItems = [];

  if (step.toolSearch) {
    const toolSearchItem = {
      id: `ts_mock_${responseId}_${outputIndex}`,
      type: 'tool_search_call',
      call_id: `call_search_mock_${responseId}_${outputIndex}`,
      status: 'completed',
      execution: 'client',
      arguments: step.toolSearch,
    };
    events.push({
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: toolSearchItem,
      },
    });
    events.push({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: toolSearchItem,
      },
    });
    outputItems.push(toolSearchItem);
    outputIndex += 1;
  }

  if (step.text) {
    const itemId = `item_mock_${responseId}_${outputIndex}`;
    events.push({
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: { id: itemId, type: 'message', role: 'assistant', content: [] },
      },
    });
    events.push({
      event: 'response.content_part.added',
      data: {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      },
    });
    for (const chunk of chunkText(step.text, step.chunkChars)) {
      events.push({
        event: 'response.output_text.delta',
        paced: true,
        data: {
          type: 'response.output_text.delta',
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          delta: chunk,
        },
      });
    }
    events.push({
      event: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text: step.text,
      },
    });
    const messageItem = {
      id: itemId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: step.text }],
    };
    events.push({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: messageItem,
      },
    });
    outputItems.push(messageItem);
    outputIndex += 1;
  }

  for (const toolCall of Array.isArray(step.toolCalls) ? step.toolCalls : []) {
    const itemId = `fc_mock_${responseId}_${outputIndex}`;
    const callId = toolCall.id ?? `call_mock_${responseId}_${outputIndex}`;
    const custom = toolCall.type === 'custom';
    const functionCallItem = {
      id: itemId,
      type: custom ? 'custom_tool_call' : 'function_call',
      name: toolCall.name,
      ...(toolCall.namespace
        ? { namespace: openAiToolNamespace(toolCall) }
        : {}),
      call_id: callId,
      ...(custom
        ? { input: toolCall.input ?? '' }
        : { arguments: JSON.stringify(toolCall.input ?? {}) }),
    };
    if (custom) {
      // Mirror the custom-tool input lifecycle as well as its terminal item.
      events.push({
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { ...functionCallItem, input: '' },
        },
      });
      events.push({
        event: 'response.custom_tool_call_input.delta',
        data: {
          type: 'response.custom_tool_call_input.delta',
          item_id: itemId,
          output_index: outputIndex,
          delta: functionCallItem.input,
        },
      });
      events.push({
        event: 'response.custom_tool_call_input.done',
        data: {
          type: 'response.custom_tool_call_input.done',
          item_id: itemId,
          output_index: outputIndex,
          input: functionCallItem.input,
        },
      });
    }
    events.push({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: functionCallItem,
      },
    });
    outputItems.push(functionCallItem);
    outputIndex += 1;
  }

  events.push({
    event: 'response.completed',
    data: {
      type: 'response.completed',
      response: {
        ...base,
        status: 'completed',
        output: outputItems,
        usage: {
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          input_tokens_details: {
            cached_tokens: usage.cacheReadInputTokens ?? 0,
          },
        },
      },
    },
  });

  return events;
}

async function renderResponsesStream(response, step, usage, model) {
  startSseResponse(response);
  const events = buildResponsesEvents(step, usage, model);
  const pacedCount = events.filter((entry) => entry.paced).length;
  const totalMs =
    typeof step.streamMs === 'number' && step.streamMs > 0 ? step.streamMs : 0;
  const perChunkMs = totalMs > 0 && pacedCount > 0 ? totalMs / pacedCount : 0;
  for (const entry of events) {
    sseWrite(response, entry.event, entry.data);
    if (entry.paced && perChunkMs > 0) {
      await delay(perChunkMs);
    }
  }
  response.end();
}

function renderResponsesJson(response, step, usage, model) {
  const events = buildResponsesEvents(step, usage, model);
  const completed = events.find(
    (entry) => entry.event === 'response.completed',
  );
  jsonResponse(response, 200, completed.data.response);
}

// ── OpenAI Chat Completions rendering ────────────────────────────────────────

async function renderChatCompletionsStream(response, step, usage, model) {
  startSseResponse(response);
  const id = `chatcmpl_mock_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const baseChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: model ?? MODEL_FALLBACK,
  };

  sseWrite(response, undefined, {
    ...baseChunk,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  if (step.text) {
    await pacedTextDeltas(
      response,
      chunkText(step.text, step.chunkChars),
      step.streamMs,
      (chunk) => {
        sseWrite(response, undefined, {
          ...baseChunk,
          choices: [
            { index: 0, delta: { content: chunk }, finish_reason: null },
          ],
        });
      },
    );
  }

  const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
  for (const [i, toolCall] of toolCalls.entries()) {
    sseWrite(response, undefined, {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: i,
                id: `call_mock_${i}`,
                type: 'function',
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.input ?? {}),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }

  const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  sseWrite(response, undefined, {
    ...baseChunk,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
  sseWrite(response, undefined, {
    ...baseChunk,
    choices: [],
    usage: {
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    },
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

function renderChatCompletionsJson(response, step, usage, model) {
  const message = { role: 'assistant', content: step.text ?? '' };
  const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((toolCall, i) => ({
      id: `call_mock_${i}`,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.input ?? {}),
      },
    }));
  }
  jsonResponse(response, 200, {
    id: `chatcmpl_mock_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model ?? MODEL_FALLBACK,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    },
  });
}

// ── Body reading ─────────────────────────────────────────────────────────────

function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    request.on('error', () => resolve({}));
  });
}

// ── Error injection ──────────────────────────────────────────────────────────

function maybeRenderError(response, step) {
  const error = step?.error;
  if (!error) {
    return false;
  }
  if (
    typeof error === 'object' &&
    (error.kind === 'disconnect' || error.kind === 'midstream')
  ) {
    return false;
  }
  if (typeof error === 'object' && error.code === 'mock_unmatched') {
    jsonResponse(response, 500, {
      error: {
        type: 'mock_unmatched',
        code: 'mock_unmatched',
        message: error.message ?? 'No mock LLM step matched the request.',
      },
    });
    return true;
  }
  if (error === 'usage_limit' || error.type === 'usage_limit') {
    jsonResponse(response, 429, {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Usage limit reached.',
      },
    });
    return true;
  }
  if (error === 'rate_limit' || error.type === 'rate_limit') {
    jsonResponse(response, 429, {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limited.' },
    });
    return true;
  }
  if (error === 'no_billing_source' || error.type === 'no_billing_source') {
    const correlationId = randomUUID();
    response.setHeader('x-canopy-request-id', correlationId);
    // Same field order as the hosted body: marker and code first, so the
    // host's truncation fallbacks see what they would in production.
    jsonResponse(response, 402, {
      error: {
        canopy_proxy: NO_BILLING_SOURCE_ERROR.canopy_proxy,
        code: NO_BILLING_SOURCE_ERROR.code,
        correlation_id: correlationId,
        message: NO_BILLING_SOURCE_ERROR.message,
      },
    });
    return true;
  }
  const status = typeof error.status === 'number' ? error.status : 500;
  const responseError = {
    type: 'api_error',
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    message: error.message ?? 'Mock error.',
  };
  jsonResponse(response, status, {
    type: 'error',
    error: responseError,
  });
  return true;
}

function setObservationError(observation, errorClass) {
  if (observation && typeof observation === 'object' && errorClass) {
    observation.errorClass = errorClass;
  }
}

function stepErrorClass(step) {
  const error = step?.error;
  if (!error) return undefined;
  if (error.kind === 'disconnect' || error.kind === 'midstream') {
    return `mock_${error.kind}`;
  }
  return classifyResponsesStepError(step)?.code ?? 'server_error';
}

async function waitBeforeRendering(step, scenarioKey, observation, response) {
  if (step?.waitFor !== undefined) {
    try {
      const timeoutMs =
        typeof step.barrierTimeoutMs === 'number'
          ? step.barrierTimeoutMs
          : 30_000;
      await waitForBarrier(scenarioKey, step.waitFor, timeoutMs);
    } catch (error) {
      const code =
        typeof error?.code === 'string' ? error.code : 'mock_barrier_error';
      const message =
        typeof error?.message === 'string'
          ? error.message
          : 'Mock barrier failed.';
      setObservationError(observation, code);
      jsonResponse(response, 500, {
        error: { type: code, code, message },
      });
      return false;
    }
  }

  if (typeof step?.delayMs === 'number' && step.delayMs > 0) {
    await delay(step.delayMs);
  }
  return true;
}

function isStructuralSseFrame(frame) {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return false;
  const value = dataLine.slice('data:'.length).trim();
  if (value === '[DONE]') return true;
  try {
    const payload = JSON.parse(value);
    if (
      payload.type === 'content_block_delta' ||
      (typeof payload.type === 'string' && payload.type.endsWith('.delta'))
    ) {
      return false;
    }
    if (Array.isArray(payload.choices)) {
      if (payload.usage) return true;
      return payload.choices.some(
        (choice) =>
          choice?.finish_reason != null ||
          choice?.delta?.role !== undefined ||
          !choice?.delta,
      );
    }
  } catch {
    // Non-JSON SSE frames are structural unless they are a known delta.
  }
  return true;
}

/** Close an SSE connection immediately after the requested number of structural frames. */
function closeSseAfterStructuralFrames(response, afterFrames) {
  const limit =
    Number.isSafeInteger(afterFrames) && afterFrames >= 0 ? afterFrames : 1;
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  let buffered = '';
  let structuralFrames = 0;
  let closed = false;

  response.write = (chunk, encoding, callback) => {
    if (closed) {
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return false;
    }
    buffered += Buffer.isBuffer(chunk)
      ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
      : String(chunk);

    let frameEnd = buffered.indexOf('\n\n');
    while (frameEnd !== -1) {
      const frame = buffered.slice(0, frameEnd + 2);
      buffered = buffered.slice(frameEnd + 2);
      const structural = isStructuralSseFrame(frame);
      if (structural && limit === 0) {
        closed = true;
        response.destroy();
        return false;
      }

      const result = originalWrite(frame, encoding, callback);
      if (structural) {
        structuralFrames += 1;
        if (structuralFrames >= limit) {
          closed = true;
          response.destroy();
          return false;
        }
      }
      frameEnd = buffered.indexOf('\n\n');
    }
    return true;
  };

  response.end = (...args) => (closed ? response : originalEnd(...args));
}

// ── AI Credits gateway proxy prefixes ────────────────────────────────────────

// In E2E the cloud base URL *is* this mock server, so an AI-Credits-routed turn
// arrives on the web LLM-proxy paths rather than the bare provider paths
// (ECW-9091). Normalize the prefix and reuse the existing provider handling
// verbatim, so a routed turn is served identically to a native one.
const ANTHROPIC_PROXY_PREFIX = '/api/v1/llm-proxy/anthropic';
// Includes the `/responses` segment because production's route is
// `openai/responses/[...path]` — the segment is part of the prefix, not part of
// the forwarded path.
const OPENAI_PROXY_PREFIX = '/api/v1/llm-proxy/openai/responses';

/**
 * Strip an LLM-proxy prefix from a request path.
 *
 * - `/api/v1/llm-proxy/anthropic/v1/messages` → `/v1/messages` (the Claude SDK
 *   appends `/v1/messages` to the configured base URL).
 * - `/api/v1/llm-proxy/openai/responses/responses` → `/v1/responses`. Codex is
 *   handed a base URL that already ends in `/responses` and appends its own,
 *   so the segment legitimately appears twice on the wire; production's
 *   `openai/responses/[...path]` catch-all serves exactly that and its
 *   `isAllowedResponsesPath` allowlists `['responses']`.
 *
 * The bare `/api/v1/llm-proxy/openai/responses`, with no trailing segment, is
 * deliberately NOT accepted. A non-optional catch-all does not match its own
 * parent segment, so production 404s it — and a mock that served it would let
 * someone "clean up" the doubled segment in `buildProxyBaseUrl` and break every
 * credits-routed Codex turn with the whole suite still green. That blind spot
 * is the reason this function needed fixing in the first place.
 *
 * @param {string} pathname
 * @returns {{ pathname: string, proxyTag: string | null }}
 */
export function normalizeLlmProxyPath(pathname) {
  if (
    pathname === ANTHROPIC_PROXY_PREFIX ||
    pathname.startsWith(`${ANTHROPIC_PROXY_PREFIX}/`)
  ) {
    return {
      pathname: pathname.slice(ANTHROPIC_PROXY_PREFIX.length) || '/',
      proxyTag: 'anthropic',
    };
  }
  if (pathname.startsWith(`${OPENAI_PROXY_PREFIX}/`)) {
    return {
      pathname: `/v1${pathname.slice(OPENAI_PROXY_PREFIX.length)}`,
      proxyTag: 'openai',
    };
  }
  return { pathname, proxyTag: null };
}

// Codex 0.164 `incremental_tools` removal notices
// (codex-rs/prompts/src/model_messages/incremental_tools.rs).
const CODEX_REMOVED_TOOLS_HEADER =
  'The following tools are no longer available. Do not call them:';
const CODEX_REMOVED_NAMESPACES_HEADER =
  'The following namespaces are no longer available. Do not call tools in them unless those tools are declared in a later update:';

function developerMessageText(item) {
  if (item?.role !== 'developer') return '';
  if (typeof item.content === 'string') return item.content;
  return Array.isArray(item.content)
    ? item.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('\n')
    : '';
}

function removedToolSections(text) {
  const removed = { namespaces: [], tools: [] };
  let section;
  for (const line of text.split('\n')) {
    if (line === CODEX_REMOVED_NAMESPACES_HEADER) section = removed.namespaces;
    else if (line === CODEX_REMOVED_TOOLS_HEADER) section = removed.tools;
    else if (section && line.startsWith('- ')) section.push(line.slice(2));
    else section = undefined;
  }
  return removed;
}

/**
 * The tools a request currently offers. Codex 0.159+ sends no top-level
 * `tools` on Responses requests; it declares them in `additional_tools` input
 * items. With Codex 0.164 `incremental_tools`, later items add only changed
 * declarations and removals arrive as developer notices, so every item is
 * folded in input order.
 */
export function currentRequestTools(body) {
  const topLevel = Array.isArray(body.tools) ? body.tools : [];
  const catalog = new Map();
  const nameOf = (tool) => toolDefinitionName(tool) ?? tool?.type;
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item?.type === 'additional_tools' && Array.isArray(item.tools)) {
      for (const tool of item.tools) {
        const name = nameOf(tool);
        if (typeof name !== 'string') continue;
        if (!Array.isArray(tool.tools)) {
          catalog.set(name, { kind: 'tool', definition: tool });
          continue;
        }
        const previous = catalog.get(name);
        const members = new Map(
          previous?.kind === 'namespace' ? previous.members : [],
        );
        for (const member of tool.tools) {
          const memberName = nameOf(member);
          if (typeof memberName === 'string') members.set(memberName, member);
        }
        catalog.set(name, { kind: 'namespace', header: tool, members });
      }
      continue;
    }
    const { namespaces, tools } = removedToolSections(
      developerMessageText(item),
    );
    for (const namespace of namespaces) catalog.delete(namespace);
    for (const qualified of tools) {
      const dot = qualified.indexOf('.');
      if (dot === -1) {
        catalog.delete(qualified);
        continue;
      }
      const entry = catalog.get(qualified.slice(0, dot));
      if (entry?.kind === 'namespace')
        entry.members.delete(qualified.slice(dot + 1));
    }
  }
  const folded = [...catalog.values()].flatMap((entry) =>
    entry.kind === 'tool'
      ? [entry.definition]
      : entry.members.size > 0
        ? [{ ...entry.header, tools: [...entry.members.values()] }]
        : [],
  );
  return [...topLevel, ...folded];
}

// ── Public route handler ─────────────────────────────────────────────────────

/**
 * Handle an LLM-surface request. Returns `true` if the request matched an LLM
 * route (and a response was written), `false` otherwise. `start.mjs` wires this
 * after the control plane and before the 404 fallback.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
export async function handleLlmRequest(request, response, url) {
  const { pathname, proxyTag } = normalizeLlmProxyPath(url.pathname);
  const method = request.method;

  // Static discovery surfaces.
  if (method === 'GET' && pathname === '/v1/models') {
    jsonResponse(response, 200, {
      object: 'list',
      data: [{ id: MODEL_FALLBACK, object: 'model', owned_by: 'canopy-mock' }],
    });
    return true;
  }

  if (method !== 'POST') {
    return false;
  }

  if (pathname === '/v1/messages/count_tokens') {
    const parsed = await readJsonBody(request);
    const body = parsed && typeof parsed === 'object' ? parsed : {};
    // Journal only: token counts are not scenario steps, so they stay out of
    // per-key request observations.
    journalInferenceRequest(
      body,
      'anthropic',
      {
        key:
          keyFromBearer(request) ??
          keyFromApiKey(request, { header: 'x-api-key' }),
        transport: 'http',
        route: pathname,
        broker: proxyTag !== null,
      },
      mockRequestTagFromText(collectAnthropicUserText(body)),
    );
    jsonResponse(response, 200, { input_tokens: 1200 });
    return true;
  }

  const isAnthropic = pathname === '/v1/messages';
  const isResponses = pathname === '/v1/responses';
  const isChat = pathname === '/v1/chat/completions';
  if (!isAnthropic && !isResponses && !isChat) {
    return false;
  }

  const body = await readJsonBody(request);
  const stream = body.stream === true;
  const model = typeof body.model === 'string' ? body.model : undefined;

  // Mirror Luna's provider-side validation so UI automation exercises the
  // exact `off` reasoning-effort mapping instead of accepting a legacy value
  // that the real Responses API rejects.
  // Both spellings: a native turn sends the bare id, while a credits-routed
  // turn sends `entry.gatewayId` (`ai-credits-routing.ts`). Matching only the
  // bare id would leave the whole proxy lane unvalidated.
  const invalidLunaReasoningEffort =
    isResponses &&
    (model === 'gpt-5.6-luna' || model === 'openai/gpt-5.6-luna') &&
    body.reasoning?.effort === 'minimal';

  const credentialKey =
    keyFromBearer(request) ?? keyFromApiKey(request, { header: 'x-api-key' });
  const context = {
    key: credentialKey,
    transport: 'http',
    route: pathname,
    broker: proxyTag !== null,
  };

  const userText = isAnthropic
    ? collectAnthropicUserText(body)
    : collectOpenAiUserText(body);
  const systemText = isAnthropic
    ? collectAnthropicSystemText(body)
    : collectOpenAiSystemText(body);
  const assistantTurns = isAnthropic
    ? countAnthropicAssistantTurns(body)
    : countOpenAiAssistantTurns(body);
  const assistantToolNames = isAnthropic
    ? collectAnthropicAssistantToolNames(body)
    : collectOpenAiAssistantToolNames(body);
  const completedToolNames = isAnthropic
    ? []
    : collectOpenAiCompletedToolNames(body);
  const assistantTurnsAfterResume = isAnthropic
    ? countAnthropicAssistantTurnsAfterResume(body)
    : null;
  const requestTag = mockRequestTagFromText(userText);
  const assistantTurnsAfterRequestTag = isAnthropic
    ? countAnthropicAssistantTurnsAfterRequestTag(body, requestTag)
    : null;

  if (invalidLunaReasoningEffort) {
    const { scenarioKey } = resolveScenarioForUserText(userText, credentialKey);
    const observation = recordLlmRequest(body, 'openai', context, scenarioKey, {
      requestTag,
    });
    setObservationError(observation, 'invalid_value');
    jsonResponse(response, 400, {
      error: {
        code: 'invalid_value',
        message:
          "Invalid 'reasoning.effort': 'minimal' is not supported for gpt-5.6-luna",
        param: 'reasoning.effort',
        type: 'invalid_request_error',
      },
    });
    return true;
  }

  let scenario;
  let scenarioKey;
  let conversationId;
  let openAiStepCursor = assistantTurns;
  let step;
  let usage;
  let observation;

  if (isAnthropic) {
    const resolvedScenario = resolveScenarioForUserText(
      userText,
      credentialKey,
    );
    scenario = resolvedScenario.scenario;
    scenarioKey = resolvedScenario.scenarioKey;
    const resolved = resolveCannedStep({
      conversationKey: resolvedScenario.conversationKey,
      userText,
      systemText,
      assistantTurns,
      assistantToolNames,
      assistantTurnsAfterResume,
      assistantTurnsAfterRequestTag,
      scenario,
    });
    const selected = resolveContextStep(
      resolved.step,
      resolved.usage,
      scenario,
      scenarioKey,
      context,
    );
    step = selected.step;
    usage = selected.usage;
    conversationId = resolved.conversationId;
    observation = recordLlmRequest(body, 'anthropic', context, scenarioKey, {
      stepId: step.stepId,
      attempt: selected.attempt,
      requestTag,
    });
    recordRequestTextObservers(
      conversationId ?? scenarioKey,
      scenario,
      body,
      userText,
      systemText,
    );
  } else {
    const reply = resolveResponsesReply(body, context);
    step = reply.step;
    usage = reply.usage;
    conversationId = reply.conversationId;
    scenarioKey = reply.scenarioKey;
    observation = reply.observation;
    scenario = resolveScenarioForUserText(userText, credentialKey).scenario;
    openAiStepCursor = resolveOpenAiStepCursor(
      assistantTurns,
      completedToolNames,
      scenario,
    );
  }

  recordScenarioActivity(conversationId, 'llmRequests');
  if (model !== undefined) {
    recordScenarioActivity(conversationId, `llmModel:${model}`);
  }
  // Helper traffic is counted under the scenario it wraps, apart from the
  // chat's own requests.
  const helperId = matchHelperFingerprint(systemText)?.id;
  if (helperId) {
    recordScenarioActivity(
      markerFromText(userText) ?? scenarioKey,
      `helperRequests:${helperId}`,
    );
  }
  if (proxyTag && getScenario(credentialKey).cloud?.managedSurvival === true) {
    recordScenarioActivity(credentialKey, 'managedProxyAuthenticated');
    if (requestTag)
      recordScenarioActivity(
        credentialKey,
        `managedProxyAuthenticated:${requestTag}`,
      );
  }
  if (proxyTag) {
    // Lets a spec assert the turn was carried by the AI Credits gateway rather
    // than a native provider request (ECW-9091).
    recordScenarioActivity(conversationId, `llmProxy:${proxyTag}`);
  }
  if (!isAnthropic) {
    recordScenarioActivity(
      conversationId,
      `openAiStepCursor:${openAiStepCursor}`,
    );
    for (const name of completedToolNames) {
      recordScenarioActivity(conversationId, `completedTool:${name}`);
    }
  }
  if (requestTag) {
    recordScenarioActivity(conversationId, `llmRequests:${requestTag}`);
  }

  if (!(await waitBeforeRendering(step, scenarioKey, observation, response))) {
    return true;
  }
  setObservationError(observation, stepErrorClass(step));
  const lifecycleError = step?.error;
  if (lifecycleError?.kind === 'disconnect') {
    response.destroy();
    return true;
  }
  if (lifecycleError?.kind === 'midstream') {
    if (!stream) {
      response.destroy();
      return true;
    }
    closeSseAfterStructuralFrames(response, lifecycleError.afterFrames);
  }

  const materializedStep = materializeCannedStep(step, body);
  if (maybeRenderError(response, materializedStep)) {
    return true;
  }

  if (isAnthropic) {
    const priorToolUses = countPriorToolUses(body);
    if (stream) {
      await renderAnthropicStream(
        response,
        materializedStep,
        usage,
        model,
        priorToolUses,
      );
    } else {
      renderAnthropicJson(
        response,
        materializedStep,
        usage,
        model,
        priorToolUses,
      );
    }
    return true;
  }

  if (isResponses) {
    if (stream) {
      await renderResponsesStream(response, materializedStep, usage, model);
    } else {
      renderResponsesJson(response, materializedStep, usage, model);
    }
    return true;
  }

  // Chat Completions.
  if (stream) {
    await renderChatCompletionsStream(response, materializedStep, usage, model);
  } else {
    renderChatCompletionsJson(response, materializedStep, usage, model);
  }
  return true;
}
