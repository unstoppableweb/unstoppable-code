import {
  chatInputDeliveryFailure,
  chatInputRefusal,
  type ChatInputDeliveryFailure,
  type ChatInputRefusal,
  type ChatInputRefusalCode,
} from '@canopy/protocol/portal/input-delivery';
import { isCodexRecoverableProcessExitError } from './connection';

/** How a failed `turn/steer` request ended. */
export type CodexSteerErrorClassification =
  | { kind: 'refusal'; refusal: ChatInputRefusal }
  | { kind: 'failure'; failure: ChatInputDeliveryFailure };

// Every `turn/steer` error Codex returns before it accepts any input, so the
// ordinary send queue can deliver the message later without a duplicate.
// Provenance: openai/codex tag rust-v0.159.0 (commit 687a119f), codex-rs/:
// - app-server/src/request_processors/turn_processor.rs `turn_steer_inner`
//   (lines 1024-1160): the `NotSubmittedReason` texts, the empty
//   expectedTurnId check (1043), and the pre-submission checks it calls:
//   `validate_user_input_image_urls` (34), `load_thread` (380, 386),
//   `ensure_direct_input_allowed` (thread_input.rs 8), `config_load_error`
//   (config_errors.rs 32) and `input_too_large_error` (503).
// - app-server/src/message_processor.rs: deserialization (113),
//   "Not initialized" (972), the experimental-API gate (978) and turn
//   admission (`server_draining_error`, error_code.rs 11).
// - app-server-transport/src/transport/mod.rs 249: the overload reply.
// "failed to steer turn: ..." is deliberately absent: Codex can raise it after
// it accepted the input (`apply_steered`), so it proves nothing.
// Re-check this table against the app-server source on every Codex bump.
const EXACT_REFUSALS: ReadonlyMap<string, ChatInputRefusalCode> = new Map([
  ['no active turn to steer', 'no-active-turn'],
  ['cannot steer a compact turn', 'compact-turn'],
  ['cannot steer a review turn', 'review-turn'],
  ['active turn uses a different output schema', 'output-schema-mismatch'],
  ['expectedTurnId must not be empty', 'empty-expected-turn-id'],
  ['input must not be empty', 'empty-input'],
  ['Server is draining; retry after reconnecting', 'not-steerable'],
  ['Server overloaded; retry later.', 'not-steerable'],
  ['Not initialized', 'not-steerable'],
  [
    'remote image URLs are not supported; use an inline data URL instead',
    'not-steerable',
  ],
  [
    'direct app-server input is not allowed for multi-agent v2 sub-agents',
    'not-steerable',
  ],
]);

const PATTERN_REFUSALS: ReadonlyArray<readonly [RegExp, ChatInputRefusalCode]> =
  [
    [
      /^expected active turn id `[\s\S]*` but found `[\s\S]*`$/,
      'turn-id-mismatch',
    ],
    [/^Invalid request: /, 'not-steerable'],
    [/^.+ requires experimentalApi capability$/, 'not-steerable'],
    [/^invalid thread id: /, 'not-steerable'],
    [/^thread not found: /, 'not-steerable'],
    [/^failed to load configuration: /, 'not-steerable'],
    [/^Input exceeds the maximum length of \d+ characters\.$/, 'not-steerable'],
  ];

function refusalCode(message: string): ChatInputRefusalCode | undefined {
  const exact = EXACT_REFUSALS.get(message);
  if (exact) return exact;
  for (const [pattern, code] of PATTERN_REFUSALS)
    if (pattern.test(message)) return code;
  return undefined;
}

// The connection's request deadline error class is module-private.
function isRequestTimeout(error: Error): boolean {
  return error.name === 'CodexAppServerRequestTimeoutError';
}

/**
 * Classifies a failed `turn/steer` request. The result is built from a code
 * alone and never carries error or payload text.
 */
export function classifyCodexSteerError(
  error: unknown,
): CodexSteerErrorClassification {
  if (isCodexRecoverableProcessExitError(error))
    return {
      kind: 'failure',
      failure: chatInputDeliveryFailure('process-exit'),
    };
  if (!(error instanceof Error))
    return {
      kind: 'failure',
      failure: chatInputDeliveryFailure('transport-error'),
    };
  if (isRequestTimeout(error))
    return {
      kind: 'failure',
      failure: chatInputDeliveryFailure('steer-timeout'),
    };
  const code = refusalCode(error.message);
  return code
    ? { kind: 'refusal', refusal: chatInputRefusal(code) }
    : {
        kind: 'failure',
        failure: chatInputDeliveryFailure('transport-error'),
      };
}
