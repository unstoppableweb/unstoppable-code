import type { ChatSendAutomationDispatch } from '@canopy/desktop-shared/types';
import type { AgentSessionOptions } from './types';

/** The facts that mark a turn as an automation's own send. */
export interface AutomationTurnFacts {
  /** Main-only; set by an automation's send and a step of a run it started. */
  readonly automationDispatch?: ChatSendAutomationDispatch;
  /** The automation's name, which only an automation's send carries. */
  readonly automationName?: string;
}

/**
 * How a chat turn resolves a connector the person holds several accounts of
 * (CAN-6232). A turn an automation sent runs with no one to choose, so it
 * loads only the exact or the only account, never the default a person's
 * chat would reach. Every other turn keeps the attended rule, including a
 * retry, a resume or a delegate's delivery into a person's chat, which share
 * the `automation` initiation source but carry neither fact.
 */
export function turnAccountResolution(
  turn: AutomationTurnFacts,
): Pick<AgentSessionOptions, 'accountResolution' | 'sharedConnectionWrites'> {
  if (
    turn.automationDispatch === undefined &&
    turn.automationName === undefined
  )
    return {};
  // Its project's shared connections answer it with a scheduled claim
  // (CAN-6252), limited to the writes its automation allowed.
  const writes = turn.automationDispatch?.sharedConnectionWrites;
  return {
    accountResolution: 'unattended',
    ...(writes === undefined ? {} : { sharedConnectionWrites: writes }),
  };
}

/** A session's unattended facts for plugin resolution, when it has them. */
export function unattendedPluginOptions(
  opts: Pick<
    AgentSessionOptions,
    'accountResolution' | 'sharedConnectionWrites'
  >,
): {
  accountResolution?: 'unattended';
  sharedConnectionWrites?: Readonly<Record<string, readonly string[]>>;
} {
  if (opts.accountResolution !== 'unattended') return {};
  return {
    accountResolution: 'unattended',
    ...(opts.sharedConnectionWrites === undefined
      ? {}
      : { sharedConnectionWrites: opts.sharedConnectionWrites }),
  };
}

/**
 * The part of a session's capability signature that keeps an automation's
 * unattended session and a person's attended one apart, so neither reuses
 * the other's resolved connectors.
 */
export function accountResolutionSignature(
  opts: Pick<
    AgentSessionOptions,
    'accountResolution' | 'sharedConnectionWrites'
  >,
): string {
  if (opts.accountResolution !== 'unattended') return '';
  // Two automations with different allowed writes never share a session.
  const writes = opts.sharedConnectionWrites;
  if (writes === undefined) return '@unattended';
  const canonical = Object.keys(writes)
    .sort()
    .map((id) => [id, [...(writes[id] ?? [])].sort()]);
  return `@unattended:${JSON.stringify(canonical)}`;
}
