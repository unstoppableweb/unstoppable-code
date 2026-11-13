// CAN-5061 golden world: a real data root, workspace records, a Git checkout
// with a project pipeline, a stored user pipeline, a signed-in cloud account
// and a fixture bundled catalog. `fetch` is an in-memory cloud; the live OS
// credential metadata probe is scoped to secure for this Node-only world.
import type * as LinuxSecretService from '../../lib/linux-secret-service';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computePipelinePackageDigestSync } from '@canopy/execution-engine/node/pipelines/package-contract';
import type {
  PipelinePackageManifestV1,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import {
  GOLDEN_PROJECT_PIPELINE_YAML,
  GOLDEN_USER_PIPELINE_YAML,
  normalizeGoldenValue,
  writeGoldenBundledResources,
  type GoldenReplacement,
} from '@canopy/execution-engine/node/pipelines/__tests__/golden-fixtures';

export const GOLDEN_WORKSPACE_ID = 'golden-ws';
export const GOLDEN_WORKTREE_ID = 'golden-wt';
export const GOLDEN_PROJECT_PIPELINE_FILE = 'golden-project.yaml';
export const GOLDEN_PROJECT_PIPELINE_ID = `project--${GOLDEN_PROJECT_PIPELINE_FILE}`;
export const GOLDEN_CLOUD_BASE_URL = 'https://cloud.golden.test';
export const GOLDEN_ACCOUNT_ID = 'acct-golden';
export const GOLDEN_SHARED_REMOTE_ID = 'shared-golden-1';
export const GOLDEN_SHARED_DISPATCH_REMOTE_ID = 'shared-golden-dispatch';
export const GOLDEN_CURATED_KEY = 'golden-curated';
export const GOLDEN_PUBLIC_SHARE_ID = 'public-golden-1';
export const GOLDEN_PUBLIC_PACKAGE_SHARE_ID = 'public-golden-package';
export const GOLDEN_TEAM_SHARE_ID = 'shared-golden-team';
export const GOLDEN_AUTOMATION_SHARE_ID = 'public-golden-automation';
export const GOLDEN_AUTOMATION_ENTRY_KEY = 'journey-entry';
export const GOLDEN_AUTOMATION_WORKER_KEY = 'journey-worker';
const GOLDEN_CLOUD_CAPABILITIES = ['pipelines-crud-v1'];

export const GOLDEN_SHARED_YAML = [
  'pipeline:',
  '  name: Golden shared plan review',
  '  description: Shared golden fixture',
  '  on:',
  '    plan_ready:',
  '      inputs:',
  '        depth:',
  '          type: choice',
  '          options: [quick, deep]',
  '          default: quick',
  '  scope: [worktree]',
  '  jobs:',
  '    review:',
  '      name: Review',
  '      steps:',
  '        - id: read',
  '          name: Read',
  '          run: echo "shared $DEPTH"',
  '          env:',
  '            DEPTH: ${{ inputs.depth }}',
  '',
].join('\n');

export const GOLDEN_SHARED_DISPATCH_YAML = [
  'pipeline:',
  '  name: Golden shared dispatch',
  '  on: dispatch',
  '  jobs:',
  '    run:',
  '      steps:',
  '        - run: echo shared dispatch',
  '',
].join('\n');

export const GOLDEN_CURATED_YAML = [
  'pipeline:',
  '  name: Golden curated triage',
  '  description: Curated golden fixture',
  '  on: dispatch',
  '  scope: [directory, worktree]',
  '  jobs:',
  '    triage:',
  '      name: Triage',
  '      steps:',
  '        - id: sort',
  '          name: Sort',
  '          run: echo curated',
  '',
].join('\n');

export const GOLDEN_PUBLIC_YAML = [
  'pipeline:',
  '  name: Golden public digest',
  '  description: Public golden fixture',
  '  on: dispatch',
  '  jobs:',
  '    digest:',
  '      steps:',
  '        - run: echo public',
  '',
].join('\n');

export const GOLDEN_PUBLIC_UPDATED_YAML = GOLDEN_PUBLIC_YAML.replace(
  'echo public',
  'echo public again',
);

export const GOLDEN_PUBLIC_PACKAGE_YAML = [
  'pipeline:',
  '  name: Golden public package',
  '  on: dispatch',
  '  jobs:',
  '    package:',
  '      steps:',
  '        - run: echo package',
  '',
].join('\n');

/** An automation package the golden cloud serves for a public automation share. */
export interface GoldenAutomationPackage {
  digest: string;
  /** The content hash of each packaged pipeline, by key. */
  contentHashes: Record<string, string>;
}

/** A public share's reviewed revision, as the share page pins it. */
export interface GoldenPublicSharePin {
  externalId: string;
  expectedPipelineContentHash: string;
  expectedDistributionMode: 'definition_only' | 'package';
  expectedPackageDigest?: string;
}

export interface GoldenWorld {
  root: string;
  dataDir: string;
  sourceRepo: string;
  worktreePath: string;
  userPipelineId: string;
  /** `METHOD path` for every cloud request since the last reset. */
  cloudRequests: string[];
  replacements: GoldenReplacement[];
  normalize(value: unknown): unknown;
  /** Republish a public definition-only share with another document. */
  publishPublicShare(externalId: string, rawPipeline: string): void;
  /** The pin the share page sends for a public share's current revision. */
  publicSharePin(externalId: string): GoldenPublicSharePin;
  /**
   * The automation packages the golden cloud serves: the first revision, a
   * republished one with an updated entry pipeline, and one whose entry
   * pipeline doesn't match its pinned hash.
   */
  automationPackages: Record<'v1' | 'v2' | 'tampered', GoldenAutomationPackage>;
  /** Store a user pipeline and give its generated id a stable token. */
  saveUserPipeline(yaml: string, token: string): Promise<string>;
  dispose(): Promise<void>;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const OWNER = {
  type: 'user' as const,
  id: GOLDEN_ACCOUNT_ID,
  name: 'Golden',
};

interface SharedFixture {
  id: string;
  triggerTypes: string[];
  /** The list row: the detail without its definition and hash. */
  summary: Record<string, unknown>;
  detail: Record<string, unknown>;
}

function sharedFixture(
  id: string,
  name: string,
  rawPipeline: string,
  triggerTypes: string[],
  scopes: string[],
): SharedFixture {
  const summary = {
    id,
    name,
    description: '',
    icon: '',
    version: '1',
    triggerTypes,
    scopes,
    createdBy: { id: GOLDEN_ACCOUNT_ID, name: 'Golden' },
    shareScope: 'private',
    owner: OWNER,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    canUpdate: true,
    canDelete: true,
    publicShare: null,
    distributionMode: 'definition_only',
  };
  return {
    id,
    triggerTypes,
    summary,
    detail: { ...summary, rawPipeline, contentHash: sha256(rawPipeline) },
  };
}

const SHARED = [
  sharedFixture(
    GOLDEN_SHARED_REMOTE_ID,
    'Golden shared plan review',
    GOLDEN_SHARED_YAML,
    ['plan_ready'],
    ['worktree'],
  ),
  sharedFixture(
    GOLDEN_SHARED_DISPATCH_REMOTE_ID,
    'Golden shared dispatch',
    GOLDEN_SHARED_DISPATCH_YAML,
    ['dispatch'],
    ['directory'],
  ),
];

const CURATED = {
  key: GOLDEN_CURATED_KEY,
  name: 'Golden curated triage',
  shortDescription: 'Curated golden fixture',
  icon: '🧭',
  version: '1.0.0',
  triggerTypes: ['dispatch'],
  scopes: ['directory', 'worktree'],
  jobCount: 1,
  stepCount: 1,
  contentHash: sha256(GOLDEN_CURATED_YAML),
  contentSizeBytes: Buffer.byteLength(GOLDEN_CURATED_YAML),
  categories: ['triage'],
  popular: false,
  sortOrder: 0,
  revision: 1,
  authorName: null,
  authorUrl: null,
  docsUrl: null,
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
};

const TEAM_SHARE = sharedFixture(
  GOLDEN_TEAM_SHARE_ID,
  'Golden team digest',
  GOLDEN_PUBLIC_YAML,
  ['dispatch'],
  ['directory'],
);
TEAM_SHARE.detail.shareScope = 'team';

const PUBLIC_PACKAGE_MANIFEST: PipelinePackageManifestV1 = {
  version: 1,
  pipelineContentHash: sha256(GOLDEN_PUBLIC_PACKAGE_YAML),
  resources: [],
  bindings: [],
  environmentRequirements: [],
  totalFiles: 0,
  totalBytes: 0,
};
const PUBLIC_PACKAGE_DIGEST = computePipelinePackageDigestSync(
  PUBLIC_PACKAGE_MANIFEST,
);

interface PublicShareFixture {
  rawPipeline: string;
  description: string;
  package?: PipelinePackageManifestV1;
}

function initialPublicShares(): Map<string, PublicShareFixture> {
  return new Map([
    [
      GOLDEN_PUBLIC_SHARE_ID,
      { rawPipeline: GOLDEN_PUBLIC_YAML, description: 'Public golden share' },
    ],
    [
      GOLDEN_PUBLIC_PACKAGE_SHARE_ID,
      {
        rawPipeline: GOLDEN_PUBLIC_PACKAGE_YAML,
        description: 'Public golden package share',
        package: PUBLIC_PACKAGE_MANIFEST,
      },
    ],
  ]);
}

function publicShareName(rawPipeline: string): string {
  return /^ {2}name: (.+)$/m.exec(rawPipeline)?.[1] ?? '';
}

/** The public resolve, which refuses a revision other than the one pinned. */
function routePublicShare(
  url: URL,
  externalId: string,
  share: PublicShareFixture,
): Response {
  const contentHash = sha256(share.rawPipeline);
  const distributionMode = share.package ? 'package' : 'definition_only';
  const digest = share.package ? PUBLIC_PACKAGE_DIGEST : undefined;
  const pinned = (name: string, value: string | undefined): boolean => {
    const expected = url.searchParams.get(name);
    return expected === null || expected === value;
  };
  if (
    !pinned('expectedPipelineContentHash', contentHash) ||
    !pinned('expectedDistributionMode', distributionMode) ||
    !pinned('expectedPackageDigest', digest)
  )
    return json(409, { error: 'pipeline_share_changed' });
  return json(200, {
    entity: 'pipeline',
    externalId,
    name: publicShareName(share.rawPipeline),
    description: share.description,
    rawPipeline: share.rawPipeline,
    contentHash,
    distributionMode,
    ...(share.package
      ? {
          package: {
            digest: PUBLIC_PACKAGE_DIGEST,
            version: 1,
            resources: [],
            environmentRequirements: [],
            totalFiles: 0,
            totalBytes: 0,
          },
        }
      : {}),
    authorUsername: 'golden',
    updatedAt: '2026-10-07T00:00:00.000Z',
  });
}

function automationPipelineYaml(name: string, step: string): string {
  return [
    'pipeline:',
    `  name: ${name}`,
    '  on: dispatch',
    '  jobs:',
    '    run:',
    '      steps:',
    `        - run: ${step}`,
    '',
  ].join('\n');
}

interface AutomationPackageFixture {
  digest: string;
  manifest: PipelinePackageManifestV1;
  blobs: Map<string, Uint8Array<ArrayBuffer>>;
  contentHashes: Record<string, string>;
}

function automationPackage(
  entryStep: string,
  tampered = false,
): AutomationPackageFixture {
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  const contentHashes: Record<string, string> = {};
  const blob = (text: string): { sha256: string; size: number } => {
    // ASCII fixtures; the secure-storage fixture's VM has no TextEncoder.
    const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
    const digest = sha256(text);
    blobs.set(digest, bytes);
    return { sha256: digest, size: bytes.byteLength };
  };
  const pipeline = (
    key: string,
    name: string,
    yaml: string,
    dependencyResourceIds: string[],
  ): PipelinePackageResource => {
    const entry = blob(yaml);
    contentHashes[key] = sha256(yaml);
    return {
      id: `automation-pipeline-${key}`,
      kind: 'automation_pipeline',
      displayName: name,
      sourceLabel: 'Your pipelines',
      sourceVisibility: 'local',
      invocationKeys: [],
      dependencyResourceIds,
      pipelineKey: key,
      pipelineContentHash:
        tampered && key === GOLDEN_AUTOMATION_ENTRY_KEY
          ? sha256(`${yaml}# tampered`)
          : sha256(yaml),
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'automation_pipeline',
          rootName: key,
          entries: [{ path: 'pipeline.yaml', ...entry, mode: 'read' }],
        },
      ],
    };
  };
  const asset = blob('Golden specialist notes\n');
  const resources: PipelinePackageResource[] = [
    {
      id: `file-asset-${GOLDEN_AUTOMATION_ENTRY_KEY}-specialists`,
      kind: 'file_asset',
      displayName: 'specialists',
      sourceLabel: 'Pipeline files',
      sourceVisibility: 'local',
      invocationKeys: [],
      dependencyResourceIds: [],
      pipelineKey: GOLDEN_AUTOMATION_ENTRY_KEY,
      assetId: 'specialists',
      installMode: 'seed',
      required: true,
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'pipeline_asset',
          rootName: 'specialists',
          entries: [{ path: 'notes.md', ...asset, mode: 'read' }],
        },
      ],
    },
    pipeline(
      GOLDEN_AUTOMATION_ENTRY_KEY,
      'Golden journey entry',
      automationPipelineYaml('Golden journey entry', entryStep),
      [`file-asset-${GOLDEN_AUTOMATION_ENTRY_KEY}-specialists`],
    ),
    pipeline(
      GOLDEN_AUTOMATION_WORKER_KEY,
      'Golden journey worker',
      automationPipelineYaml('Golden journey worker', 'echo worker'),
      [],
    ),
  ];
  const files = resources.flatMap((resource) =>
    resource.trees.flatMap((tree) => tree.entries),
  );
  const manifest: PipelinePackageManifestV1 = {
    version: 1,
    pipelineContentHash: sha256('{"automation":true}'),
    resources,
    bindings: [
      {
        jobId: 'automation',
        stepId: 'action',
        resourceIds: resources
          .filter((resource) => resource.kind === 'automation_pipeline')
          .map((resource) => resource.id),
      },
    ],
    environmentRequirements: [],
    totalFiles: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
  };
  return {
    digest: computePipelinePackageDigestSync(manifest),
    manifest,
    blobs,
    contentHashes,
  };
}

