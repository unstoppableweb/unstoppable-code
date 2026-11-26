import { z } from 'zod';
import type { HostedFirstPartyClient } from '../remote-control/security';

/**
 * Wire shapes for the External agents pages: the agents a person
 * connected to the hosted MCP servers through OAuth, and what each may do.
 * Normative sources: docs/planning/2026-10-12-web-mcp-server/
 * 04-oauth-and-access-control.md ("External agents dashboard") and
 * contracts/connections-and-tokens.md.
 */

export const EXTERNAL_AGENT_SERVERS = ['account', 'tasks'] as const;
export type ExternalAgentServer = (typeof EXTERNAL_AGENT_SERVERS)[number];

export const EXTERNAL_AGENT_TOOL_GROUPS = [
  'account',
  'digests',
  'usage',
  'billing',
  'org',
  'library',
  'work',
  'memory',
  'tasks',
] as const;
export type ExternalAgentToolGroup =
  (typeof EXTERNAL_AGENT_TOOL_GROUPS)[number];

export const EXTERNAL_AGENT_ACCESS_LEVELS = [
  'read',
  'write',
  'destructive',
] as const;
export type ExternalAgentAccessLevel =
  (typeof EXTERNAL_AGENT_ACCESS_LEVELS)[number];

/** Groups whose server catalog has a destructive (removal) tool. */
export const EXTERNAL_AGENT_DESTRUCTIVE_GROUPS = [
  'org',
  'library',
] as const satisfies readonly ExternalAgentToolGroup[];
export type ExternalAgentDestructiveGroup =
  (typeof EXTERNAL_AGENT_DESTRUCTIVE_GROUPS)[number];

export function isExternalAgentDestructiveGroup(
  group: string,
): group is ExternalAgentDestructiveGroup {
  return EXTERNAL_AGENT_DESTRUCTIVE_GROUPS.some(
    (candidate) => candidate === group,
  );
}

const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const ACCESS = z.enum(EXTERNAL_AGENT_ACCESS_LEVELS);

const accessGroupsSchema = z
  .partialRecord(z.enum(EXTERNAL_AGENT_TOOL_GROUPS), ACCESS)
  .superRefine((groups, context) => {
    for (const group of EXTERNAL_AGENT_TOOL_GROUPS) {
      if (
        groups[group] === 'destructive' &&
        !isExternalAgentDestructiveGroup(group)
      ) {
        context.addIssue({
          code: 'custom',
          path: [group],
          message: 'Destructive access is not available for this group.',
        });
      }
    }
  });

/**
 * What the person chose for one connection: on the consent page, and again
 * when they edit an agent's access. The server turns it into a connection
 * policy and validates it against the full catalog (including the 80-tool
 * ceiling) before anything is stored.
 */
export const externalAgentAccessDecisionSchema = z.strictObject({
  groups: accessGroupsSchema,
  disabledTools: z.array(z.string().max(46)).max(128),
  enabledDefaultOff: z.array(z.string().max(46)).max(16),
  organizations: z.strictObject({
    mode: z.enum(['all', 'selected']),
    organizationIds: z.array(UUID).max(500),
  }),
  /** Which hosts a Tasks connection may use; Account connections send the default. */
  hosts: z.strictObject({
    /** The Cloud agents switch. */
    managed: z.boolean(),
    /** The device choice, by `remoteId`. */
    connected: z.strictObject({
      mode: z.enum(['all', 'selected']),
      remoteIds: z.array(UUID).max(500),
    }),
    /** Show device names to the agent. */
    exposeNames: z.boolean(),
  }),
  /** Whole days until the connection ends, or null for until removed. */
  durationDays: z.number().int().min(1).max(365).nullable(),
  /**
   * Repeat each tool result's structured content as JSON in its text, for
   * agents that read only the text. Omitted means the client's default.
   */
  textContentCompatibility: z.boolean().optional(),
});
export type ExternalAgentAccessDecision = z.infer<
  typeof externalAgentAccessDecisionSchema
>;

