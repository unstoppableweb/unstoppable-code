import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type {
  AgentProviderType,
  ChatModel,
} from '@canopy/desktop-shared/types';
import { isAntigravityConnectionEnabled } from '../antigravity/connection';
import { isCopilotRuntimeAvailable } from '../copilot/runtime-availability';
import { isCursorRuntimeAvailable } from '../cursor/runtime-availability';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import { isOpenCodeRuntimeAvailable } from '../opencode/runtime-availability';

/** A desktop-connected runtime a chat model can need. */
export type ChatModelConnectedRuntime =
  | 'antigravity'
  | 'cursor'
  | 'copilot'
  | 'opencode';

const CONNECTED_RUNTIMES: ReadonlyArray<
  readonly [ChatModelConnectedRuntime, string, () => Promise<boolean>]
> = [
  ['antigravity', 'Antigravity', isAntigravityConnectionEnabled],
  ['cursor', 'Cursor', isCursorRuntimeAvailable],
  ['copilot', 'Copilot', isCopilotRuntimeAvailable],
  ['opencode', 'OpenCode', isOpenCodeRuntimeAvailable],
];

export interface ChatModelConnectionRefusal {
  ok: false;
  reason: 'not-connected';
  runtime: ChatModelConnectedRuntime;
  /** Product name of the runtime, for the caller's own copy. */
  label: string;
}

export type ChatModelAdmissionRefusal =
  | { ok: false; reason: 'model-policy'; message: string }
  | { ok: false; reason: 'gateway'; message: string };

export type ChatModelEligibility =
  | { ok: true }
  | ChatModelConnectionRefusal
  | ChatModelAdmissionRefusal;

/**
 * Whether the desktop runtime a model or its selected harness needs is
 * connected. Reads no account state. Advisory: each provider's own turn gate
 * (for example the Antigravity session's connection check) re-checks before
 * a turn runs, so a connection revoked after this returns is still refused.
 */
export async function checkChatModelConnection(input: {
  providerType?: AgentProviderType;
  executionHarness?: string;
}): Promise<{ ok: true } | ChatModelConnectionRefusal> {
  for (const [runtime, label, isAvailable] of CONNECTED_RUNTIMES) {
    if (
      (input.providerType === runtime || input.executionHarness === runtime) &&
      !(await isAvailable())
    )
      return { ok: false, reason: 'not-connected', runtime, label };
  }
  return { ok: true };
}

/**
 * Whether the organization model policy allows the model and an enforced
 * gateway does not exclude its route, for an owner the caller resolved for
 * its own scope and passes explicitly. An undefined owner is judged against
 * every enforcing organization (the strictest reading); the Portal model
 * change relies on that, as the desktop model-change IPC does, while agent
 * chat creation refuses an unknown owner before calling this. Advisory: the
 * session gate (`getOrCreateSessionImpl`) re-checks policy and the gateway
 * before every turn.
 */
export async function checkChatModelAdmission(input: {
  model: ChatModel;
  /** The model the policy governs; an Agent's runtime model. */
  policyModel?: ChatModel;
  workOwner: WorkOwner | undefined;
}): Promise<{ ok: true } | ChatModelAdmissionRefusal> {
  if (
    await isModelBlockedByStoredPolicy(
      input.policyModel ?? input.model,
      input.workOwner,
    )
  )
    return {
      ok: false,
      reason: 'model-policy',
      message: 'This model is blocked by your organization policy.',
    };
  const gateway = await checkModelGatewayRoute(input.model, input.workOwner);
  if (!gateway.ok)
    return { ok: false, reason: 'gateway', message: gateway.message };
  return { ok: true };
}

/**
 * Connection, then policy and gateway, before a model is stored for a chat.
 * Shared by agent chat creation and the Portal model change so both refuse
 * the same things.
 */
export async function checkChatModelEligibility(input: {
  model: ChatModel;
  policyModel?: ChatModel;
  providerType?: AgentProviderType;
  executionHarness?: string;
  workOwner: WorkOwner | undefined;
}): Promise<ChatModelEligibility> {
  const connection = await checkChatModelConnection(input);
  if (!connection.ok) return connection;
  return checkChatModelAdmission(input);
}