const AUTOMATION_PACKAGES = {
  v1: automationPackage('echo entry'),
  v2: automationPackage('echo entry again'),
  tampered: automationPackage('echo tampered', true),
};

/** The public automation package endpoints, by the digest a request pins. */
function routeAutomationPackage(path: string, url: URL): Response | null {
  const prefix = `/api/v1/public-shares/automations/${GOLDEN_AUTOMATION_SHARE_ID}/package`;
  if (path !== prefix && !path.startsWith(`${prefix}/blobs/`)) return null;
  const fixture = Object.values(AUTOMATION_PACKAGES).find(
    (candidate) =>
      candidate.digest === url.searchParams.get('expectedPackageDigest'),
  );
  if (!fixture) return json(404, { error: 'Not found' });
  if (path === prefix)
    return json(200, { digest: fixture.digest, manifest: fixture.manifest });
  const bytes = fixture.blobs.get(
    decodeURIComponent(path.slice(`${prefix}/blobs/`.length)),
  );
  return bytes
    ? new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    : json(404, { error: 'Not found' });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The fixed cloud every golden reads; anything unrouted is a 404. */
function routeCloudRequest(
  method: string,
  url: URL,
  publicShares: ReadonlyMap<string, PublicShareFixture>,
): Response {
  const path = url.pathname;
  const pipelines = '/api/v1/desktop-app/pipelines';
  if (method === 'GET') {
    const automationPackageResponse = routeAutomationPackage(path, url);
    if (automationPackageResponse) return automationPackageResponse;
  }
  const publicShare =
    /^\/api\/v1\/[^/]+\/public-shares\/pipelines\/([^/]+)$/.exec(path);
  if (method === 'GET' && publicShare) {
    const externalId = decodeURIComponent(publicShare[1] ?? '');
    const share = publicShares.get(externalId);
    return share
      ? routePublicShare(url, externalId, share)
      : json(404, { error: 'Not found' });
  }
  if (
    method === 'GET' &&
    path ===
      `/api/v1/public-shares/pipelines/${GOLDEN_PUBLIC_PACKAGE_SHARE_ID}/package` &&
    url.searchParams.get('expectedPackageDigest') === PUBLIC_PACKAGE_DIGEST
  )
    return json(200, {
      digest: PUBLIC_PACKAGE_DIGEST,
      manifest: PUBLIC_PACKAGE_MANIFEST,
    });
  if (method === 'GET' && path === `${pipelines}/${TEAM_SHARE.id}`)
    return json(200, TEAM_SHARE.detail);
  if (method === 'GET' && path === `${pipelines}/curated`) {
    const q = url.searchParams.get('q');
    const data =
      q === null || CURATED.key.includes(q) || CURATED.name.includes(q)
        ? [CURATED]
        : [];
    return json(200, { version: 1, data, nextCursor: null });
  }
  if (method === 'GET' && path === `${pipelines}/curated/${CURATED.key}`) {
    return json(200, { ...CURATED, rawPipeline: GOLDEN_CURATED_YAML });
  }
  if (
    method === 'GET' &&
    path === `${pipelines}/curated/${CURATED.key}/content`
  ) {
    return json(200, { ...CURATED, rawPipeline: GOLDEN_CURATED_YAML });
  }
  if (method === 'GET' && path === pipelines) {
    const trigger = url.searchParams.get('triggerType');
    const data = SHARED.filter(
      (row) => trigger === null || row.triggerTypes.includes(trigger),
    ).map((row) => row.summary);
    return json(200, { data, nextCursor: null });
  }
  if (method === 'GET' && path === '/.well-known/canopy') {
    return json(200, { capabilities: GOLDEN_CLOUD_CAPABILITIES });
  }
  const shared = SHARED.find((row) => path === `${pipelines}/${row.id}`);
  if (method === 'GET' && shared) return json(200, shared.detail);
  return json(404, { error: 'Not found' });
}

function installGoldenCloud(
  requests: string[],
  publicShares: ReadonlyMap<string, PublicShareFixture>,
): () => void {
  const original = global.fetch;
  const golden = globalThis as Record<string, unknown>;
  const originalBaseUrl = golden.__CANOPY_CLOUD_BASE_URL__;
  golden.__CANOPY_CLOUD_BASE_URL__ = GOLDEN_CLOUD_BASE_URL;
  global.fetch = (input, init): Promise<Response> => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (url.origin !== GOLDEN_CLOUD_BASE_URL) {
      requests.push(`${method} ${url.origin} (outside the golden cloud)`);
      return Promise.reject(new Error(`Unexpected request to ${url.origin}`));
    }
    // Subscription uploads run independently of the foreground operation.
    // Keep their fixture response outside its request capture window.
    if (
      method === 'POST' &&
      url.pathname === '/api/v1/shared-item-subscriptions/batch'
    ) {
      return Promise.resolve(routeCloudRequest(method, url, publicShares));
    }
    requests.push(`${method} ${url.pathname}${url.search}`);
    return Promise.resolve(routeCloudRequest(method, url, publicShares));
  };
  return () => {
    global.fetch = original;
    golden.__CANOPY_CLOUD_BASE_URL__ = originalBaseUrl;
  };
}