/** An existing connection's access, as an edit starts from and sends it. */
export const externalAgentAccessSchema = externalAgentAccessDecisionSchema.omit(
  { durationDays: true, textContentCompatibility: true },
);
export type ExternalAgentAccess = z.infer<typeof externalAgentAccessSchema>;

/**
 * One paired desktop a connection can be given access to. `remoteId` is the
 * desktop's stable external identity, the value stored in
 * `hosts.connected.remoteIds`; `hostCode` is the host ID agents see for it.
 */
export const externalAgentDesktopSchema = z.strictObject({
  remoteId: UUID,
  hostCode: z.string().regex(/^[0-9abcdefghjkmnpqrstvwxyz]{10}$/),
  name: z.string().min(1).max(120),
  hostname: z.string().max(255).nullable(),
  connection: z.enum(['active', 'reconnecting', 'inactive']),
  lastSeenAt: z.iso.datetime().nullable(),
});
export type ExternalAgentDesktop = z.infer<typeof externalAgentDesktopSchema>;

/** Every desktop the person has paired, newest first, for the desktop selector. */
export const externalAgentDesktopListSchema = z.strictObject({
  desktops: z.array(externalAgentDesktopSchema).max(100),
});
export type ExternalAgentDesktopList = z.infer<
  typeof externalAgentDesktopListSchema
>;

/** The cap on each list the computers section receives. */
export const EXTERNAL_AGENT_COMPUTERS_MAX = 100;

/**
 * One of the person's computers as hosted agents see it (CAN-5985).
 * `agents` is `connected` once the computer approved the hosted agents root,
 * and `removal_pending` until it confirms forgetting it. `online` comes from
 * fresh relay presence, never from a stored record.
 */
export const externalAgentComputerSchema = z.strictObject({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  /** Stable remote ID, once the computer is connected for agents. */
  remoteId: z.uuid().nullable(),
  name: z.string().max(120),
  online: z.boolean(),
  agents: z.enum(['connected', 'not_connected', 'removal_pending']),
  /**
   * Retired with Portal (CAN-5986): always `false`. Optional on the wire so a
   * server may stop sending it; the web still sends it because older desktops
   * parse a strict schema that requires it. A follow-up stops sending it and
   * drops the field once those desktops age out (CAN-7216).
   */
  viaPortal: z.boolean().default(false),
});
export type ExternalAgentComputer = z.infer<typeof externalAgentComputerSchema>;

export const externalAgentComputerListSchema = z.strictObject({
  computers: z
    .array(externalAgentComputerSchema)
    .max(EXTERNAL_AGENT_COMPUTERS_MAX),
  /**
   * Retired with Portal (CAN-5986): always empty. Optional on the wire for the
   * same reason as `viaPortal`, with the same follow-up (CAN-7216).
   */
  portalOnly: z
    .array(z.strictObject({ remoteId: z.uuid(), name: z.string().max(120) }))
    .max(EXTERNAL_AGENT_COMPUTERS_MAX)
    .default([]),
});
export type ExternalAgentComputerList = z.infer<
  typeof externalAgentComputerListSchema
>;

/** How a Connect ended. Only `paired` changed anything. */
export const externalAgentComputerConnectOutcomeSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({ status: z.literal('paired'), remoteId: z.uuid() }),
    z.strictObject({
      status: z.enum([
        'denied',
        'offline',
        'host_unsupported',
        'timeout',
        'cancelled',
        'busy',
        'capacity',
        'plan_required',
        'failed',
      ]),
    }),
  ],
);
export type ExternalAgentComputerConnectOutcome = z.infer<
  typeof externalAgentComputerConnectOutcomeSchema
>;

/** `pending` until the computer confirms; it never claims removal early. */
export const externalAgentComputerRemovalSchema = z.strictObject({
  status: z.enum(['removed', 'pending']),
});
export type ExternalAgentComputerRemoval = z.infer<
  typeof externalAgentComputerRemovalSchema
>;

/** How an edit changes when the connection ends. */
export const externalAgentExpiryChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('keep') }),
  z.strictObject({ kind: z.literal('never') }),
  z.strictObject({
    kind: z.literal('days'),
    days: z.number().int().min(1).max(365),
  }),
]);
export type ExternalAgentExpiryChange = z.infer<
  typeof externalAgentExpiryChangeSchema
