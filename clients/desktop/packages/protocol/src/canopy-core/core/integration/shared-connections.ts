import { z } from 'zod';

import { CanopyJsonValueSchema } from '../../errors';
import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';
import { CORE_INTEGRATION_GRANTS } from './operations';

// ---------------------------------------------------------------------------
// Shared connections for project teams (CAN-6243, CAN-6247; spec NFR-2,
// FR-4.1).
//
// An organization's connection reaches a chat only through the hosted proxy,
// and the proxy serves it only with a claim the web core signed: the person,
// the API key that asked, the organization, the project and the chat. The
// web core issues one when a chat in an organization project starts, after
// checking that the person was added to the project and has it set up, and
// pins the chat to that project. The proxy re-checks the person, the project
// and the connection's binding on every call, so the claim proves who and
// where, never what is allowed.
//
// Served by the web core only. The desktop core does not install it and
// answers capability_unavailable; desktop main calls the web core.
// ---------------------------------------------------------------------------

/** The longest chat id a claim names. */
export const SHARED_CONNECTION_CHAT_ID_MAX_LENGTH = 256;

/** The request header that carries a claim to the proxy. */
export const SHARED_CONNECTION_CLAIM_HEADER = 'x-canopy-connection-claim';

const ProjectIdSchema = z.string().min(1).max(128);

/**
 * A scheduled run's allowed writes (CAN-6252): tool names by shared
 * connection id. Read-only tools are always allowed; any other tool a
 * scheduled run calls must be listed. Bounded so the claim stays a header.
 */
export const SharedConnectionWriteListSchema = z
  .record(
    z.string().min(1).max(128),
    z.array(z.string().min(1).max(128)).max(64),
  )
  .refine((writes) => Object.keys(writes).length <= 16, {
    message: 'At most 16 connections may list writes.',
  })
  .refine((writes) => JSON.stringify(writes).length <= 2048, {
    message: 'The write list is too long.',
  });
export type SharedConnectionWriteList = z.output<
  typeof SharedConnectionWriteListSchema
>;

export const SharedConnectionSessionIssueParamsSchema = z
  .strictObject({
    /** The organization project (`TrackedWorkspace`) external id. */
    projectId: ProjectIdSchema,
    /** The chat the claim is for; it stays in this project for good. */
    chatId: z.string().min(1).max(SHARED_CONNECTION_CHAT_ID_MAX_LENGTH),
    /**
     * `scheduled` for a run no one attends (an automation, a pipeline step):
     * it may call read-only tools and the `writes` listed, nothing else.
     * Absent for an attended chat.
     */
    run: z.literal('scheduled').optional(),
    /** A scheduled run's allowed writes; absent allows none. */
    writes: SharedConnectionWriteListSchema.optional(),
  })
  .refine(
    (params) => params.run === 'scheduled' || params.writes === undefined,
    {
      message: 'Only a scheduled run lists writes.',
      path: ['writes'],
    },
  );

/** A shared connection in force for the project, for display and routing. */
export const SharedConnectionInForceSchema = z
  .object({
    /** The connection's external id. */
    id: z.string().min(1).max(128),
    serverKey: z.string().min(1).max(512),
    configId: z.string().min(1).max(128),
    /** Its label, else the service's name. */
    name: z.string().max(512),
    identityKind: z.enum(['user', 'bot']),
    status: z.enum(['pending', 'connected', 'needsSignIn', 'disconnected']),
    /** The proxy route the claim must be sent to. */
    routeId: z.string().min(1).max(64),
    /**
     * The tools this project may call on it, or null for every tool the
     * connection allows. The proxy enforces it; this copy is for display.
     */
    tools: z.array(z.string().min(1).max(256)).max(2048).nullable(),
  })
  .catchall(CanopyJsonValueSchema);
export type SharedConnectionInForce = z.output<
  typeof SharedConnectionInForceSchema
>;

export const SharedConnectionSessionIssueResultSchema = z
  .object({
    /** Send as the `x-canopy-connection-claim` header on proxy calls. */
    claim: z.string().min(1).max(4096),
    /** ISO time after which the claim must be asked for again. */
    expiresAt: z.string().min(1).max(64),
    project: z
      .object({
        id: ProjectIdSchema,
        name: z.string().max(512),
      })
      .catchall(CanopyJsonValueSchema),
    connections: z.array(SharedConnectionInForceSchema).max(512),
  })
  .catchall(CanopyJsonValueSchema);