const ENV_KEYS = [
  'CANOPY_DATA_DIR',
  'CANOPY_SECURE_DATA_DIR',
  'CANOPY_BUNDLED_RESOURCES_DIR',
] as const;

/**
 * Build the world. Call from `beforeAll`, before any production module that
 * caches a data root is imported.
 */
export async function createPipelineGoldenWorld(): Promise<GoldenWorld> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-golden-')));
  const dataDir = join(root, 'data');
  const originalEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  process.env.CANOPY_DATA_DIR = dataDir;
  process.env.CANOPY_SECURE_DATA_DIR = join(root, 'secure');
  process.env.CANOPY_BUNDLED_RESOURCES_DIR = writeGoldenBundledResources(
    join(root, 'resources'),
  );
  const cloudRequests: string[] = [];
  const publicShares = initialPublicShares();
  const restoreCloud = installGoldenCloud(cloudRequests, publicShares);

  const sourceRepo = join(root, 'repos', 'source');
  mkdirSync(join(sourceRepo, '.canopy', 'pipelines'), { recursive: true });
  git(sourceRepo, ['init', '-q', '-b', 'main']);
  git(sourceRepo, ['config', 'user.email', 'golden@example.com']);
  git(sourceRepo, ['config', 'user.name', 'Golden']);
  writeFileSync(join(sourceRepo, 'README.md'), 'golden\n');
  writeFileSync(
    join(sourceRepo, '.canopy', 'pipelines', GOLDEN_PROJECT_PIPELINE_FILE),
    GOLDEN_PROJECT_PIPELINE_YAML,
  );
  git(sourceRepo, ['add', '.']);
  git(sourceRepo, ['commit', '-q', '-m', 'init']);

  const workspaceDir = join(dataDir, 'workspaces', GOLDEN_WORKSPACE_ID);
  const worktreePath = join(workspaceDir, 'worktrees', GOLDEN_WORKTREE_ID);
  mkdirSync(join(worktreePath, '..'), { recursive: true });
  git(sourceRepo, ['worktree', 'add', '-q', '-b', 'golden', worktreePath]);
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: GOLDEN_WORKSPACE_ID,
        name: 'Golden',
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 0,
      },
    ],
  });
  writeJson(join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: sourceRepo,
    repos: [],
  });
  writeJson(join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: GOLDEN_WORKTREE_ID,
        branchName: 'golden',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  });

  const { saveStoredPipeline } =
    await import('@canopy/execution-engine/pipelines/store');
  const { parsePipelineText } =
    await import('@canopy/execution-engine/pipelines/parse-pipeline');
  const content = parsePipelineText(GOLDEN_USER_PIPELINE_YAML);
  const saved = saveStoredPipeline({
    name: content.name,
    description: content.description ?? '',
    icon: '',
    content,
  });
  if (!saved.success || !saved.data)
    throw new Error(saved.error ?? 'Could not save the golden user pipeline');
  const userPipelineId = saved.data.id;

  // Electron itself is already a golden mock. Keep its metadata boundary
  // equally deterministic on Linux runners without a session Secret Service.
  const metadata = jest.requireActual<typeof LinuxSecretService>(
    '../../lib/linux-secret-service',
  );
  const metadataProbe = jest
    .spyOn(metadata, 'getLinuxSecretServiceState')
    .mockReturnValue('secure');
  const asyncMetadataProbe = jest
    .spyOn(metadata, 'getLinuxSecretServiceStateAsync')
    .mockResolvedValue('secure');
  // The execution golden simulates a relaunch with jest.resetModules(). Keep
  // that fresh runtime on this world's metadata boundary until disposal.
  jest.doMock('../../lib/linux-secret-service', () => metadata);
  const subscriptions =
    await import('../../canopy-cloud/shared-item-subscriptions');
  const { saveCanopyCloudAccount } =
    await import('../../lib/canopy-cloud-account-store');
  await saveCanopyCloudAccount({
    apiKey: 'csk_golden',
    capabilities: GOLDEN_CLOUD_CAPABILITIES,
    account: {
      id: GOLDEN_ACCOUNT_ID,
      email: 'golden@example.com',
      name: 'Golden',
      role: 'DEVELOPER',
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });

  const replacements: GoldenReplacement[] = [
    { value: worktreePath, token: '<worktree>' },
    { value: sourceRepo, token: '<source-repo>' },
    { value: join(root, 'resources'), token: '<resources>' },
    { value: dataDir, token: '<data>' },
    { value: root, token: '<root>' },
    { value: userPipelineId, token: '<user-pipeline-id>' },
  ];
  return {
    root,
    dataDir,
    sourceRepo,
    worktreePath,
    userPipelineId,
    cloudRequests,
    replacements,
    normalize: (value) => normalizeGoldenValue(value, replacements),
    automationPackages: {
      v1: {
        digest: AUTOMATION_PACKAGES.v1.digest,
        contentHashes: AUTOMATION_PACKAGES.v1.contentHashes,
      },
      v2: {
        digest: AUTOMATION_PACKAGES.v2.digest,
        contentHashes: AUTOMATION_PACKAGES.v2.contentHashes,
      },
      tampered: {
        digest: AUTOMATION_PACKAGES.tampered.digest,
        contentHashes: AUTOMATION_PACKAGES.tampered.contentHashes,
      },
    },
    publishPublicShare: (externalId, rawPipeline): void => {
      const share = publicShares.get(externalId);
      if (!share || share.package)
        throw new Error(`Not a definition-only public share: ${externalId}`);
      publicShares.set(externalId, { ...share, rawPipeline });
    },
    publicSharePin: (externalId): GoldenPublicSharePin => {
      const share = publicShares.get(externalId);
      if (!share) throw new Error(`Unknown public share: ${externalId}`);
      return {
        externalId,
        expectedPipelineContentHash: sha256(share.rawPipeline),
        expectedDistributionMode: share.package ? 'package' : 'definition_only',
        ...(share.package
          ? { expectedPackageDigest: PUBLIC_PACKAGE_DIGEST }
          : {}),
      };
    },
    saveUserPipeline: (yaml, token): Promise<string> => {
      const parsed = parsePipelineText(yaml);
      const result = saveStoredPipeline({
        name: parsed.name,
        description: parsed.description ?? '',
        icon: '',
        content: parsed,
      });
      if (!result.success || !result.data)
        throw new Error(result.error ?? 'Could not save a golden pipeline');
      replacements.push({ value: result.data.id, token: `<${token}>` });
      return Promise.resolve(result.data.id);
    },
    dispose: async (): Promise<void> => {
      // Shared install records flush in the background. Drain both the
      // original world and any simulated relaunch before restoring fetch.
      const currentSubscriptions =
        await import('../../canopy-cloud/shared-item-subscriptions');
      await subscriptions.flushSharedItemSubscriptions();
      if (currentSubscriptions !== subscriptions)
        await currentSubscriptions.flushSharedItemSubscriptions();
      metadataProbe.mockRestore();
      asyncMetadataProbe.mockRestore();
      jest.dontMock('../../lib/linux-secret-service');
      restoreCloud();
      originalEnv.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
}