>;

/**
 * Write classes a person can set to ask first. Destructive actions always ask
 * and are not configurable here.
 */
export const EXTERNAL_AGENT_CONFIRMATION_CLASSES = [
  'profile',
  'settings',
  'membership',
  'sharing',
  'content',
  'task',
  'pipeline',
] as const;
export type ExternalAgentConfirmationClass =
  (typeof EXTERNAL_AGENT_CONFIRMATION_CLASSES)[number];

export const EXTERNAL_AGENT_CONFIRMATION_MODES = ['act', 'ask_first'] as const;
export type ExternalAgentConfirmationMode =
  (typeof EXTERNAL_AGENT_CONFIRMATION_MODES)[number];

/** A change to some classes; classes left out keep their current mode. */
export const externalAgentConfirmationChangeSchema = z.partialRecord(
  z.enum(EXTERNAL_AGENT_CONFIRMATION_CLASSES),
  z.enum(EXTERNAL_AGENT_CONFIRMATION_MODES),
);
export type ExternalAgentConfirmationChange = z.infer<
  typeof externalAgentConfirmationChangeSchema
>;

/** The most characters a person's own name for a connection may have. */
export const EXTERNAL_AGENT_LABEL_MAX_LENGTH = 60;

/** A person's own name for a connection; null removes it. */
export const externalAgentLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(EXTERNAL_AGENT_LABEL_MAX_LENGTH)
  .refine((label) => !/\p{Cc}/u.test(label), {
    message: 'A label cannot contain control characters.',
  })
  .nullable();

/**
 * How every surface names a connection: "My agent (ChatGPT)" with a label,
 * else the client's own name.
 */
export function externalAgentDisplayName(connection: {
  readonly clientName: string;
  readonly label: string | null;
}): string {
  return connection.label === null
    ? connection.clientName
    : `${connection.label} (${connection.clientName})`;
}

/** Body of `PUT /api/v1/external-agents/connections/[connectionId]/access`. */
export const externalAgentAccessUpdateSchema = z.strictObject({
  /** The revision the page loaded; a newer one is refused as a conflict. */
  revision: z.number().int().min(1),
  access: externalAgentAccessSchema,
  expiry: externalAgentExpiryChangeSchema,
  confirmation: externalAgentConfirmationChangeSchema.optional(),
  /** Omitted keeps the current setting. */
  textContentCompatibility: z.boolean().optional(),
  /** Omitted keeps the current label; null removes it. */
  label: externalAgentLabelSchema.optional(),
});
export type ExternalAgentAccessUpdate = z.infer<
  typeof externalAgentAccessUpdateSchema
>;

/** Body of the pause and resume routes. */
export const externalAgentRevisionSchema = z.strictObject({
  revision: z.number().int().min(1),
});
export type ExternalAgentRevision = z.infer<typeof externalAgentRevisionSchema>;

/** A disclosure shown beside a tool. */
export type ExternalAgentToolMarkers = {
  spendsCredits: boolean;
  sendsEmail: boolean;
  publicEffect: boolean;
  actsOnRemote: boolean;
};

/** One catalog tool of a server, as the access editor lists it. */
export type ExternalAgentAccessTool = {
  name: string;
  title: string;
  /** The group level the tool needs. Destructive tools are not listed here. */
  access: 'read' | 'write';
  defaultOff: boolean;
  markers: ExternalAgentToolMarkers;
  /** The host kinds a Tasks tool runs on; null for tools that take no host. */
  hosts: { managed: boolean; connected: boolean } | null;
};

/** One tool group of a server, as the access editor offers it. */
export type ExternalAgentAccessGroup = {
  id: ExternalAgentToolGroup;
  label: string;
  description: string;
  /** The server has at least one write tool in this group. */
  writable: boolean;
  /** The server has at least one destructive tool in this group. */
  destructive: boolean;
  /** This group's destructive tools on this server; the switch governs them. */
  destructiveTools: string[];
  /** Write is shown but unavailable with this reason (Billing). */
  writeUnavailableReason: string | null;
  /** The lowest level allowed: `read` for `account`, else `off`. */
  minimum: 'off' | 'read';
  /** Set when the group cannot be granted at all (Remote Control while off). */
  unavailableReason: string | null;
  tools: ExternalAgentAccessTool[];
};