export type SharedConnectionSessionIssueResult = z.output<
  typeof SharedConnectionSessionIssueResultSchema
>;

export const SHARED_CONNECTION_SESSION_CODES = [
  /** The person was not added to the project (or it is not theirs to see). */
  'core.integration.sharedConnection.notOnProject',
  /** The project is archived. */
  'core.integration.sharedConnection.projectArchived',
  /** The person has not set the project up on any device. */
  'core.integration.sharedConnection.projectNotSetUp',
  /** The chat was first used in another project. */
  'core.integration.sharedConnection.chatInOtherProject',
  /** Only a desktop's own key may ask. */
  'core.integration.sharedConnection.desktopOnly',
] as const;

export const CORE_INTEGRATION_SHARED_CONNECTION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.integration.sharedConnection.session.issue': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      // Issuing a claim pins the chat to its project, a write; every
      // signed-in desktop session holds this grant.
      requiredGrants: [CORE_INTEGRATION_GRANTS.write],
      params: SharedConnectionSessionIssueParamsSchema,
      result: SharedConnectionSessionIssueResultSchema,
      error: inherentOperationErrorSchema(SHARED_CONNECTION_SESSION_CODES),
    }),
  });

// ---------------------------------------------------------------------------
// The organization's own connections (CAN-6245; spec FR-3.1, NFR-1).
//
// Organization owners and admins list, connect, reconnect, disconnect and
// remove the connections the organization holds. Connecting always starts a
// fresh sign-in as the organization; a person's own sign-in is never
// converted. A server with a bot identity is shared only as its bot
// (`sharedConnectionIdentityKind`), so until its bot sign-in is available it
// cannot be connected here. Removing a connection takes it out of the
// organization's defaults and every project. Served by the web core only.
// ---------------------------------------------------------------------------

const OrganizationIdSchema = z.string().min(1).max(128);
const ConnectionIdSchema = z.string().min(1).max(128);
const KeyedMetaSchema = CanopyRequestMetadataSchema.extend({
  idempotencyKey: z.string().min(1).max(512),
});

/** An organization connection as its admins see it. */
export const OrganizationConnectionSchema = z
  .object({
    id: ConnectionIdSchema,
    serverKey: z.string().min(1).max(512),
    configId: z.string().min(1).max(128),
    /** Its label, else the service's name. */
    name: z.string().max(512),
    /** The service's name. */
    serviceName: z.string().max(512),
    label: z.string().max(80).nullable(),
    identityKind: z.enum(['user', 'bot']),
    status: z.enum(['pending', 'connected', 'needsSignIn', 'disconnected']),
    /** Who signed it in, for "Connected by"; null once they are gone. */
    connectedBy: z
      .object({ name: z.string().max(512) })
      .catchall(CanopyJsonValueSchema)
      .nullable(),
    connectedAt: z.string().max(64).nullable(),
    /** Whether it is one of the organization's default connections. */
    organizationDefault: z.boolean(),
    /** The projects that use it: added there, or a default not switched off. */
    projects: z
      .array(
        z
          .object({ id: z.string().min(1).max(128), name: z.string().max(512) })
          .catchall(CanopyJsonValueSchema),
      )
      .max(2048),
    /**
     * For a default, the active projects that switched it off. Absent from
     * servers that predate it.
     */
    excludedProjects: z
      .array(
        z
          .object({ id: z.string().min(1).max(128), name: z.string().max(512) })
          .catchall(CanopyJsonValueSchema),
      )
      .max(2048)
      .optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type OrganizationConnection = z.output<
  typeof OrganizationConnectionSchema
>;

export const SharedConnectionListParamsSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
});

/** One of the caller's own connections the organization could also hold. */
export const SharedConnectionOwnSchema = z
  .object({
    serverKey: z.string().min(1).max(512),
    /** Its label, else the service's name. */
    name: z.string().max(512),
  })
  .catchall(CanopyJsonValueSchema);
export type SharedConnectionOwn = z.output<typeof SharedConnectionOwnSchema>;

