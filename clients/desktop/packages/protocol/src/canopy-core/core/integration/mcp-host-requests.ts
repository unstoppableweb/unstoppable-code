import { z } from 'zod';

import { CanopyQueryRequestMetadataSchema } from '../../common';
import {
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';

/**
 * Reach-back (CAN-6176): a cloud chat calls an MCP server on its owner's own
 * desktop. The web core holds each proxied request; the owning desktop opens
 * `core.integration.mcpHostRequests` to receive them and answers each with
 * `core.integration.mcpHostRequest.respond`.
 */
export const CORE_INTEGRATION_HOST_GRANT = 'core.integration.host';

/** The proxy's request body limit. */
export const MCP_HOST_REQUEST_MAX_BODY_BYTES = 1024 * 1024;
/** The response body limit. */
export const MCP_HOST_RESPONSE_MAX_BODY_BYTES = 4 * 1024 * 1024;

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
const headerValue = z.string().max(8192);
const base64 = (maxBytes: number): z.ZodString =>
  z
    .string()
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** The MCP request headers the desktop's server sees; nothing else crosses. */
export const MCP_HOST_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;

/** The response headers the proxy passes back to the harness. */
export const MCP_HOST_RESPONSE_HEADERS = [
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
] as const;

const requestHeaders = z.partialRecord(
  z.enum(MCP_HOST_REQUEST_HEADERS),
  headerValue,
);
const responseHeaders = z.partialRecord(
  z.enum(MCP_HOST_RESPONSE_HEADERS),
  headerValue,
);

/** One proxied request for a server this desktop allowed in cloud chats. */
export const McpHostRequestSchema = z.strictObject({
  requestId: id,
  /** The cloud connection the request came through. */
  connectionId: id,
  serverId: id,
  configId: id,
  method: z.enum(['POST', 'GET', 'DELETE']),
  headers: requestHeaders,
  bodyBase64: base64(MCP_HOST_REQUEST_MAX_BODY_BYTES),
  deadlineAt: timestamp,
  /**
   * The cloud chat whose turn made the request, with its title when the
   * proxy received it (one line, at most 120 characters), for the desktop's
   * approval prompt and call log.
   */
  chat: z.strictObject({ id, title: z.string().max(120) }),
});

/** A request the web core took back: never answer it. */
export const McpHostRequestWithdrawalSchema = z.strictObject({
  requestId: id,
  withdrawn: z.literal(true),
  reason: z.enum(['deadline', 'caller_gone', 'redelivery_refused']),
});

/** One `core.integration.mcpHostRequests` item: a request, or its withdrawal. */
export const McpHostRequestsItemSchema = z.union([
  McpHostRequestSchema,
  McpHostRequestWithdrawalSchema,
]);

export type McpHostRequest = z.output<typeof McpHostRequestSchema>;
export type McpHostRequestWithdrawal = z.output<
  typeof McpHostRequestWithdrawalSchema
>;
export type McpHostRequestsItem = z.output<typeof McpHostRequestsItemSchema>;

export function isMcpHostRequestWithdrawal(
  item: McpHostRequestsItem,
): item is McpHostRequestWithdrawal {
  return 'withdrawn' in item;
}

export const McpHostRequestsParamsSchema = z.strictObject({
  /** The stream doesn't resume; a new subscriber gets every pending request. */
  cursor: z.null().optional(),
  /**
   * This desktop reports its servers' serving state with
   * `core.integration.mcpHostStatus.report` (CAN-6659), so a server it hasn't
   * reported ready over this connection isn't offered to cloud chats.
   * Without it, its servers are offered while the stream is open.
   */
  servingReports: z.literal(true).optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const McpHostRequestsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: z.null(),
});

export const CORE_INTEGRATION_MCP_HOST_REQUEST_CODES = [
  'core.integration.mcpHostRequestNotFound',
  'core.integration.mcpHostConnectionNotOwned',
] as const;

export const McpHostRequestErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(CORE_INTEGRATION_MCP_HOST_REQUEST_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const McpHostRequestsEndSchema = CanopyStreamEndSchema.extend({
  error: McpHostRequestErrorSchema.nullable(),
});

export const McpHostRequestRespondParamsSchema = z.strictObject({
  requestId: id,
  /** A final status: an informational one can't answer a request. */
  status: z.number().int().min(200).max(599),
  headers: responseHeaders,
  bodyBase64: base64(MCP_HOST_RESPONSE_MAX_BODY_BYTES),
});

export const McpHostRequestRespondResultSchema = z.strictObject({
  requestId: id,
  /** `already_settled`: answered, withdrawn or past its deadline first. */
  outcome: z.enum(['applied', 'already_settled']),
  settledAt: timestamp,
});

export type McpHostRequestRespondParams = z.output<
  typeof McpHostRequestRespondParamsSchema
>;
export type McpHostRequestRespondResult = z.output<
  typeof McpHostRequestRespondResultSchema
>;

/**
 * Why a desktop can't serve one of its servers now (CAN-6659). The desktop
 * sends one of these and, at most, a short message it redacted: never a URL,
 * a header or an environment value.
 */
export const MCP_HOST_SERVING_CAUSES = [
  'start_failed',
  'proxy_unavailable',
  'upstream_unreachable',
  'timed_out',
  'refused',
  'unknown',
] as const;

export const McpHostServingCauseSchema = z.enum(MCP_HOST_SERVING_CAUSES);

/**
 * One server's serving state, as its desktop reports it, by the desktop's
 * own server and config ids: the ones its requests carry.
 */
export const McpHostServingServerSchema = z.strictObject({
  serverId: id,
  configId: id,
  /** `ready`: the desktop can serve it now; `unreachable`: it can't. */
  state: z.enum(['ready', 'unreachable']),
  cause: McpHostServingCauseSchema.optional(),
  message: z.string().max(300).optional(),
});

/**
 * Whether each server this desktop allowed in cloud chats can be served now.
 * A server not in the report keeps its last state from this connection; a
 * report from an earlier connection counts for nothing.
 */
export const McpHostStatusReportParamsSchema = z.strictObject({
  servers: z.array(McpHostServingServerSchema).max(256),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const McpHostStatusReportResultSchema = z.strictObject({
  reportedAt: timestamp,
  servers: z.number().int().min(0),
});

export type McpHostServingCause = z.output<typeof McpHostServingCauseSchema>;
export type McpHostServingServer = z.output<typeof McpHostServingServerSchema>;
export type McpHostStatusReportParams = z.output<
  typeof McpHostStatusReportParamsSchema
>;
export type McpHostStatusReportResult = z.output<
  typeof McpHostStatusReportResultSchema
>;

/**
 * Served by the web core to desktop-key connections only, which alone hold
 * `core.integration.host`; never relayed from a renderer.
 */
export const CORE_INTEGRATION_MCP_HOST_STREAM_DEFINITIONS =
  defineCanopyStreamRegistry('core', {
    'core.integration.mcpHostRequests': defineCanopyStream({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_INTEGRATION_HOST_GRANT],
      params: McpHostRequestsParamsSchema,
      openResult: McpHostRequestsOpenResultSchema,
      item: McpHostRequestsItemSchema,
      end: McpHostRequestsEndSchema,
      error: McpHostRequestErrorSchema,
    }),
  });

export const CORE_INTEGRATION_MCP_HOST_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.integration.mcpHostRequest.respond': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_INTEGRATION_HOST_GRANT],
      params: McpHostRequestRespondParamsSchema,
      result: McpHostRequestRespondResultSchema,
      error: McpHostRequestErrorSchema,
    }),
    'core.integration.mcpHostStatus.report': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_INTEGRATION_HOST_GRANT],
      params: McpHostStatusReportParamsSchema,
      result: McpHostStatusReportResultSchema,
      error: McpHostRequestErrorSchema,
    }),
  });
