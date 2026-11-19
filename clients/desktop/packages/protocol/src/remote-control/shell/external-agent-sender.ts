import { z } from 'zod';
import {
  parseChatAgentSentInfo,
  type ChatAgentSentInfo,
} from './input-delivery';

/**
 * Trusted sender of an operation an external MCP agent submitted on a
 * person's behalf (docs/planning/2026-10-12-web-mcp-server/contracts/provenance.md).
 * The hosted server derives every field from the authenticated connection and
 * user; no client may supply or clear it.
 */
export const externalAgentSenderSchema = z.strictObject({
  kind: z.literal('external_agent'),
  /** Canonical lowercase external UUID of the authenticated connection. */
  connectionId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  /** Sanitized display name from trusted connection metadata. */
  clientName: z.string().min(1).max(120),
  /** Per-authorization redirect trust; loopback and CIMD-only flows are false. */
  verified: z.boolean(),
  /** Canonical lowercase external UUID of the authenticated user. */
  userId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
});
export type ExternalAgentSender = z.infer<typeof externalAgentSenderSchema>;

/**
 * Trusted sender of a managed delegate's message to its root chat, such as a
 * RequestSteering request. The desktop host derives every field from its own
 * delegation record when it creates the internal chat request; no renderer,
 * Portal payload or MCP client may supply it.
 */
export const managedDelegateSenderSchema = z.strictObject({
  kind: z.literal('managed_delegate'),
  /** Opaque host-issued delegation ID. */
  delegationId: z.string().min(1).max(256),
  /** The delegation's task description, as one plain line. */
  title: z.string().min(1).max(200),
});
export type ManagedDelegateSender = z.infer<typeof managedDelegateSenderSchema>;

/**
 * Who submitted a tool-originated message: an external MCP agent, or a
 * managed delegate writing to its root chat. This is the one declaration of
 * the union (provenance.md: "whoever lands the shared union first owns its
 * exact declaration"); later sender kinds extend it here.
 */
export type ToolMessageSender = ExternalAgentSender | ManagedDelegateSender;

/**
 * Trusted attribution recorded on the message an agent submitted: another
 * Canopy chat (`ChatAgentSentInfo`, set by the desktop's agent send paths) or
 * an external MCP agent. Both keep their own declarations; one `agentSent`
 * field carries either, and one title row renders it.
 */
export type AgentSentInfo = ChatAgentSentInfo | ToolMessageSender;

/** Whether the attribution names an external MCP agent, not a Canopy chat. */
export function isExternalAgentSent(
  info: AgentSentInfo,
): info is ExternalAgentSender {
  return 'kind' in info && info.kind === 'external_agent';
}

/** The Canopy chat sender, or undefined for a tool sender or none. */
export function chatAgentSent(
  info: AgentSentInfo | undefined,
): ChatAgentSentInfo | undefined {
  // Only tool senders carry a top-level `kind`.
  return info && !('kind' in info) ? info : undefined;
}

const toolMessageSenderSchema = z.discriminatedUnion('kind', [
  externalAgentSenderSchema,
  managedDelegateSenderSchema,
]);

/** Parses a tool sender (external agent or managed delegate), or null. */
export function parseToolMessageSender(
  value: unknown,
): ToolMessageSender | null {
  const parsed = toolMessageSenderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Parses a stored or projected message's sender, either attribution, returning
 * null when it is malformed. Use {@link parseExternalAgentSender} for a
 * command origin, which is only ever an external agent.
 */
export function parseAgentSentInfo(value: unknown): AgentSentInfo | null {
  return parseToolMessageSender(value) ?? parseChatAgentSentInfo(value) ?? null;
}

/** Parses a value as a trusted sender, returning null when it is malformed. */
export function parseExternalAgentSender(
  value: unknown,
): ExternalAgentSender | null {
  const parsed = externalAgentSenderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether a browser-submitted Portal command sets the server-only envelope
 * `origin`, including `origin: null` (provenance.md "Trust boundary and Portal
 * envelope"). Only the envelope carries sender data; keys inside the payload
 * are user data, such as pipeline input names, and are not inspected.
 */
export function hasOriginKey(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'origin')
  );
}