/** A catalog server the organization could hold, for the connect dialog. */
export const SharedConnectionCatalogEntrySchema = z
  .object({
    serverKey: z.string().min(1).max(512),
    name: z.string().max(512),
    /** Who a shared connection to it acts as. */
    identityKind: z.enum(['user', 'bot']),
    /**
     * False when it cannot be connected for the organization yet (a service
     * shared only as its bot before that bot exists).
     */
    available: z.boolean(),
  })
  .catchall(CanopyJsonValueSchema);
export type SharedConnectionCatalogEntry = z.output<
  typeof SharedConnectionCatalogEntrySchema
>;

export const SharedConnectionToolsParamsSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  connectionId: ConnectionIdSchema,
  /**
   * A project the caller may use the connection in (CAN-6252): a person on
   * it, who isn't an owner or admin, may then read the tools to choose an
   * automation's allowed writes. Absent needs an owner or admin.
   */
  projectId: z.string().min(1).max(128).optional(),
});

/** One tool an organization connection's server offers (CAN-6248). */
export const SharedConnectionToolSchema = z
  .object({
    name: z.string().min(1).max(256),
    title: z.string().max(256).optional(),
    description: z.string().max(1024).optional(),
    /**
     * The server's `readOnlyHint`: true when it says the tool changes
     * nothing. A project's "Read only" limit keeps these.
     */
    readOnly: z.boolean().optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type SharedConnectionTool = z.output<typeof SharedConnectionToolSchema>;

/**
 * Every tool the connection's server offers, before any project's limit, so
 * an admin can choose which a project may call.
 */
export const SharedConnectionToolsResultSchema = z
  .object({
    tools: z.array(SharedConnectionToolSchema).max(1000),
  })
  .catchall(CanopyJsonValueSchema);
export type SharedConnectionToolsResult = z.output<
  typeof SharedConnectionToolsResultSchema
>;

/** At most this many uses answer one page of the usage list. */
export const SHARED_CONNECTION_USAGE_PAGE_LIMIT = 100;

export const SharedConnectionUsageListParamsSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  /** Only this connection's uses. */
  connectionId: ConnectionIdSchema.optional(),
  /** Only uses from this project. */
  projectId: z.string().min(1).max(128).optional(),
  /** Only this person's uses. */
  personId: z.string().min(1).max(128).optional(),
  /** The `nextCursor` of the page before; absent for the newest page. */
  cursor: z.string().min(1).max(64).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SHARED_CONNECTION_USAGE_PAGE_LIMIT)
    .optional(),
});

const UsageRefSchema = z
  .object({
    /** Null once the connection, project or person is gone. */
    id: z.string().max(128).nullable(),
    name: z.string().max(512),
  })
  .catchall(CanopyJsonValueSchema);

export type SharedConnectionUsageListParams = z.output<
  typeof SharedConnectionUsageListParamsSchema
>;

/** One use of an organization connection (CAN-6249), newest first. */
export const SharedConnectionUseSchema = z
  .object({
    id: z.string().min(1).max(128),
    /** When the call reached the proxy, ISO 8601. */
    at: z.string().max(64),
    connection: UsageRefSchema,
    /** Null once the person's account is deleted. */
    person: UsageRefSchema.nullable(),
    /** Null when the call carried no valid claim for a project. */
    project: UsageRefSchema.nullable(),
    chatId: z.string().max(256).nullable(),
    /** `attended`, or `scheduled` for a scheduled run. */
    runKind: z.string().max(16).nullable(),
    /** The JSON-RPC method, such as `tools/call`. */
    method: z.string().max(128),
    tool: z.string().max(256).nullable(),
    outcome: z.enum(['allowed', 'refused']),
    /** Why a refused call was refused, such as `toolLimited`. */
    reason: z.string().max(64).nullable(),
  })
  .catchall(CanopyJsonValueSchema);
export type SharedConnectionUse = z.output<typeof SharedConnectionUseSchema>;

const UsageFilterOptionSchema = z
  .object({ id: z.string().min(1).max(128), name: z.string().max(512) })
  .catchall(CanopyJsonValueSchema);

