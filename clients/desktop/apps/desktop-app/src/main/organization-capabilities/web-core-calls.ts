import { app } from 'electron';
import {
  CanopyClientError,
  createCanopyClient,
  type CanopyClient,
} from '@canopy/core-client';
import {
  CORE_CATALOG_CAPABILITY_SETUP_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_CAPABILITY_SETUP_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CatalogOrganizationDefaultsGetResultSchema,
  CatalogOrganizationDefaultsUpdateResultSchema,
  CatalogProjectSetupGetResultSchema,
  CatalogProjectSetupUpdateResultSchema,
  composeCanopyInstructionRegistries,
  composeCanopyQueryRegistries,
  type CapabilitySetupItemRef,
  type CatalogOrganizationDefaultsGetResult,
  type CatalogProjectSetupGetResult,
  CORE_ORGANIZATION_TRANSCRIPT_INSTRUCTIONS,
  CORE_ORGANIZATION_TRANSCRIPT_QUERIES,
  OrgTranscriptAccessEventsListResultSchema,
  OrgTranscriptExportEstimateResultSchema,
  OrgTranscriptExportSchema,
  OrgTranscriptExportsListResultSchema,
  OrgTranscriptSessionGetResultSchema,
  OrgTranscriptSessionsListResultSchema,
  type OrgTranscriptAccessEventsListParams,
  type OrgTranscriptAccessEventsListResult,
  type OrgTranscriptExport,
  type OrgTranscriptExportDeleteParams,
  type OrgTranscriptExportEstimateResult,
  type OrgTranscriptExportRequestParams,
  type OrgTranscriptExportsListParams,
  type OrgTranscriptExportsListResult,
  type OrgTranscriptSessionGetParams,
  type OrgTranscriptSessionGetResult,
  type OrgTranscriptSessionsListParams,
  type OrgTranscriptSessionsListResult,
  type CapabilitySetupConnectorRef,
  type StoredProjectConnectorSetup,
} from '@canopy/protocol/canopy-core';
import type { z } from 'zod';
import { connectWebCore } from '../canopy-cloud/web-core-connection';
import { desktopWebCoreBindingOptions } from '../ipc/cloud-chats';

/**
 * What a read answered: the result; `unavailable` when the web core does not
 * offer the operation (an older web), read as no organization setup; or
 * `refused` when the web core says the account may not read it (not found or
 * permission denied), so a set kept from before must stop applying. Any other
 * failure throws and is transient.
 */
export type OrganizationCapabilityRead<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'refused' };

/**
 * The web core reads behind an organization's shared skills and plugins
 * (CAN-6236). Each call opens its own connection as the signed-in account
 * and closes it once it settles.
 */
export interface OrganizationCapabilityCalls {
  projectSetup(
    projectId: string,
  ): Promise<OrganizationCapabilityRead<CatalogProjectSetupGetResult>>;
  organizationDefaults(
    organizationId: string,
  ): Promise<OrganizationCapabilityRead<CatalogOrganizationDefaultsGetResult>>;
}

const REFUSALS = new Set(['not_found', 'permission_denied']);

const CALL_TIMEOUT_MS = 30_000;

const DEFINITIONS = {
  queries: composeCanopyQueryRegistries(
    CORE_TRANSPORT_QUERY_DEFINITIONS,
    CORE_CATALOG_CAPABILITY_SETUP_QUERY_DEFINITIONS,
  ),
  instructions: composeCanopyInstructionRegistries(
    CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    CORE_CATALOG_CAPABILITY_SETUP_INSTRUCTION_DEFINITIONS,
  ),
  streams: {},
};

type Client = CanopyClient<
  (typeof DEFINITIONS)['queries'],
  (typeof DEFINITIONS)['instructions']
>;

/** One connection as the signed-in account, closed once `call` settles. */
async function withWebCoreClient<T>(
  call: (client: Client) => Promise<T>,
): Promise<T> {
  // Not behind the cloud chats flag: the web core gates these calls itself.
  const binding = {
    ...desktopWebCoreBindingOptions(),
    isEnabled: (): boolean => true,
  };
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const client: Client = await createCanopyClient({
    connection: await connectWebCore(binding, signal),
    clientName: 'canopy-desktop-organization-capabilities',
    clientVersion: app.getVersion(),
    definitions: DEFINITIONS,
    signal,
  });
  try {
    return await call(client);
  } finally {
    await client.close();
  }
}

