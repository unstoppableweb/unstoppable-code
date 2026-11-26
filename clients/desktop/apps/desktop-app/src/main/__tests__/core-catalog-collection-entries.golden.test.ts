// CAN-4170 golden: local collections through core.catalog.entry.get and
// core.catalog.entry.upsert on the desktop dispatcher, over the real
// collection store on a data root the suite owns. A stored config that can't
// be read is answered as unreadable, never as missing.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  collectionEntryId,
  type CanopyCallerDescriptor,
  type CatalogCollectionMembers,
  type CatalogCollectionShareDocument,
} from '@canopy/protocol/canopy-core';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type * as PluginService from '../plugins/plugin-service';
import type * as SkillService from '../skills/skill-service';
import type * as AccountCatalog from '../mcp/account-catalog';
import type * as CloudAccountStore from '../lib/canopy-cloud-account-store';
import type * as ServerClient from '../collections/canopy-server-client';
import type * as SharedItemSubscriptions from '../canopy-cloud/shared-item-subscriptions';
import type * as FsPromises from 'node:fs/promises';
import { analyzeCapabilityPackage } from '@canopy/desktop-shared/node';
import {
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  type PipelinePackageAnalysisSummary,
  type PipelinePackageEnvironmentRequirement,
  type PipelinePackageInvocationDismissal,
} from '@canopy/protocol/pipelines';
import type * as PackageService from '../pipelines/pipeline-package-service';
import {
  listPipelinePackageDismissals,
  replacePipelinePackageDismissals,
} from '../pipelines/pipeline-package-dismissal-store';
import type * as CloudClient from '../canopy-cloud/client';
import type * as McpConnections from '../canopy-cloud/mcp-connections';
import type * as PublicShareClient from '../canopy-cloud/public-share-client';
import type * as ConnectionStatus from '../mcp/connection-status';
import type * as SecureStoragePolicy from '../lib/secure-storage-policy';
import type * as PathLookup from '@canopy/execution-engine/node/lib/path-lookup';

// Resource contexts are off unless a case turns them on, with the signed-in
// account below and an organization whose context the foreground refuses.
// A case bumps an epoch to switch the selected context, or the signed-in
// account, mid-read.
const mockContext: {
  enabled: boolean;
  refusedOrganization: string | null;
  epoch: number;
  accountEpoch: number;
} = {
  enabled: false,
  refusedOrganization: null,
  epoch: 0,
  accountEpoch: 0,
};
jest.mock('../lib/resource-context', () => {
  const decide = (resource: { owner?: unknown }): Promise<void> => {
    const owner = resource.owner;
    return typeof owner === 'object' &&
      owner !== null &&
      'type' in owner &&
      owner.type === 'organization' &&
      'id' in owner &&
      owner.id === mockContext.refusedOrganization
      ? Promise.reject(new Error('Resource unavailable (context)'))
      : Promise.resolve();
  };
  return {
    resourceContextEnabled: (): boolean => mockContext.enabled,
    resourceContextSnapshot: (): Promise<string> =>
      Promise.resolve(`context-${mockContext.epoch}`),
    assertResourceContextSnapshot: (snapshot: string): Promise<void> =>
      snapshot === `context-${mockContext.epoch}`
        ? Promise.resolve()
        : Promise.reject(new Error('Resource unavailable (context-mismatch)')),
    resourceAccountSnapshot: (): Promise<number> =>
      Promise.resolve(mockContext.accountEpoch),
    assertResourceAccountSnapshot: (snapshot: number): Promise<void> =>
      snapshot === mockContext.accountEpoch
        ? Promise.resolve()
        : Promise.reject(new Error('Resource unavailable (context-mismatch)')),
    assertResourceContext: decide,
    assertResourceContextForContext: decide,
  };
});
jest.mock('../lib/canopy-cloud-account-store', () => {
  const actual = jest.requireActual<typeof CloudAccountStore>(
    '../lib/canopy-cloud-account-store',
  );
  return {
    ...actual,
    // CAN-4170 PR 4b-1: a signed-in account whose cached capabilities are
    // cold, and every capability write the cloud client makes for it.
    getCanopyCloudCredentials: (
      ...args: Parameters<typeof actual.getCanopyCloudCredentials>
    ): ReturnType<typeof actual.getCanopyCloudCredentials> =>
      mockColdAccount.on
        ? Promise.resolve({
            baseUrl: 'https://cloud.golden.test',
            apiKey: 'golden-cold-key',
            capabilities: [],
            memorySearchOrganizationExternalIds: [],
          })
        : actual.getCanopyCloudCredentials(...args),
    mergeCanopyCloudAccountCapabilities: (
      ...args: Parameters<typeof actual.mergeCanopyCloudAccountCapabilities>
    ): ReturnType<typeof actual.mergeCanopyCloudAccountCapabilities> => {
      if (!mockColdAccount.on)
        return actual.mergeCanopyCloudAccountCapabilities(...args);
      mockColdAccount.writes.push([...args[0]]);
      return Promise.resolve(null);
    },
    readCanopyCloudAccountWithStatus: (
      ...args: Parameters<typeof actual.readCanopyCloudAccountWithStatus>
    ): Promise<unknown> =>
      mockContext.enabled
        ? Promise.resolve({
            status: 'ok',
            entry: { account: { id: 'account-1' } },
          })
        : actual.readCanopyCloudAccountWithStatus(...args),
    // CAN-4170 PR 4c: the signed-in account an analysis is made under, read
    // locally; a case switches it.
    loadCanopyCloudAccount: (): ReturnType<
      typeof actual.loadCanopyCloudAccount
    > => {
      mockSignedIn.onRead?.();
      return Promise.resolve(
        mockSignedIn.accountId === null
          ? null
          : {
              apiKey: 'golden-fixture-key',
              capabilities: [],
              createdAt: STAMP,
              updatedAt: STAMP,
              account: {
                id: mockSignedIn.accountId,
                name: 'Golden',
                email: 'golden@example.test',
                role: 'DEVELOPER',
              },
            },
      );
    },
  };
});
const mockColdAccount: { on: boolean; writes: string[][] } = {
  on: false,
  writes: [],
};
const mockSignedIn: {
  accountId: string | null;
  /** Runs on each account read; a case cancels a call during it. */
  onRead: (() => void) | null;
} = { accountId: null, onRead: null };
// Only the outside organization's share is still live; every other share an
// installed collection came from has been revoked. Each hosted read is
// counted, as are the cloud capability check and the MCP connection list.
const mockHostedReads: string[] = [];
// CAN-4170 PR 4b-1: shares a case answers; any other is the default above.
const mockShares: {
  scoped: Map<string, (signal?: AbortSignal) => Promise<unknown>>;
  public: Map<string, (signal?: AbortSignal) => Promise<unknown>>;
} = { scoped: new Map(), public: new Map() };
/** When set, the next hosted read waits for it before answering. */
const mockHostedReadHold: { next: Promise<void> | null } = { next: null };
jest.mock('../collections/canopy-server-client', () => ({
  ...jest.requireActual<typeof ServerClient>(
    '../collections/canopy-server-client',
  ),
  getSharedCollection: async (
    remoteId: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    mockHostedReads.push(`shared:${remoteId}`);
    const hold = mockHostedReadHold.next;
    mockHostedReadHold.next = null;
    if (hold) await hold;
    const shared = mockShares.scoped.get(remoteId);
    if (shared) return shared(signal);
    return remoteId === 'remote-outside'
      ? Promise.resolve({
          id: 'remote-outside',
          owner: {
            type: 'organization',
            id: 'dededede-0000-4000-8000-00000000000e',
            name: null,
          },
          shareScope: 'organization',
          contentHash: 'a'.repeat(64),
        })
      : Promise.reject(new Error('Shared collection not found'));
  },
}));
jest.mock('../canopy-cloud/client', () => {
  const actual = jest.requireActual<typeof CloudClient>(
    '../canopy-cloud/client',
  );
  return {
    ...actual,
    assertCanopyCloudCapability: (
      ...args: Parameters<typeof actual.assertCanopyCloudCapability>
    ): ReturnType<typeof actual.assertCanopyCloudCapability> => {
      mockHostedReads.push('capability');
      return mockCapability.check
        ? mockCapability.check()
        : actual.assertCanopyCloudCapability(...args);
    },
    // CAN-4170 PR 4b-1: the credentials a readiness capability check uses,
    // the real account's when the check itself is real.
    resolveCanopyCloudCredentialContext: (
      ...args: Parameters<typeof actual.resolveCanopyCloudCredentialContext>
    ): ReturnType<typeof actual.resolveCanopyCloudCredentialContext> =>
      mockCapability.check
        ? Promise.resolve(MOCK_CLOUD_CONTEXT)
        : actual.resolveCanopyCloudCredentialContext(...args),
    // CAN-4170 PR 4c: the one account a commit's capability check and upload use.
    resolveCanopyCloudCredentialContextWithCapability: (
      capability: string,
    ): Promise<CloudClient.CanopyCloudCredentialContext> => {
      mockHostedReads.push(`capability:${capability}`);
      return mockCloudContext.next();
    },
  };
});
const ACCOUNT_A = 'account-a';
const mockCapability: { check: (() => Promise<void>) | null } = {
  check: null,
};
jest.mock('../canopy-cloud/public-share-client', () => ({
  ...jest.requireActual<typeof PublicShareClient>(
    '../canopy-cloud/public-share-client',
  ),
  getPublicCollectionShareSnapshot: (
    remoteId: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    mockHostedReads.push(`public:${remoteId}`);
    const shared = mockShares.public.get(remoteId);
    return shared
      ? shared(signal)
      : Promise.reject(new Error('no public share expected'));
  },
}));
// The MCP status probes a requirement makes, as the IPC readiness makes them,
// and how many are in flight at once.
const mockMcpProbes: string[] = [];
const mockMcpInFlight = { now: 0, max: 0 };
/** Runs as each catalog probe starts; a case cancels a read during it. */
const mockMcpProbeHook: { onCatalog: (() => void) | null } = {
  onCatalog: null,
};
jest.mock('../mcp/connection-status', () => {
  const actual = jest.requireActual<typeof ConnectionStatus>(
    '../mcp/connection-status',
  );
  return {
    ...actual,
    getMcpServerStatusByCatalogId: async (
      catalogId: string,
    ): ReturnType<typeof actual.getMcpServerStatusByCatalogId> => {
      mockMcpProbes.push(`catalog:${catalogId}`);
      mockMcpProbeHook.onCatalog?.();
      mockMcpInFlight.now += 1;
      mockMcpInFlight.max = Math.max(mockMcpInFlight.max, mockMcpInFlight.now);
      try {
        return await actual.getMcpServerStatusByCatalogId(catalogId);
      } finally {
        mockMcpInFlight.now -= 1;
      }
    },
    getMcpServerStatusByName: (
      name: string,
    ): ReturnType<typeof actual.getMcpServerStatusByName> => {
      mockMcpProbes.push(`name:${name}`);
      return actual.getMcpServerStatusByName(name);
    },
  };
});
// The PATH probes command requirements make, with a hook as each starts.
const mockPathProbes: string[] = [];
const mockPathProbeHook: { onProbe: (() => void) | null } = { onProbe: null };
jest.mock('@canopy/execution-engine/node/lib/path-lookup', () => {
  const actual = jest.requireActual<typeof PathLookup>(
    '@canopy/execution-engine/node/lib/path-lookup',
  );
  return {
    ...actual,
    findExecutableOnPath: (
      ...args: Parameters<typeof actual.findExecutableOnPath>
    ): ReturnType<typeof actual.findExecutableOnPath> => {
      mockPathProbes.push(args[0]);
      mockPathProbeHook.onProbe?.();
      return actual.findExecutableOnPath(...args);
    },
  };
});
// CAN-4170 PR 4b-1: the MCP OAuth token store's encryption, reversible here.
jest.mock('../lib/secure-storage-policy', () => ({
  ...jest.requireActual<typeof SecureStoragePolicy>(
    '../lib/secure-storage-policy',
  ),
  getSecureStorageFailure: (): null => null,
  getSecretStoragePolicy: (): Omit<
    SecureStoragePolicy.SecretStoragePolicy,
    'getStatus'
  > => ({
    isWriteAvailable: (): boolean => true,
    nativeEncryptionAvailable: (): boolean => true,
    assertCanRead: (): void => undefined,
    assertCanWrite: (): void => undefined,
    encrypt: (text: string): Buffer => Buffer.from(`enc:${text}`),
    decrypt: (ciphertext: Buffer): string =>
      ciphertext.toString().replace(/^enc:/, ''),
  }),
}));
const MOCK_CLOUD_CONTEXT = {
  baseUrl: 'https://cloud.test',
  apiKey: 'golden-fixture-key',
  account: {
    id: ACCOUNT_A,
    name: 'Golden',
    email: 'golden@example.test',
    role: 'DEVELOPER' as const,
  },
};
const mockCloudContext: {
  next: () => Promise<CloudClient.CanopyCloudCredentialContext>;
} = { next: () => Promise.resolve(MOCK_CLOUD_CONTEXT) };
jest.mock('../canopy-cloud/mcp-connections', () => {
  const actual = jest.requireActual<typeof McpConnections>(
    '../canopy-cloud/mcp-connections',
  );
  return {
    ...actual,
    listAccountMcpConnections: (
      ...args: Parameters<typeof actual.listAccountMcpConnections>
    ): ReturnType<typeof actual.listAccountMcpConnections> => {
      mockHostedReads.push('mcp-connections');
      return actual.listAccountMcpConnections(...args);
    },
  };
});
// The package analyzer has its own goldens; here it answers what each case
// sets, so a case sees what core sends it and what core keeps.
const mockAnalyzer: {
  inputs: PackageService.AnalyzeSubjectCapabilityPackageInput[];
  dropped: string[];
  /** The analyses the service still holds: answered and not dropped. */
  live: Set<string>;
  /** Runs on each liveness read; a case cancels a commit during it. */
  onLiveRead: (() => void) | null;
  respond: (
    input: PackageService.AnalyzeSubjectCapabilityPackageInput,
  ) => Promise<PipelinePackageAnalysisSummary>;
} = {
  inputs: [],
  dropped: [],
  live: new Set(),
  onLiveRead: null,
  respond: () => Promise.reject(new Error('no analysis expected')),
};
type CommitUpload = Awaited<
  ReturnType<typeof PackageService.createSubjectCapabilityPackage>
>;
// The upload (prepare, blobs, commit) has its own goldens; here it records
// what a commit sends it and answers what each case sets.
const mockCommitter: {
  calls: Array<{
    analysisId: string;
    selectedOptionalResourceIds: string[] | undefined;
    credentialContext: CloudClient.CanopyCloudCredentialContext | undefined;
  }>;
  respond: (stillInTime: () => void) => Promise<CommitUpload>;
} = {
  calls: [],
  respond: () => Promise.reject(new Error('no commit expected')),
};
jest.mock('../pipelines/pipeline-package-service', () => ({
  ...jest.requireActual<typeof PackageService>(
    '../pipelines/pipeline-package-service',
  ),
  analyzeSubjectCapabilityPackage: async (
    input: PackageService.AnalyzeSubjectCapabilityPackageInput,
  ): Promise<PipelinePackageAnalysisSummary> => {
    mockAnalyzer.inputs.push(input);
    const summary = await mockAnalyzer.respond(input);
    mockAnalyzer.live.add(summary.analysisId);
    return summary;
  },
  cancelPackageAnalysis: (analysisId: string): void => {
    mockAnalyzer.dropped.push(analysisId);
    mockAnalyzer.live.delete(analysisId);
  },
  packageAnalysisConsentFacts: (
    analysisId: string,
  ): PackageService.PackageConsentFacts | null => {
    mockAnalyzer.onLiveRead?.();
    return mockAnalyzer.live.has(analysisId)
      ? { contentHash: '', ready: true, files: [], withheld: [] }
      : null;
  },
  createSubjectCapabilityPackage: (
    request: { analysisId: string; selectedOptionalResourceIds?: string[] },
    _getWindow: unknown,
    credentialContext?: CloudClient.CanopyCloudCredentialContext,
    stillInTime?: () => void,
  ): Promise<CommitUpload> => {
    mockCommitter.calls.push({
      analysisId: request.analysisId,
      selectedOptionalResourceIds: request.selectedOptionalResourceIds,
      credentialContext,
    });
    return mockCommitter.respond(stillInTime ?? ((): void => undefined));
  },
}));
// Installs and uninstalls are not synced to the hosted service from here.
jest.mock('../canopy-cloud/shared-item-subscriptions', () => ({
  ...jest.requireActual<typeof SharedItemSubscriptions>(
    '../canopy-cloud/shared-item-subscriptions',
  ),
  recordSharedItemInstall: (): void => undefined,
  recordSharedItemUninstall: (): void => undefined,
}));

// A disk error on the read of a config's text right after a read of its bytes
// of the same file, as the hash delete's second read would meet it; or once,
// on the next read of a config's text.
const mockReadFault: {
  path: string | null;
  bytesRead: boolean;
  nextText: string | null;
} = {
  path: null,
  bytesRead: false,
  nextText: null,
};
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    __esModule: true,
    ...actual,
    readFile: (
      ...args: Parameters<typeof actual.readFile>
    ): ReturnType<typeof actual.readFile> => {
      if (args[0] === mockReadFault.nextText && args[1] !== undefined) {
        mockReadFault.nextText = null;
        return Promise.reject(
          Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }),
        );
      }
      if (args[0] === mockReadFault.path) {
        if (args[1] === undefined) mockReadFault.bytesRead = true;
        else if (mockReadFault.bytesRead) {
          mockReadFault.path = null;
          return Promise.reject(
            Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }),
          );
        }
      }
      return actual.readFile(...args);
    },
  };
});

const SKILL: InstalledSkillInfo = {
  name: 'deploy',
  sourceId: 'user',
  description: 'Deploy the app',
  source: 'user',
  installedAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  updateAvailable: false,
};
jest.mock('../skills/skill-service', () => ({
  ...jest.requireActual<typeof SkillService>('../skills/skill-service'),
  loadSkills: (): { success: true; data: InstalledSkillInfo[] } => ({
    success: true,
    data: [SKILL],
  }),
}));
const pluginsCache = (): unknown => ({
  success: true,
  data: {
    marketplaces: [
      {
        id: 'owner/tools',
        name: 'Tools',
        sourceType: 'github',
        sourceUrl: 'https://github.com/owner/tools',
        installLocation: '/cache',
        pluginCount: 1,
        plugins: [
          {
            name: 'linter',
            description: 'Lints',
            sourcePath: '/cache/linter',
            marketplaceId: 'owner/tools',
            providerSupport: { claude: 'native', codex: 'none' },
          },
        ],
        validProviders: ['claude'],
      },
    ],
  },
});
jest.mock('../plugins/plugin-service', () => ({
  ...jest.requireActual<typeof PluginService>('../plugins/plugin-service'),
  loadMarketplaces: (): Promise<unknown> => Promise.resolve(pluginsCache()),
  loadMarketplacesCacheOnly: (): Promise<unknown> =>
    Promise.resolve(pluginsCache()),
}));
jest.mock('../mcp/account-catalog', () => ({
  ...jest.requireActual<typeof AccountCatalog>('../mcp/account-catalog'),
  loadAccountMcpRefConnections: (): Promise<null> => Promise.resolve(null),
}));