export const SharedConnectionUsageListResultSchema = z
  .object({
    uses: z
      .array(SharedConnectionUseSchema)
      .max(SHARED_CONNECTION_USAGE_PAGE_LIMIT),
    /** Pass as `cursor` for the next, older page; null on the last page. */
    nextCursor: z.string().max(64).nullable(),
    /** What the filters can choose: the organization's connections, projects and people. */
    filters: z
      .object({
        connections: z.array(UsageFilterOptionSchema).max(1024),
        projects: z.array(UsageFilterOptionSchema).max(4096),
        people: z.array(UsageFilterOptionSchema).max(4096),
      })
      .catchall(CanopyJsonValueSchema),
  })
  .catchall(CanopyJsonValueSchema);
export type SharedConnectionUsageListResult = z.output<
  typeof SharedConnectionUsageListResultSchema
>;

export const SharedConnectionListResultSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    connections: z.array(OrganizationConnectionSchema).max(512),
    /** The catalog servers an admin can connect (CAN-6245). */
    catalog: z.array(SharedConnectionCatalogEntrySchema).max(1024).optional(),
    /**
     * The caller's own connections to catalog servers the organization can
     * hold (CAN-6251), for "Share with this project": each names its server,
     * never its sign-in. Sharing one starts a fresh sign-in as the
     * organization; the caller's own connection is unchanged.
     */
    yours: z.array(SharedConnectionOwnSchema).max(512).optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type SharedConnectionListResult = z.output<
  typeof SharedConnectionListResultSchema
>;

/** Where the sign-in goes, or the connection when none is needed. */
export const SharedConnectionStartResultSchema = z
  .object({
    /** The provider's authorization URL. */
    authorizationUrl: z.string().max(8192).optional(),
    /** The same-origin sign-in page that sends only this admin on. */
    signInPath: z.string().max(8192).optional(),
    connection: OrganizationConnectionSchema.optional(),
    /**
     * The new connection's id, also while its sign-in is pending. Servers
     * from before it set it only when the connect added it to a project
     * (CAN-6251).
     */
    connectionId: ConnectionIdSchema.optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type SharedConnectionStartResult = z.output<
  typeof SharedConnectionStartResultSchema
>;

export const SharedConnectionConnectParamsSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  /** A catalog server's key; organizations hold catalog servers only. */
  serverKey: z.string().min(1).max(512),
  label: z.string().min(1).max(80).optional(),
  /**
   * One of the catalog server's endpoint options, for a server that offers
   * several; omitted for a server with one.
   */
  endpointUrl: z.string().min(1).max(2048).optional(),
  /** The page to return to after the sign-in (same origin). */
  returnTo: z.string().min(1).max(2048).optional(),
  /**
   * An organization project to add the new connection to (CAN-6251):
   * "Share with this project". It is added at once, signed in or not, so a
   * sign-in finished later needs nothing else.
   */
  projectId: z.string().min(1).max(128).optional(),
  _meta: KeyedMetaSchema,
});

export const SharedConnectionReconnectParamsSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  connectionId: ConnectionIdSchema,
  returnTo: z.string().min(1).max(2048).optional(),
  _meta: KeyedMetaSchema,
});

export const SharedConnectionDisconnectParamsSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  connectionId: ConnectionIdSchema,
  _meta: KeyedMetaSchema,
});

export const SharedConnectionDisconnectResultSchema = z
  .object({ connection: OrganizationConnectionSchema })
  .catchall(CanopyJsonValueSchema);

export const SharedConnectionRemoveParamsSchema =
  SharedConnectionDisconnectParamsSchema;

export const SharedConnectionRemoveResultSchema = z
  .object({
    /** The projects it was taken out of. */
    projects: z
      .array(
        z
          .object({ id: z.string().min(1).max(128), name: z.string().max(512) })
          .catchall(CanopyJsonValueSchema),
      )
      .max(2048),
  })
  .catchall(CanopyJsonValueSchema);

/**
 * Where an organization connection is used: every project (the
 * organization's default) or only the projects that use it, and the projects
 * the caller changed. Each change says what the caller read, so a project or
 * default someone else changed since refuses the whole update.
 */
export const SharedConnectionProjectsUpdateParamsSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  connectionId: ConnectionIdSchema,
  /** True for every project, new ones included; false for chosen ones. */
  everyProject: z.boolean(),
  /** Whether it was a default when the caller read it. */
  expectedEveryProject: z.boolean(),
  /** The projects the caller changed; every other project keeps its use. */
  changes: z
    .array(
      z.strictObject({
        projectId: z.string().min(1).max(128),
        /** Whether the project should use it. */
        use: z.boolean(),
        /** Whether it used it when the caller read it. */
        using: z.boolean(),
      }),
    )
    .max(2048),
  _meta: KeyedMetaSchema,
});