/** An organization the person can let a connection reach. */
export type ExternalAgentOrganization = {
  id: string;
  name: string;
  /** The person's role there, as a sentence ("You are an admin."). */
  roleLine: string;
  /** The person's own Personal organization (an account fact). */
  personal: boolean;
  /**
   * Why the organization can't be newly chosen for a connection (its owner
   * doesn't allow outside agents); null when it can. Never set for Personal.
   */
  unavailableReason: string | null;
};

/** The `unavailableReason` of an organization whose owner set Not allowed. */
export const EXTERNAL_AGENT_ORGANIZATION_NOT_ALLOWED_REASON =
  "This organization's owner doesn't allow outside agents.";

/** Revoked connections are never listed. */
export type ExternalAgentConnectionStatus = 'active' | 'paused' | 'expired';

/** The short access summary a list row shows. */
export type ExternalAgentAccessSummary = {
  /** Groups at Read (not Write), in catalog order. */
  read: ExternalAgentToolGroup[];
  /** Groups at Write or Destructive, in catalog order. */
  write: ExternalAgentToolGroup[];
  /** Groups at Destructive, in catalog order. */
  destructive: ExternalAgentToolGroup[];
  /** Organizations it may reach; null on the Tasks server. */
  organizations: 'all' | number | null;
  /** Desktops it may use; null on the Account and organizations server. */
  desktops: 'all' | number | null;
  /** Cloud agents (the managed host) are on; null on the Account server. */
  managed: boolean | null;
};

export type ExternalAgentConnectionSummary = {
  /** The connection's external id. */
  id: string;
  server: ExternalAgentServer;
  clientName: string;
  /** The person's own name for it; null when they haven't set one. */
  label: string | null;
  verified: boolean;
  status: ExternalAgentConnectionStatus;
  /** ISO 8601 timestamps. */
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  access: ExternalAgentAccessSummary;
  /**
   * Set only for a connection the product itself owns (CAN-7606: `slack`,
   * the token-less connection behind Connect Slack). Its access can't be
   * edited here; Pause and Remove still work, and Remove also disconnects
   * Slack. Absent on every OAuth-authorized agent.
   */
  firstPartyClient?: HostedFirstPartyClient;
};

/** The canonical address an agent adds for one server. */
export type ExternalAgentServerAddress = {
  server: ExternalAgentServer;
  url: string;
};

/**
 * A recent change the person should know about: an agent connected, or an
 * agent's access widened. Derived from the audit trail of the last 24 hours;
 * a dismissal is remembered only on the device where it was made.
 */
export type ExternalAgentNotice = {
  kind: 'connected' | 'widened';
  connectionId: string;
  clientName: string;
  label: string | null;
  server: ExternalAgentServer;
  at: string;
};

/** A request waiting for the person's decision, as a list row shows it. */
export type ExternalAgentWaitingAction = {
  pendingActionId: string;
  connectionId: string;
  clientName: string;
  label: string | null;
  server: ExternalAgentServer;
  /** The registry's plain-language action with server-resolved names. */
  action: string;
  requestedAt: string;
  decisionExpiresAt: string;
};

/** `GET /api/v1/external-agents`. */
export type ExternalAgentsOverview = {
  /** Newest first. */
  notices: ExternalAgentNotice[];
  /** Every connection's waiting requests, oldest first. */
  waiting: ExternalAgentWaitingAction[];
  /** Account and organizations first, then Tasks. */
  servers: ExternalAgentServerAddress[];
  /** The pre-registered client id Cursor's `mcp.json` entry uses. */
  cursorClientId: string;
  /** Newest first. */
  connections: ExternalAgentConnectionSummary[];
};

export type ExternalAgentActivityTarget = {
  kind: 'organization' | 'project' | 'remote' | 'task';
  id: string;
  /** A display name when the server could resolve one the person can see. */
  label: string | null;
};