const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ID_S = 'cccccccc-0000-4000-8000-000000000003';
const ID_NONE = 'dddddddd-0000-4000-8000-000000000004';
const STAMP = '2026-11-01T00:00:00.000Z';
const SERVER = 'eeeeeeee-0000-4000-8000-000000000005';
const CONFIG = 'ffffffff-0000-4000-8000-000000000006';
const OTHER_SERVER = '99999999-0000-4000-8000-000000000007';
const ID_X = '12121212-0000-4000-8000-000000000008';
const ORG_OWNER = { type: 'organization', organizationId: 'org-1' };
const ID_PAIR = '34343434-0000-4000-8000-000000000009';
const ID_ORG = '56565656-0000-4000-8000-00000000000a';
const ID_REVOKED = '78787878-0000-4000-8000-00000000000b';
const ID_OUTSIDE = '9a9a9a9a-0000-4000-8000-00000000000c';
const ID_MALFORMED = 'bcbcbcbc-0000-4000-8000-00000000000d';
const ORG_OUTSIDE = 'dededede-0000-4000-8000-00000000000e';
const ID_MALFORMED_OUTSIDE = 'efefefef-0000-4000-8000-00000000000f';
const ID_UNDATED = '13131313-0000-4000-8000-000000000010';
const ID_PIN = '14141414-0000-4000-8000-000000000011';
const ID_CORRUPT = '15151515-0000-4000-8000-000000000012';
const ID_REPAIRED = '16161616-0000-4000-8000-000000000013';
const ID_ODD = '17171717-0000-4000-8000-000000000014';
const ID_GONE = '18181818-0000-4000-8000-000000000015';
const ID_LONG = '19191919-0000-4000-8000-000000000016';
const ID_LEGACY = '1a1a1a1a-0000-4000-8000-000000000017';
const ID_DENIED = '1b1b1b1b-0000-4000-8000-000000000018';
const ID_BLANK = '1c1c1c1c-0000-4000-8000-000000000019';
const ID_PINCAP = '1d1d1d1d-0000-4000-8000-00000000001a';
const ID_EIO = '1e1e1e1e-0000-4000-8000-00000000001b';
const ID_ESCAPED = '1f1f1f1f-0000-4000-8000-00000000001c';
const ID_FRACTION = '2a2a2a2a-0000-4000-8000-00000000001d';
const ID_LATE = '2b2b2b2b-0000-4000-8000-00000000001e';
const ID_FLAKY = '2c2c2c2c-0000-4000-8000-00000000001f';
const ID_KIT = '3a3a3a3a-0000-4000-8000-000000000020';
const ID_KIT_MCP = '3b3b3b3b-0000-4000-8000-000000000021';
const ID_KIT_ORG = '3c3c3c3c-0000-4000-8000-000000000022';
const ID_KIT_REVOKED = '3d3d3d3d-0000-4000-8000-000000000023';
const ID_KIT_OUTSIDE = '3e3e3e3e-0000-4000-8000-000000000024';
const ID_KIT_EDIT = '3f3f3f3f-0000-4000-8000-000000000025';
const UNREADABLE = {
  kind: 'failed_precondition',
  code: 'core.catalog.entryUnreadable',
};
const SAME_IDS = { serverId: SERVER, configId: CONFIG };
const OTHER_MCP = { serverId: OTHER_SERVER, configId: CONFIG };
const PAIR = [SAME_IDS, { ...SAME_IDS, owner: ORG_OWNER }];
const OWNER_UNKNOWN = {
  kind: 'failed_precondition',
  code: undefined,
  retry: { kind: 'never' },
};
const OWNER_UNKNOWN_MESSAGE =
  "This edit changes MCP server connections that can't be told apart here. Edit the collection in the app.";
const SHARE_HASH = 'a'.repeat(64);

const MEMBERS = {
  skills: [
    { sourceId: 'user', skillName: 'deploy' },
    { sourceId: 'user', skillName: 'ghost' },
  ],
  plugins: [{ marketplaceId: 'owner/tools', pluginName: 'linter' }],
  mcpServers: [{ serverId: SERVER, configId: CONFIG }],
};
const UNRESOLVED = [
  { kind: 'skill', sourceId: 'user', skillName: 'ghost' },
  { kind: 'mcp_server', serverId: SERVER, configId: CONFIG },
];

const inheritedDirs = {
  CANOPY_DATA_DIR: process.env.CANOPY_DATA_DIR,
  CANOPY_SECURE_DATA_DIR: process.env.CANOPY_SECURE_DATA_DIR,
};
let root = '';
const collectionsDir = (): string => join(root, 'data', 'collections');
const configPath = (id: string): string =>
  join(collectionsDir(), `collection-${id}.json`);
const preferencesPath = (): string => join(root, 'data', 'preferences.json');

function seedConfig(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    configPath(id),
    JSON.stringify({
      version: 2,
      collection: {
        id,
        name,
        description: `${name} collection`,
        skills: MEMBERS.skills,
        plugins: MEMBERS.plugins,
        mcpServers: [{ serverId: SERVER, configId: CONFIG, owner: ORG_OWNER }],
        createdAt: STAMP,
        updatedAt: STAMP,
        revision: `rev-${name}`,
        ...extra,
      },
    }),
  );
}

function storedCollection(id: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(configPath(id), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('collection' in parsed) ||
    typeof parsed.collection !== 'object' ||
    parsed.collection === null
  )
    throw new Error(`No stored collection ${id}`);
  return { ...parsed.collection };
}

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'collection-entries-golden',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants,
});

let dispatcher: DesktopCanopyDispatcher;
let keyCount = 0;
let preferencesBefore = '';

function get(id: string): Promise<unknown> {
  return dispatcher.query(
    'core.catalog.entry.get',
    { kind: 'collection', read: 'entry', entryId: collectionEntryId(id) },
    { caller: caller(['core.catalog.read']) },
  );
}

type UpsertRequest = {
  name: string;
  description?: string;
  members?: CatalogCollectionMembers;
  sharedRevision?: {
    remoteId: string;
    contentHash: string;
    fromPublicShare: boolean;
  } | null;
} & (
  | { entryId: null; expectedRevision: null }
  | { entryId: string; expectedRevision: string }
);

function upsert(
  request: UpsertRequest,
  options: {
    key?: string;
    grants?: CanopyCallerDescriptor['grants'];
  } = {},
): Promise<unknown> {
  const idempotencyKey = options.key ?? `collection-entries-${(keyCount += 1)}`;
  const base = {
    kind: 'collection' as const,
    name: request.name,
    description: request.description ?? '',
    members: request.members ?? { skills: [], plugins: [], mcpServers: [] },
    sharedRevision: request.sharedRevision ?? null,
    _meta: { idempotencyKey },
  };
  return dispatcher.instruction(
    'core.catalog.entry.upsert',
    request.entryId === null
      ? { ...base, entryId: null, expectedRevision: null }
      : {
          ...base,
          entryId: request.entryId,
          expectedRevision: request.expectedRevision,
        },
    {
      caller: caller(options.grants ?? ['core.catalog.write']),
      metadata: { idempotencyKey },
    },
  );
}

function remove(
  id: string,
  expectedRevision: string,
  key = `collection-delete-${(keyCount += 1)}`,
): Promise<unknown> {
  return dispatcher.instruction(
    'core.catalog.entry.delete',
    {
      kind: 'collection',
      entryId: collectionEntryId(id),
      expectedRevision,
      _meta: { idempotencyKey: key },
    },
    {
      caller: caller(['core.catalog.write']),
      metadata: { idempotencyKey: key },
    },
  );
}

function management(id: string): Promise<unknown> {
  return dispatcher.query(
    'core.catalog.entry.get',
    { kind: 'collection', read: 'management', entryId: collectionEntryId(id) },
    { caller: caller(['core.catalog.read']) },
  );
}

function removeCorrupt(
  id: string,
  expectedStoredBytesHash: string,
  key = `collection-delete-${(keyCount += 1)}`,
): Promise<unknown> {
  return dispatcher.instruction(
    'core.catalog.entry.delete',
    {
      kind: 'collection',
      entryId: collectionEntryId(id),
      expectedStoredBytesHash,
      _meta: { idempotencyKey: key },
    },
    {
      caller: caller(['core.catalog.write']),
      metadata: { idempotencyKey: key },
    },
  );
}

const bytesHash = (id: string): string =>
  createHash('sha256')
    .update(readFileSync(configPath(id)))
    .digest('hex');

async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    const { kind, code, details } = error.payload;
    return { kind, code, details };
  }
  throw new Error('expected a refusal');
}

async function refusalWithRetry(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    const { kind, code, retry } = error.payload;
    return { kind, code, retry };
  }
  throw new Error('expected a refusal');
}

/** Every entry in the collections directory, with a file's bytes. */
function collectionFiles(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(collectionsDir())
      .sort()
      .map((name) => {
        const path = join(collectionsDir(), name);
        return [
          name,
          statSync(path).isDirectory()
            ? 'directory'
            : readFileSync(path, 'utf8'),
        ];
      }),
  );
}

async function withResourceContext(work: () => Promise<void>): Promise<void> {
  mockContext.enabled = true;
  try {
    await work();
  } finally {
    mockContext.enabled = false;
    mockContext.refusedOrganization = null;
  }
}

/** Installs `id` from the share `remoteId`, as the signed-in account. */
async function recordInstall(
  id: string,
  remoteId: string,
  ownerContext:
    | { kind: 'personal' }
    | { kind: 'organization'; organizationId: string },
  extra: Record<string, unknown> = {},
): Promise<void> {
  seedConfig(id, id === ID_REVOKED ? 'Revoked' : 'Outside', {
    ...extra,
    sharedSource: {
      remoteId,
      fetchedAt: STAMP,
      fromPublicShare: false,
      contentHash: SHARE_HASH,
    },
  });
  const { createResourceInstallReceiptsStore } =
    await import('../lib/resource-install-receipts');
  await createResourceInstallReceiptsStore('account-1').record({
    family: 'collections',
    remoteId,
    localResourceIds: [id],
    shareScope:
      ownerContext.kind === 'organization' ? 'organization' : 'private',
    ownerContext,
    hash: SHARE_HASH,
    authorizedAt: STAMP,
  });
}

async function entryOf(id: string): Promise<Record<string, unknown>> {
  const read: unknown = await get(id);
  if (
    typeof read !== 'object' ||
    read === null ||
    !('entry' in read) ||
    typeof read.entry !== 'object' ||
    read.entry === null
  )
    throw new Error(`No entry for ${id}`);
  return { ...read.entry };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'collection-entries-'));
  process.env.CANOPY_DATA_DIR = join(root, 'data');
  process.env.CANOPY_SECURE_DATA_DIR = join(root, 'secure');
  mkdirSync(collectionsDir(), { recursive: true });
  seedConfig(ID_A, 'Alpha');
  seedConfig(ID_S, 'Shared', {
    sharedSource: {
      remoteId: 'remote-1',
      fetchedAt: STAMP,
      fromPublicShare: false,
      contentHash: SHARE_HASH,
    },
    remote: {
      remoteId: 'remote-2',
      contentHash: SHARE_HASH,
      shareScope: 'team',
      sharedAt: STAMP,
    },
  });
  // #10260's fault: config B is a folder (an I/O error) and the index is
  // damaged, so the index can't be rebuilt while B can't be read.
  mkdirSync(configPath(ID_B));
  writeFileSync(join(collectionsDir(), 'index.json'), '{ not json');
  const { updatePreferencesFile } = await import('../lib/preferences-store');
  await updatePreferencesFile((current) => ({
    ...current,
    globalPluginSelections: {
      collectionIds: [ID_A],
      skillRefs: [],
      pluginRefs: [],
    },
  }));
  preferencesBefore = readFileSync(preferencesPath(), 'utf8');
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
});