export const SharedConnectionProjectsUpdateResultSchema = z
  .object({ connection: OrganizationConnectionSchema })
  .catchall(CanopyJsonValueSchema);

export const ORGANIZATION_CONNECTION_CODES = [
  'core.integration.sharedConnection.notFound',
  /** The server is shared only as its bot, whose sign-in is not set up. */
  'core.integration.sharedConnection.botUnavailable',
  /** The server cannot be held by the organization (not in the catalog). */
  'core.integration.sharedConnection.serverUnavailable',
] as const;

/** `projects.update`'s codes: the others, and a read that went stale. */
export const ORGANIZATION_CONNECTION_PROJECTS_CODES = [
  ...ORGANIZATION_CONNECTION_CODES,
  /**
   * The default, or a project the caller changed, moved since the caller
   * read it (another admin's change); nothing was written.
   */
  'core.integration.sharedConnection.changed',
  /**
   * The update would put more connectors in a project or in the defaults,
   * or the connection in more projects, than they can hold.
   */
  'core.integration.sharedConnection.tooMany',
] as const;

export const CORE_INTEGRATION_SHARED_CONNECTION_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.integration.sharedConnection.list': defineCanopyQuery({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_INTEGRATION_GRANTS.write],
      params: SharedConnectionListParamsSchema,
      result: SharedConnectionListResultSchema,
      error: inherentOperationErrorSchema(ORGANIZATION_CONNECTION_CODES),
    }),
    'core.integration.sharedConnection.usage.list': defineCanopyQuery({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_INTEGRATION_GRANTS.write],
      params: SharedConnectionUsageListParamsSchema,
      result: SharedConnectionUsageListResultSchema,
      error: inherentOperationErrorSchema(ORGANIZATION_CONNECTION_CODES),
    }),
    'core.integration.sharedConnection.tools': defineCanopyQuery({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_INTEGRATION_GRANTS.write],
      params: SharedConnectionToolsParamsSchema,
      result: SharedConnectionToolsResultSchema,
      error: inherentOperationErrorSchema(ORGANIZATION_CONNECTION_CODES),
    }),
  });

export const CORE_INTEGRATION_ORGANIZATION_CONNECTION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.integration.sharedConnection.connect': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_INTEGRATION_GRANTS.write],
      params: SharedConnectionConnectParamsSchema,
      result: SharedConnectionStartResultSchema,
      error: keyedOperationErrorSchema(ORGANIZATION_CONNECTION_CODES),
    }),
    'core.integration.sharedConnection.reconnect': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_INTEGRATION_GRANTS.write],
      params: SharedConnectionReconnectParamsSchema,
      result: SharedConnectionStartResultSchema,
      error: keyedOperationErrorSchema(ORGANIZATION_CONNECTION_CODES),
    }),
    'core.integration.sharedConnection.disconnect': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_INTEGRATION_GRANTS.write],
      params: SharedConnectionDisconnectParamsSchema,
      result: SharedConnectionDisconnectResultSchema,
      error: keyedOperationErrorSchema(ORGANIZATION_CONNECTION_CODES),
    }),
    'core.integration.sharedConnection.remove': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_INTEGRATION_GRANTS.write],
      params: SharedConnectionRemoveParamsSchema,
      result: SharedConnectionRemoveResultSchema,
      error: keyedOperationErrorSchema(ORGANIZATION_CONNECTION_CODES),
    }),
    'core.integration.sharedConnection.projects.update':
      defineCanopyInstruction({
        plane: 'core',
        domain: 'integration',
        version: 1,
        placement: 'core-only',
        idempotency: 'keyed',
        requiredGrants: [CORE_INTEGRATION_GRANTS.write],
        params: SharedConnectionProjectsUpdateParamsSchema,
        result: SharedConnectionProjectsUpdateResultSchema,
        error: keyedOperationErrorSchema(
          ORGANIZATION_CONNECTION_PROJECTS_CODES,
        ),
      }),
  });
