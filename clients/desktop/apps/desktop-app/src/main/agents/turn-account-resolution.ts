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
): Pick<AgentSessionOptions, 'accountResolution'> {
  return turn.automationDispatch !== undefined ||
    turn.automationName !== undefined
    ? { accountResolution: 'unattended' }
    : {};
}

/**
 * The part of a session's capability signature that keeps an automation's
 * unattended session and a person's attended one apart, so neither reuses
 * the other's resolved connectors.
 */
export function accountResolutionSignature(
  opts: Pick<AgentSessionOptions, 'accountResolution'>,
): string {
  return opts.accountResolution === 'unattended' ? '@unattended' : '';
}