afterAll(async () => {
  await dispatcher.shutdown();
  for (const [name, value] of Object.entries(inheritedDirs)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('Local collections through core.catalog.entry (CAN-4170)', () => {
  it('reads a collection with its revision, members and the members nothing installed answers', async () => {
    expect(await get(ID_A)).toEqual({
      read: 'entry',
      entry: {
        kind: 'collection',
        entryId: collectionEntryId(ID_A),
        revision: 'rev-Alpha',
        name: 'Alpha',
        description: 'Alpha collection',
        members: MEMBERS,
        createdAt: STAMP,
        updatedAt: STAMP,
        sharedSource: null,
        share: null,
        unresolvedMembers: UNRESOLVED,
      },
    });
  });

  it('reads where an added collection came from and its own share link', async () => {
    const entry = await entryOf(ID_S);
    expect({
      sharedSource: entry.sharedSource,
      share: entry.share,
    }).toEqual({
      sharedSource: {
        remoteId: 'remote-1',
        contentHash: SHARE_HASH,
        fromPublicShare: false,
        fetchedAt: STAMP,
      },
      share: {
        remoteId: 'remote-2',
        contentHash: SHARE_HASH,
        shareScope: 'team',
        sharedAt: STAMP,
      },
    });
  });

  it('answers a collection the store does not have as not found', async () => {
    expect(await refusal(get(ID_NONE))).toEqual({
      kind: 'not_found',
      code: 'core.catalog.entryNotFound',
      details: undefined,
    });
  });

  it('answers a collection that cannot be read as unreadable, never as not found, while the index cannot be read', async () => {
    expect(await refusal(get(ID_B))).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.catalog.entryUnreadable',
    });
    const listed = await refusal(
      dispatcher.query(
        'core.catalog.snapshot.get',
        { scope: {}, kinds: ['collection'], includeUnavailable: true },
        { caller: caller(['core.catalog.read']) },
      ),
    );
    expect(listed).toMatchObject({ kind: 'unavailable' });
  });

  it('creates a collection with a trimmed name, keeping the members nothing installed answers', async () => {
    const created: unknown = await upsert({
      entryId: null,
      expectedRevision: null,
      name: '  Gamma  ',
      description: 'New',
      members: MEMBERS,
    });
    if (
      typeof created !== 'object' ||
      created === null ||
      !('entry' in created) ||
      typeof created.entry !== 'object' ||
      created.entry === null ||
      !('entryId' in created.entry) ||
      typeof created.entry.entryId !== 'string'
    )
      throw new Error('No created entry');
    expect(created.entry).toMatchObject({
      kind: 'collection',
      name: 'Gamma',
      description: 'New',
      members: MEMBERS,
      sharedSource: null,
      share: null,
      unresolvedMembers: UNRESOLVED,
    });
    const id = created.entry.entryId.slice('collection:'.length);
    expect(await get(id)).toEqual({ read: 'entry', entry: created.entry });
  });

  it('replaces a collection at the revision read, keeping its provenance, share link and member owners', async () => {
    const before = await entryOf(ID_S);
    const replaced: unknown = await upsert({
      entryId: collectionEntryId(ID_S),
      expectedRevision: 'rev-Shared',
      name: 'Shared renamed',
      members: MEMBERS,
    });
    expect(replaced).toMatchObject({
      entry: {
        name: 'Shared renamed',
        sharedSource: before.sharedSource,
        share: before.share,
        createdAt: STAMP,
      },
    });
    const stored = storedCollection(ID_S);
    expect({
      revisionChanged: stored.revision !== 'rev-Shared',
      mcpServers: stored.mcpServers,
    }).toEqual({
      revisionChanged: true,
      mcpServers: [{ serverId: SERVER, configId: CONFIG, owner: ORG_OWNER }],
    });
  });

  it('reads and replaces a collection with no stored date, leaving it undated (CAN-5239)', async () => {
    // A legacy config without createdAt: JSON drops the undefined field.
    seedConfig(ID_UNDATED, 'Undated', { createdAt: undefined });
    const read = await entryOf(ID_UNDATED);
    expect({ read: 'createdAt' in read, revision: read.revision }).toEqual({
      read: false,
      revision: 'rev-Undated',
    });
    const replaced: unknown = await upsert({
      entryId: collectionEntryId(ID_UNDATED),
      expectedRevision: 'rev-Undated',
      name: 'Undated renamed',
      members: MEMBERS,
    });
    if (
      typeof replaced !== 'object' ||
      replaced === null ||
      !('entry' in replaced) ||
      typeof replaced.entry !== 'object' ||
      replaced.entry === null
    )
      throw new Error('No replaced entry');
    const written: Record<string, unknown> = { ...replaced.entry };
    const stored = storedCollection(ID_UNDATED);
    expect({
      written: 'createdAt' in written,
      name: written.name,
      stored: 'createdAt' in stored,
      revisionChanged: stored.revision !== 'rev-Undated',
    }).toEqual({
      written: false,
      name: 'Undated renamed',
      stored: false,
      revisionChanged: true,
    });
    expect(await get(ID_UNDATED)).toEqual({ read: 'entry', entry: written });
  });

  it('drops a removed MCP member with its owner, and gives an added one none', async () => {
    const current = await entryOf(ID_S);
    if (typeof current.revision !== 'string') throw new Error('No revision');
    await upsert({
      entryId: collectionEntryId(ID_S),
      expectedRevision: current.revision,
      name: 'Shared renamed',
      members: {
        ...MEMBERS,
        mcpServers: [{ serverId: OTHER_SERVER, configId: CONFIG }],
      },
    });
    expect(storedCollection(ID_S).mcpServers).toEqual([
      { serverId: OTHER_SERVER, configId: CONFIG },
    ]);
  });

  it('keeps a personal and an organization MCP member with the same ids, owners included, through a replace that leaves them', async () => {
    seedConfig(ID_PAIR, 'Pair', { mcpServers: PAIR });
    const before = readFileSync(configPath(ID_PAIR), 'utf8');
    const read = await entryOf(ID_PAIR);
    const members = { ...MEMBERS, mcpServers: [SAME_IDS, SAME_IDS] };
    expect(read.members).toEqual(members);
    await upsert({
      entryId: collectionEntryId(ID_PAIR),
      expectedRevision: 'rev-Pair',
      name: 'Pair',
      description: 'Pair collection',
      members,
    });
    const after = readFileSync(configPath(ID_PAIR), 'utf8');
    expect(after).not.toBe(before);
    expect(JSON.stringify(storedCollection(ID_PAIR).mcpServers)).toBe(
      JSON.stringify(PAIR),
    );
  });

  it('refuses an edit that removes or adds one of several MCP members with the same ids, writing nothing', async () => {
    seedConfig(ID_PAIR, 'Pair', { mcpServers: PAIR });
    const before = readFileSync(configPath(ID_PAIR), 'utf8');
    const edit = (
      mcpServers: CatalogCollectionMembers['mcpServers'],
    ): Promise<unknown> =>
      refusalWithRetry(
        upsert({
          entryId: collectionEntryId(ID_PAIR),
          expectedRevision: 'rev-Pair',
          name: 'Pair',
          members: { ...MEMBERS, mcpServers },
        }),
      );
    expect({
      removed: await edit([SAME_IDS]),
      added: await edit([SAME_IDS, SAME_IDS, SAME_IDS]),
    }).toEqual({ removed: OWNER_UNKNOWN, added: OWNER_UNKNOWN });
    expect(readFileSync(configPath(ID_PAIR), 'utf8')).toBe(before);
  });

  it('refuses adding an MCP member with the ids of an organization member, writing nothing', async () => {
    seedConfig(ID_ORG, 'Org');
    const before = readFileSync(configPath(ID_ORG), 'utf8');
    const added = upsert({
      entryId: collectionEntryId(ID_ORG),
      expectedRevision: 'rev-Org',
      name: 'Org',
      members: { ...MEMBERS, mcpServers: [SAME_IDS, SAME_IDS] },
    });
    await expect(added).rejects.toThrow(OWNER_UNKNOWN_MESSAGE);
    expect(await refusalWithRetry(added)).toEqual(OWNER_UNKNOWN);
    expect(readFileSync(configPath(ID_ORG), 'utf8')).toBe(before);
  });

  it('keeps both owners of a same-id pair when an edit changes the members beside it', async () => {
    seedConfig(ID_PAIR, 'Pair', { mcpServers: PAIR });
    await upsert({
      entryId: collectionEntryId(ID_PAIR),
      expectedRevision: 'rev-Pair',
      name: 'Pair renamed',
      members: {
        skills: [],
        plugins: MEMBERS.plugins,
        mcpServers: [SAME_IDS, OTHER_MCP, SAME_IDS],
      },
    });
    expect(storedCollection(ID_PAIR)).toMatchObject({
      name: 'Pair renamed',
      skills: [],
      mcpServers: [SAME_IDS, OTHER_MCP, { ...SAME_IDS, owner: ORG_OWNER }],
    });
  });

  it('drops every MCP member with the same ids when an edit removes them all', async () => {
    seedConfig(ID_PAIR, 'Pair', { mcpServers: PAIR });
    await upsert({
      entryId: collectionEntryId(ID_PAIR),
      expectedRevision: 'rev-Pair',
      name: 'Pair',
      members: { ...MEMBERS, mcpServers: [OTHER_MCP] },
    });
    expect(storedCollection(ID_PAIR).mcpServers).toEqual([OTHER_MCP]);
  });

  it('refuses a replace at another revision and writes nothing', async () => {
    const before = readFileSync(configPath(ID_A), 'utf8');
    expect(
      await refusal(
        upsert({
          entryId: collectionEntryId(ID_A),
          expectedRevision: 'rev-stale',
          name: 'Alpha changed',
        }),
      ),
    ).toEqual({
      kind: 'conflict',
      code: 'core.catalog.revisionConflict',
      details: { currentRevision: 'rev-Alpha' },
    });
    expect(readFileSync(configPath(ID_A), 'utf8')).toBe(before);
  });

  it('refuses to replace a collection that cannot be read, or one the store does not have', async () => {
    expect({
      unreadable: await refusal(
        upsert({
          entryId: collectionEntryId(ID_B),
          expectedRevision: 'rev-B',
          name: 'Beta',
        }),
      ),
      missing: await refusal(
        upsert({
          entryId: collectionEntryId(ID_NONE),
          expectedRevision: 'rev-none',
          name: 'None',
        }),
      ),
    }).toMatchObject({
      unreadable: {
        kind: 'failed_precondition',
        code: 'core.catalog.entryUnreadable',
      },
      missing: { kind: 'not_found', code: 'core.catalog.entryNotFound' },
    });
    expect(statSync(configPath(ID_B)).isDirectory()).toBe(true);
  });

  it('answers a replayed upsert from its first outcome and refuses its key with other params', async () => {
    const params = {
      entryId: null,
      expectedRevision: null,
      name: 'Replayed',
    };
    const first = await upsert(params, { key: 'replayed-key' });
    expect(await upsert(params, { key: 'replayed-key' })).toEqual(first);
    expect(
      await refusal(
        upsert({ ...params, name: 'Other' }, { key: 'replayed-key' }),
      ),
    ).toMatchObject({ kind: 'conflict' });
  });

  // The ledger records an outcome of up to 32,768 characters (CAN-5898); with
  // 16-character skill names, 263 members fit the worst-case entry, share
  // account pin included, 264 don't.
  it('saves a collection just under the ledger cap and refuses one just over it, writing nothing', async () => {
    const skills = (count: number): CatalogCollectionMembers['skills'] =>
      Array.from({ length: count }, (_, index) => ({
        sourceId: 'user',
        skillName: `skill-${String(index).padStart(4, '0')}`.padEnd(16, 'x'),
      }));
    const capped = (count: number): Promise<unknown> =>
      upsert({
        entryId: null,
        expectedRevision: null,
        name: 'Cap',
        members: { skills: skills(count), plugins: [], mcpServers: [] },
      });
    const before = readdirSync(collectionsDir()).sort();
    expect(await refusal(capped(264))).toMatchObject({
      kind: 'resource_exhausted',
    });
    expect(readdirSync(collectionsDir()).sort()).toEqual(before);
    const saved: unknown = await capped(263);
    expect(saved).toMatchObject({
      entry: { name: 'Cap', members: { skills: skills(263) } },
    });
    const added = readdirSync(collectionsDir()).filter(
      (name) => !before.includes(name),
    );
    expect(added).toHaveLength(1);
    const [file] = added;
    const id = file?.slice('collection-'.length, -'.json'.length) ?? '';
    expect(storedCollection(id)).toMatchObject({
      name: 'Cap',
      skills: skills(263),
    });
  });

  it('refuses an upsert when the installed catalog cannot be read, writing nothing, and its key then writes once', async () => {
    const service = await import('../services/plugin-catalog-service');
    const before = collectionFiles();
    const current = await entryOf(ID_S);
    if (typeof current.revision !== 'string') throw new Error('No revision');
    const create = {
      entryId: null,
      expectedRevision: null,
      name: 'Pending',
    } as const;
    const failing = jest
      .spyOn(service, 'buildCachedPluginCatalog')
      .mockRejectedValue(new Error('catalog read failed'));
    try {
      expect({
        create: await refusalWithRetry(
          upsert(create, { key: 'installed-unreadable' }),
        ),
        replace: await refusalWithRetry(
          upsert({
            entryId: collectionEntryId(ID_S),
            expectedRevision: current.revision,
            name: 'Shared pending',
          }),
        ),
      }).toEqual({
        create: {
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        },
        replace: {
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        },
      });
    } finally {
      failing.mockRestore();
    }
    expect(collectionFiles()).toEqual(before);
    expect((await entryOf(ID_S)).revision).toBe(current.revision);
    // A refusal the key had recorded would replay here; this one runs.
    const created: unknown = await upsert(create, {
      key: 'installed-unreadable',
    });
    if (
      typeof created !== 'object' ||
      created === null ||
      !('entry' in created) ||
      typeof created.entry !== 'object' ||
      created.entry === null ||
      !('entryId' in created.entry) ||
      typeof created.entry.entryId !== 'string' ||
      !('revision' in created.entry) ||
      typeof created.entry.revision !== 'string'
    )
      throw new Error('The retry answered no entry');
    const id = created.entry.entryId.slice('collection:'.length);
    expect(
      Object.keys(collectionFiles()).filter(
        (name) => name.startsWith('collection-') && !(name in before),
      ),
    ).toEqual([`collection-${id}.json`]);
    expect(storedCollection(id)).toMatchObject({
      name: 'Pending',
      revision: created.entry.revision,
    });
    expect(await upsert(create, { key: 'installed-unreadable' })).toEqual(
      created,
    );
    expect(
      Object.keys(collectionFiles()).filter(
        (name) => name.startsWith('collection-') && !(name in before),
      ),
    ).toEqual([`collection-${id}.json`]);
  });

  it('refuses an upsert from a caller without the catalog write grant', async () => {
    expect(
      await refusal(
        upsert(
          { entryId: null, expectedRevision: null, name: 'Denied' },
          { grants: ['core.catalog.read'] },
        ),
      ),
    ).toMatchObject({ kind: 'permission_denied' });
  });

  it('leaves shared updates for a later PR, and answers import readiness', async () => {
    const unavailable = { kind: 'capability_unavailable' };
    expect({
      sharedRevision: await refusal(
        upsert({
          entryId: collectionEntryId(ID_S),
          expectedRevision: 'any',
          name: 'Shared',
          sharedRevision: {
            remoteId: 'remote-1',
            contentHash: SHARE_HASH,
            fromPublicShare: false,
          },
        }),
      ),
    }).toMatchObject({
      sharedRevision: unavailable,
    });
    // PR 4b-1 ends the import readiness refusal this test pinned: the read
    // now answers the share's hash, package and requirements.
    mockCapability.check = (): Promise<void> => Promise.resolve();
    try {
      expect(
        await dispatcher.query(
          'core.catalog.entry.get',
          {
            kind: 'collection',
            read: 'importReadiness',
            remoteId: 'remote-outside',
            fromPublicShare: false,
          },
          { caller: caller(['core.catalog.read']) },
        ),
      ).toEqual({
        read: 'importReadiness',
        readiness: {
          remoteId: 'remote-outside',
          contentHash: 'a'.repeat(64),
          package: null,
          requirements: [],
        },
      });
    } finally {
      mockCapability.check = null;
    }
    expect(storedCollection(ID_A).revision).toBe('rev-Alpha');
  });

  it('refuses a guarded store delete at another revision or of a missing collection, deleting nothing', async () => {
    seedConfig(ID_X, 'Guarded');
    const store = await import('../collections/collection-store');
    const codeOf = async (call: Promise<void>): Promise<unknown> =>
      call.then(
        () => 'deleted',
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : error,
      );
    expect({
      stale: await codeOf(
        store.deleteCollectionConfig(ID_X, { expectedRevision: 'rev-stale' }),
      ),
      missing: await codeOf(
        store.deleteCollectionConfig(ID_NONE, { expectedRevision: 'rev-any' }),
      ),
    }).toEqual({ stale: 'conflict', missing: 'not_found' });
    expect(existsSync(configPath(ID_X))).toBe(true);
  });

  it('deletes without a guard as before, a missing collection included', async () => {
    const store = await import('../collections/collection-store');
    await expect(store.deleteCollectionConfig(ID_X)).resolves.toBeUndefined();
    await expect(
      store.deleteCollectionConfig(ID_NONE),
    ).resolves.toBeUndefined();
    expect(existsSync(configPath(ID_X))).toBe(false);
  });

  it('deletes a collection at the revision read, and answers a replay from its first outcome', async () => {
    const deleted = {
      kind: 'collection',
      entryId: collectionEntryId(ID_A),
      deleted: true,
    };
    expect(await remove(ID_A, 'rev-Alpha', 'delete-alpha')).toEqual(deleted);
    expect(await remove(ID_A, 'rev-Alpha', 'delete-alpha')).toEqual(deleted);
    expect({
      file: existsSync(configPath(ID_A)),
      read: await refusal(get(ID_A)),
    }).toEqual({
      file: false,
      read: {
        kind: 'not_found',
        code: 'core.catalog.entryNotFound',
        details: undefined,
      },
    });
  });

  it('refuses a delete at another revision, of a missing collection or of one that cannot be read', async () => {
    const current = await entryOf(ID_S);
    expect({
      stale: await refusal(remove(ID_S, 'rev-stale')),
      missing: await refusal(remove(ID_NONE, 'rev-any')),
      unreadable: await refusal(remove(ID_B, 'rev-any')),
    }).toEqual({
      stale: {
        kind: 'conflict',
        code: 'core.catalog.revisionConflict',
        details: { currentRevision: current.revision },
      },
      missing: {
        kind: 'not_found',
        code: 'core.catalog.entryNotFound',
        details: undefined,
      },
      unreadable: {
        kind: 'failed_precondition',
        code: 'core.catalog.entryUnreadable',
        details: undefined,
      },
    });
    expect({
      shared: existsSync(configPath(ID_S)),
      unreadable: statSync(configPath(ID_B)).isDirectory(),
    }).toEqual({ shared: true, unreadable: true });
  });

  it('reads and writes collections while another listed collection cannot be read', async () => {
    const service = await import('../services/plugin-catalog-service');
    const catalog = service.buildCachedPluginCatalog;
    const listed = jest
      .spyOn(service, 'buildCachedPluginCatalog')
      .mockImplementation(async () => ({
        ...(await catalog()),
        collections: [
          {
            id: ID_B,
            name: 'Beta',
            description: '',
            skillCount: 0,
            pluginCount: 0,
            mcpServerCount: 0,
          },
        ],
      }));
    try {
      const created: unknown = await upsert({
        entryId: null,
        expectedRevision: null,
        name: 'Beside an unreadable one',
        members: MEMBERS,
      });
      expect(created).toMatchObject({
        entry: {
          name: 'Beside an unreadable one',
          unresolvedMembers: UNRESOLVED,
        },
      });
      if (
        typeof created !== 'object' ||
        created === null ||
        !('entry' in created) ||
        typeof created.entry !== 'object' ||
        created.entry === null ||
        !('entryId' in created.entry) ||
        typeof created.entry.entryId !== 'string'
      )
        throw new Error('The create answered no entry');
      expect(
        await get(created.entry.entryId.slice('collection:'.length)),
      ).toEqual({ read: 'entry', entry: created.entry });
      expect(await get(ID_S)).toMatchObject({ read: 'entry' });
    } finally {
      listed.mockRestore();
    }
    expect(statSync(configPath(ID_B)).isDirectory()).toBe(true);
  });

  it('never answers or replaces a stored collection whose members the contract refuses, and still removes it', async () => {
    seedConfig(ID_MALFORMED, 'Malformed', { skills: {} });
    const before = readFileSync(configPath(ID_MALFORMED), 'utf8');
    expect({
      read: await refusal(get(ID_MALFORMED)),
      replace: await refusal(
        upsert({
          entryId: collectionEntryId(ID_MALFORMED),
          expectedRevision: 'rev-Malformed',
          name: 'Malformed renamed',
        }),
      ),
    }).toMatchObject({ read: UNREADABLE, replace: UNREADABLE });
    expect(readFileSync(configPath(ID_MALFORMED), 'utf8')).toBe(before);
    expect(await remove(ID_MALFORMED, 'rev-Malformed')).toEqual({
      kind: 'collection',
      entryId: collectionEntryId(ID_MALFORMED),
      deleted: true,
    });
    expect(existsSync(configPath(ID_MALFORMED))).toBe(false);
  });

  it('refuses to delete a stored collection whose members the contract refuses outside the context', async () => {
    await recordInstall(
      ID_MALFORMED_OUTSIDE,
      'remote-malformed-outside',
      { kind: 'organization', organizationId: ORG_OUTSIDE },
      { skills: {} },
    );
    const before = readFileSync(configPath(ID_MALFORMED_OUTSIDE), 'utf8');
    await withResourceContext(async () => {
      mockContext.refusedOrganization = ORG_OUTSIDE;
      expect(
        await refusal(remove(ID_MALFORMED_OUTSIDE, 'rev-Outside')),
      ).toMatchObject(UNREADABLE);
    });
    expect(readFileSync(configPath(ID_MALFORMED_OUTSIDE), 'utf8')).toBe(before);
  });

  it('deletes an installed collection whose share was revoked, which reads and replaces still refuse', async () => {
    await recordInstall(ID_REVOKED, 'remote-revoked', { kind: 'personal' });
    const before = readFileSync(configPath(ID_REVOKED), 'utf8');
    await withResourceContext(async () => {
      expect({
        read: await refusal(get(ID_REVOKED)),
        replace: await refusal(
          upsert({
            entryId: collectionEntryId(ID_REVOKED),
            expectedRevision: 'rev-Revoked',
            name: 'Revoked renamed',
          }),
        ),
      }).toMatchObject({ read: UNREADABLE, replace: UNREADABLE });
      expect(readFileSync(configPath(ID_REVOKED), 'utf8')).toBe(before);
      expect(await remove(ID_REVOKED, 'rev-Revoked')).toEqual({
        kind: 'collection',
        entryId: collectionEntryId(ID_REVOKED),
        deleted: true,
      });
    });
    expect(existsSync(configPath(ID_REVOKED))).toBe(false);
  });

  it('refuses to read, replace or delete a collection outside the context, writing nothing', async () => {
    await recordInstall(ID_OUTSIDE, 'remote-outside', {
      kind: 'organization',
      organizationId: ORG_OUTSIDE,
    });
    const before = readFileSync(configPath(ID_OUTSIDE), 'utf8');
    await withResourceContext(async () => {
      mockContext.refusedOrganization = ORG_OUTSIDE;
      expect({
        read: await refusal(get(ID_OUTSIDE)),
        replace: await refusal(
          upsert({
            entryId: collectionEntryId(ID_OUTSIDE),
            expectedRevision: 'rev-Outside',
            name: 'Outside renamed',
          }),
        ),
        delete: await refusal(remove(ID_OUTSIDE, 'rev-Outside')),
        management: await refusal(management(ID_OUTSIDE)),
      }).toMatchObject({
        read: UNREADABLE,
        replace: UNREADABLE,
        delete: UNREADABLE,
        management: UNREADABLE,
      });
    });
    expect(readFileSync(configPath(ID_OUTSIDE), 'utf8')).toBe(before);
  });

  it('reads the account a share was made under as stored, whoever is signed in, and acts on none of it yet', async () => {
    seedConfig(ID_PIN, 'Pinned', {
      remote: {
        accountId: 'account-other',
        remoteId: 'remote-pin',
        contentHash: SHARE_HASH,
        shareScope: 'private',
        sharedAt: STAMP,
      },
    });
    const pinned = {
      remoteId: 'remote-pin',
      contentHash: SHARE_HASH,
      shareScope: 'private',
      sharedAt: STAMP,
      accountId: 'account-other',
    };
    // Signed out, then signed in as account-1: the pin is answered as stored.
    expect((await entryOf(ID_PIN)).share).toEqual(pinned);
    const before = collectionFiles();
    await withResourceContext(async () => {
      expect((await entryOf(ID_PIN)).share).toEqual(pinned);
      const key = `collection-publish-${(keyCount += 1)}`;
      expect(
        await refusal(
          dispatcher.instruction(
            'core.catalog.entry.publish',
            {
              kind: 'collection',
              mode: 'update',
              publicationId: 'remote-pin',
              sourceEntryId: collectionEntryId(ID_PIN),
              expectedAccountId: 'account-1',
              document: {
                rawCollection:
                  '{"version":1,"name":"Pinned","description":"","items":[]}',
              },
              _meta: { idempotencyKey: key },
            },
            {
              caller: caller(['core.catalog.write']),
              metadata: { idempotencyKey: key },
            },
          ),
        ),
      ).toMatchObject({ kind: 'capability_unavailable' });
    });
    expect(collectionFiles()).toEqual(before);
  });

  it('answers what a delete needs for a collection the contract cannot carry or whose share was revoked, and deletes it at that revision', async () => {
    seedConfig(ID_ODD, 'Odd', { skills: {} });
    expect(await management(ID_ODD)).toEqual({
      read: 'management',
      entryId: collectionEntryId(ID_ODD),
      revision: 'rev-Odd',
    });
    expect(await remove(ID_ODD, 'rev-Odd')).toMatchObject({ deleted: true });
    await recordInstall(ID_GONE, 'remote-gone', { kind: 'personal' });
    await withResourceContext(async () => {
      expect(await refusal(get(ID_GONE))).toMatchObject(UNREADABLE);
      expect(await management(ID_GONE)).toEqual({
        read: 'management',
        entryId: collectionEntryId(ID_GONE),
        revision: 'rev-Outside',
      });
      expect(await remove(ID_GONE, 'rev-Outside')).toMatchObject({
        deleted: true,
      });
    });
    expect({
      odd: existsSync(configPath(ID_ODD)),
      gone: existsSync(configPath(ID_GONE)),
    }).toEqual({ odd: false, gone: false });
    expect(await refusal(management(ID_NONE))).toMatchObject({
      kind: 'not_found',
      code: 'core.catalog.entryNotFound',
    });
  });

  it('deletes a collection whose stored configuration cannot be parsed only at the hash of its bytes, which nothing else takes', async () => {
    writeFileSync(configPath(ID_CORRUPT), '{ "version": 2, "collection": ');
    const hash = bytesHash(ID_CORRUPT);
    const before = readFileSync(configPath(ID_CORRUPT), 'utf8');
    expect({
      entry: await refusal(get(ID_CORRUPT)),
      management: await management(ID_CORRUPT),
      replace: await refusal(
        upsert({
          entryId: collectionEntryId(ID_CORRUPT),
          expectedRevision: hash,
          name: 'Corrupt renamed',
        }),
      ),
      deleteAtHashAsRevision: await refusal(remove(ID_CORRUPT, hash)),
      deleteAtOtherBytes: await refusal(
        removeCorrupt(ID_CORRUPT, 'b'.repeat(64)),
      ),
    }).toEqual({
      entry: { ...UNREADABLE, details: undefined },
      management: {
        read: 'management',
        entryId: collectionEntryId(ID_CORRUPT),
        storedBytesHash: hash,
      },
      replace: { ...UNREADABLE, details: undefined },
      deleteAtHashAsRevision: { ...UNREADABLE, details: undefined },
      deleteAtOtherBytes: {
        kind: 'conflict',
        code: 'core.catalog.revisionConflict',
        details: undefined,
      },
    });
    expect(readFileSync(configPath(ID_CORRUPT), 'utf8')).toBe(before);
    // With resource contexts on, every delete reads the local snapshot first,
    // which these bytes fail; this one is refused as the others are.
    await withResourceContext(async () => {
      expect({
        atHash: await refusal(removeCorrupt(ID_CORRUPT, hash)),
        atOtherBytes: await refusal(removeCorrupt(ID_CORRUPT, 'b'.repeat(64))),
      }).toMatchObject({ atHash: UNREADABLE, atOtherBytes: UNREADABLE });
    });
    expect(readFileSync(configPath(ID_CORRUPT), 'utf8')).toBe(before);
    const key = `collection-delete-${(keyCount += 1)}`;
    const deleted = {
      kind: 'collection',
      entryId: collectionEntryId(ID_CORRUPT),
      deleted: true,
    };
    expect(await removeCorrupt(ID_CORRUPT, hash, key)).toEqual(deleted);
    expect(existsSync(configPath(ID_CORRUPT))).toBe(false);
    expect(await removeCorrupt(ID_CORRUPT, hash, key)).toEqual(deleted);
  });

  it('refuses a hash delete once the collection can be read again, answering its revision, and reads a folder in its place as unreadable', async () => {
    writeFileSync(configPath(ID_REPAIRED), '{ not json');
    const hash = bytesHash(ID_REPAIRED);
    seedConfig(ID_REPAIRED, 'Repaired');
    expect(await refusal(removeCorrupt(ID_REPAIRED, hash))).toEqual({
      kind: 'conflict',
      code: 'core.catalog.revisionConflict',
      details: { currentRevision: 'rev-Repaired' },
    });
    expect(storedCollection(ID_REPAIRED).revision).toBe('rev-Repaired');
    expect({
      management: await refusal(management(ID_B)),
      delete: await refusal(removeCorrupt(ID_B, 'b'.repeat(64))),
    }).toEqual({
      management: { ...UNREADABLE, details: undefined },
      delete: { ...UNREADABLE, details: undefined },
    });
    expect(statSync(configPath(ID_B)).isDirectory()).toBe(true);
  });

  it('answers a collection whose stored revision the contract cannot carry by its stored bytes hash, and deletes it there', async () => {
    seedConfig(ID_LONG, 'Long', { revision: 'r'.repeat(257) });
    const hash = bytesHash(ID_LONG);
    expect(await management(ID_LONG)).toEqual({
      read: 'management',
      entryId: collectionEntryId(ID_LONG),
      storedBytesHash: hash,
    });
    expect(await removeCorrupt(ID_LONG, hash)).toMatchObject({ deleted: true });
    expect(existsSync(configPath(ID_LONG))).toBe(false);
  });

  it('answers no stored bytes hash with resource contexts on, even for a shared collection whose authorization fails', async () => {
    // No install receipt, a share the hosted service refuses, and a revision
    // the contract cannot carry.
    seedConfig(ID_DENIED, 'Denied', {
      revision: 'r'.repeat(257),
      sharedSource: {
        remoteId: 'remote-denied',
        fetchedAt: STAMP,
        fromPublicShare: false,
        contentHash: SHARE_HASH,
      },
    });
    const before = readFileSync(configPath(ID_DENIED), 'utf8');
    await withResourceContext(async () => {
      expect({
        management: await refusal(management(ID_DENIED)),
        delete: await refusal(removeCorrupt(ID_DENIED, bytesHash(ID_DENIED))),
      }).toEqual({
        management: { ...UNREADABLE, details: undefined },
        delete: { ...UNREADABLE, details: undefined },
      });
    });
    expect(readFileSync(configPath(ID_DENIED), 'utf8')).toBe(before);
  });

  it('reads a whitespace-only revision as a revision, so the hash delete keeps the config and answers it', async () => {
    seedConfig(ID_BLANK, 'Blank', { revision: '   ' });
    const hash = bytesHash(ID_BLANK);
    expect({
      management: await management(ID_BLANK),
      delete: await refusal(removeCorrupt(ID_BLANK, hash)),
    }).toEqual({
      management: {
        read: 'management',
        entryId: collectionEntryId(ID_BLANK),
        revision: '   ',
      },
      delete: {
        kind: 'conflict',
        code: 'core.catalog.revisionConflict',
        details: { currentRevision: '   ' },
      },
    });
    expect(existsSync(configPath(ID_BLANK))).toBe(true);
  });

  it('refuses a replace whose answer, with the share account pin, would be too large to record, writing nothing', async () => {
    const skills = Array.from({ length: 268 }, (_, index) => ({
      sourceId: 'user',
      skillName: `skill-${String(index).padStart(4, '0')}`.padEnd(16, 'x'),
    }));
    seedConfig(ID_PINCAP, 'PinCap', {
      skills,
      plugins: [],
      mcpServers: [],
      revision: 'r'.repeat(256),
      sharedSource: {
        remoteId: 'A'.repeat(128),
        fetchedAt: STAMP,
        fromPublicShare: false,
        contentHash: 'c'.repeat(128),
      },
      remote: {
        remoteId: 'B'.repeat(128),
        contentHash: 'd'.repeat(128),
        shareScope: 'organization',
        sharedAt: STAMP,
        accountId: 'a'.repeat(512),
      },
    });
    const before = readFileSync(configPath(ID_PINCAP), 'utf8');
    expect(
      await refusal(
        upsert({
          entryId: collectionEntryId(ID_PINCAP),
          expectedRevision: 'r'.repeat(256),
          name: 'PinCap',
          members: { skills, plugins: [], mcpServers: [] },
        }),
      ),
    ).toMatchObject({ kind: 'resource_exhausted' });
    expect(readFileSync(configPath(ID_PINCAP), 'utf8')).toBe(before);
  });

  it('sizes a replace by the share it keeps as stored, refusing one whose answer could not be recorded under every retry, writing nothing', async () => {
    const skills = Array.from({ length: 263 }, (_, index) => ({
      sourceId: 'user',
      skillName: `skill-${String(index).padStart(4, '0')}`.padEnd(16, 'x'),
    }));
    // Within the bound in ASCII; JSON writes each control character as six,
    // and the fraction has no length limit.
    const shares = [
      {
        id: ID_ESCAPED,
        name: 'Escaped',
        share: { accountId: '\u0001'.repeat(512) },
      },
      {
        id: ID_FRACTION,
        name: 'Fraction',
        share: { sharedAt: `2026-11-01T00:00:00.${'1'.repeat(3000)}Z` },
      },
    ];
    for (const { id, name, share } of shares) {
      seedConfig(id, name, {
        skills,
        plugins: [],
        mcpServers: [],
        remote: {
          remoteId: 'remote-wide',
          contentHash: SHARE_HASH,
          shareScope: 'organization',
          sharedAt: STAMP,
          ...share,
        },
      });
      const before = readFileSync(configPath(id), 'utf8');
      const replace = (): Promise<unknown> =>
        upsert(
          {
            entryId: collectionEntryId(id),
            expectedRevision: `rev-${name}`,
            name,
            members: { skills, plugins: [], mcpServers: [] },
          },
          { key: `oversized-${name}` },
        );
      expect([await refusal(replace()), await refusal(replace())]).toEqual([
        expect.objectContaining({ kind: 'resource_exhausted' }),
        expect.objectContaining({ kind: 'resource_exhausted' }),
      ]);
      expect(readFileSync(configPath(id), 'utf8')).toBe(before);
    }
  });

  it('refuses an oversized replace whose first read meets a disk error, writing nothing under any retry', async () => {
    const skills = Array.from({ length: 263 }, (_, index) => ({
      sourceId: 'user',
      skillName: `skill-${String(index).padStart(4, '0')}`.padEnd(16, 'x'),
    }));
    seedConfig(ID_FLAKY, 'Flaky', {
      skills,
      plugins: [],
      mcpServers: [],
      remote: {
        remoteId: 'remote-wide',
        contentHash: SHARE_HASH,
        shareScope: 'organization',
        sharedAt: STAMP,
        accountId: '\u0001'.repeat(512),
      },
    });
    const before = readFileSync(configPath(ID_FLAKY), 'utf8');
    const replace = (): Promise<unknown> =>
      upsert(
        {
          entryId: collectionEntryId(ID_FLAKY),
          expectedRevision: 'rev-Flaky',
          name: 'Flaky',
          members: { skills, plugins: [], mcpServers: [] },
        },
        { key: 'oversized-flaky' },
      );
    mockReadFault.nextText = configPath(ID_FLAKY);
    expect([await refusal(replace()), await refusal(replace())]).toEqual([
      expect.objectContaining({ kind: 'resource_exhausted' }),
      expect.objectContaining({ kind: 'resource_exhausted' }),
    ]);
    expect(mockReadFault.nextText).toBeNull();
    expect(readFileSync(configPath(ID_FLAKY), 'utf8')).toBe(before);
  });

  it('records a replace of a missing collection under its key, so a retry replays not found after the collection appears', async () => {
    const replace = (): Promise<unknown> =>
      upsert(
        {
          entryId: collectionEntryId(ID_LATE),
          expectedRevision: 'rev-Late',
          name: 'Late renamed',
        },
        { key: 'replace-missing' },
      );
    expect(await refusal(replace())).toMatchObject({
      kind: 'not_found',
      code: 'core.catalog.entryNotFound',
    });
    seedConfig(ID_LATE, 'Late');
    const before = readFileSync(configPath(ID_LATE), 'utf8');
    expect(await refusal(replace())).toMatchObject({
      kind: 'not_found',
      code: 'core.catalog.entryNotFound',
    });
    expect(readFileSync(configPath(ID_LATE), 'utf8')).toBe(before);
  });

  it('keeps a readable config whose second read meets a disk error, answering the hash delete as unreadable', async () => {
    seedConfig(ID_EIO, 'Eio');
    const before = readFileSync(configPath(ID_EIO), 'utf8');
    mockReadFault.path = configPath(ID_EIO);
    mockReadFault.bytesRead = false;
    expect(await refusal(removeCorrupt(ID_EIO, bytesHash(ID_EIO)))).toEqual({
      ...UNREADABLE,
      details: undefined,
    });
    expect(mockReadFault.path).toBeNull();
    expect(readFileSync(configPath(ID_EIO), 'utf8')).toBe(before);
  });

  it('keeps a config that index recovery restores before a hash delete would remove it', async () => {
    const paths = await import('../lib/paths');
    writeFileSync(configPath(ID_LEGACY), '{ corrupt');
    const hash = bytesHash(ID_LEGACY);
    mkdirSync(dirname(paths.getBundlesIndexFilePath()), { recursive: true });
    writeFileSync(
      paths.getBundlesIndexFilePath(),
      JSON.stringify({ version: 1, bundles: [{ id: ID_LEGACY }] }),
    );
    writeFileSync(
      paths.getBundleConfigFilePath(ID_LEGACY),
      JSON.stringify({
        version: 1,
        bundle: {
          id: ID_LEGACY,
          name: 'Legacy',
          description: '',
          skills: [],
          plugins: [],
          mcpServers: [],
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      }),
    );
    // A missing index converts the retained legacy bundle onto this config.
    rmSync(paths.getCollectionsIndexFilePath(), { force: true });
    expect(await refusal(removeCorrupt(ID_LEGACY, hash))).toMatchObject({
      kind: 'conflict',
      code: 'core.catalog.revisionConflict',
    });
    expect(storedCollection(ID_LEGACY).name).toBe('Legacy');
  });

  it('never writes selections', () => {
    expect(readFileSync(preferencesPath(), 'utf8')).toBe(preferencesBefore);
  });
});

// CAN-4170 PR 4a: core.catalog.entry.import mode analyze.
const MEMBER_ITEMS = [
  {
    type: 'skill',
    source: { type: 'builtin', id: 'user' },
    skill_name: 'deploy',
  },
  { type: 'custom_skill', clientKey: 'k1', skill_name: 'ghost' },
  {
    type: 'claude_plugin',
    marketplace: { type: 'github', repo: 'owner/tools' },
    plugin_name: 'linter',
  },
];
const documentOf = (items: unknown[]): CatalogCollectionShareDocument => ({
  rawCollection: JSON.stringify({
    version: 1,
    name: 'Kit',
    description: '',
    items,
  }),
  customSkills: [
    { clientKey: 'k1', name: 'ghost', rawSkill: '---\nname: ghost\n---\n' },
  ],
});
const DOCUMENT = documentOf(MEMBER_ITEMS);
const ANY_STRING: unknown = expect.any(String);
// The stored deploy skill as the real analyzer reads it: it invokes /release,
// which nothing installed answers, so its analysis blocks until dismissed.
const RELEASE = { provider: 'claude' as const, token: '/release' };
const DEPLOY_SKILL =
  '---\nname: deploy\ndescription: Deploys.\n---\nWhen done, run /release.\n';
const DEPLOY_GUIDE = 'How to deploy.\n';
const DEPLOY_DIR = mkdtempSync(join(tmpdir(), 'can-4170-4a-deploy-'));
writeFileSync(join(DEPLOY_DIR, 'SKILL.md'), DEPLOY_SKILL);
writeFileSync(join(DEPLOY_DIR, 'guide.md'), DEPLOY_GUIDE);
const LINEAR: PipelinePackageEnvironmentRequirement = {
  id: 'mcp:linear',
  kind: 'mcp',
  displayName: 'Linear',
  required: true,
  affectedSteps: [],
  setupHint: 'Connect Linear.',
};

/**
 * What the share service answers for the stored members: the real analyzer's
 * summary, so a fixture can't drift from the shape it produces (CAN-4170 PR
 * 4a R1). The service adds the labels it can't package.
 */
async function analyzedSummary(
  dismissedInvocations: PipelinePackageInvocationDismissal[] = [],
): Promise<PipelinePackageAnalysisSummary> {
  const key = 'skill:user:deploy';
  const { summary } = await analyzeCapabilityPackage({
    rawContent: DOCUMENT.rawCollection,
    invocableInventory: {
      version: 6,
      builtAt: '2026-11-24T00:00:00.000Z',
      entries: [
        {
          id: 'e1',
          provider: 'claude',
          kind: 'skill',
          name: 'deploy',
          displayName: 'deploy',
          description: '',
          insertText: '/deploy',
          invocationKey: 'deploy',
          enableRef: { kind: 'skill', sourceId: 'user', skillName: 'deploy' },
        },
      ],
    },
    capabilityInventoryEntryIdsByKey: { [key]: ['e1'] },
    sourceByInventoryEntryId: {
      e1: {
        sourceRoot: DEPLOY_DIR,
        memberPath: '.',
        sourceVisibility: 'local',
        runtimeKind: 'standalone_skill',
        rootName: 'deploy',
      },
    },
    requests: [
      {
        key,
        provider: 'claude',
        required: true,
        bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
      },
    ],
    environmentRequirements: [LINEAR],
    dismissedInvocations,
  });
  return { ...summary, unpackageableSelectionLabels: ['ghost'] };
}

/** A blocker on an invocation nothing installed answers, offering its dismissal. */
const offered = (
  token: string,
): PipelinePackageAnalysisSummary['blockers'][number] => ({
  code: 'UNRESOLVED_INVOCATION',
  subject: token,
  message: `The deploy skill invokes ${token}.`,
  occurrences: [],
  dismissal: { provider: 'claude', token },
});

let realSummary: PipelinePackageAnalysisSummary | null = null;
let analysisCount = 0;
/** The real summary, ready, with a fresh id; `over` replaces fields. */
const summaryOf = (
  over: Partial<PipelinePackageAnalysisSummary> = {},
): PipelinePackageAnalysisSummary => {
  if (realSummary === null) throw new Error('no real summary yet');
  return {
    ...realSummary,
    analysisId: `analysis-${(analysisCount += 1)}`,
    state: 'ready',
    blockers: [],
    dismissedInvocations: [],
    expiresAt: '2026-11-23T22:00:00.000Z',
    ...over,
  };
};

function analyze(
  id: string,
  options: {
    expectedRevision: string;
    document?: CatalogCollectionShareDocument;
    dismissed?: Array<{ provider: 'claude' | 'codex'; token: string }>;
    /** Leaves dismissedInvocations out, so the saved ones apply. */
    omitDismissals?: boolean;
    key?: string;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const idempotencyKey = options.key ?? `collection-analyze-${(keyCount += 1)}`;
  return dispatcher.instruction(
    'core.catalog.entry.import',
    {
      kind: 'collection',
      mode: 'analyze',
      entryId: collectionEntryId(id),
      expectedRevision: options.expectedRevision,
      document: options.document ?? DOCUMENT,
      ...(options.omitDismissals === true
        ? {}
        : { dismissedInvocations: options.dismissed ?? [] }),
      _meta: { idempotencyKey },
    },
    {
      caller: caller(['core.catalog.write']),
      metadata: { idempotencyKey },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

/** The analysis a call answered. */
function analysisIn(result: unknown): Record<string, unknown> {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('analysis' in result) ||
    typeof result.analysis !== 'object' ||
    result.analysis === null
  )
    throw new Error('expected an analysis');
  return { ...result.analysis };
}

/** Until the analyzer has dropped `analysisId`, for at most a second. */
async function droppedEventually(analysisId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mockAnalyzer.dropped.includes(analysisId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/**
 * Until the analyzer has seen `count` requests, for at most a second; fails
 * as soon as `calls` holds a settled request the analyzer hasn't seen.
 */
async function analyzerSees(
  count: number,
  calls: Array<{ settled: boolean }>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (mockAnalyzer.inputs.length >= count) return;
    if (
      calls.filter((call) => call.settled).length > mockAnalyzer.inputs.length
    )
      throw new Error('a request settled before the analyzer saw it');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the analyzer saw ${mockAnalyzer.inputs.length} of ${count}`);
}

/**
 * Until `count` import operations are running, for at most a second. A
 * running one has been admitted, so while an earlier analysis of its
 * collection is held it is waiting for its turn.
 */
async function importsRunning(count: number): Promise<void> {
  let running = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const listed = await dispatcher.query(
      'core.operation.list',
      { kinds: ['core.catalog.entry.import'], statuses: ['running'] },
      { caller: caller(['core.operation.read']) },
    );
    running = listed.items.length;
    if (running >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${running} of ${count} imports are running`);
}

/**
 * An analyzer that holds its first call until released and answers later
 * ones at once, so a regression fails on an expectation instead of hanging.
 */
function holdingAnalyzer(): Array<() => void> {
  const held: Array<() => void> = [];
  mockAnalyzer.respond = (input): Promise<PipelinePackageAnalysisSummary> => {
    const summary = summaryOf({
      dismissedInvocations: input.dismissedInvocations ?? [],
    });
    if (held.length > 0) return Promise.resolve(summary);
    return new Promise((resolve) => {
      held.push((): void => resolve(summary));
    });
  };
  return held;
}

/** A call whose settlement `analyzerSees` can watch. */
function tracked(call: Promise<unknown>): {
  settled: boolean;
  outcome: Promise<PromiseSettledResult<unknown>>;
} {
  const state = {
    settled: false,
    outcome: Promise.allSettled([call]).then((outcomes) => {
      state.settled = true;
      return outcomes[0];
    }),
  };
  return state;
}

/** The dismissals an analysis answered, or why it was refused. */
async function echoOf(call: {
  outcome: Promise<PromiseSettledResult<unknown>>;
}): Promise<unknown> {
  const outcome = await call.outcome;
  if (outcome.status === 'fulfilled')
    return analysisIn(outcome.value).dismissedInvocations;
  return outcome.reason instanceof CanopyOperationError
    ? outcome.reason.payload.kind
    : 'rejected';
}

describe('core.catalog.entry.import mode analyze (CAN-4170 PR 4a)', () => {
  beforeAll(async () => {
    seedConfig(ID_KIT, 'Kit', { mcpServers: [] });
    seedConfig(ID_KIT_MCP, 'KitMcp');
    seedConfig(ID_KIT_EDIT, 'KitEdit', { mcpServers: [] });
    realSummary = await analyzedSummary([RELEASE]);
  });
  afterAll(() => {
    rmSync(DEPLOY_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    mockAnalyzer.inputs.length = 0;
    mockAnalyzer.dropped.length = 0;
    mockHostedReads.length = 0;
    mockAnalyzer.respond = (): Promise<PipelinePackageAnalysisSummary> =>
      Promise.reject(new Error('no analysis expected'));
  });

  it('analyzes the stored members for the exact document bytes, then applies a dismissal and echoes it', async () => {
    // Blocked on /release until it is dismissed; then the real analysis.
    mockAnalyzer.respond = (input): Promise<PipelinePackageAnalysisSummary> =>
      (input.dismissedInvocations ?? []).some(
        (dismissal) => dismissal.token === RELEASE.token,
      )
        ? analyzedSummary(input.dismissedInvocations)
        : Promise.resolve(
            summaryOf({ state: 'blocked', blockers: [offered('/release')] }),
          );
    const blocked = analysisIn(
      await analyze(ID_KIT, { expectedRevision: 'rev-Kit' }),
    );
    expect(blocked).toMatchObject({
      state: 'blocked',
      blockers: [
        {
          code: 'UNRESOLVED_INVOCATION',
          subject: '/release',
          message: 'The deploy skill invokes /release.',
          dismissal: RELEASE,
        },
      ],
      dismissedInvocations: [],
    });
    expect(mockAnalyzer.inputs[0]).toMatchObject({
      rawContent: DOCUMENT.rawCollection,
      scopeKey: `collection:${ID_KIT}`,
      selections: {
        collectionIds: [],
        skillRefs: MEMBERS.skills,
        pluginRefs: MEMBERS.plugins,
        mcpServerRefs: [],
      },
    });
    // The resources come from the analysis's manifest, counted file by file.
    expect(
      analysisIn(
        await analyze(ID_KIT, {
          expectedRevision: 'rev-Kit',
          dismissed: [RELEASE],
        }),
      ),
    ).toEqual({
      analysisId: ANY_STRING,
      state: 'ready',
      blockers: [],
      resources: [
        {
          resourceId: ANY_STRING,
          displayName: 'deploy',
          fileCount: 2,
          totalBytes:
            Buffer.byteLength(DEPLOY_SKILL) + Buffer.byteLength(DEPLOY_GUIDE),
        },
      ],
      requirements: [
        {
          id: 'mcp:linear',
          kind: 'mcp',
          displayName: 'Linear',
          required: true,
          setupHint: 'Connect Linear.',
        },
      ],
      unpackageableMemberLabels: ['ghost'],
      dismissedInvocations: [RELEASE],
      expiresAt: ANY_STRING,
    });
    expect(mockAnalyzer.dropped).toEqual([]);
  });

  it('replays an analysis under its key without analyzing again, even once the analysis has expired', async () => {
    mockAnalyzer.respond = (): Promise<PipelinePackageAnalysisSummary> =>
      Promise.resolve(summaryOf());
    const first = await analyze(ID_KIT, {
      expectedRevision: 'rev-Kit',
      key: 'analyze-replay',
    });
    expect(
      await analyze(ID_KIT, {
        expectedRevision: 'rev-Kit',
        key: 'analyze-replay',
      }),
    ).toEqual(first);
    expect(mockAnalyzer.inputs).toHaveLength(1);
  });

  it('answers a collection with an MCP server member blocked, after only the authorization reads a get makes and before any MCP connection read', async () => {
    await recordInstall(ID_KIT_ORG, 'remote-outside', {
      kind: 'organization',
      organizationId: ORG_OUTSIDE,
    });
    await withResourceContext(async () => {
      mockHostedReads.length = 0;
      await get(ID_KIT_ORG);
      const getReads = [...mockHostedReads];
      mockHostedReads.length = 0;
      const answer = analysisIn(
        await analyze(ID_KIT_ORG, { expectedRevision: 'rev-Outside' }),
      );
      expect({ answer, reads: mockHostedReads }).toEqual({
        answer: {
          analysisId: ANY_STRING,
          state: 'blocked',
          blockers: [
            {
              code: 'MCP_SHARE_BLOCKED',
              subject: null,
              message:
                'Collections with MCP server configs cannot be shared. Remove MCP servers before sharing.',
            },
          ],
          resources: [],
          requirements: [],
          unpackageableMemberLabels: [],
          dismissedInvocations: [],
          expiresAt: ANY_STRING,
        },
        reads: getReads,
      });
      // get's authorization: the store's installed-context check and its
      // shared-source check each read the shared collection, and nothing else.
      expect(getReads).toEqual([
        'shared:remote-outside',
        'shared:remote-outside',
      ]);
    });
    expect(
      analysisIn(await analyze(ID_KIT_MCP, { expectedRevision: 'rev-KitMcp' })),
    ).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'MCP_SHARE_BLOCKED' }],
    });
    expect(mockAnalyzer.inputs).toEqual([]);
  });

  it('answers cancelled, and records nothing blocked, for a request cancelled while its collection read is pending', async () => {
    await recordInstall(ID_KIT_ORG, 'remote-outside', {
      kind: 'organization',
      organizationId: ORG_OUTSIDE,
    });
    await withResourceContext(async () => {
      mockHostedReads.length = 0;
      let release = (): void => undefined;
      mockHostedReadHold.next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const key = `collection-analyze-held-read-${(keyCount += 1)}`;
      const aborting = new AbortController();
      const call = tracked(
        analyze(ID_KIT_ORG, {
          expectedRevision: 'rev-Outside',
          key,
          signal: aborting.signal,
        }),
      );
      try {
        for (let attempt = 0; mockHostedReads.length === 0; attempt += 1) {
          if (attempt === 200 || call.settled)
            throw new Error('the collection read never started');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // The read is pending; the MCP gate would answer blocked after it.
        aborting.abort();
      } finally {
        release();
        mockHostedReadHold.next = null;
      }
      expect(await echoOf(call)).toBe('cancelled');
      // The same key replays what was recorded: cancelled, never blocked.
      expect(
        await refusal(
          analyze(ID_KIT_ORG, { expectedRevision: 'rev-Outside', key }),
        ),
      ).toMatchObject({ kind: 'cancelled' });
    });
    expect(mockAnalyzer.inputs).toEqual([]);
  });

  it('authorizes an installed collection exactly as get does, with resource contexts on', async () => {
    await recordInstall(
      ID_KIT_OUTSIDE,
      'remote-outside',
      {
        kind: 'organization',
        organizationId: ORG_OUTSIDE,
      },
      { mcpServers: [] },
    );
    await recordInstall(
      ID_KIT_REVOKED,
      'remote-revoked',
      {
        kind: 'personal',
      },
      { mcpServers: [] },
    );
    mockAnalyzer.respond = (): Promise<PipelinePackageAnalysisSummary> =>
      Promise.resolve(summaryOf());
    await withResourceContext(async () => {
      expect(
        analysisIn(
          await analyze(ID_KIT_OUTSIDE, { expectedRevision: 'rev-Outside' }),
        ),
      ).toMatchObject({ state: 'ready' });
      expect({
        get: await refusal(get(ID_KIT_REVOKED)),
        analyze: await refusal(
          analyze(ID_KIT_REVOKED, { expectedRevision: 'rev-Outside' }),
        ),
      }).toEqual({
        get: { ...UNREADABLE, details: undefined },
        analyze: { ...UNREADABLE, details: undefined },
      });
      mockContext.refusedOrganization = ORG_OUTSIDE;
      expect({
        get: await refusal(get(ID_KIT_OUTSIDE)),
        analyze: await refusal(
          analyze(ID_KIT_OUTSIDE, { expectedRevision: 'rev-Outside' }),
        ),
      }).toEqual({
        get: { ...UNREADABLE, details: undefined },
        analyze: { ...UNREADABLE, details: undefined },
      });
    });
    expect(mockAnalyzer.inputs).toHaveLength(1);
  });

  it('refuses a document whose items do not name the stored members, before analyzing anything', async () => {
    const invalid = {
      kind: 'failed_precondition',
      code: 'core.catalog.entryInvalid',
      details: undefined,
    };
    const documents = {
      renamed: documentOf([
        ...MEMBER_ITEMS.slice(0, 2),
        { ...MEMBER_ITEMS[2], plugin_name: 'formatter' },
      ]),
      extra: documentOf([
        ...MEMBER_ITEMS,
        { type: 'custom_skill', clientKey: 'k2', skill_name: 'notes' },
      ]),
      missing: documentOf(MEMBER_ITEMS.slice(1)),
      mcp: documentOf([...MEMBER_ITEMS, { type: 'mcp_server', id: SERVER }]),
      // Publish knows only claude_plugin and codex_plugin.
      pluginTyped: documentOf([
        ...MEMBER_ITEMS.slice(0, 2),
        { ...MEMBER_ITEMS[2], type: 'plugin' },
      ]),
      notJson: { rawCollection: '{ not json' },
    };
    const answers: Record<string, unknown> = {};
    for (const [name, document] of Object.entries(documents))
      answers[name] = await refusal(
        analyze(ID_KIT, { expectedRevision: 'rev-Kit', document }),
      );
    expect(answers).toEqual({
      renamed: invalid,
      extra: invalid,
      missing: invalid,
      mcp: invalid,
      pluginTyped: invalid,
      notJson: invalid,
    });
    expect(mockAnalyzer.inputs).toEqual([]);
  });

  it('passes a same-named skill from another source, analyzing the document bytes as sent (known limit)', async () => {
    // Sources aren't compared; the hosted hash binding still keeps analyzed
    // bytes equal to published bytes.
    mockAnalyzer.respond = (): Promise<PipelinePackageAnalysisSummary> =>
      Promise.resolve(summaryOf());
    const elsewhere = documentOf([
      { ...MEMBER_ITEMS[0], source: { type: 'github', repo: 'other/skills' } },
      ...MEMBER_ITEMS.slice(1),
    ]);
    expect(
      analysisIn(
        await analyze(ID_KIT, {
          expectedRevision: 'rev-Kit',
          document: elsewhere,
        }),
      ),
    ).toMatchObject({ state: 'ready' });
    expect(mockAnalyzer.inputs).toHaveLength(1);
    expect(mockAnalyzer.inputs[0]).toMatchObject({
      rawContent: elsewhere.rawCollection,
      selections: { skillRefs: MEMBERS.skills },
    });
  });

  it('offers only dismissals the dismissal store can save, and refuses unsavable ones before the operation runs, under any retry', async () => {
    mockAnalyzer.respond = (): Promise<PipelinePackageAnalysisSummary> =>
      Promise.resolve(
        summaryOf({
          state: 'blocked',
          blockers: [
            offered('/'),
            offered(`/${'x'.repeat(200)}`),
            offered('/release'),
          ],
        }),
      );
    const answer = analysisIn(
      await analyze(ID_KIT, { expectedRevision: 'rev-Kit' }),
    );
    expect(answer.blockers).toEqual([
      {
        code: 'UNRESOLVED_INVOCATION',
        subject: '/',
        message: 'The deploy skill invokes /.',
      },
      {
        code: 'UNRESOLVED_INVOCATION',
        subject: `/${'x'.repeat(200)}`,
        message: `The deploy skill invokes /${'x'.repeat(200)}.`,
      },
      {
        code: 'UNRESOLVED_INVOCATION',
        subject: '/release',
        message: 'The deploy skill invokes /release.',
        dismissal: RELEASE,
      },
    ]);
    mockAnalyzer.inputs.length = 0;

    const invalid = {
      kind: 'invalid_argument',
      code: undefined,
      details: undefined,
    };
    const tooMany = Array.from({ length: 51 }, (_, index) => ({
      provider: 'claude' as const,
      token: `/skill-${index}`,
    }));
    const unsavable = {
      bare: [{ provider: 'claude' as const, token: '/' }],
      long: [{ provider: 'claude' as const, token: `/${'x'.repeat(200)}` }],
      tooMany,
    };
    for (const dismissed of Object.values(unsavable)) {
      const key = `collection-analyze-unsavable-${(keyCount += 1)}`;
      // Nothing is recorded, so a retry is refused the same way and the key
      // stays free for a request the store can take.
      expect(
        await refusal(
          analyze(ID_KIT, { expectedRevision: 'rev-Kit', dismissed, key }),
        ),
      ).toEqual(invalid);
      expect(
        await refusal(
          analyze(ID_KIT, { expectedRevision: 'rev-Kit', dismissed, key }),
        ),
      ).toEqual(invalid);
      expect(
        analysisIn(
          await analyze(ID_KIT, {
            expectedRevision: 'rev-Kit',
            dismissed: [RELEASE],
            key,
          }),
        ),
      ).toMatchObject({ state: 'blocked' });
    }
    // 50 distinct dismissals, repeated, are still savable.
    expect(
      analysisIn(
        await analyze(ID_KIT, {
          expectedRevision: 'rev-Kit',
          dismissed: [...tooMany.slice(0, 50), ...tooMany.slice(0, 50)],
        }),
      ),
    ).toMatchObject({ state: 'blocked' });
    expect(mockAnalyzer.inputs).toHaveLength(4);
  });

  it('runs one analysis of a collection at a time, from its read to its answer, so each echoes the dismissals it was given', async () => {
    const held = holdingAnalyzer();
    const other = { provider: 'codex' as const, token: '$notes' };
    const calls = [
      tracked(
        analyze(ID_KIT, { expectedRevision: 'rev-Kit', dismissed: [RELEASE] }),
      ),
    ];
    let seenWhileQueued = 0;
    try {
      await analyzerSees(1, calls);
      calls.push(
        tracked(
          analyze(ID_KIT, { expectedRevision: 'rev-Kit', dismissed: [other] }),
        ),
      );
      // Admitted while the first is held, so it waits for its turn.
      await importsRunning(2);
      seenWhileQueued = mockAnalyzer.inputs.length;
      held[0]?.();
      await analyzerSees(2, calls);
    } finally {
      for (const release of held) release();
    }
    expect({
      seenWhileQueued,
      echoes: await Promise.all(calls.map(echoOf)),
    }).toEqual({ seenWhileQueued: 1, echoes: [[RELEASE], [other]] });
    expect(
      mockAnalyzer.inputs.map((input) => input.dismissedInvocations),
    ).toEqual([[RELEASE], [other]]);
  });

  it('answers a request cancelled while it waits for its turn as cancelled, never reading or analyzing it', async () => {
    const held = holdingAnalyzer();
    const abandoned = { provider: 'codex' as const, token: '$notes' };
    const waiting = new AbortController();
    const calls = [
      tracked(
        analyze(ID_KIT, { expectedRevision: 'rev-Kit', dismissed: [RELEASE] }),
      ),
    ];
    try {
      await analyzerSees(1, calls);
      calls.push(
        tracked(
          analyze(ID_KIT, {
            expectedRevision: 'rev-Kit',
            dismissed: [abandoned],
            signal: waiting.signal,
          }),
        ),
      );
      await importsRunning(2);
      waiting.abort();
      held[0]?.();
      expect(await Promise.all(calls.map(echoOf))).toEqual([
        [RELEASE],
        'cancelled',
      ]);
    } finally {
      for (const release of held) release();
    }
    // The analyzer, which saves a request's dismissals, never saw it.
    expect(
      mockAnalyzer.inputs.map((input) => input.dismissedInvocations),
    ).toEqual([[RELEASE]]);
    expect(mockAnalyzer.dropped).toEqual([]);
  });

  it('reads the current revision when its turn comes, refusing a request whose collection changed while it waited', async () => {
    const held = holdingAnalyzer();
    const calls = [
      tracked(analyze(ID_KIT_EDIT, { expectedRevision: 'rev-KitEdit' })),
    ];
    let replaced: unknown = null;
    try {
      await analyzerSees(1, calls);
      calls.push(
        tracked(analyze(ID_KIT_EDIT, { expectedRevision: 'rev-KitEdit' })),
      );
      await importsRunning(2);
      replaced = await upsert({
        entryId: collectionEntryId(ID_KIT_EDIT),
        expectedRevision: 'rev-KitEdit',
        name: 'KitEdit',
        members: { ...MEMBERS, mcpServers: [] },
      });
      held[0]?.();
      await Promise.all(calls.map((call) => call.outcome));
    } finally {
      for (const release of held) release();
    }
    const revision = (): unknown =>
      typeof replaced === 'object' &&
      replaced !== null &&
      'entry' in replaced &&
      typeof replaced.entry === 'object' &&
      replaced.entry !== null &&
      'revision' in replaced.entry
        ? replaced.entry.revision
        : null;
    const second = await calls[1]?.outcome;
    expect({
      revision: revision(),
      refused:
        second?.status === 'rejected' &&
        second.reason instanceof CanopyOperationError
          ? {
              kind: second.reason.payload.kind,
              code: second.reason.payload.code,
              details: second.reason.payload.details,
            }
          : second?.status,
    }).toEqual({
      revision: ANY_STRING,
      refused: {
        kind: 'conflict',
        code: 'core.catalog.revisionConflict',
        details: { currentRevision: revision() },
      },
    });
    expect(mockAnalyzer.inputs).toHaveLength(1);
  });

  it('applies the saved dismissals when the field is left out, and replaces them with any list sent, an empty one included', async () => {
    const storePath = join(DEPLOY_DIR, 'dismissals.json');
    // As the share service resolves them: a sent list replaces the
    // collection's saved dismissals; a left-out one applies the saved ones.
    mockAnalyzer.respond = async (
      input,
    ): Promise<PipelinePackageAnalysisSummary> => {
      if (input.dismissedInvocations !== undefined)
        await replacePipelinePackageDismissals(
          storePath,
          input.scopeKey,
          input.dismissedInvocations,
        );
      const saved = await listPipelinePackageDismissals(
        storePath,
        input.scopeKey,
      );
      return summaryOf({
        dismissedInvocations: saved.map(({ provider, token }) => ({
          provider,
          token,
        })),
      });
    };
    const echo = async (options: {
      dismissed?: Array<{ provider: 'claude' | 'codex'; token: string }>;
      omitDismissals?: boolean;
    }): Promise<unknown> =>
      analysisIn(
        await analyze(ID_KIT, { expectedRevision: 'rev-Kit', ...options }),
      ).dismissedInvocations;
    // Sent, then left out on a reopen: the saved list still applies.
    expect(await echo({ dismissed: [RELEASE] })).toEqual([RELEASE]);
    expect(await echo({ omitDismissals: true })).toEqual([RELEASE]);
    // An empty list is a real "no dismissals", and clears the saved ones.
    expect(await echo({ dismissed: [] })).toEqual([]);
    expect(await echo({ omitDismissals: true })).toEqual([]);
    // The left-out field reaches the analyzer left out, never as a list.
    expect(
      mockAnalyzer.inputs.map((input) =>
        'dismissedInvocations' in input ? input.dismissedInvocations : 'saved',
      ),
    ).toEqual([[RELEASE], 'saved', [], 'saved']);
  });

  it('refuses a stale revision and a missing collection', async () => {
    expect({
      stale: await refusal(analyze(ID_KIT, { expectedRevision: 'rev-old' })),
      missing: await refusal(
        analyze(ID_NONE, { expectedRevision: 'rev-None' }),
      ),
    }).toEqual({
      stale: {
        kind: 'conflict',
        code: 'core.catalog.revisionConflict',
        details: { currentRevision: 'rev-Kit' },
      },
      missing: {
        kind: 'not_found',
        code: 'core.catalog.entryNotFound',
        details: undefined,
      },
    });
    expect(mockAnalyzer.inputs).toEqual([]);
  });

  it('refuses an analysis too large to record and drops it, and answers one just under the bound', async () => {
    const withBlockers =
      (count: number) => (): Promise<PipelinePackageAnalysisSummary> =>
        Promise.resolve(
          summaryOf({
            state: 'blocked',
            blockers: Array.from({ length: count }, (_, index) => ({
              code: 'SUSPECTED_SECRET' as const,
              subject: `file-${index}`,
              message: 'm'.repeat(4096),
              occurrences: [],
            })),
          }),
        );
    mockAnalyzer.respond = withBlockers(9);
    expect(
      await refusal(analyze(ID_KIT, { expectedRevision: 'rev-Kit' })),
    ).toMatchObject({ kind: 'resource_exhausted' });
    expect(mockAnalyzer.dropped).toEqual([`analysis-${analysisCount}`]);
    mockAnalyzer.respond = withBlockers(6);
    expect(
      analysisIn(await analyze(ID_KIT, { expectedRevision: 'rev-Kit' }))
        .blockers,
    ).toHaveLength(6);
    expect(mockAnalyzer.dropped).toHaveLength(1);
  });

  it('keeps no analysis from a call cancelled before or after the analyzer returns', async () => {
    let release: () => void = () => undefined;
    const before = new AbortController();
    mockAnalyzer.respond = (): Promise<PipelinePackageAnalysisSummary> =>
      new Promise((resolve) => {
        release = (): void => resolve(summaryOf());
      });
    const held = refusal(
      analyze(ID_KIT, { expectedRevision: 'rev-Kit', signal: before.signal }),
    );
    while (mockAnalyzer.inputs.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    before.abort();
    expect(await held).toMatchObject({ kind: 'cancelled' });
    release();
    expect(await droppedEventually(`analysis-${analysisCount}`)).toBe(true);

    const after = new AbortController();
    mockAnalyzer.respond = (): Promise<PipelinePackageAnalysisSummary> => {
      const summary = summaryOf();
      after.abort();
      return Promise.resolve(summary);
    };
    expect(
      await refusal(
        analyze(ID_KIT, { expectedRevision: 'rev-Kit', signal: after.signal }),
      ),
    ).toMatchObject({ kind: 'cancelled' });
    expect(await droppedEventually(`analysis-${analysisCount}`)).toBe(true);
  });

  it('runs no analysis, saving no dismissals, for a call cancelled during its account read', async () => {
    const abandoned = { provider: 'codex' as const, token: '$notes' };
    const during = new AbortController();
    mockSignedIn.onRead = (): void => {
      mockSignedIn.onRead = null;
      during.abort();
    };
    expect(
      await refusal(
        analyze(ID_KIT, {
          expectedRevision: 'rev-Kit',
          dismissed: [abandoned],
          signal: during.signal,
        }),
      ),
    ).toMatchObject({ kind: 'cancelled' });
    // The next analysis waits for the cancelled one's turn to end.
    mockAnalyzer.respond = (): Promise<PipelinePackageAnalysisSummary> =>
      Promise.resolve(summaryOf());
    analysisIn(await analyze(ID_KIT, { expectedRevision: 'rev-Kit' }));
    // The analyzer, which saves a request's dismissals, never saw it.
    expect(
      mockAnalyzer.inputs.map((input) => input.dismissedInvocations),
    ).toEqual([[]]);
  });

  it('still refuses install on every collection', async () => {
    const idempotencyKey = `collection-import-${(keyCount += 1)}`;
    expect(
      await refusal(
        dispatcher.instruction(
          'core.catalog.entry.import',
          {
            kind: 'collection',
            mode: 'install',
            remoteId: 'remote-1',
            fromPublicShare: false,
            expectedContentHash: SHARE_HASH,
            package: { version: 1, digest: `pp:v1:${'A'.repeat(43)}` },
            target: { create: { name: 'Kit', description: '' } },
            _meta: { idempotencyKey },
          },
          {
            caller: caller(['core.catalog.write']),
            metadata: { idempotencyKey },
          },
        ),
      ),
    ).toMatchObject({ kind: 'capability_unavailable' });
    expect(mockAnalyzer.inputs).toEqual([]);
  });
});

// CAN-4170 PR 4c: core.catalog.entry.import mode commit.
const ID_COMMIT = '4a4a4a4a-0000-4000-8000-000000000026';
const ID_COMMIT_EDIT = '4b4b4b4b-0000-4000-8000-000000000027';
const DIGEST = `pp:v1:${'B'.repeat(43)}`;
const LATER = '2099-01-01T00:00:00.000Z';
const UPLOADED: CommitUpload = {
  capabilityPackage: { version: 1, digest: DIGEST },
  committedPackageUploadId: 'upload-1',
};
const COMMITTED = {
  kind: 'collection',
  mode: 'commit',
  package: { version: 1, digest: DIGEST },
  committedPackageUploadId: 'upload-1',
};
const refused = (kind: string, code: string): unknown => ({
  kind,
  code: `core.catalog.${code}`,
  details: undefined,
});
const NOT_FOUND = refused('not_found', 'analysisNotFound');
const BLOCKED = refused('failed_precondition', 'packageBlocked');
const STALE = refused('conflict', 'packageStale');
const DENIED = refused('permission_denied', 'remoteAccessDenied');
const UNREACHABLE = refused('unavailable', 'remoteUnavailable');
// CAN-4170 PR 4b-1b: a readiness answer past the relay's reply cap.
const TOO_LARGE_TO_ANSWER = {
  kind: 'resource_exhausted',
  code: undefined,
  details: undefined,
};

function commit(
  id: string,
  options: {
    expectedRevision: string;
    analysisId: string;
    selected?: string[];
    key?: string;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const idempotencyKey = options.key ?? `collection-commit-${(keyCount += 1)}`;
  return dispatcher.instruction(
    'core.catalog.entry.import',
    {
      kind: 'collection',
      mode: 'commit',
      entryId: collectionEntryId(id),
      expectedRevision: options.expectedRevision,
      analysisId: options.analysisId,
      selectedOptionalResourceIds: options.selected ?? [],
      _meta: { idempotencyKey },
    },
    {
      caller: caller(['core.catalog.write']),
      metadata: { idempotencyKey },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

/** A live analysis of `id` at `revision`, ready unless `over` says otherwise. */
async function liveAnalysis(
  id: string,
  revision: string,
  over: Partial<PipelinePackageAnalysisSummary> = {},
): Promise<string> {
  mockAnalyzer.respond = (): Promise<PipelinePackageAnalysisSummary> =>
    Promise.resolve(summaryOf({ expiresAt: LATER, ...over }));
  const { analysisId } = analysisIn(
    await analyze(id, { expectedRevision: revision }),
  );
  if (typeof analysisId !== 'string') throw new Error('expected an analysis');
  return analysisId;
}

describe('core.catalog.entry.import mode commit (CAN-4170 PR 4c)', () => {
  beforeAll(async () => {
    seedConfig(ID_COMMIT, 'Commit', { mcpServers: [] });
    seedConfig(ID_COMMIT_EDIT, 'CommitEdit', { mcpServers: [] });
    seedConfig(ID_KIT_MCP, 'KitMcp');
    realSummary ??= await analyzedSummary([RELEASE]);
  });
  beforeEach(() => {
    mockAnalyzer.inputs.length = 0;
    mockAnalyzer.dropped.length = 0;
    mockHostedReads.length = 0;
    mockCommitter.calls.length = 0;
    mockCommitter.respond = (): Promise<CommitUpload> =>
      Promise.resolve(UPLOADED);
    mockCloudContext.next =
      (): Promise<CloudClient.CanopyCloudCredentialContext> =>
        Promise.resolve(MOCK_CLOUD_CONTEXT);
    mockSignedIn.accountId = ACCOUNT_A;
  });
  afterAll(() => {
    mockSignedIn.accountId = null;
  });

  it('answers analysisNotFound, uploading nothing, for an analysis made under another account or none', async () => {
    const asA = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    mockSignedIn.accountId = null;
    const signedOut = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    // The person switched to account B before committing.
    mockSignedIn.accountId = 'account-b';
    mockCloudContext.next =
      (): Promise<CloudClient.CanopyCloudCredentialContext> =>
        Promise.resolve({
          ...MOCK_CLOUD_CONTEXT,
          account: { ...MOCK_CLOUD_CONTEXT.account, id: 'account-b' },
        });
    mockHostedReads.length = 0;
    expect({
      switched: await refusal(
        commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId: asA }),
      ),
      signedOut: await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId: signedOut,
        }),
      ),
    }).toEqual({ switched: NOT_FOUND, signedOut: NOT_FOUND });
    // Both are refused from the local account store: no capability read.
    expect(mockHostedReads).toEqual([]);
    expect(mockCommitter.calls).toEqual([]);
  });

  it('answers analysisNotFound, uploading nothing, for an account switch during a capability read that succeeds', async () => {
    const asA = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    // The capability read resolves A's credentials and succeeds, but B is
    // signed in by the time it answers.
    mockCloudContext.next =
      (): Promise<CloudClient.CanopyCloudCredentialContext> => {
        mockSignedIn.accountId = 'account-b';
        return Promise.resolve(MOCK_CLOUD_CONTEXT);
      };
    const key = `collection-commit-switch-probe-ok-${(keyCount += 1)}`;
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId: asA,
          key,
        }),
      ),
    ).toEqual(NOT_FOUND);
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId: asA,
          key,
        }),
      ),
    ).toEqual(NOT_FOUND);
    expect(mockCommitter.calls).toEqual([]);
  });

  it('answers analysisNotFound, not remoteUnavailable, for an account switch during the capability read', async () => {
    const asA = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    const { CanopyCloudClientError } = await import('../canopy-cloud/client');
    // The local check passes as A; B is signed in by the time the capability
    // read answers, and B lacks it.
    mockCloudContext.next =
      (): Promise<CloudClient.CanopyCloudCredentialContext> => {
        mockSignedIn.accountId = 'account-b';
        return Promise.reject(
          new CanopyCloudClientError(
            'unsupported-capability',
            'This account lacks the capability.',
          ),
        );
      };
    const key = `collection-commit-switch-probe-${(keyCount += 1)}`;
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId: asA,
          key,
        }),
      ),
    ).toEqual(NOT_FOUND);
    // Its replay answers the same.
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId: asA,
          key,
        }),
      ),
    ).toEqual(NOT_FOUND);
    expect(mockCommitter.calls).toEqual([]);
  });

  it('answers analysisNotFound, not remoteUnavailable, for an analysis made under another account when this one lacks the capability', async () => {
    const asA = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    mockSignedIn.accountId = 'account-b';
    const { CanopyCloudClientError } = await import('../canopy-cloud/client');
    mockCloudContext.next =
      (): Promise<CloudClient.CanopyCloudCredentialContext> =>
        Promise.reject(
          new CanopyCloudClientError(
            'unsupported-capability',
            'This account lacks the capability.',
          ),
        );
    mockHostedReads.length = 0;
    expect(
      await refusal(
        commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId: asA }),
      ),
    ).toEqual(NOT_FOUND);
    expect(mockHostedReads).toEqual([]);
    expect(mockCommitter.calls).toEqual([]);
  });

  it('answers analysisNotFound, with no cloud call, for an analysis made signed out while still signed out', async () => {
    mockSignedIn.accountId = null;
    const signedOut = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    const { CanopyCloudClientError } = await import('../canopy-cloud/client');
    mockCloudContext.next =
      (): Promise<CloudClient.CanopyCloudCredentialContext> =>
        Promise.reject(
          new CanopyCloudClientError('missing-api-key', 'Sign in first.'),
        );
    mockHostedReads.length = 0;
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId: signedOut,
        }),
      ),
    ).toEqual(NOT_FOUND);
    expect(mockHostedReads).toEqual([]);
    expect(mockCommitter.calls).toEqual([]);
  });

  it('records no account for an analysis during which the signed-in account changed, so its commit uploads nothing', async () => {
    let release = (): void => undefined;
    mockAnalyzer.respond = (): Promise<PipelinePackageAnalysisSummary> =>
      new Promise((resolve) => {
        release = (): void => resolve(summaryOf({ expiresAt: LATER }));
      });
    const analyzing = analyze(ID_COMMIT, { expectedRevision: 'rev-Commit' });
    for (let attempt = 0; mockAnalyzer.inputs.length === 0; attempt += 1) {
      if (attempt === 200) throw new Error('the analyzer never started');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Switched from A to B while the analysis ran, then committed as B.
    mockSignedIn.accountId = 'account-b';
    mockCloudContext.next =
      (): Promise<CloudClient.CanopyCloudCredentialContext> =>
        Promise.resolve({
          ...MOCK_CLOUD_CONTEXT,
          account: { ...MOCK_CLOUD_CONTEXT.account, id: 'account-b' },
        });
    release();
    const { analysisId } = analysisIn(await analyzing);
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId: typeof analysisId === 'string' ? analysisId : '',
        }),
      ),
    ).toEqual(NOT_FOUND);
    expect(mockCommitter.calls).toEqual([]);
  });

  it('answers analysisNotFound, not packageStale, for an analysis dropped during its upload, expired or not', async () => {
    const analysisId = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    const { PackageAnalysisMissingError } =
      await import('../sharing/share-operation-result');
    // Evicted after the preflight, long before its expiry: the package read
    // finds it missing.
    mockCommitter.respond = (): Promise<CommitUpload> => {
      mockAnalyzer.live.delete(analysisId);
      return Promise.reject(new PackageAnalysisMissingError());
    };
    expect(
      await refusal(
        commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId }),
      ),
    ).toEqual(NOT_FOUND);
  });

  it('answers cancelled, with no capability read, for a commit cancelled during its preflight, and replays that', async () => {
    const analysisId = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    const aborting = new AbortController();
    const key = `collection-commit-preflight-cancel-${(keyCount += 1)}`;
    mockAnalyzer.onLiveRead = (): void => {
      mockAnalyzer.onLiveRead = null;
      aborting.abort();
    };
    // Meanwhile the person switched accounts: a refusal, were it reached.
    mockCloudContext.next =
      (): Promise<CloudClient.CanopyCloudCredentialContext> =>
        Promise.resolve({
          ...MOCK_CLOUD_CONTEXT,
          account: { ...MOCK_CLOUD_CONTEXT.account, id: 'account-b' },
        });
    mockHostedReads.length = 0;
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId,
          key,
          signal: aborting.signal,
        }),
      ),
    ).toMatchObject({ kind: 'cancelled' });
    expect(
      await refusal(
        commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId, key }),
      ),
    ).toMatchObject({ kind: 'cancelled' });
    expect(mockHostedReads).toEqual([]);
    expect(mockCommitter.calls).toEqual([]);
  });

  it('uploads a ready analysis with the chosen optional resources under the one account its capability check resolved', async () => {
    const analysisId = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    mockHostedReads.length = 0;
    expect(
      await commit(ID_COMMIT, {
        expectedRevision: 'rev-Commit',
        analysisId,
        selected: ['resource-1'],
      }),
    ).toEqual(COMMITTED);
    expect(mockCommitter.calls).toEqual([
      {
        analysisId,
        selectedOptionalResourceIds: ['resource-1'],
        credentialContext: MOCK_CLOUD_CONTEXT,
      },
    ]);
    expect(mockCommitter.calls[0]?.credentialContext).toBe(MOCK_CLOUD_CONTEXT);
    expect(mockHostedReads).toEqual(['capability:collections-crud-v1']);
  });

  it('replays a commit under its key without uploading again, even once its analysis is gone', async () => {
    const analysisId = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    const request = {
      expectedRevision: 'rev-Commit',
      analysisId,
      key: `collection-commit-replay-${(keyCount += 1)}`,
    };
    expect(await commit(ID_COMMIT, request)).toEqual(COMMITTED);
    mockAnalyzer.live.delete(analysisId);
    expect(await commit(ID_COMMIT, request)).toEqual(COMMITTED);
    expect(
      await refusal(
        commit(ID_COMMIT, { ...request, selected: ['resource-1'] }),
      ),
    ).toMatchObject({ kind: 'conflict' });
    expect(mockCommitter.calls).toHaveLength(1);
  });

  it('answers analysisNotFound, before any cloud call, for an analysis this collection never made or the service no longer holds', async () => {
    const other = await liveAnalysis(ID_COMMIT_EDIT, 'rev-CommitEdit');
    const evicted = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    mockAnalyzer.live.delete(evicted);
    const expired = await liveAnalysis(ID_COMMIT, 'rev-Commit', {
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    // A skill's analysis in the shared service, which no collection made.
    mockAnalyzer.live.add('skill-analysis-1');
    mockHostedReads.length = 0;
    const ids = {
      unknown: 'analysis-unknown',
      other,
      skill: 'skill-analysis-1',
      evicted,
      expired,
    };
    const answers: Record<string, unknown> = {};
    for (const [name, analysisId] of Object.entries(ids))
      answers[name] = await refusal(
        commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId }),
      );
    expect(answers).toEqual({
      unknown: NOT_FOUND,
      other: NOT_FOUND,
      skill: NOT_FOUND,
      evicted: NOT_FOUND,
      expired: NOT_FOUND,
    });
    expect(mockCommitter.calls).toEqual([]);
    expect(mockHostedReads).toEqual([]);
  });

  it('forgets the oldest analysis beyond the newest 16, answering analysisNotFound for it, not internal', async () => {
    const ids: string[] = [];
    for (let count = 0; count < 17; count += 1)
      ids.push(await liveAnalysis(ID_COMMIT, 'rev-Commit'));
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId: ids[0] ?? '',
        }),
      ),
    ).toEqual(NOT_FOUND);
    expect(mockCommitter.calls).toEqual([]);
    expect(
      await commit(ID_COMMIT, {
        expectedRevision: 'rev-Commit',
        analysisId: ids[1] ?? '',
      }),
    ).toEqual(COMMITTED);
  });

  it('refuses an analysis of another revision as packageStale, and a collection that moved on as revisionConflict', async () => {
    const analysisId = await liveAnalysis(ID_COMMIT_EDIT, 'rev-CommitEdit');
    seedConfig(ID_COMMIT_EDIT, 'CommitEdit', {
      mcpServers: [],
      revision: 'rev-CommitEdit-2',
    });
    expect({
      moved: await refusal(
        commit(ID_COMMIT_EDIT, {
          expectedRevision: 'rev-CommitEdit',
          analysisId,
        }),
      ),
      stale: await refusal(
        commit(ID_COMMIT_EDIT, {
          expectedRevision: 'rev-CommitEdit-2',
          analysisId,
        }),
      ),
    }).toEqual({
      moved: {
        kind: 'conflict',
        code: 'core.catalog.revisionConflict',
        details: { currentRevision: 'rev-CommitEdit-2' },
      },
      stale: STALE,
    });
    expect(mockCommitter.calls).toEqual([]);
    // The files the analysis read changed since: the upload refuses it.
    const changed = await liveAnalysis(ID_COMMIT_EDIT, 'rev-CommitEdit-2');
    const { ShareOperationError } =
      await import('../sharing/share-operation-result');
    // As the package service does, the stale analysis is dropped first.
    mockCommitter.respond = (): Promise<CommitUpload> => {
      mockAnalyzer.live.delete(changed);
      return Promise.reject(
        new ShareOperationError(
          'dependency-review',
          'Dependency files changed since analysis.',
          'prepare',
        ),
      );
    };
    expect(
      await refusal(
        commit(ID_COMMIT_EDIT, {
          expectedRevision: 'rev-CommitEdit-2',
          analysisId: changed,
        }),
      ),
    ).toEqual(STALE);
    expect(mockCommitter.calls).toHaveLength(1);
  });

  it('answers packageBlocked with no capability or MCP connection read for a blocked analysis or a collection with an MCP server member', async () => {
    const blocked = await liveAnalysis(ID_COMMIT, 'rev-Commit', {
      state: 'blocked',
      blockers: [offered('/release')],
    });
    const { analysisId: mcpBlocked } = analysisIn(
      await analyze(ID_KIT_MCP, { expectedRevision: 'rev-KitMcp' }),
    );
    const ready = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    mockHostedReads.length = 0;
    expect({
      blocked: await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId: blocked,
        }),
      ),
      mcp: await refusal(
        commit(ID_KIT_MCP, {
          expectedRevision: 'rev-KitMcp',
          analysisId: typeof mcpBlocked === 'string' ? mcpBlocked : '',
        }),
      ),
      // The stored MCP member is refused before the analysis is looked up.
      mcpWithAnother: await refusal(
        commit(ID_KIT_MCP, {
          expectedRevision: 'rev-KitMcp',
          analysisId: ready,
        }),
      ),
    }).toEqual({ blocked: BLOCKED, mcp: BLOCKED, mcpWithAnother: BLOCKED });
    expect(mockCommitter.calls).toEqual([]);
    expect(mockHostedReads).toEqual([]);
  });

  it('answers packageBlocked for a package the upload refuses as holding a secret or as blocked', async () => {
    const analysisId = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    const { SkillSecretDetectedError, PackageAnalysisBlockedError } =
      await import('../sharing/share-operation-result');
    const answers: unknown[] = [];
    for (const error of [
      new SkillSecretDetectedError(
        'The deploy skill looks like it holds a secret.',
        'prepare',
      ),
      new PackageAnalysisBlockedError(),
    ]) {
      mockCommitter.respond = (): Promise<CommitUpload> =>
        Promise.reject(error);
      answers.push(
        await refusal(
          commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId }),
        ),
      );
    }
    expect(answers).toEqual([BLOCKED, BLOCKED]);
  });

  it('authorizes the collection exactly as get does, before any capability read or upload, with resource contexts on', async () => {
    await recordInstall(
      ID_KIT_OUTSIDE,
      'remote-outside',
      { kind: 'organization', organizationId: ORG_OUTSIDE },
      { mcpServers: [] },
    );
    await recordInstall(
      ID_KIT_REVOKED,
      'remote-revoked',
      { kind: 'personal' },
      { mcpServers: [] },
    );
    await withResourceContext(async () => {
      const analysisId = await liveAnalysis(ID_KIT_OUTSIDE, 'rev-Outside');
      mockContext.refusedOrganization = ORG_OUTSIDE;
      mockHostedReads.length = 0;
      expect({
        revoked: await refusal(
          commit(ID_KIT_REVOKED, {
            expectedRevision: 'rev-Outside',
            analysisId,
          }),
        ),
        outside: await refusal(
          commit(ID_KIT_OUTSIDE, {
            expectedRevision: 'rev-Outside',
            analysisId,
          }),
        ),
      }).toEqual({
        revoked: { ...UNREADABLE, details: undefined },
        outside: { ...UNREADABLE, details: undefined },
      });
      // Only get's authorization reads each installed share; no capability
      // read.
      expect(mockHostedReads).toEqual([
        'shared:remote-revoked',
        'shared:remote-outside',
      ]);
    });
    expect(mockCommitter.calls).toEqual([]);
  });

  it('answers cancelled, recording it, for a commit cancelled before or during its read or during the upload', async () => {
    const analysisId = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    const before = new AbortController();
    before.abort();
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId,
          signal: before.signal,
        }),
      ),
    ).toMatchObject({ kind: 'cancelled' });
    // During the upload: it stops at its next request.
    const during = new AbortController();
    const key = `collection-commit-upload-cancel-${(keyCount += 1)}`;
    mockCommitter.respond = (stillInTime): Promise<CommitUpload> =>
      new Promise((resolve) => {
        during.abort();
        stillInTime();
        resolve(UPLOADED);
      });
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId,
          key,
          signal: during.signal,
        }),
      ),
    ).toMatchObject({ kind: 'cancelled' });
    mockCommitter.respond = (): Promise<CommitUpload> =>
      Promise.resolve(UPLOADED);
    expect(
      await refusal(
        commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId, key }),
      ),
    ).toMatchObject({ kind: 'cancelled' });
    expect(mockCommitter.calls).toHaveLength(1);
    // During the read: an MCP member would answer packageBlocked after it.
    await recordInstall(ID_KIT_ORG, 'remote-outside', {
      kind: 'organization',
      organizationId: ORG_OUTSIDE,
    });
    await withResourceContext(async () => {
      mockHostedReads.length = 0;
      let release = (): void => undefined;
      mockHostedReadHold.next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const heldKey = `collection-commit-held-read-${(keyCount += 1)}`;
      const aborting = new AbortController();
      const call = tracked(
        commit(ID_KIT_ORG, {
          expectedRevision: 'rev-Outside',
          analysisId,
          key: heldKey,
          signal: aborting.signal,
        }),
      );
      try {
        for (let attempt = 0; mockHostedReads.length === 0; attempt += 1) {
          if (attempt === 200 || call.settled)
            throw new Error('the collection read never started');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        aborting.abort();
      } finally {
        release();
        mockHostedReadHold.next = null;
      }
      const outcome = await call.outcome;
      expect(
        outcome.status === 'rejected' &&
          outcome.reason instanceof CanopyOperationError
          ? outcome.reason.payload.kind
          : outcome.status,
      ).toBe('cancelled');
      expect(
        await refusal(
          commit(ID_KIT_ORG, {
            expectedRevision: 'rev-Outside',
            analysisId,
            key: heldKey,
          }),
        ),
      ).toMatchObject({ kind: 'cancelled' });
    });
    expect(mockCommitter.calls).toHaveLength(1);
  });

  it('records, and replays, a commit whose upload finished after its caller cancelled', async () => {
    const analysisId = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    const late = new AbortController();
    const key = `collection-commit-late-cancel-${(keyCount += 1)}`;
    mockCommitter.respond = (): Promise<CommitUpload> => {
      late.abort();
      return Promise.resolve(UPLOADED);
    };
    // The dispatcher answers the caller who left; the finished upload is what
    // the run records, so the same key answers it.
    expect(
      await refusal(
        commit(ID_COMMIT, {
          expectedRevision: 'rev-Commit',
          analysisId,
          key,
          signal: late.signal,
        }),
      ),
    ).toMatchObject({ kind: 'cancelled' });
    expect(
      await commit(ID_COMMIT, {
        expectedRevision: 'rev-Commit',
        analysisId,
        key,
      }),
    ).toEqual(COMMITTED);
    expect(mockCommitter.calls).toHaveLength(1);
  });

  it('maps the cloud refusing access or being unreachable, recording each refusal under its key', async () => {
    const analysisId = await liveAnalysis(ID_COMMIT, 'rev-Commit');
    const { ShareOperationError, ShareStageError } =
      await import('../sharing/share-operation-result');
    const { CanopyCloudClientError } = await import('../canopy-cloud/client');
    const offline = new ShareStageError(
      'upload',
      new CanopyCloudClientError('network-error', 'offline'),
    );
    const failures: Record<string, Error> = {
      permission: new ShareStageError(
        'prepare',
        new ShareOperationError('permission', 'No access.', 'prepare'),
      ),
      authentication: new ShareOperationError(
        'authentication',
        'Sign in again.',
        'prepare',
      ),
      offline,
    };
    const answers: Record<string, unknown> = {};
    for (const [name, error] of Object.entries(failures)) {
      mockCommitter.respond = (): Promise<CommitUpload> =>
        Promise.reject(error);
      answers[name] = await refusal(
        commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId }),
      );
    }
    mockCloudContext.next =
      (): Promise<CloudClient.CanopyCloudCredentialContext> =>
        Promise.reject(
          new CanopyCloudClientError('unsupported-capability', 'unsupported'),
        );
    answers.capability = await refusal(
      commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId }),
    );
    expect(answers).toEqual({
      permission: DENIED,
      authentication: DENIED,
      offline: UNREACHABLE,
      capability: UNREACHABLE,
    });
    // A refusal replays under its key; only a new key reaches the cloud again.
    mockCloudContext.next =
      (): Promise<CloudClient.CanopyCloudCredentialContext> =>
        Promise.resolve(MOCK_CLOUD_CONTEXT);
    const key = `collection-commit-offline-${(keyCount += 1)}`;
    mockCommitter.respond = (): Promise<CommitUpload> =>
      Promise.reject(offline);
    await refusal(
      commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId, key }),
    );
    mockCommitter.respond = (): Promise<CommitUpload> =>
      Promise.resolve(UPLOADED);
    expect(
      await refusal(
        commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId, key }),
      ),
    ).toEqual(UNREACHABLE);
    expect(
      await commit(ID_COMMIT, { expectedRevision: 'rev-Commit', analysisId }),
    ).toEqual(COMMITTED);
    expect(mockCommitter.calls).toHaveLength(5);
  });
});

