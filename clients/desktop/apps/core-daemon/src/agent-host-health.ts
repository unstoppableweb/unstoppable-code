import type { RuntimeService } from '@canopy/core-runtime';
import { isAgentDaemonHostingRequired } from '@canopy/core-runtime/node/agent/hosting';
import type { StorageOwnershipRow } from '@canopy/core-runtime/storage';

/** The agent host's service, and its health check's name either way. */
export const DAEMON_AGENT_HOST_SERVICE = 'core.daemon.agent-host';

/**
 * How this build's daemon agent host composes chat search (CAN-7728): not at
 * all, as a typed refusing stub, or for real over the chat search index.
 */
export type DaemonChatSearchComposition =
  | 'not_composed'
  | 'refusing_stub'
  | 'composed';

/** This build's composition. The slice that composes the real host sets it. */
export const DAEMON_CHAT_SEARCH_COMPOSITION: DaemonChatSearchComposition =
  'not_composed';

/**
 * Whether ownership rows may hand chats to a daemon whose chat search has
 * this composition. Once the rows say daemon, the index belongs to it and
 * Electron main stops serving search, so anything short of `composed` would
 * leave chat search unavailable (a CAN-7085 prerequisite).
 */
export function isAgentHostChatSearchReady(
  rows: readonly StorageOwnershipRow[],
  composition: DaemonChatSearchComposition = DAEMON_CHAT_SEARCH_COMPOSITION,
): boolean {
  return !isAgentDaemonHostingRequired(rows) || composition === 'composed';
}

/**
 * Why a daemon whose ownership rows hand it the agent host serves without
 * one (CAN-6995). Additive: the composing slices add their own reasons.
 */
export const DAEMON_AGENT_HOST_UNAVAILABLE_REASONS = [
  /** This build composes no agent host yet. */
  'not_composed',
] as const;

export type DaemonAgentHostUnavailableReason =
  (typeof DAEMON_AGENT_HOST_UNAVAILABLE_REASONS)[number];

const MESSAGES: Record<DaemonAgentHostUnavailableReason, string> = {
  not_composed:
    'The ownership rows hand chats to this daemon, but this build composes no agent host, so it serves none.',
};

/**
 * The stand-in for the agent host when it is selected but unavailable:
 * optional, so the runtime reports `degraded` with the typed reason instead
 * of refusing startup, and no chat operation is registered.
 */
export function unavailableDaemonAgentHostService(
  reason: DaemonAgentHostUnavailableReason,
): RuntimeService {
  return {
    name: DAEMON_AGENT_HOST_SERVICE,
    plane: 'core',
    required: false,
    health: () => ({
      name: DAEMON_AGENT_HOST_SERVICE,
      status: 'warn',
      message: MESSAGES[reason],
      reason,
    }),
  };
}