export function createWebCoreOrganizationCapabilityCalls(): OrganizationCapabilityCalls {
  async function withClient<T>(
    method: string,
    call: (client: Client) => Promise<T>,
  ): Promise<OrganizationCapabilityRead<T>> {
    try {
      return await withWebCoreClient(async (client) =>
        client.manifest.has('operations', method)
          ? { kind: 'ok', value: await call(client) }
          : { kind: 'unavailable' },
      );
    } catch (error) {
      if (
        error instanceof CanopyClientError &&
        REFUSALS.has(error.payload.kind)
      )
        return { kind: 'refused' };
      throw error;
    }
  }
  return {
    projectSetup: (projectId) =>
      withClient('core.catalog.projectSetup.get', async (client) =>
        CatalogProjectSetupGetResultSchema.parse(
          await client.query('core.catalog.projectSetup.get', { projectId }),
        ),
      ),
    organizationDefaults: (organizationId) =>
      withClient('core.catalog.organizationDefaults.get', async (client) =>
        CatalogOrganizationDefaultsGetResultSchema.parse(
          await client.query('core.catalog.organizationDefaults.get', {
            organizationId,
          }),
        ),
      ),
  };
}

export type OrganizationDefaultsUpdateResult = z.output<
  typeof CatalogOrganizationDefaultsUpdateResultSchema
>;

/**
 * The organization Settings Project defaults page's calls (CAN-6237): the
 * same operations as the reads above, as the signed-in account, with every
 * refusal left as the web core's `CanopyClientError` so the settings page can
 * tell a stale revision from lost access. A web core that does not offer the
 * operation answers `capability_unavailable`.
 */
export interface OrganizationDefaultsSettingsCalls {
  read(organizationId: string): Promise<CatalogOrganizationDefaultsGetResult>;
  update(input: {
    readonly organizationId: string;
    readonly expectedRevision: number;
    readonly items: readonly CapabilitySetupItemRef[];
    /** The default connections (CAN-6246); absent leaves them unchanged. */
    readonly connectors?: readonly CapabilitySetupConnectorRef[];
    readonly idempotencyKey: string;
  }): Promise<OrganizationDefaultsUpdateResult>;
}

function requireOperation(client: Client, method: string): void {
  if (!client.manifest.has('operations', method))
    throw new CanopyClientError({
      kind: 'capability_unavailable',
      message: `The web core does not serve ${method}.`,
      retry: { kind: 'never' },
    });
}

export function createWebCoreOrganizationDefaultsSettingsCalls(): OrganizationDefaultsSettingsCalls {
  return {
    read: (organizationId) =>
      withWebCoreClient(async (client) => {
        requireOperation(client, 'core.catalog.organizationDefaults.get');
        return CatalogOrganizationDefaultsGetResultSchema.parse(
          await client.query('core.catalog.organizationDefaults.get', {
            organizationId,
          }),
        );
      }),
    update: ({
      organizationId,
      expectedRevision,
      items,
      connectors,
      idempotencyKey,
    }) =>
      withWebCoreClient(async (client) => {
        requireOperation(client, 'core.catalog.organizationDefaults.update');
        return CatalogOrganizationDefaultsUpdateResultSchema.parse(
          await client.instruction('core.catalog.organizationDefaults.update', {
            organizationId,
            expectedRevision,
            items: [...items],
            ...(connectors === undefined
              ? {}
              : { connectors: [...connectors] }),
            _meta: { idempotencyKey },
          }),
        );
      }),
  };
}

/**
 * The shared project setup panel's calls (CAN-6239), as the organization
 * defaults calls above: `core.catalog.projectSetup.get` and `.update` as the
 * signed-in account, refusals left as the web core's `CanopyClientError`.
 */
export interface ProjectSetupSettingsCalls {
  read(projectId: string): Promise<CatalogProjectSetupGetResult>;
  update(input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly added: readonly CapabilitySetupItemRef[];
    readonly removed: readonly CapabilitySetupItemRef[];
    readonly dismissedRecommendations: readonly string[];
    /**
     * The project's connections and tool limits (CAN-6246, CAN-6248);
     * absent leaves them unchanged.
     */
    readonly connectors?: StoredProjectConnectorSetup;
    readonly idempotencyKey: string;
  }): Promise<CatalogProjectSetupGetResult>;
}

export function createWebCoreProjectSetupSettingsCalls(): ProjectSetupSettingsCalls {
  return {
    read: (projectId) =>
      withWebCoreClient(async (client) => {
        requireOperation(client, 'core.catalog.projectSetup.get');
        return CatalogProjectSetupGetResultSchema.parse(
          await client.query('core.catalog.projectSetup.get', { projectId }),
        );
      }),
    update: ({
      idempotencyKey,
      added,
      removed,
      dismissedRecommendations,
      ...input
    }) =>
      withWebCoreClient(async (client) => {
        requireOperation(client, 'core.catalog.projectSetup.update');
        return CatalogProjectSetupUpdateResultSchema.parse(
          await client.instruction('core.catalog.projectSetup.update', {
            ...input,
            added: [...added],
            removed: [...removed],
            dismissedRecommendations: [...dismissedRecommendations],
            _meta: { idempotencyKey },
          }),
        );
      }),
  };
}

const ORGANIZATION_TRANSCRIPT_DEFINITIONS = {
  queries: composeCanopyQueryRegistries(
    CORE_TRANSPORT_QUERY_DEFINITIONS,
    CORE_ORGANIZATION_TRANSCRIPT_QUERIES,
  ),
  instructions: composeCanopyInstructionRegistries(
    CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    CORE_ORGANIZATION_TRANSCRIPT_INSTRUCTIONS,
  ),
  streams: {},
};