// CAN-4170 PR 4b-1: core.catalog.entry.get read importReadiness.
const SLACK: PipelinePackageEnvironmentRequirement = {
  id: 'connector:slack',
  kind: 'connector',
  displayName: 'Slack',
  required: false,
  affectedSteps: [],
  setupHint: 'Connect Slack.',
};
const SHARED_PACKAGE = {
  digest: DIGEST,
  version: 1,
  resources: [],
  environmentRequirements: [LINEAR, SLACK],
};
const READY_REQUIREMENTS = [
  {
    id: 'mcp:linear',
    kind: 'mcp',
    displayName: 'Linear',
    required: true,
    setupHint: 'Connect Linear.',
    status: 'missing',
  },
  {
    id: 'connector:slack',
    kind: 'connector',
    displayName: 'Slack',
    required: false,
    setupHint: 'Connect Slack.',
    status: 'unknown',
  },
];

function readiness(
  remoteId: string,
  fromPublicShare: boolean,
  signal?: AbortSignal,
): Promise<unknown> {
  return dispatcher.query(
    'core.catalog.entry.get',
    { kind: 'collection', read: 'importReadiness', remoteId, fromPublicShare },
    { caller: caller(['core.catalog.read']), ...(signal ? { signal } : {}) },
  );
}

/** Lets a read the caller left run on until it next waits on I/O. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A share requirement on the MCP server named, under its own id. */
function mcpRequirement(
  id: string,
  displayName: string,
): PipelinePackageEnvironmentRequirement {
  return {
    id,
    kind: 'mcp',
    displayName,
    required: true,
    affectedSteps: [],
    setupHint: `Connect ${displayName}.`,
  };
}