/** One tool call, without argument values or content. */
export type ExternalAgentActivityItem = {
  at: string;
  tool: string;
  toolTitle: string | null;
  targets: ExternalAgentActivityTarget[];
  outcome: 'success' | 'error';
  /** The tool error code when the call failed. */
  outcomeCode: string | null;
};

/** `GET /api/v1/external-agents/connections/[connectionId]`. */
export type ExternalAgentConnectionDetail = ExternalAgentConnectionSummary & {
  /** Sent back with every change; a newer revision is a conflict. */
  revision: number;
  /** The metadata document host, or the curated domain; null when neither. */
  from: string | null;
  /** The callback's host (and port when present). */
  returnsTo: string;
  /** The callback is `127.0.0.1` or `localhost`. */
  loopback: boolean;
  /** What this server offers, in catalog order. */
  groups: ExternalAgentAccessGroup[];
  /** The connection's current access. */
  current: ExternalAgentAccess;
  /** The person's memberships (Account and organizations only; else empty). */
  organizations: ExternalAgentOrganization[];
  remoteControlEnabled: boolean;
  /** The most tools one connection may expose. */
  maxTools: number;
  /** Newest first; at most 50. */
  activity: ExternalAgentActivityItem[];
  /** The write classes this server's tools use, in display order. */
  confirmationClasses: ExternalAgentConfirmationClass[];
  /** Act or ask first for every class. */
  confirmation: Record<
    ExternalAgentConfirmationClass,
    ExternalAgentConfirmationMode
  >;
  /** This connection's waiting requests, oldest first. */
  waiting: ExternalAgentWaitingAction[];
  /** Tool results repeat their structured content as JSON in their text. */
  textContentCompatibility: boolean;
};

export const EXTERNAL_AGENT_PENDING_ACTION_STATUSES = [
  'pending',
  'confirmed',
  'executed',
  'failed',
  'declined',
  'expired',
] as const;
export type ExternalAgentPendingActionStatus =
  (typeof EXTERNAL_AGENT_PENDING_ACTION_STATUSES)[number];

/** A complete MCP tool result, success or error, as the agent receives it. */
export type ExternalAgentToolResult = {
  resultType: 'complete';
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
};

/**
 * `GET /api/v1/external-agents/pending-actions/[pendingActionId]`: one action
 * an agent asked for. Normative source: contracts/pending-actions.md
 * (`PendingActionDto`).
 */
export type ExternalAgentPendingAction = {
  pendingActionId: string;
  connectionId: string;
  server: ExternalAgentServer;
  clientName: string;
  label: string | null;
  clientVerified: boolean;
  toolName: string;
  confirmation: {
    class: ExternalAgentConfirmationClass | 'destructive';
    action: string;
    effects: string[];
    resolvedTargets: { resourceKind: string; displayName: string }[];
  };
  status: ExternalAgentPendingActionStatus;
  /** The exact arguments to run; null once retention removes them. */
  arguments: Record<string, unknown> | null;
  requestedAt: string;
  decisionExpiresAt: string;
  confirmedAt: string | null;
  terminalAt: string | null;
  outcomeExpiresAt: string | null;
  /** The one recorded result; null while open or after retention. */
  outcome: ExternalAgentToolResult | null;
};

/** Body of `POST .../pending-actions/[pendingActionId]/decision`. */
export const externalAgentPendingActionDecisionSchema = z.strictObject({
  /** Must equal the id in the path. */
  pendingActionId: UUID,
  decision: z.enum(['confirm', 'decline']),
});
export type ExternalAgentPendingActionDecision = z.infer<
  typeof externalAgentPendingActionDecisionSchema
>;

/** `GET /api/v1/external-agents/waiting-count`. */
export type ExternalAgentWaitingCount = { count: number };

/** Error codes the dashboard routes return as `{ error }`. */
export const EXTERNAL_AGENT_ERRORS = [
  'not_found',
  'conflict',
  'expired',
  'invalid_policy',
  'invalid_request',
  /** The connection's access is fixed (a first-party connection, CAN-7606). */
  'failed_precondition',
] as const;
export type ExternalAgentError = (typeof EXTERNAL_AGENT_ERRORS)[number];