type OrganizationTranscriptClient = CanopyClient<
  (typeof ORGANIZATION_TRANSCRIPT_DEFINITIONS)['queries'],
  (typeof ORGANIZATION_TRANSCRIPT_DEFINITIONS)['instructions']
>;

/** As {@link withWebCoreClient}, over the organization transcript operations. */
async function withOrganizationTranscriptClient<T>(
  method: string,
  call: (client: OrganizationTranscriptClient) => Promise<T>,
): Promise<T> {
  // Not behind the cloud chats flag: the web core gates these calls itself.
  const binding = {
    ...desktopWebCoreBindingOptions(),
    isEnabled: (): boolean => true,
  };
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const client: OrganizationTranscriptClient = await createCanopyClient({
    connection: await connectWebCore(binding, signal),
    clientName: 'canopy-desktop-organization-transcripts',
    clientVersion: app.getVersion(),
    definitions: ORGANIZATION_TRANSCRIPT_DEFINITIONS,
    signal,
  });
  try {
    if (!client.manifest.has('operations', method))
      throw new CanopyClientError({
        kind: 'capability_unavailable',
        message: `The web core does not serve ${method}.`,
        retry: { kind: 'never' },
      });
    return await call(client);
  } finally {
    await client.close();
  }
}

/**
 * The organization Transcripts pages' calls: `core.organizationTranscripts.*`
 * as the signed-in account, refusals left as the web core's
 * `CanopyClientError`. Owners only; every call reauthorizes on the server.
 */
export interface OrganizationTranscriptSettingsCalls {
  sessions(
    params: OrgTranscriptSessionsListParams,
  ): Promise<OrgTranscriptSessionsListResult>;
  session(
    params: OrgTranscriptSessionGetParams,
  ): Promise<OrgTranscriptSessionGetResult>;
  exports(
    params: OrgTranscriptExportsListParams,
  ): Promise<OrgTranscriptExportsListResult>;
  estimate(
    params: OrgTranscriptExportRequestParams,
  ): Promise<OrgTranscriptExportEstimateResult>;
  accessEvents(
    params: OrgTranscriptAccessEventsListParams,
  ): Promise<OrgTranscriptAccessEventsListResult>;
  createExport(
    params: OrgTranscriptExportRequestParams,
    idempotencyKey: string,
  ): Promise<OrgTranscriptExport>;
  deleteExport(
    params: Omit<OrgTranscriptExportDeleteParams, '_meta'>,
    idempotencyKey: string,
  ): Promise<OrgTranscriptExport>;
}

export function createWebCoreOrganizationTranscriptSettingsCalls(): OrganizationTranscriptSettingsCalls {
  const SESSIONS = 'core.organizationTranscripts.sessions.list';
  const SESSION = 'core.organizationTranscripts.session.get';
  const EXPORTS = 'core.organizationTranscripts.exports.list';
  const ESTIMATE = 'core.organizationTranscripts.exports.estimate';
  const ACCESS = 'core.organizationTranscripts.accessEvents.list';
  const CREATE = 'core.organizationTranscripts.exports.create';
  const DELETE = 'core.organizationTranscripts.exports.delete';
  return {
    sessions: (params) =>
      withOrganizationTranscriptClient(SESSIONS, async (client) =>
        OrgTranscriptSessionsListResultSchema.parse(
          await client.query(SESSIONS, params),
        ),
      ),
    session: (params) =>
      withOrganizationTranscriptClient(SESSION, async (client) =>
        OrgTranscriptSessionGetResultSchema.parse(
          await client.query(SESSION, params),
        ),
      ),
    exports: (params) =>
      withOrganizationTranscriptClient(EXPORTS, async (client) =>
        OrgTranscriptExportsListResultSchema.parse(
          await client.query(EXPORTS, params),
        ),
      ),
    estimate: (params) =>
      withOrganizationTranscriptClient(ESTIMATE, async (client) =>
        OrgTranscriptExportEstimateResultSchema.parse(
          await client.query(ESTIMATE, params),
        ),
      ),
    accessEvents: (params) =>
      withOrganizationTranscriptClient(ACCESS, async (client) =>
        OrgTranscriptAccessEventsListResultSchema.parse(
          await client.query(ACCESS, params),
        ),
      ),
    createExport: (params, idempotencyKey) =>
      withOrganizationTranscriptClient(CREATE, async (client) =>
        OrgTranscriptExportSchema.parse(
          await client.instruction(CREATE, {
            ...params,
            _meta: { idempotencyKey },
          }),
        ),
      ),
    deleteExport: (params, idempotencyKey) =>
      withOrganizationTranscriptClient(DELETE, async (client) =>
        OrgTranscriptExportSchema.parse(
          await client.instruction(DELETE, {
            ...params,
            _meta: { idempotencyKey },
          }),
        ),
      ),
  };
}