describe('core.catalog.entry.get read importReadiness (CAN-4170 PR 4b-1)', () => {
  let filesBefore: Record<string, string> = {};
  beforeEach(() => {
    mockShares.scoped.clear();
    mockShares.public.clear();
    mockCapability.check = (): Promise<void> => Promise.resolve();
    mockHostedReads.length = 0;
    mockMcpProbes.length = 0;
    filesBefore = collectionFiles();
  });
  afterEach(() => {
    // A readiness read writes nothing.
    expect(collectionFiles()).toEqual(filesBefore);
    expect(readFileSync(preferencesPath(), 'utf8')).toBe(preferencesBefore);
  });
  afterAll(() => {
    mockCapability.check = null;
  });

  it('answers the revision, package and requirements of a shared collection, probing them exactly as the import readiness channel does', async () => {
    mockShares.scoped.set(
      'remote-ready',
      (): Promise<unknown> =>
        Promise.resolve({ contentHash: SHARE_HASH, package: SHARED_PACKAGE }),
    );
    expect(await readiness('remote-ready', false)).toEqual({
      read: 'importReadiness',
      readiness: {
        remoteId: 'remote-ready',
        contentHash: SHARE_HASH,
        package: { version: 1, digest: DIGEST },
        requirements: READY_REQUIREMENTS,
      },
    });
    // The channel's capability check, then the share; no other hosted read.
    expect(mockHostedReads).toEqual(['capability', 'shared:remote-ready']);
    // The same MCP status probes as the channel, which reach the account's
    // MCP connections for an account-routed server (N4).
    const probes = [...mockMcpProbes];
    expect(probes).toEqual(['catalog:Linear', 'name:Linear']);
    mockMcpProbes.length = 0;
    const { inspectSharedCollectionImport } =
      await import('../collections/collection-handlers');
    const channel = await inspectSharedCollectionImport('remote-ready');
    expect(mockMcpProbes).toEqual(probes);
    expect(
      channel.requirements.map(
        ({ id, status }): { id: string; status: string } => ({ id, status }),
      ),
    ).toEqual(
      READY_REQUIREMENTS.map(
        ({ id, status }): { id: string; status: string } => ({ id, status }),
      ),
    );
  });

  it('answers a public share from its public snapshot, with no capability check', async () => {
    mockShares.public.set(
      'remote-public',
      (): Promise<unknown> =>
        Promise.resolve({ contentHash: SHARE_HASH, package: SHARED_PACKAGE }),
    );
    expect(await readiness('remote-public', true)).toEqual({
      read: 'importReadiness',
      readiness: {
        remoteId: 'remote-public',
        contentHash: SHARE_HASH,
        package: { version: 1, digest: DIGEST },
        requirements: READY_REQUIREMENTS,
      },
    });
    expect(mockHostedReads).toEqual(['public:remote-public']);
    expect(mockMcpProbes).toEqual(['catalog:Linear', 'name:Linear']);
  });

  it('answers a null package and no requirements for a share without a package', async () => {
    const bare = (): Promise<unknown> =>
      Promise.resolve({ contentHash: SHARE_HASH });
    mockShares.scoped.set('remote-bare', bare);
    mockShares.public.set('remote-bare', bare);
    const bareReadiness = {
      read: 'importReadiness',
      readiness: {
        remoteId: 'remote-bare',
        contentHash: SHARE_HASH,
        package: null,
        requirements: [],
      },
    };
    expect({
      scoped: await readiness('remote-bare', false),
      public: await readiness('remote-bare', true),
    }).toEqual({ scoped: bareReadiness, public: bareReadiness });
    expect(mockMcpProbes).toEqual([]);
  });

  it('maps a missing share, a refused account and an unreachable cloud, scoped and public', async () => {
    const { CanopyCloudClientError } = await import('../canopy-cloud/client');
    const failures: Record<string, () => Error> = {
      missing: () => new CanopyCloudClientError('http-error', 'Not found', 404),
      forbidden: () =>
        new CanopyCloudClientError('http-error', 'Forbidden', 403),
      signedOut: () =>
        new CanopyCloudClientError('missing-api-key', 'Sign in first.'),
      serverError: () =>
        new CanopyCloudClientError('http-error', 'Unavailable', 503),
      offline: () => new CanopyCloudClientError('network-error', 'offline'),
    };
    const answers: Record<string, unknown> = {};
    for (const [name, failure] of Object.entries(failures))
      for (const fromPublicShare of [false, true]) {
        const shares = fromPublicShare ? mockShares.public : mockShares.scoped;
        shares.set(
          'remote-failing',
          (): Promise<unknown> => Promise.reject(failure()),
        );
        answers[`${name}:${fromPublicShare ? 'public' : 'scoped'}`] =
          await refusal(readiness('remote-failing', fromPublicShare));
      }
    // The organization context refuses the share's owner.
    mockShares.scoped.set(
      'remote-failing',
      (): Promise<unknown> =>
        Promise.reject(new Error('Resource unavailable (context)')),
    );
    answers.context = await refusal(readiness('remote-failing', false));
    // The cloud lacks the capability: refused before the share is read.
    mockHostedReads.length = 0;
    mockCapability.check = (): Promise<void> =>
      Promise.reject(
        new CanopyCloudClientError('unsupported-capability', 'unsupported'),
      );
    answers.capability = await refusal(readiness('remote-failing', false));
    expect(mockHostedReads).toEqual(['capability']);
    // A 404 from the capability check never read the share: unavailable.
    mockCapability.check = (): Promise<void> =>
      Promise.reject(
        new CanopyCloudClientError('http-error', 'Not found', 404),
      );
    answers.capabilityNotFound = await refusal(
      readiness('remote-failing', false),
    );
    const notFound = refused('not_found', 'remoteNotFound');
    expect(answers).toEqual({
      'missing:scoped': notFound,
      'missing:public': notFound,
      'forbidden:scoped': DENIED,
      'forbidden:public': DENIED,
      'signedOut:scoped': DENIED,
      'signedOut:public': DENIED,
      'serverError:scoped': UNREACHABLE,
      'serverError:public': UNREACHABLE,
      'offline:scoped': UNREACHABLE,
      'offline:public': UNREACHABLE,
      context: DENIED,
      capability: UNREACHABLE,
      capabilityNotFound: UNREACHABLE,
    });
  });

  it('checks a cold capability cache without writing the signed-in account', async () => {
    mockShares.scoped.set(
      'remote-cold',
      (): Promise<unknown> => Promise.resolve({ contentHash: SHARE_HASH }),
    );
    mockCapability.check = null;
    mockColdAccount.on = true;
    mockColdAccount.writes.length = 0;
    const discovery = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        (): Promise<Response> =>
          Promise.resolve(
            new Response(
              JSON.stringify({ capabilities: ['collections-crud-v1'] }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          ),
      );
    try {
      expect(await readiness('remote-cold', false)).toMatchObject({
        readiness: { remoteId: 'remote-cold', contentHash: SHARE_HASH },
      });
      // The real check ran live discovery, and saved nothing it found.
      expect(discovery).toHaveBeenCalledTimes(1);
      expect(mockColdAccount.writes).toEqual([]);
    } finally {
      discovery.mockRestore();
      mockColdAccount.on = false;
    }
  });

  it('refuses a scoped share when the selected context changes while its requirements are probed', async () => {
    mockContext.enabled = true;
    mockShares.scoped.set('remote-switched', (): Promise<unknown> => {
      // The share is read in one context; the probes finish in another.
      mockContext.epoch += 1;
      return Promise.resolve({
        contentHash: SHARE_HASH,
        package: SHARED_PACKAGE,
      });
    });
    try {
      expect(await refusal(readiness('remote-switched', false))).toEqual(
        DENIED,
      );
    } finally {
      mockContext.enabled = false;
    }
  });

  it('answers a published requirement whatever its name and setup hint length, and refuses an answer too large to send', async () => {
    // Publish caps neither, so neither does readiness (PR 4b-1b).
    for (const longer of [
      { ...SLACK, setupHint: 'x'.repeat(4097) },
      { ...SLACK, displayName: 'x'.repeat(513) },
    ]) {
      mockShares.scoped.set(
        'remote-long-hint',
        (): Promise<unknown> =>
          Promise.resolve({
            contentHash: SHARE_HASH,
            package: { ...SHARED_PACKAGE, environmentRequirements: [longer] },
          }),
      );
      expect(await readiness('remote-long-hint', false)).toMatchObject({
        readiness: {
          requirements: [
            {
              id: longer.id,
              displayName: longer.displayName,
              setupHint: longer.setupHint,
              status: 'unknown',
            },
          ],
        },
      });
    }
    // An answer past the relay's 1 MiB reply cap is refused as too large.
    mockShares.scoped.set(
      'remote-long-hint',
      (): Promise<unknown> =>
        Promise.resolve({
          contentHash: SHARE_HASH,
          package: {
            ...SHARED_PACKAGE,
            environmentRequirements: [
              { ...SLACK, setupHint: 'x'.repeat(1024 * 1024) },
            ],
          },
        }),
    );
    expect(await refusal(readiness('remote-long-hint', false))).toEqual(
      TOO_LARGE_TO_ANSWER,
    );
  });

  it('refuses a scoped share when the signed-in account changes while its requirements are probed, with organization contexts off', async () => {
    mockShares.scoped.set('remote-account-switched', (): Promise<unknown> => {
      // Read under one account; the probes finish under another.
      mockContext.accountEpoch += 1;
      return Promise.resolve({
        contentHash: SHARE_HASH,
        package: SHARED_PACKAGE,
      });
    });
    expect(await refusal(readiness('remote-account-switched', false))).toEqual(
      DENIED,
    );
  });

  it('refuses a public share when the signed-in account or the selected context changes while its requirements are probed', async () => {
    const switched = (move: () => void) => (): Promise<unknown> => {
      // Read in one account or context; the probes finish in another.
      move();
      return Promise.resolve({
        contentHash: SHARE_HASH,
        package: SHARED_PACKAGE,
      });
    };
    mockShares.public.set(
      'remote-public-switched',
      switched((): void => {
        mockContext.accountEpoch += 1;
      }),
    );
    const accountSwitch = await refusal(
      readiness('remote-public-switched', true),
    );
    mockContext.enabled = true;
    mockShares.public.set(
      'remote-public-switched',
      switched((): void => {
        mockContext.epoch += 1;
      }),
    );
    let contextSwitch: unknown;
    try {
      contextSwitch = await refusal(readiness('remote-public-switched', true));
    } finally {
      mockContext.enabled = false;
    }
    expect({ accountSwitch, contextSwitch }).toEqual({
      accountSwitch: DENIED,
      contextSwitch: DENIED,
    });
  });

  it('refuses a public share as access denied when the cloud is not configured', async () => {
    const { CanopyCloudConfigError } = await import('../canopy-cloud/config');
    mockShares.public.set(
      'remote-no-cloud',
      (): Promise<unknown> =>
        Promise.reject(
          new CanopyCloudConfigError(
            'base-url-not-configured',
            'The cloud is not configured.',
          ),
        ),
    );
    expect(await refusal(readiness('remote-no-cloud', true))).toEqual(DENIED);
  });

  it('stops a cancelled read before its share read and before its probes', async () => {
    mockShares.scoped.set(
      'remote-cancelled',
      (): Promise<unknown> =>
        Promise.resolve({ contentHash: SHARE_HASH, package: SHARED_PACKAGE }),
    );
    // Cancelled during the capability check: the share is never read.
    const duringCheck = new AbortController();
    mockCapability.check = (): Promise<void> => {
      duringCheck.abort();
      return Promise.resolve();
    };
    expect(
      await refusal(readiness('remote-cancelled', false, duringCheck.signal)),
    ).toMatchObject({ kind: 'cancelled' });
    await settled();
    expect(mockHostedReads).toEqual(['capability']);
    // Cancelled during the share read: nothing is probed.
    mockCapability.check = (): Promise<void> => Promise.resolve();
    for (const fromPublicShare of [false, true]) {
      const aborting = new AbortController();
      const shares = fromPublicShare ? mockShares.public : mockShares.scoped;
      shares.set('remote-cancelled', (): Promise<unknown> => {
        aborting.abort();
        return Promise.resolve({
          contentHash: SHARE_HASH,
          package: SHARED_PACKAGE,
        });
      });
      expect(
        await refusal(
          readiness('remote-cancelled', fromPublicShare, aborting.signal),
        ),
      ).toMatchObject({ kind: 'cancelled' });
    }
    await settled();
    expect(mockMcpProbes).toEqual([]);
  });

  it('sends no further share request once a read is cancelled during its retry wait', async () => {
    const actual = jest.requireActual<typeof ServerClient>(
      '../collections/canopy-server-client',
    );
    // The real scoped share client, against a cloud that is briefly down.
    mockShares.scoped.set(
      'remote-retrying',
      (signal?: AbortSignal): Promise<unknown> =>
        actual.getSharedCollection('remote-retrying', signal),
    );
    mockColdAccount.on = true;
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const requests = jest.spyOn(globalThis, 'fetch').mockImplementation(
      (): Promise<Response> =>
        Promise.resolve(
          new Response('{}', {
            status: 503,
            headers: { 'retry-after': '1' },
          }),
        ),
    );
    try {
      const aborting = new AbortController();
      const call = refusal(
        readiness('remote-retrying', false, aborting.signal),
      );
      for (
        let turn = 0;
        turn < 50 && requests.mock.calls.length === 0;
        turn += 1
      )
        await new Promise<void>((resolve) => setImmediate(resolve));
      // The first request failed and its one-second retry wait is scheduled.
      await settled();
      expect(requests).toHaveBeenCalledTimes(1);
      aborting.abort();
      await jest.advanceTimersByTimeAsync(2000);
      await settled();
      expect(await call).toMatchObject({ kind: 'cancelled' });
      expect(requests).toHaveBeenCalledTimes(1);
    } finally {
      requests.mockRestore();
      jest.useRealTimers();
      mockColdAccount.on = false;
    }
  });

  it('starts no probe once a cancel lands between synchronous probes', async () => {
    // The host's READINESS_PROBE_CONCURRENCY: the probes admitted at once.
    const HOST_PROBE_CONCURRENCY = 8;
    mockShares.public.set(
      'remote-cancel-probing',
      (): Promise<unknown> =>
        Promise.resolve({
          contentHash: SHARE_HASH,
          package: {
            ...SHARED_PACKAGE,
            environmentRequirements: Array.from(
              { length: 20 },
              (_, index): PipelinePackageEnvironmentRequirement => ({
                id: `command:tool-${index}`,
                kind: 'command',
                displayName: `canopy-absent-tool-${index}`,
                required: true,
                setupHint: '',
                affectedSteps: [],
              }),
            ),
          },
        }),
    );
    const aborting = new AbortController();
    mockPathProbes.length = 0;
    // PATH probes don't yield; the cancel arrives as its own event once the
    // first one starts.
    mockPathProbeHook.onProbe = (): void => {
      mockPathProbeHook.onProbe = null;
      setImmediate(() => aborting.abort());
    };
    try {
      expect(
        await refusal(
          readiness('remote-cancel-probing', true, aborting.signal),
        ),
      ).toMatchObject({ kind: 'cancelled' });
      for (let turn = 0; turn < 40; turn += 1) await settled();
    } finally {
      mockPathProbeHook.onProbe = null;
    }
    // The probes admitted before the cancel ran; none started after it.
    expect(
      mockPathProbes.filter((name) => name.startsWith('canopy-absent-tool-')),
    ).toHaveLength(HOST_PROBE_CONCURRENCY);
  });

  it('refuses a requirement too large to answer without serializing it', async () => {
    // A long hint, and one under the cap in characters that JSON escapes to
    // six bytes apiece.
    for (const hint of [
      'x'.repeat(3 * 1024 * 1024),
      '\u0001'.repeat(900_000),
    ]) {
      mockShares.public.set(
        'remote-huge-hint',
        (): Promise<unknown> =>
          Promise.resolve({
            contentHash: SHARE_HASH,
            package: {
              ...SHARED_PACKAGE,
              environmentRequirements: [
                { ...mcpRequirement('mcp:huge', 'Huge'), setupHint: hint },
              ],
            },
          }),
      );
      const stringify = jest.spyOn(JSON, 'stringify');
      try {
        expect(await refusal(readiness('remote-huge-hint', true))).toEqual(
          TOO_LARGE_TO_ANSWER,
        );
        expect(
          stringify.mock.calls.some((call): boolean => {
            const value: unknown = call[0];
            return (
              typeof value === 'object' &&
              value !== null &&
              'setupHint' in value &&
              value.setupHint === hint
            );
          }),
        ).toBe(false);
      } finally {
        stringify.mockRestore();
      }
    }
    expect(mockMcpProbes).toEqual([]);
  });

  it('refuses a share whose answer must exceed the reply cap before any probe, and answers one just under it', async () => {
    const hinted = (
      count: number,
      hintLength: number,
    ): PipelinePackageEnvironmentRequirement[] =>
      Array.from(
        { length: count },
        (_, index): PipelinePackageEnvironmentRequirement => ({
          ...mcpRequirement(`mcp:hinted-${index}`, `Hinted ${index}`),
          setupHint: 'x'.repeat(hintLength),
        }),
      );
    // Two requirements of 600,000 characters can't fit in 1 MiB.
    mockShares.public.set(
      'remote-near-cap',
      (): Promise<unknown> =>
        Promise.resolve({
          contentHash: SHARE_HASH,
          package: {
            ...SHARED_PACKAGE,
            environmentRequirements: hinted(2, 600_000),
          },
        }),
    );
    expect(await refusal(readiness('remote-near-cap', true))).toEqual(
      TOO_LARGE_TO_ANSWER,
    );
    expect(mockMcpProbes).toEqual([]);
    // One a few kilobytes under the cap is answered.
    mockShares.public.set(
      'remote-near-cap',
      (): Promise<unknown> =>
        Promise.resolve({
          contentHash: SHARE_HASH,
          package: {
            ...SHARED_PACKAGE,
            environmentRequirements: hinted(1, 1024 * 1024 - 4096),
          },
        }),
    );
    expect(await readiness('remote-near-cap', true)).toMatchObject({
      readiness: { requirements: [{ id: 'mcp:hinted-0', status: 'missing' }] },
    });
  });

  it('probes each requirement target once, at most 8 at a time, and refuses a share too large to answer before probing', async () => {
    // 20 requirements naming 10 servers, each twice under its own id.
    const requirements = Array.from(
      { length: 20 },
      (_, index): PipelinePackageEnvironmentRequirement =>
        mcpRequirement(`mcp:server-${index}`, `Server ${index % 10}`),
    );
    mockShares.public.set(
      'remote-many',
      (): Promise<unknown> =>
        Promise.resolve({
          contentHash: SHARE_HASH,
          package: { ...SHARED_PACKAGE, environmentRequirements: requirements },
        }),
    );
    mockMcpInFlight.max = 0;
    expect(await readiness('remote-many', true)).toMatchObject({
      readiness: {
        requirements: requirements.map(({ id }) => ({ id, status: 'missing' })),
      },
    });
    expect(mockMcpProbes).toHaveLength(20);
    expect(new Set(mockMcpProbes).size).toBe(20);
    expect(mockMcpInFlight.max).toBeLessThanOrEqual(8);
    // 1025 requirements, past the old cap, are answered, and probed once.
    mockMcpProbes.length = 0;
    const many = (length: number): PipelinePackageEnvironmentRequirement[] =>
      Array.from(
        { length },
        (_, index): PipelinePackageEnvironmentRequirement =>
          mcpRequirement(`mcp:linear-${index}`, 'Linear'),
      );
    const share =
      (requirements: PipelinePackageEnvironmentRequirement[]) =>
      (): Promise<unknown> =>
        Promise.resolve({
          contentHash: SHARE_HASH,
          package: { ...SHARED_PACKAGE, environmentRequirements: requirements },
        });
    mockShares.public.set('remote-oversize', share(many(1025)));
    expect(await readiness('remote-oversize', true)).toMatchObject({
      readiness: { requirements: many(1025).map(({ id }) => ({ id })) },
    });
    expect(mockMcpProbes).toEqual(['catalog:Linear', 'name:Linear']);
    // More than a 1 MiB answer can hold: refused as too large, with no probe.
    mockMcpProbes.length = 0;
    for (const shares of [mockShares.scoped, mockShares.public])
      shares.set('remote-oversize', share(many(16385)));
    expect({
      scoped: await refusal(readiness('remote-oversize', false)),
      public: await refusal(readiness('remote-oversize', true)),
    }).toEqual({
      scoped: TOO_LARGE_TO_ANSWER,
      public: TOO_LARGE_TO_ANSWER,
    });
    expect(mockMcpProbes).toEqual([]);
  });

  it('leaves a token bound to the local server it names untouched, evicting only one bound to another upstream', async () => {
    const [paths, tokens] = await Promise.all([
      import('../lib/paths'),
      import('../mcp/oauth-token-store'),
    ]);
    const servers = [
      { id: 'golden-mcp-kept', name: 'Golden Kept', bound: '/mcp' },
      { id: 'golden-mcp-stale', name: 'Golden Stale', bound: '/old-mcp' },
    ];
    const indexPath = paths.getMcpServersIndexFilePath();
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(
      indexPath,
      JSON.stringify({
        version: 1,
        servers: servers.map(({ id, name }) => ({
          id,
          name,
          description: '',
          type: 'http',
          configs: [{ id: 'config-1', name: 'Default', enabled: true }],
          updatedAt: STAMP,
        })),
      }),
    );
    try {
      for (const { id, name, bound } of servers) {
        const serverPath = paths.getMcpServerFilePath(id);
        mkdirSync(dirname(serverPath), { recursive: true });
        writeFileSync(
          serverPath,
          JSON.stringify({
            version: 1,
            server: {
              definition: {
                id,
                name,
                description: '',
                type: 'http',
                url: 'https://mcp.golden.test/mcp',
                createdAt: STAMP,
                updatedAt: STAMP,
              },
              configs: [
                {
                  id: 'config-1',
                  name: 'Default',
                  description: '',
                  enabled: true,
                  envVars: {},
                  extraArgs: [],
                  extraHeaders: {},
                  createdAt: STAMP,
                  updatedAt: STAMP,
                },
              ],
            },
          }),
        );
        await tokens.saveMcpOAuthToken({
          serverId: id,
          configId: 'config-1',
          accessToken: `access-${id}`,
          upstreamUrl: `https://mcp.golden.test${bound}`,
          tokenType: 'Bearer',
          updatedAt: STAMP,
        });
      }
      // The share names local servers only; their definitions stay local.
      mockShares.public.set(
        'remote-names-servers',
        (): Promise<unknown> =>
          Promise.resolve({
            contentHash: SHARE_HASH,
            package: {
              ...SHARED_PACKAGE,
              environmentRequirements: servers.map(({ id, name }) =>
                mcpRequirement(`mcp:${id}`, name),
              ),
            },
          }),
      );
      expect(await readiness('remote-names-servers', true)).toMatchObject({
        readiness: {
          requirements: [
            { id: 'mcp:golden-mcp-kept' },
            { id: 'mcp:golden-mcp-stale' },
          ],
        },
      });
      expect(
        (await tokens.getMcpOAuthToken('golden-mcp-kept', 'config-1'))
          ?.accessToken,
      ).toBe('access-golden-mcp-kept');
      // The shared status read drops a token that can't reach this upstream.
      expect(
        await tokens.getMcpOAuthToken('golden-mcp-stale', 'config-1'),
      ).toBeNull();
    } finally {
      rmSync(indexPath, { force: true });
      for (const { id } of servers) {
        rmSync(paths.getMcpServerFilePath(id), { force: true });
        await tokens.clearMcpOAuthToken(id, 'config-1');
      }
    }
  });

  it('answers a failure that is not the cloud as internal, scoped and public', async () => {
    for (const shares of [mockShares.scoped, mockShares.public])
      shares.set(
        'remote-broken',
        (): Promise<unknown> => Promise.reject(new TypeError('broken')),
      );
    expect({
      scoped: await refusal(readiness('remote-broken', false)),
      public: await refusal(readiness('remote-broken', true)),
    }).toMatchObject({
      scoped: { kind: 'internal' },
      public: { kind: 'internal' },
    });
  });
});
