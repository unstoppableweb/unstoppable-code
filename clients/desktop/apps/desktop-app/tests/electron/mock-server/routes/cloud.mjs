import {
  EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS,
  migrateExtractedLabsChoices,
} from '@canopy/protocol/experiments';
import { createHash, createHmac } from 'node:crypto';
import { MCP_CATALOG_API_VERSION } from '@canopy/protocol/mcp-catalog';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_SCENARIO,
  getScenario,
  getScenarioActivity,
  keyFromBearer,
  recordScenarioActivity,
  registerScenario,
  waitForBarrier,
} from '../control-plane.mjs';
import { isSharedContainersCloudApiKey } from '../../sharedContainersCloudFixtureKey.mjs';
import { AI_GATEWAY_MODEL_CATALOG } from './ai-gateway-catalog.mjs';

// Canopy Cloud surface for the shared UI-automation mock server.
//
// Ported from the per-test `startMockCanopyCloud` previously in
// `canopy-portal.spec.mjs`. The shared server (see ../start.mjs) runs once for
// the whole Playwright suite (Doc 4 §0); these routes are stateless and keyed by
// the request's Bearer API key so concurrent tests/workers don't collide.

/**
 * The account every guest the mock mints signs in as. A production build with
 * guest mode on mints one at launch, so release-like fixtures that must belong
 * to the signed-in account use it.
 */
export const MOCK_GUEST_ACCOUNT_ID = 'guest-account-e2e';

const CLOUD_CAPABILITIES = [
  'org-projects-v1',
  'org-member-code-projects-v1',
  'org-project-reclaim-v1',
  'pipelines-crud-v1',
  'plans-crud-v1',
  'account-v1',
  'organizations-v1',
  'teams-v1',
  'portal-v1',
  'skills-crud-v1',
  'plugins-crud-v1',
  'agents-crud-v1',
  'automations-crud-v1',
  'automations-target-requirements-v3',
  'automations-run-condition-v4',
  'automations-pipeline-dependencies-v5',
  'automations-pipeline-targets-v6',
  'automation-catalog-v1',
  'collections-crud-v1',
  'workspace-templates-v1',
  'llm-proxy-v1',
  'model-routing-v1',
  'shared-containers-v1',
  'shared-container-dismissals-v1',
];

/**
 * Models a Canopy Cloud deployed before recoverable share removal
 * (CAN-4052): `cloud.withholdSharedContainerDismissalsCapability: true` drops
 * `shared-container-dismissals-v1` from every capability list the key reads,
 * so the desktop's unsupported-server fallback can be exercised end to end.
 */
function withoutWithheldCapabilities(capabilities, cloudScenario) {
  return cloudScenario?.withholdSharedContainerDismissalsCapability === true
    ? capabilities.filter(
        (capability) => capability !== 'shared-container-dismissals-v1',
      )
    : capabilities;
}

/** The account `/api/v1/<ns>/account` reports unless a scenario renames it. */
export const CLOUD_ACCOUNT = {
  id: 'account-e2e',
  name: 'Portal E2E',
  email: 'portal-e2e@example.test',
  role: 'ADMIN',
};

// Mirrors DEFAULT_DIGEST_PREFERENCES in @canopy/protocol/digests, which is the
// single source of truth for the real web service, the web route validators,
// and the desktop cloud client. This fixture is plain ESM loaded by the E2E
// harness outside the TS build graph, so it restates the value rather than
// importing it; keep the two in sync if a cadence is ever added.
const DEFAULT_DIGEST_PREFERENCES = {
  daily: false,
  weekly: true,
  monthly: false,
  weeklyAnchorDay: 1,
  monthlyAnchorDay: 1,
};

const MEMORY_FEEDBACK_CLOUD_API_KEY = 'csk_memory_feedback_e2e';
/**
 * Same memory-eligible account as `MEMORY_FEEDBACK_CLOUD_API_KEY`, on its own
 * key so a spec can count this key's `/memory/search` requests without another
 * spec's searches landing in the same counters (CAN-3457).
 */
const MEMORY_OWNER_CLOUD_API_KEY = 'csk_memory_owner_e2e';
const MEMORY_CLOUD_API_KEYS = new Set([
  MEMORY_FEEDBACK_CLOUD_API_KEY,
  MEMORY_OWNER_CLOUD_API_KEY,
]);
const MEMORY_FEEDBACK_ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333';
const MEMORY_FEEDBACK_ORGANIZATION_NAME = 'Acme Memory';
const MODEL_POLICY_CLOUD_API_KEY = 'csk_model_policy_e2e';
const MODEL_POLICY_ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
/**
 * Signs in as a member of an org that REQUIRES every telemetry-sync scope at
 * organization visibility, so the one-time opt-in modal has nothing the member
 * can set and renders in its read-only, acknowledge-only form.
 */
const TELEMETRY_ALL_LOCKED_CLOUD_API_KEY = 'csk_telemetry_all_locked_e2e';
// A real UUID: telemetry policy is resolved per organization external id
// (CAN-3459), and ids that are not UUIDs are skipped. Specs select this id as
// the workspace context, so keep it in sync with `privacy-settings.spec.mjs`
// and `cloud-sign-in-modal.spec.mjs`.
const TELEMETRY_ALL_LOCKED_ORG_ID = 'e2e1a0c4-7d3b-4c2a-9f10-0000000c3459';
const NOW = '2026-06-18T00:00:00.000Z';
const SCOPED_LINKS_CLOUD_API_KEY = 'csk_brady_scoped_links_e2e';
const SCOPED_LINKS_ORGANIZATION = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Acme Release',
  createdAt: NOW,
  updatedAt: NOW,
};
const SCOPED_LINKS_PIPELINE_ID = '33333333-3333-4333-8333-333333333333';
const SHARED_CONTAINERS_ORGANIZATION_ID =
  '77777777-7777-4777-8777-777777777777';
const SHARED_CONTAINERS_TEAM_ID = '88888888-8888-4888-8888-888888888888';

/**
 * The shared-container fixture organization summary. Its
 * `allowExternalContainerSharing` mirrors the server default (off) unless the
 * scenario sets `sharedContainers.allowExternalContainerSharing: true`, the
 * same knob the shared-container routes read before accepting an email
 * recipient for an organization-owned container.
 */
function sharedContainersOrganization(scenarioKey) {
  return {
    id: SHARED_CONTAINERS_ORGANIZATION_ID,
    name: 'Shared Containers E2E',
    allowExternalContainerSharing:
      getScenario(scenarioKey)?.sharedContainers
        ?.allowExternalContainerSharing === true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const MOCK_SESSION_ID = 'portal-session-e2e';
const MAX_LONG_POLL_TIMEOUT_MS = 25_000;
const pipelinePackageUploads = new Map();
const committedPipelinePackages = new Map();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
const PIPELINE_PUBLIC_SHARE = {
  externalId: 'public-pipeline-e2e',
  pinnedContentHash: 'e2e-hash',
  upToDate: true,
  sharePath: '/portal/plugins/pipelines/shared/public-pipeline-e2e',
  createdAt: NOW,
  updatedAt: NOW,
};

const PLUGIN_PUBLIC_SHARE = {
  externalId: 'fd98d65c-4897-4ce7-bd65-f2875b533210',
  pinnedRefKey: 'codex_plugin:demo/market:gamma-tool',
  upToDate: true,
  sharePath:
    '/portal/plugins/plugins/shared/fd98d65c-4897-4ce7-bd65-f2875b533210',
  createdAt: NOW,
  updatedAt: NOW,
};

const AGENT_SHARE_ID = '7c3f9e42-2f19-4bc4-a43f-95e780f2e68f';
const AGENT_PUBLIC_SHARE_ID = '81fb19b2-522b-43b4-b7f8-edbcc274dcdd';
const AGENT_PACKAGE_PUBLIC_SHARE_ID = '81fb19b2-522b-43b4-b7f8-edbcc274dcde';
const AGENT_DOCUMENT = {
  version: 1,
  id: 'agent_model_public_reviewer',
  name: 'Public Reviewer',
  baseModel: 'sonnet',
  instructions: 'Review shared changes carefully and call out risky edges.',
  plugins: [],
};
const AGENT_PUBLIC_SHARE = {
  externalId: AGENT_PUBLIC_SHARE_ID,
  pinnedContentHash: 'agent-public-e2e-hash',
  upToDate: true,
  sharePath: `/portal/plugins/agents/${AGENT_SHARE_ID}`,
  createdAt: NOW,
  updatedAt: NOW,
};
const AUTOMATION_SHARE_ID = 'c1f5d3a2-7b6e-4c2d-9a1b-0e8f7d6c5b4a';
const AUTOMATION_PUBLIC_SHARE_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const AUTOMATION_SCOPED_CONTENT_HASH = 'd1'.repeat(32);
// Server fixture: the desktop consumes this opaque path without constructing it.
// A real 64-hex digest: the desktop only sends `expectedAutomationContentHash`
// when `isSharedAutomationContentHash` accepts the value, so a placeholder
// string would make the pin silently untestable.
const AUTOMATION_PUBLIC_CONTENT_HASH = 'a1'.repeat(32);
const AUTOMATION_PUBLIC_SHARE = {
  externalId: AUTOMATION_PUBLIC_SHARE_ID,
  pinnedContentHash: AUTOMATION_PUBLIC_CONTENT_HASH,
  upToDate: true,
  sharePath: `/portal/plugins/automations/${AUTOMATION_SHARE_ID}`,
  createdAt: NOW,
  updatedAt: NOW,
};
let automationPublicShare = null;
let sharedAutomationShareScope = 'private';
let sharedAutomationOwner = {
  type: 'user',
  id: CLOUD_ACCOUNT.id,
  name: CLOUD_ACCOUNT.name,
};
let sharedAutomationDocument = {
  version: 1,
  name: 'Nightly review pipeline',
  description: '',
  trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
  action: {
    type: 'worktree_pipeline',
    target: { kind: 'workspace' },
    pipeline: { source: 'bundled', pipelineId: 'code-review' },
    inputKeys: ['branch'],
  },
  hasRunCondition: false,
};
let automationPublicSnapshot = null;
let automationPublicPackage = null;
// A public skill share that carries a capability package: its SKILL.md, a
// supporting file, and a runnable script, in the Claude and Codex trees a
// real share publishes. Built in canonical key order with pre-sorted arrays,
// so `JSON.stringify` is the canonical form and the digest is the one the
// desktop recomputes before installing. Drives
// `skills-install-capability-package.spec.mjs`.
const SKILL_PACKAGE_PUBLIC_SHARE_ID = '7c4e2a91-3b5d-4f6e-8a1c-9d0b2e4f6a83';
const SKILL_PACKAGE_RAW = [
  '---',
  'name: release-notes',
  'description: Draft release notes from merged pull requests.',
  '---',
  '',
  '# Release notes',
  '',
  'Read references/style.md, then run scripts/collect.sh and post the',
  'summary with `mcp__Slack__slack_send_message`.',
  '',
].join('\n');
const SKILL_PACKAGE_FILES = [
  { path: 'SKILL.md', body: SKILL_PACKAGE_RAW, mode: 'read' },
  {
    path: 'references/style.md',
    body: '# Style\n\nLead with the user-visible change.\n',
    mode: 'read',
  },
  {
    path: 'scripts/collect.sh',
    body: '#!/bin/sh\ngit log --merges --oneline "$1"..HEAD\n',
    mode: 'execute',
  },
].map((file) => {
  const bytes = Buffer.from(file.body, 'utf8');
  return {
    ...file,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
});
const SKILL_PACKAGE_BLOBS = new Map(
  SKILL_PACKAGE_FILES.map((file) => [file.sha256, file.bytes]),
);
const SKILL_PACKAGE_CONTENT_HASH = createHash('sha256')
  .update(SKILL_PACKAGE_RAW)
  .digest('hex');
const SKILL_PACKAGE_TREE_BYTES = SKILL_PACKAGE_FILES.reduce(
  (total, file) => total + file.bytes.byteLength,
  0,
);
const SKILL_PACKAGE_MANIFEST = {
  version: 1,
  pipelineContentHash: SKILL_PACKAGE_CONTENT_HASH,
  // One resource per provider over the same folder, as the analyzer emits.
  resources: [
    { provider: 'claude', invocationKey: '/release-notes' },
    { provider: 'codex', invocationKey: '$release-notes' },
  ].map(({ provider, invocationKey }) => ({
    id: `release-notes-${provider}`,
    kind: 'standalone_skill',
    displayName: invocationKey,
    sourceLabel: 'Custom',
    sourceVisibility: 'local',
    invocationKeys: [invocationKey],
    dependencyResourceIds: [],
    trees: [
      {
        provider,
        runtimeKind: 'standalone_skill',
        rootName: 'release-notes',
        entries: SKILL_PACKAGE_FILES.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          size: file.bytes.byteLength,
          mode: file.mode,
        })),
      },
    ],
  })),
  bindings: [
    {
      target: 'subject',
      resourceIds: ['release-notes-claude', 'release-notes-codex'],
    },
  ],
  environmentRequirements: [
    {
      id: 'mcp-slack',
      kind: 'mcp',
      displayName: 'Slack',
      required: false,
      affectedSteps: [],
      setupHint: 'Connect the Slack MCP server in Settings.',
    },
  ],
  totalFiles: SKILL_PACKAGE_FILES.length * 2,
  totalBytes: SKILL_PACKAGE_TREE_BYTES * 2,
};
const SKILL_PACKAGE_DIGEST = `pp:v1:${createHash('sha256')
  .update(JSON.stringify(SKILL_PACKAGE_MANIFEST))
  .digest('base64url')}`;
const CAN3310_PACKAGE_SUMMARY = {
  digest: SKILL_PACKAGE_DIGEST,
  version: 1,
  resources: [
    {
      id: 'release-notes-claude',
      displayName: '/release-notes',
      kind: 'standalone_skill',
      sourceLabel: 'Custom',
      fileCount: SKILL_PACKAGE_FILES.length,
      totalBytes: SKILL_PACKAGE_TREE_BYTES,
      affectedSteps: [],
      executableFiles: ['scripts/collect.sh'],
    },
  ],
  environmentRequirements: SKILL_PACKAGE_MANIFEST.environmentRequirements,
  totalFiles: SKILL_PACKAGE_FILES.length,
  totalBytes: SKILL_PACKAGE_TREE_BYTES,
};
const CAN3310_AGENT_API_KEY = 'csk_can3310_agent_package_e2e';
const CAN3310_COLLECTION_API_KEY = 'csk_can3310_collection_package_e2e';
// A UUID like every real shared collection id: the share resolver behind the
// install review (CAN-3710) rejects anything else.
const CAN3310_COLLECTION_ID = 'c3310000-0000-4000-8000-0000000000c1';
const can3310SharedAgents = new Map();
const can3310SharedCollections = new Map();
const can3310CollectionPackages = new Map();

// The Shared tab lists what this account can see. Before CAN-3135 nothing
// drove that list, so it was hard-coded empty; the public-link row now lives
// on the shared-automation preview, which is only reachable from a listed
// row.
let sharedAutomationCreated = false;
// The capability package committed with the scoped automation share. A share
// whose pipeline only needs setup requirements (no files) still carries a
// requirements-only package, which the install wizard downloads and verifies.
let sharedAutomationPackage = null;

/** The public snapshot's package summary: per-resource steps and sizes. */
function publicAutomationPackageSummary({ digest, manifest }) {
  return {
    digest,
    version: 1,
    resources: manifest.resources.map((resource) => {
      const entries = (resource.trees ?? []).flatMap(
        (tree) => tree.entries ?? [],
      );
      return {
        id: resource.id,
        kind: resource.kind,
        displayName: resource.displayName,
        sourceLabel: resource.sourceLabel,
        invocationKeys: resource.invocationKeys,
        dependencyResourceIds: resource.dependencyResourceIds,
        affectedSteps: (manifest.bindings ?? [])
          .filter((binding) => binding.resourceIds?.includes(resource.id))
          .map(({ jobId, stepId }) => ({ jobId, stepId })),
        totalFiles: entries.length,
        totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
      };
    }),
    environmentRequirements: manifest.environmentRequirements ?? [],
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
  };
}

function sharedAutomationSummary(automation, publicShare) {
  const summary = sharedAutomationDetail(automation, publicShare);
  delete summary.automation;
  return summary;
}

function sharedAutomationDetail(automation, publicShare) {
  return {
    id: AUTOMATION_SHARE_ID,
    name: automation.name,
    description: automation.description,
    triggerKind: automation.trigger.kind,
    actionType: automation.action.type,
    contentHash: AUTOMATION_SCOPED_CONTENT_HASH,
    shareScope: sharedAutomationShareScope,
    owner: sharedAutomationOwner,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: { id: CLOUD_ACCOUNT.id, name: CLOUD_ACCOUNT.name, email: null },
    canUpdate: true,
    canDelete: true,
    publicShare,
    automation,
    // A committed package makes this a package share, which the install
    // wizard verifies before it offers Install.
    ...(sharedAutomationPackage
      ? {
          distributionMode: 'package',
          package: {
            digest: sharedAutomationPackage.digest,
            version: 1,
            resources: sharedAutomationPackage.manifest.resources ?? [],
            environmentRequirements:
              sharedAutomationPackage.manifest.environmentRequirements ?? [],
            totalFiles: sharedAutomationPackage.manifest.totalFiles ?? 0,
            totalBytes: sharedAutomationPackage.manifest.totalBytes ?? 0,
          },
        }
      : {}),
  };
}

function isVisibleSharedResource(resource) {
  return resource?.owner?.type !== 'user' || resource?.publicShare != null;
}

function isVisibleSharedCollection(collection) {
  return collection?.owner?.type !== 'user';
}

/**
 * Applies the audience a create request asked for, as the real server does:
 * a team or organization share is owned by that target, anything else stays
 * a user-owned private row. Names come from the scenario's membership.
 */
function withRequestedAudience(detail, body, scenario) {
  const teams = scenario?.cloud?.teams ?? [];
  const organizations = scenario?.cloud?.organizations ?? [];
  if (body?.shareScope === 'team' && typeof body.teamId === 'string') {
    const team = teams.find((candidate) => candidate.id === body.teamId);
    return {
      ...detail,
      shareScope: 'team',
      owner: {
        type: 'team',
        id: body.teamId,
        name: team?.name ?? null,
        organization: {
          id: team?.organization?.id ?? 'org-e2e',
          name: team?.organization?.name ?? null,
        },
      },
    };
  }
  if (
    body?.shareScope === 'organization' &&
    typeof body.organizationId === 'string'
  ) {
    const organization = organizations.find(
      (candidate) => candidate.id === body.organizationId,
    );
    return {
      ...detail,
      shareScope: 'organization',
      owner: {
        type: 'organization',
        id: body.organizationId,
        name: organization?.name ?? null,
      },
    };
  }
  return detail;
}

/** Filters a scenario's membership list by the picker's `q` query. */
function matchingTargets(targets, url) {
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  return query
    ? targets.filter((target) => target.name.toLowerCase().includes(query))
    : targets;
}

const WORKSPACE_TEMPLATE_SHARE_ID = '5a4b3c2d-1e0f-4a5b-8c7d-6e5f4a3b2c1d';
const WORKSPACE_TEMPLATE_RETRY_SHARE_ID =
  '6b5c4d3e-2f1a-4b6c-9d8e-7f6a5b4c3d2e';
const WORKSPACE_TEMPLATE_DOCUMENT = {
  version: 1,
  name: 'Biology 101',
  description: 'A patient tutoring workspace',
  color: '#7C9B6D',
  instructions: 'Tutor patiently and use short study checks.',
  plugins: [],
  customSkills: [],
};
const WORKSPACE_TEMPLATE_CONTENT_HASH = 'c'.repeat(64);
let workspaceTemplateShareRevoked = false;
let workspaceTemplateRetryResolveCount = 0;
let authoredWorkspaceTemplateShare = null;

function sharedAgentDetail(
  agent = AGENT_DOCUMENT,
  publicShare = null,
  capabilityPackage = null,
) {
  return {
    id: AGENT_SHARE_ID,
    name: agent.name,
    modelId: agent.id,
    baseModel: agent.baseModel,
    instructionsPreview: agent.instructions,
    contentHash: 'agent-shared-e2e-hash',
    shareScope: 'private',
    owner: { type: 'user', id: CLOUD_ACCOUNT.id, name: CLOUD_ACCOUNT.name },
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: { id: CLOUD_ACCOUNT.id, name: CLOUD_ACCOUNT.name },
    canUpdate: true,
    canDelete: true,
    publicShare,
    ...(capabilityPackage
      ? { distributionMode: 'package', package: capabilityPackage }
      : {}),
    agent,
  };
}

const packageConfig = JSON.parse(
  readFileSync(
    new URL('../../../../../../package.json', import.meta.url),
    'utf8',
  ),
);

const MODEL_POLICY_REVIEWED_IDS = [
  ...(packageConfig['claude-code']?.models ?? []),
  ...(packageConfig.codex?.models ?? []),
].flatMap((model) => {
  const id = model.gatewayId ?? model.id;
  return typeof id === 'string' ? [id] : [];
});
const MODEL_POLICY_BLOCKED_ID = 'openai/gpt-5.6-sol';

const SHARED_PIPELINES = [
  {
    id: 'shared-dispatch',
    name: 'Shared Dispatch Pipeline',
    description: 'Visible for manual dispatch',
    icon: '',
    version: '1',
    triggerTypes: ['dispatch'],
    createdBy: { id: 'account-e2e', name: 'Portal E2E' },
    shareScope: 'private',
    owner: { type: 'user', id: 'account-e2e', name: 'Portal E2E' },
    createdAt: NOW,
    updatedAt: NOW,
    canUpdate: true,
    canDelete: true,
    publicShare: { ...PIPELINE_PUBLIC_SHARE, upToDate: false },
    distributionMode: 'package',
    package: {
      digest: 'pp:v1:e2e-shared-dispatch',
      version: 1,
      resources: [],
      environmentRequirements: [
        {
          id: 'shared-fixture-cli',
          kind: 'command',
          displayName: 'canopy-e2e-shared-missing-cli',
          required: true,
          affectedSteps: [{ jobId: 'dispatch', stepId: 'run' }],
          setupHint: 'Install the shared fixture CLI.',
        },
      ],
      totalFiles: 0,
      totalBytes: 0,
    },
    rawPipeline: [
      'name: Shared Dispatch Pipeline',
      'on: dispatch',
      'jobs:',
      '  dispatch:',
      '    steps:',
      '      - run: echo dispatch',
      '',
    ].join('\n'),
  },
  {
    id: 'shared-dual',
    name: 'Shared Dual Trigger Pipeline',
    description: 'Visible for dispatch and plan ready',
    icon: '',
    version: '1',
    triggerTypes: ['dispatch', 'plan_ready'],
    createdBy: { id: 'account-e2e', name: 'Portal E2E' },
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'team-e2e',
      name: 'E2E Team',
      organization: {
        id: 'org-e2e',
        name: 'E2E Org',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
    canUpdate: true,
    canDelete: true,
    rawPipeline: [
      'name: Shared Dual Trigger Pipeline',
      'on:',
      '  - dispatch',
      '  - plan_ready',
      'jobs:',
      '  dual:',
      '    steps:',
      '      - run: echo dual',
      '',
    ].join('\n'),
  },
  {
    id: 'shared-plan-only',
    name: 'Shared Plan Only Pipeline',
    description: 'Hidden from manual dispatch',
    icon: '',
    version: '1',
    triggerTypes: ['plan_ready'],
    createdBy: { id: 'account-e2e', name: 'Portal E2E' },
    shareScope: 'team',
    // A team owner always carries its organization (the protocol requires
    // it); the pipeline scope badge reads its name.
    owner: {
      type: 'team',
      id: 'team-e2e',
      name: 'E2E Team',
      organization: {
        id: 'org-e2e',
        name: 'E2E Org',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
    canUpdate: true,
    canDelete: true,
    rawPipeline: [
      'name: Shared Plan Only Pipeline',
      'on: plan_ready',
      'jobs:',
      '  plan:',
      '    steps:',
      '      - run: echo plan',
      '',
    ].join('\n'),
  },
  {
    id: 'shared-other-public',
    name: 'Other User Public Pipeline',
    description: "Another user's publicly shared pipeline",
    icon: '',
    version: '1',
    triggerTypes: ['plan_ready'],
    createdBy: { id: 'account-other-e2e', name: 'Other User' },
    shareScope: 'private',
    owner: { type: 'user', id: 'account-other-e2e', name: 'Other User' },
    createdAt: NOW,
    updatedAt: NOW,
    canUpdate: false,
    canDelete: false,
    publicShare: {
      externalId: 'public-other-e2e',
      pinnedContentHash: 'e2e-other-hash',
      upToDate: true,
      sharePath: '/portal/plugins/pipelines/shared/public-other-e2e',
      createdAt: NOW,
      updatedAt: NOW,
    },
    rawPipeline: [
      'name: Other User Public Pipeline',
      'on: plan_ready',
      'jobs:',
      '  review:',
      '    steps:',
      '      - run: echo other-user-review',
      '',
    ].join('\n'),
  },
];

const MARKETPLACE_SHARED_SKILL = {
  id: 'marketplace-review-skill',
  name: 'Marketplace Review Skill',
  description: 'Reviews a release before publishing.',
  contentHash: 'sha256:marketplace-review-skill',
  shareScope: 'organization',
  owner: { type: 'organization', id: 'org-e2e', name: 'E2E Organization' },
  createdBy: {
    id: CLOUD_ACCOUNT.id,
    name: CLOUD_ACCOUNT.name,
    email: CLOUD_ACCOUNT.email,
  },
  createdAt: NOW,
  updatedAt: NOW,
  canUpdate: true,
  canDelete: true,
  publicShare: null,
  rawSkill:
    '---\nname: Marketplace Review Skill\ndescription: Reviews a release before publishing.\n---\n\n# Review\n',
};

const MARKETPLACE_SHARED_COLLECTION = {
  id: 'marketplace-review-collection',
  name: 'Marketplace Review Collection',
  description: 'Capabilities used for release review.',
  contentHash: 'sha256:marketplace-review-collection',
  itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
  shareScope: 'organization',
  owner: { type: 'organization', id: 'org-e2e', name: 'E2E Organization' },
  createdBy: {
    id: CLOUD_ACCOUNT.id,
    name: CLOUD_ACCOUNT.name,
    email: CLOUD_ACCOUNT.email,
  },
  createdAt: NOW,
  updatedAt: NOW,
  canUpdate: true,
  canDelete: true,
  rawCollection:
    '{"version":1,"name":"Marketplace Review Collection","description":"Capabilities used for release review.","items":[]}',
  collection: {
    version: 1,
    name: 'Marketplace Review Collection',
    description: 'Capabilities used for release review.',
    items: [],
  },
  customSkills: [],
};

const CAN3310_SHARED_COLLECTION = {
  id: CAN3310_COLLECTION_ID,
  name: 'Release Readiness Collection',
  description: 'A packaged local skill plus Slack setup.',
  contentHash: 'sha256:can3310-package-collection',
  itemCounts: { skills: 1, plugins: 0, customSkills: 1 },
  shareScope: 'organization',
  owner: { type: 'organization', id: 'org-e2e', name: 'E2E Organization' },
  createdBy: {
    id: CLOUD_ACCOUNT.id,
    name: CLOUD_ACCOUNT.name,
    email: CLOUD_ACCOUNT.email,
  },
  createdAt: NOW,
  updatedAt: NOW,
  canUpdate: true,
  canDelete: true,
  distributionMode: 'package',
  package: CAN3310_PACKAGE_SUMMARY,
  rawCollection: JSON.stringify({
    version: 1,
    name: 'Release Readiness Collection',
    description: 'A packaged local skill plus Slack setup.',
    items: [],
  }),
  collection: {
    version: 1,
    name: 'Release Readiness Collection',
    description: 'A packaged local skill plus Slack setup.',
    items: [],
  },
  customSkills: [],
};

const SCOPED_LINKS_PIPELINE = {
  id: SCOPED_LINKS_PIPELINE_ID,
  name: 'Scoped Release Pipeline',
  description: 'Deploys the internal release for Acme members.',
  icon: '',
  version: '1',
  triggerTypes: ['dispatch'],
  createdBy: { id: CLOUD_ACCOUNT.id, name: CLOUD_ACCOUNT.name },
  shareScope: 'organization',
  owner: {
    type: 'organization',
    id: SCOPED_LINKS_ORGANIZATION.id,
    name: SCOPED_LINKS_ORGANIZATION.name,
  },
  createdAt: NOW,
  updatedAt: NOW,
  canUpdate: true,
  canDelete: true,
  rawPipeline: [
    'name: Scoped Release Pipeline',
    'on: dispatch',
    'jobs:',
    '  deploy:',
    '    steps:',
    '      - run: echo scoped-release',
    '',
  ].join('\n'),
};

function toPipelineSummary(pipeline) {
  const { rawPipeline, ...summary } = pipeline;
  return summary;
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', () => resolve(undefined));
  });
}

// Agent Ledger mirror (phase 13). Per-key state: the sequence each scope's
// mirror holds. A scenario's `cloud.ledger` slice decides how it answers:
//
//   ledger.ingest: 'accept' (default) | 'disabled' | 'prohibited'
//     'disabled' answers as the ingest kill switch does (503, retry later);
//     'prohibited' as a summaries prohibition does (403, never).
//   ledger.push:   'accept' (default) | 'stale_writer'
//     'stale_writer' refuses every push as from a superseded writer (409).
//   ledger.feed:   the mirror's read side, for the Feed (phase 14):
//     { mine, teammates, actors, entries } | 'unavailable'
//     `mine` and `teammates` are search rows (`LedgerMirrorEntry`) for each
//     audience, `actors` their labels, `entries` the entry responses by ID;
//     'unavailable' answers every read as a server outage (503). A search
//     applies its filters as the mirror does (`matchesLedgerSearch`).
//
// Activity: `ledgerRegister` and `ledgerPush` count requests, `ledgerEvents`
// the events the mirror applied, `ledgerSearch` the Feed's searches.
const ledgerMirrors = new Map();

function ledgerMirrorScopes(key) {
  let scopes = ledgerMirrors.get(key);
  if (!scopes) {
    scopes = new Map();
    ledgerMirrors.set(key, scopes);
  }
  return scopes;
}

function ledgerError(response, status, code, retry, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...headers,
  });
  response.end(
    JSON.stringify({ error: { code, message: `Mock ${code}`, retry } }),
  );
}

/** Answers a refused ingest; true when the request was refused. */
function refuseLedgerIngest(response, ledger) {
  if (ledger.ingest === 'disabled') {
    ledgerError(response, 503, 'ledger_ingest_disabled', 'later', {
      'retry-after': '1',
    });
    return true;
  }
  if (ledger.ingest === 'prohibited') {
    ledgerError(response, 403, 'ledger_scope_prohibited', 'never');
    return true;
  }
  return false;
}

/** Newest change first, as the mirror's `updated_desc` search orders. */
function byNewestChange(left, right) {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt < right.updatedAt ? 1 : -1;
  }
  return left.entryId < right.entryId ? 1 : -1;
}

/** The lowercased words of a row's title, content and highlights. */
function ledgerRowWords(row) {
  return [row.title, row.content, ...(row.highlights ?? [])]
    .filter((text) => typeof text === 'string')
    .join(' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Whether a search row passes the request's filters, as the mirror applies
 * them: each word of the query matches the start of a word of the entry, and
 * an owner or author of `self` is the account's own user.
 */
function matchesLedgerSearch(row, body) {
  if (body?.includeArchived !== true && row.scopeArchived) return false;
  if (Array.isArray(body?.types) && !body.types.includes(row.type)) {
    return false;
  }
  if (Array.isArray(body?.statuses) && !body.statuses.includes(row.status)) {
    return false;
  }
  if (
    typeof body?.updatedAfter === 'string' &&
    Date.parse(row.updatedAt) < Date.parse(body.updatedAfter)
  ) {
    return false;
  }
  const own = (actor) => actor?.kind === 'user' && row.source?.kind === 'mine';
  if (body?.owner === 'self' && !own(row.owner)) return false;
  if (body?.author === 'self' && !own(row.author)) return false;
  if (typeof body?.query === 'string') {
    const words = ledgerRowWords(row);
    const parts = body.query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((part) => part.length > 0);
    if (!parts.every((part) => words.some((word) => word.startsWith(part)))) {
      return false;
    }
  }
  return true;
}

const LEDGER_MIRROR_CAPABILITIES_HEADER = 'x-canopy-ledger-capabilities';

/** Whether this mirror read requested the version 2 operations fields. */
function hasLedgerOperationsCapability(request) {
  const header = Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === LEDGER_MIRROR_CAPABILITIES_HEADER,
  )?.[1];
  const value = Array.isArray(header) ? header.join(',') : header;
  return (
    typeof value === 'string' &&
    value
      .split(',')
      .some((token) => token.trim().toLowerCase() === 'operations')
  );
}

function hasOwn(object, key) {
  if (object === null || typeof object !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

/** Whether a push carries a field only an operations version (3 or 4) can. */
function ledgerPushNeedsOperationsVersion(events) {
  return (Array.isArray(events) ? events : []).some((event) => {
    const payload = event?.payload;
    const entry = payload?.entry;
    const mutation = payload?.mutation;
    return (
      entry?.type === 'OPERATION' ||
      hasOwn(entry, 'parentEntryId') ||
      hasOwn(mutation, 'parent') ||
      hasOwn(mutation, 'leftOpen')
    );
  });
}

/** Copy an entry response into the strict version 1 shape. */
function withoutLedgerOperationsFields(entryResponse) {
  const entry = entryResponse?.entry;
  const { parentEntryId: _parentEntryId, ...v1Entry } = entry ?? {};
  const history = entryResponse?.history;
  const mutations = (history?.mutations ?? []).flatMap((mutation) => {
    const { parent: _parent, leftOpen: _leftOpen, ...v1Mutation } = mutation;
    if (
      v1Mutation.kind !== 'create' &&
      v1Mutation.status === undefined &&
      v1Mutation.owner === undefined
    ) {
      return [];
    }
    return [v1Mutation];
  });
  return {
    ...entryResponse,
    ...(entryResponse?.entry === undefined ? {} : { entry: v1Entry }),
    ...(history === undefined ? {} : { history: { ...history, mutations } }),
  };
}

/** Whether a row's parent chain reaches a requested root. */
function isLedgerDescendantOf(row, rootEntryId, rowsById) {
  let current = row;
  const visited = new Set();
  while (current && !visited.has(current.entryId)) {
    if (current.entryId === rootEntryId) return true;
    visited.add(current.entryId);
    current = current.parentEntryId
      ? rowsById.get(current.parentEntryId)
      : undefined;
  }
  return false;
}

/** The mirror's search and entry reads; true when the request was one. */
async function handleLedgerReadRequest(request, response, pathname) {
  const isSearch =
    request.method === 'POST' && pathname === '/api/v1/ledger/search';
  const entryMatch =
    request.method === 'GET'
      ? /^\/api\/v1\/ledger\/entries\/([^/]+)$/.exec(pathname)
      : null;
  if (!isSearch && entryMatch === null) return false;
  if (!hasValidAuth(request)) {
    jsonResponse(response, 401, { error: 'Invalid API key.' });
    return true;
  }
  const key = keyFromBearer(request);
  const feed = getScenario(key).cloud?.ledger?.feed;
  if (feed === 'unavailable') {
    ledgerError(response, 503, 'ledger_unavailable', 'later');
    return true;
  }
  if (isSearch) {
    const body = await readJsonBody(request);
    recordScenarioActivity(key, 'ledgerSearch');
    const hasOperations = hasLedgerOperationsCapability(request);
    if (
      !hasOperations &&
      (hasOwn(body, 'parentEntryId') ||
        hasOwn(body, 'rootEntryId') ||
        (Array.isArray(body?.types) && body.types.includes('OPERATION')))
    ) {
      ledgerError(response, 400, 'ledger_invalid_request', 'never');
      return true;
    }
    const audience = body?.audience === 'teammates' ? 'teammates' : 'mine';
    const sourceRows = [...(feed?.[audience] ?? [])];
    const rowsById = new Map(sourceRows.map((row) => [row.entryId, row]));
    const rows = sourceRows
      .filter((row) => hasOperations || row.type !== 'OPERATION')
      .filter((row) =>
        hasOperations && hasOwn(body, 'parentEntryId')
          ? body.parentEntryId === null
            ? row.parentEntryId === undefined || row.parentEntryId === null
            : row.parentEntryId === body.parentEntryId
          : true,
      )
      .filter((row) =>
        hasOperations && typeof body?.rootEntryId === 'string'
          ? isLedgerDescendantOf(row, body.rootEntryId, rowsById)
          : true,
      )
      .filter((row) => matchesLedgerSearch(row, body))
      .map((row) => {
        if (hasOperations || !hasOwn(row, 'parentEntryId')) return row;
        const { parentEntryId: _parentEntryId, ...v1Row } = row;
        return v1Row;
      })
      .sort(byNewestChange);
    jsonResponse(response, 200, {
      entries: rows,
      actors: feed?.actors ?? [],
      nextCursor: null,
      hasMore: false,
    });
    return true;
  }
  const entry = feed?.entries?.[decodeURIComponent(entryMatch[1])];
  const hasOperations = hasLedgerOperationsCapability(request);
  if (!entry || (!hasOperations && entry.entry?.type === 'OPERATION')) {
    ledgerError(response, 404, 'ledger_entry_not_found', 'never');
    return true;
  }
  jsonResponse(
    response,
    200,
    hasOperations ? entry : withoutLedgerOperationsFields(entry),
  );
  return true;
}

async function handleLedgerRequest(request, response, pathname) {
  const isRegister = pathname === '/api/v1/ledger/scopes/register';
  const isPush = pathname === '/api/v1/ledger/sync/push';
  if (request.method !== 'POST' || (!isRegister && !isPush)) return false;
  if (!hasValidAuth(request)) {
    jsonResponse(response, 401, { error: 'Invalid API key.' });
    return true;
  }
  const key = keyFromBearer(request);
  const ledger = getScenario(key).cloud?.ledger ?? {};
  const body = await readJsonBody(request);
  recordScenarioActivity(key, isRegister ? 'ledgerRegister' : 'ledgerPush');
  if (refuseLedgerIngest(response, ledger)) return true;
  const scopes = ledgerMirrorScopes(key);
  if (isRegister) {
    const scope = scopes.get(body?.ledgerId) ?? { acknowledged: 0 };
    scopes.set(body?.ledgerId, scope);
    const audience =
      body?.audience?.kind === 'organization'
        ? {
            kind: 'organization',
            organizationId: '44444444-4444-4444-8444-444444444444',
            trackedWorkspaceId: body.audience.trackedWorkspaceId,
            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
          }
        : { kind: 'private' };
    jsonResponse(response, 200, {
      ledgerId: body?.ledgerId,
      writerEpoch: '1',
      acknowledgedSequence: String(scope.acknowledged),
      audience,
    });
    return true;
  }
  // Versions 1 and 2 are plain task and global batches; 3 and 4 carry
  // operation fields.
  if (
    ![1, 2, 3, 4].includes(body?.schemaVersion) ||
    (body.schemaVersion <= 2 && ledgerPushNeedsOperationsVersion(body.events))
  ) {
    ledgerError(response, 400, 'ledger_invalid_request', 'never');
    return true;
  }
  const scope = scopes.get(body?.ledgerId);
  if (!scope) {
    ledgerError(response, 404, 'ledger_scope_not_registered', 'after_register');
    return true;
  }
  if (ledger.push === 'stale_writer') {
    ledgerError(response, 409, 'ledger_stale_writer', 'never');
    return true;
  }
  if (Number(body?.acknowledgedSequence) > scope.acknowledged) {
    ledgerError(response, 409, 'ledger_sequence_gap', 'never');
    return true;
  }
  let applied = 0;
  let replayed = 0;
  for (const event of body?.events ?? []) {
    const sequence = Number(event.scopeSequence);
    if (sequence <= scope.acknowledged) {
      replayed += 1;
    } else if (sequence === scope.acknowledged + 1) {
      scope.acknowledged = sequence;
      applied += 1;
      recordScenarioActivity(key, 'ledgerEvents');
    } else {
      ledgerError(response, 409, 'ledger_sequence_gap', 'never');
      return true;
    }
  }
  recordScenarioActivity(key, `ledgerPushVersion${body.schemaVersion}`);
  jsonResponse(response, 200, {
    ledgerId: body.ledgerId,
    acknowledgedSequence: String(scope.acknowledged),
    applied,
    replayed,
  });
  return true;
}

function readBinaryBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function parseLongPollTimeout(url) {
  const raw = url.searchParams.get('timeoutMs');
  const parsed = raw == null ? 0 : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(Math.max(parsed, 0), MAX_LONG_POLL_TIMEOUT_MS);
}

function waitForLongPollTimeout(response, timeoutMs) {
  if (timeoutMs <= 0 || response.destroyed || response.writableEnded) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      response.off('close', finish);
      resolve();
    };

    timer = setTimeout(finish, timeoutMs);
    response.once('close', finish);
  });
}

// Collapse any `/api/v1/<namespace>` prefix to the canonical `/api/v1/canopy`
// so brand-specific namespaces resolve to the same handlers.
function normalizeApiNamespace(pathname) {
  if (pathname.startsWith('/api/v1/ai-credits/')) {
    return pathname;
  }
  // These desktop probe endpoints live at top-level `/api/v1/*` paths (not
  // brand-namespaced), so preserve them rather than collapsing the segment.
  // Feedback is the same shape: `feedback` is a resource segment, not a brand,
  // so collapsing it would rewrite `/api/v1/feedback/reports` to
  // `/api/v1/canopy/reports` and 404 the route below.
  if (
    pathname === '/api/v1/entitlements' ||
    pathname === '/api/v1/mobile-activation' ||
    pathname.startsWith('/api/v1/model-routing/') ||
    pathname.startsWith('/api/v1/product-activity/') ||
    pathname.startsWith('/api/v1/feedback/') ||
    pathname.startsWith('/api/v1/device-relay/') ||
    pathname.startsWith('/api/v1/pipeline-packages/') ||
    pathname.startsWith('/api/v1/public-shares/') ||
    pathname.startsWith('/api/v1/mcp-servers/') ||
    pathname.startsWith('/api/v1/curated-automations') ||
    pathname.startsWith('/api/v1/agents/') ||
    pathname.startsWith('/api/v1/automations/') ||
    pathname.startsWith('/api/v1/collections/') ||
    pathname.startsWith('/api/v1/projects/') ||
    pathname.startsWith('/api/v1/organizations/') ||
    pathname.startsWith('/api/v1/experiments/') ||
    pathname.startsWith('/api/v1/ledger/') ||
    pathname.startsWith('/api/v1/account/')
  ) {
    return pathname;
  }
  return pathname.replace(/^\/api\/v1\/[^/]+/, '/api/v1/canopy');
}

// Dedicated key for the subscription-status pill spec. Only this key gets a
// billing grant from `/api/v1/entitlements`; every other key keeps the default
// 404 (unlinked account) so the data-sync privacy-gate specs are unaffected.
const SUBSCRIPTION_PILL_TRIAL_KEY = 'csk_subscription_pill_e2e';
const SUBSCRIPTION_PILL_BUSINESS_TRIAL_KEY =
  'csk_subscription_pill_business_e2e';

// Dedicated key for CAN-1939. Every other valid key resolves false so specs
// can transition from eligible to activated without involving live services.
const MOBILE_ACTIVATION_KEY = 'csk_mobile_activation_e2e';

// Dedicated key for the Usage page AI Credits tile spec. Since native billing
// (CAN-1557) the tile's plan chip is fed by `loadCanopyCloudEntitlements`
// (`/api/v1/entitlements`) via `useSubscriptionStatus`, not the AI-credits
// subscription route, so this key gets a paid `Pro` grant. Every other key
// still 404s (unlinked) so the privacy-gate specs are unaffected.
const USAGE_AI_CREDITS_TILE_KEY = 'csk_usage_ai_credits_tile_e2e';

// Dedicated keys for the CAN-2311 lapsed-org specs. `/api/v1/canopy/account`
// answers each of them with the SAME two orgs and a different per-org
// entitlement mix, because the whole contract under test is per-org: the lapsed
// org must be named and blocked while the healthy one is untouched. Only these
// keys get `orgBillingStates`; every other key keeps the key absent entirely,
// which is the "older server" shape and must degrade to today's ungated
// behavior.
//
// Keeping the org ids/names fixed across the three fixtures is what makes the
// mid-session refresh spec meaningful: swapping the connected key is a pure
// change of BILLING STATE for orgs the account already belongs to, i.e. exactly
// the "org lapsed / org restored while the app is open" transition the banner's
// account-changed subscription exists to notice.
const ORG_LAPSED_KEY = 'csk_org_lapsed_e2e';
// Same two orgs, both entitled: the "admin already restored the org" snapshot.
const ORG_RESTORED_KEY = 'csk_org_restored_e2e';
// Same two orgs, with the OTHER one lapsed. Used to prove a dismissal is scoped
// to the org set it was taken against rather than muting the banner outright.
const ORG_OTHER_LAPSED_KEY = 'csk_org_lapsed_other_e2e';
// Empty personal wallet covered by an org credit pool. Distinct from the lapse
// fixtures above: this org is HEALTHY and funding, which is what makes the
// AI-Credits banner render at all (`resolveChatBillingFramework` needs
// `personalEligible || orgSpendable`, and this key has only the org half).
const ORG_FUNDED_CREDITS_KEY = 'csk_org_funded_credits_e2e';
const ORG_FUNDED_ID = '66666666-6666-4666-8666-666666666666';
const ORG_FUNDED_ORGANIZATIONS = [
  {
    id: ORG_FUNDED_ID,
    name: 'Acme E2E',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];
// `OrgAiCreditsSpendable` with real headroom — the org pool the gateway would
// debit once the member's personal wallet is empty.
const ORG_FUNDED_SPENDABLE = {
  hasSpendableHeadroom: true,
  hasBalanceNow: true,
  canReplenish: true,
  orgCreditPoolCapable: true,
  balanceCredits: 50_000,
  balanceUsd: 500,
  hasPaymentMethodOnFile: true,
  billingActive: true,
};
/**
 * CAN-3463: the balance endpoint reports only the pool of the organization
 * that owns the work, named by the `x-canopy-work-owner` header. With an
 * `aiCreditsOrgPools` scenario (`{ [orgId]: orgName }` of FUNDED pools) the
 * mock honors that header like the real server: an owning org with a funded
 * pool gets `orgPool`; Personal, a missing header, or an unfunded org gets
 * none. Without the scenario the response is unchanged.
 * @param {import('node:http').IncomingMessage} request
 * @param {Record<string, string> | undefined} pools
 * @returns {Record<string, unknown>}
 */
function scopedOrgPoolFor(request, pools) {
  if (!pools || typeof pools !== 'object') return {};
  const header = request.headers['x-canopy-work-owner'];
  const owner = typeof header === 'string' ? header.trim().toLowerCase() : '';
  const orgId = owner.startsWith('org:') ? owner.slice('org:'.length) : null;
  const orgName = orgId ? pools[orgId] : undefined;
  return typeof orgName === 'string'
    ? {
        orgPool: { orgId, orgName },
        orgFundingAvailable: true,
      }
    : { orgPool: null, orgFundingAvailable: false };
}

const NO_ORG_SPENDABLE = {
  hasSpendableHeadroom: false,
  hasBalanceNow: false,
  canReplenish: false,
  orgCreditPoolCapable: false,
  balanceCredits: 0,
  balanceUsd: 0,
  hasPaymentMethodOnFile: false,
  billingActive: false,
};
// Brand-agnostic: the desktop builds this path from `BRAND.web.apiNamespace`
// (`desktop-app` for the canopy brand), so match the namespace segment rather
// than pinning one brand's value into the mock.
const ORG_CREDITS_SPENDABLE_PATH =
  /^\/api\/v1\/[^/]+\/organizations\/([^/]+)\/billing\/credits\/spendable$/;
const ORG_LAPSED_ID = '44444444-4444-4444-8444-444444444444';
const ORG_HEALTHY_ID = '55555555-5555-4555-8555-555555555555';
// CAN-2349: deterministic account whose org credit pool exists but has no
// spendable headroom, driving the recovery modal's contact-admin branch.
//
// The id MUST stay distinct from every other org id above. Its spendable route
// is registered ahead of the generic `ORG_CREDITS_SPENDABLE_PATH` handler and
// 404s any other bearer, so sharing an id with a funding org (as this briefly
// did with `ORG_FUNDED_ID`) silently strips that org's headroom and the
// AI-Credits banner stops rendering.
const MODEL_RECOVERY_CONTACT_ADMIN_KEY = 'csk_model_recovery_contact_admin_e2e';
const MODEL_RECOVERY_CONTACT_ADMIN_ORG_ID =
  '77777777-7777-4777-8777-777777777777';
const ORG_LAPSED_BILLING_STATES = [
  {
    organizationId: ORG_LAPSED_ID,
    organizationName: 'Acme E2E',
    teamsEntitled: false,
    trialEndedAt: '2026-05-01T00:00:00.000Z',
  },
  {
    organizationId: ORG_HEALTHY_ID,
    organizationName: 'Globex E2E',
    teamsEntitled: true,
  },
];
const ORG_RESTORED_BILLING_STATES = [
  {
    organizationId: ORG_LAPSED_ID,
    organizationName: 'Acme E2E',
    teamsEntitled: true,
  },
  {
    organizationId: ORG_HEALTHY_ID,
    organizationName: 'Globex E2E',
    teamsEntitled: true,
  },
];
const ORG_OTHER_LAPSED_BILLING_STATES = [
  {
    organizationId: ORG_LAPSED_ID,
    organizationName: 'Acme E2E',
    teamsEntitled: true,
  },
  {
    organizationId: ORG_HEALTHY_ID,
    organizationName: 'Globex E2E',
    teamsEntitled: false,
    trialEndedAt: '2026-05-01T00:00:00.000Z',
  },
];
const ORG_BILLING_STATE_FIXTURES = new Map([
  [ORG_LAPSED_KEY, ORG_LAPSED_BILLING_STATES],
  [ORG_RESTORED_KEY, ORG_RESTORED_BILLING_STATES],
  [ORG_OTHER_LAPSED_KEY, ORG_OTHER_LAPSED_BILLING_STATES],
]);
// Must be a well-formed `CanopyOrganizationSummary` (id/name/createdAt/updatedAt)
// or the desktop's `normalizeOrganizations` drops the entry and the account
// reads as belonging to no org at all — which would quietly disable the very
// org-scoped reads the fixture exists to exercise.
const ORG_LAPSED_ORGANIZATIONS = [
  {
    id: ORG_LAPSED_ID,
    name: 'Acme E2E',
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: ORG_HEALTHY_ID,
    name: 'Globex E2E',
    createdAt: NOW,
    updatedAt: NOW,
  },
];

// Accept any `csk_`-prefixed key so each test can use its own per-test key.
/**
 * Device relay token (device-to-device remote access). A spec opts in by
 * registering `cloud.deviceRelay: { url, secret, userId }` and running
 * `apps/device-relay` with the same secret; the token format matches
 * `apps/web/src/lib/device-relay/token.ts`.
 */
function handleDeviceRelayToken(request, response, body) {
  if (!hasValidAuth(request)) {
    jsonResponse(response, 401, { error: 'Invalid API key.' });
    return;
  }
  const relay = getScenario(keyFromBearer(request)).cloud?.deviceRelay;
  if (!relay) {
    jsonResponse(response, 503, {
      error: 'Remote access is not configured.',
      code: 'device_relay_not_configured',
    });
    return;
  }
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
  if (!/^[A-Za-z0-9_-]{22}$/.test(deviceId)) {
    jsonResponse(response, 400, { error: 'Invalid device ID.' });
    return;
  }
  const expiresAt = Date.now() + 10 * 60_000;
  const payload = Buffer.from(
    JSON.stringify({ v: 1, userId: relay.userId, deviceId, expiresAt }),
  ).toString('base64url');
  const signature = createHmac('sha256', relay.secret)
    .update(payload)
    .digest('base64url');
  jsonResponse(response, 200, {
    token: `${payload}.${signature}`,
    relayUrl: relay.url,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

function hasValidAuth(request) {
  const authorization = request.headers.authorization ?? '';
  return /^Bearer\s+csk_/.test(authorization);
}

/**
 * Handle a Canopy Cloud request. Returns `true` if the request matched a cloud
 * route (and a response was written), `false` otherwise.
 */
export async function handleCloudRequest(request, response, url) {
  const pathname = normalizeApiNamespace(url.pathname);
  if (request.method === 'GET' && pathname === '/api/v1/mcp-servers/curated') {
    jsonResponse(response, 200, {
      version: MCP_CATALOG_API_VERSION,
      servers: [],
    });
    return true;
  }
  if (
    request.method === 'POST' &&
    /^\/api\/v1\/canopy\/(skills|pipelines)(?:\/[^/]+\/public-share)?$/.test(
      pathname,
    )
  ) {
    recordScenarioActivity(
      keyFromBearer(request),
      'capabilityPublicationRequests',
    );
  }
  if (pathname === '/api/v1/device-relay/token' && request.method === 'POST') {
    handleDeviceRelayToken(request, response, await readJsonBody(request));
    return true;
  }
  // CAN-3633's client-layout tests create real shares in an isolated keyed
  // scenario. Other fixtures keep the existing static responses below.
  const scenario = getScenario(keyFromBearer(request));
  // CAN-3662: complete account choice sets, isolated by fixture credential.
  if (
    pathname === '/api/v1/experiments/choices' ||
    pathname.startsWith('/api/v1/experiments/choices/')
  ) {
    const scenarioKey = keyFromBearer(request);
    const configured = scenario.cloud?.experiments ?? {};
    if (
      !hasValidAuth(request) ||
      configured.anonymous ||
      configured.serviceAccount
    ) {
      jsonResponse(response, 401, {
        error: 'Authentication required',
        code: 'unauthorized',
      });
      return true;
    }
    // Mirror the account service's one-time extraction before either API verb.
    const previousChoices = configured.choices ?? {};
    configured.choices =
      request.headers['x-labs-experiments-version'] === '2'
        ? migrateExtractedLabsChoices(previousChoices)
        : previousChoices;
    if (scenario === DEFAULT_SCENARIO) registerScenario(scenarioKey, {});
    const choicesScenario = getScenario(scenarioKey);
    choicesScenario.cloud ??= {};
    choicesScenario.cloud.experiments = configured;
    const delayMs =
      request.method === 'GET' ? configured.getDelayMs : configured.putDelayMs;
    // Capture GET state before delaying, to reproduce a stale GET versus PUT.
    const captured = { ...(configured.choices ?? {}) };
    if (delayMs > 0) await delay(delayMs);
    const failure =
      request.method === 'GET' ? configured.getStatus : configured.putStatus;
    if (failure && failure !== 200) {
      jsonResponse(response, failure, { error: 'Fixture choice failure' });
      return true;
    }
    if (
      pathname === '/api/v1/experiments/choices' &&
      request.method === 'GET'
    ) {
      recordScenarioActivity(scenarioKey, 'experimentChoicesGet');
      jsonResponse(response, 200, {
        choices:
          request.headers['x-labs-experiments-version'] === '2'
            ? captured
            : Object.fromEntries(
                Object.entries(captured).filter(
                  ([id]) => !EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS.includes(id),
                ),
              ),
      });
      return true;
    }
    const experimentId = pathname.slice('/api/v1/experiments/choices/'.length);
    if (
      request.method !== 'PUT' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(experimentId)
    ) {
      jsonResponse(response, 400, { error: 'Invalid experiment id' });
      return true;
    }
    const body = await readJsonBody(request);
    if (
      !body ||
      typeof body.enabled !== 'boolean' ||
      Object.keys(body).length !== 1
    ) {
      jsonResponse(response, 400, { error: 'Invalid body' });
      return true;
    }
    const choices = configured.choices ?? {};
    if (
      !Object.hasOwn(choices, experimentId) &&
      !EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS.includes(experimentId) &&
      Object.keys(choices).filter(
        (id) => !EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS.includes(id),
      ).length >= 100
    ) {
      jsonResponse(response, 409, {
        error: 'Experiment choice limit reached',
        code: 'experiment_choice_limit',
      });
      return true;
    }
    configured.choices = { ...choices, [experimentId]: body.enabled };
    if (scenario === DEFAULT_SCENARIO) registerScenario(scenarioKey, {});
    const keyedScenario = getScenario(scenarioKey);
    keyedScenario.cloud ??= {};
    keyedScenario.cloud.experiments = configured;
    recordScenarioActivity(scenarioKey, 'experimentChoicesPut', {
      experimentId,
      enabled: body.enabled,
    });
    jsonResponse(response, 200, {
      experimentId,
      enabled: body.enabled,
      updatedAt: new Date().toISOString(),
      ...(request.headers['x-labs-experiments-version'] === '2'
        ? { choices: configured.choices }
        : {}),
    });
    return true;
  }
  const organizationOperation = pathname.match(
    /^\/api\/v1\/organizations\/([^/]+)\/(upgrade|invites)$/,
  );
  if (
    organizationOperation &&
    scenario.cloud?.personalOrganizationUpgrade === true
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, {
        error: 'Invalid API key.',
        code: 'unauthorized',
      });
      return true;
    }
    const [, organizationId, action] = organizationOperation;
    const cloud = scenario.cloud;
    if (action === 'upgrade' && request.method === 'POST') {
      const body = await readJsonBody(request);
      cloud.promotionReceipts ??= {};
      const receipt = cloud.promotionReceipts[body.operationId];
      if (receipt) {
        if (
          receipt.organizationId !== organizationId ||
          receipt.name !== body.name?.trim()
        )
          jsonResponse(response, 409, {
            error: 'Operation conflict',
            code: 'operation_conflict',
          });
        else jsonResponse(response, 200, { ...receipt, alreadyUpgraded: true });
        return true;
      }
      if (cloud.personalOrganizationId !== organizationId) {
        jsonResponse(response, 404, {
          error: 'Organization not found',
          code: 'not_found',
        });
        return true;
      }
      if (typeof body.name !== 'string' || !body.name.trim()) {
        jsonResponse(response, 400, {
          error: 'Enter a team name',
          code: 'invalid_request',
        });
        return true;
      }
      const replacement = randomUUID();
      const result = {
        organizationId,
        operationId: body.operationId,
        name: body.name.trim(),
        personalOrganizationId: replacement,
        alreadyUpgraded: false,
        warnings: [],
      };
      cloud.personalOrganizationId = replacement;
      cloud.organizations = [
        ...(cloud.organizations ?? []),
        {
          id: organizationId,
          name: result.name,
          role: 'OWNER',
          createdAt: NOW,
          updatedAt: NOW,
          automaticPersonalProjectConversionExcluded: true,
        },
      ];
      if (cloud.personalUpgradeDestinationUnavailable === true)
        cloud.organizations = cloud.organizations.filter(
          (organization) => organization.id !== organizationId,
        );
      cloud.promotionReceipts[body.operationId] = result;
      recordScenarioActivity(
        keyFromBearer(request),
        'personalOrganizationPromotion',
      );
      jsonResponse(response, 200, result);
      return true;
    }
    if (action === 'invites') {
      cloud.organizationInvitations ??= {};
      if (request.method === 'GET') {
        if (cloud.organizationInvitationReconcileRefused) {
          jsonResponse(response, 409, {
            code: 'invite_refused',
            error: "The invitation couldn't be completed. Retry the invite.",
          });
          return true;
        }
        jsonResponse(
          response,
          200,
          cloud.organizationInvitations[
            `${organizationId}:${url.searchParams.get('email')?.toLowerCase()}`
          ] ?? { status: 'not-found' },
        );
        return true;
      }
      if (request.method === 'POST') {
        const body = await readJsonBody(request);
        const invitationKey = `${organizationId}:${body.email?.toLowerCase()}`;
        const previous = cloud.organizationInvitations[invitationKey];
        const result = {
          inviteId: previous?.inviteId ?? randomUUID(),
          status:
            cloud.organizationInvitationDelivery ??
            (previous ? 'resent' : 'sent'),
        };
        cloud.organizationInvitations[invitationKey] = result;
        recordScenarioActivity(
          keyFromBearer(request),
          'organizationInvitation',
        );
        if (cloud.organizationInvitationReplyLostOnce) {
          cloud.organizationInvitationReplyLostOnce = false;
          response.destroy();
          return true;
        }
        jsonResponse(response, 201, result);
        return true;
      }
    }
  }
  const shareMember = pathname.match(
    /^\/api\/v1\/projects\/([^/]+)\/share-with-organization$/,
  );
  const memberDetail = shareMember;
  if (
    memberDetail &&
    request.method === 'GET' &&
    scenario.cloud?.personalOrganizationUpgrade === true
  ) {
    const project = Object.values(scenario.cloud.orgProjects ?? {})
      .flat()
      .find((entry) => entry.id === memberDetail[1]);
    jsonResponse(
      response,
      project ? 200 : 404,
      project ?? { error: 'Project not found' },
    );
    return true;
  }
  if (
    shareMember &&
    request.method === 'POST' &&
    scenario.cloud?.personalOrganizationUpgrade === true
  ) {
    const body = await readJsonBody(request);
    const project = Object.values(scenario.cloud.orgProjects ?? {})
      .flat()
      .find((entry) => entry.id === shareMember[1]);
    if (!project || !hasValidAuth(request)) {
      jsonResponse(response, 404, {
        error: 'Project not found',
        code: 'not_found',
      });
      return true;
    }
    if (scenario.cloud.memberProjectShareStatus) {
      jsonResponse(response, scenario.cloud.memberProjectShareStatus, {
        error: 'Sharing unavailable',
        code: 'share_refused',
      });
      return true;
    }
    if (project.visibility !== 'organization') {
      if (project.authorizationVersion !== body.authorizationVersion) {
        jsonResponse(response, 409, {
          error: 'Project changed',
          code: 'conflict',
        });
        return true;
      }
      project.visibility = 'organization';
      project.memberOwned = false;
      project.authorizationVersion += 1;
    }
    recordScenarioActivity(keyFromBearer(request), 'memberProjectShare');
    jsonResponse(response, 200, {
      projectId: project.id,
      visibility: 'organization',
      authorizationVersion: project.authorizationVersion,
    });
    return true;
  }
  const activityShares = scenario.cloud?.activityRowShares;
  const activityShareRoute = pathname.match(
    /^\/api\/v1\/canopy\/(skills|plugins)(?:\/([^/]+)(\/public-share)?)?$/,
  );
  if (activityShares && activityShareRoute) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const [, kind, id, publicRoute] = activityShareRoute;
    const rows = activityShares[kind];
    if (request.method === 'POST' && !id) {
      const body = await readJsonBody(request);
      const externalId = randomUUID();
      const ref = body.ref;
      const source = ref?.marketplace;
      const sourceKey =
        source?.type === 'builtin'
          ? 'builtin:app'
          : source?.type === 'codex-builtin'
            ? `codex-builtin:${source.id}`
            : `github:${source?.repo?.toLowerCase()}`;
      const refKey =
        kind === 'plugins'
          ? `${ref.type}:${sourceKey}:${ref.plugin_name.toLowerCase()}`
          : undefined;
      const detail = withRequestedAudience(
        {
          ...(kind === 'skills'
            ? {
                id: externalId,
                rawSkill: body.rawSkill,
                contentHash: createHash('sha256')
                  .update(body.rawSkill)
                  .digest('hex'),
                canUpdate: true,
                canDelete: true,
              }
            : { externalId, ref, refKey, marketplaceOrigin: sourceKey }),
          name: body.name ?? body.rawSkill?.match(/^name:\s*(.+)$/m)?.[1],
          description:
            body.description ??
            body.rawSkill?.match(/^description:\s*(.+)$/m)?.[1] ??
            null,
          shareScope: 'private',
          owner: {
            type: 'user',
            id: CLOUD_ACCOUNT.id,
            name: CLOUD_ACCOUNT.name,
          },
          createdBy: {
            id: CLOUD_ACCOUNT.id,
            name: CLOUD_ACCOUNT.name,
            email: CLOUD_ACCOUNT.email,
          },
          createdAt: NOW,
          updatedAt: NOW,
          publicShare: null,
        },
        body,
        scenario,
      );
      rows.push(detail);
      jsonResponse(response, 201, detail);
      return true;
    }
    if (request.method === 'GET' && !id) {
      jsonResponse(
        response,
        200,
        kind === 'skills'
          ? { skills: rows, nextCursor: null }
          : { data: rows, nextCursor: null },
      );
      return true;
    }
    const detail = rows.find((row) => (row.id ?? row.externalId) === id);
    if (!detail) {
      jsonResponse(response, 404, { error: 'Shared fixture not found.' });
      return true;
    }
    if (request.method === 'POST' && publicRoute) {
      detail.publicShare = {
        externalId: randomUUID(),
        ...(kind === 'skills'
          ? { pinnedContentHash: detail.contentHash }
          : { pinnedRefKey: detail.refKey }),
        upToDate: true,
        sharePath: `/share/${kind}/${id}`,
        createdAt: NOW,
        updatedAt: NOW,
      };
      jsonResponse(response, 200, { publicShare: detail.publicShare });
      return true;
    }
    if (request.method === 'GET') {
      jsonResponse(response, 200, detail);
      return true;
    }
  }
  const method = request.method;

  if (await handleLedgerRequest(request, response, pathname)) return true;
  if (await handleLedgerReadRequest(request, response, pathname)) return true;

  // Publisher scenarios supply their own catalog; ordinary UI tests see the
  // same empty response as an environment where publisher seeds are disabled.
  if (method === 'GET' && url.pathname === '/api/v1/marketplace/skills') {
    jsonResponse(response, 200, { skills: [] });
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/pipeline-packages/uploads') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const body = await readJsonBody(request);
    const uploadId = randomUUID();
    const requestsEveryBlob = [
      'csk_workspace_template_e2e',
      CAN3310_COLLECTION_API_KEY,
    ].includes(keyFromBearer(request));
    // Packaged automation pipelines and their file assets have no fixture
    // fallback, so the mock always asks for their bytes; a recipient can only
    // install them from blobs the author actually uploaded.
    const missingBlobs = Array.from(
      new Set(
        (body?.manifest?.resources ?? [])
          .filter(
            (resource) =>
              requestsEveryBlob ||
              resource.kind === 'automation_pipeline' ||
              resource.kind === 'file_asset',
          )
          .flatMap((resource) =>
            (resource.trees ?? []).flatMap((tree) =>
              (tree.entries ?? []).map((entry) => entry.sha256),
            ),
          ),
      ),
    );
    pipelinePackageUploads.set(uploadId, {
      ...body,
      missingBlobs,
      blobs: new Map(),
    });
    jsonResponse(response, 200, {
      uploadId,
      expiresAt: '2099-01-01T00:00:00.000Z',
      missingBlobs,
    });
    return true;
  }

  const pipelinePackageBlobUploadMatch = pathname.match(
    /^\/api\/v1\/pipeline-packages\/uploads\/([^/]+)\/blobs\/([^/]+)$/,
  );
  if (method === 'PUT' && pipelinePackageBlobUploadMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const upload = pipelinePackageUploads.get(
      pipelinePackageBlobUploadMatch[1],
    );
    if (!upload) {
      jsonResponse(response, 404, { error: 'Package upload not found.' });
      return true;
    }
    upload.blobs.set(
      pipelinePackageBlobUploadMatch[2],
      await readBinaryBody(request),
    );
    response.writeHead(204);
    response.end();
    return true;
  }

  const pipelinePackageCommitMatch = pathname.match(
    /^\/api\/v1\/pipeline-packages\/uploads\/([^/]+)\/commit$/,
  );
  if (method === 'POST' && pipelinePackageCommitMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const uploadId = pipelinePackageCommitMatch[1];
    const upload = pipelinePackageUploads.get(uploadId);
    if (!upload) {
      jsonResponse(response, 404, { error: 'Package upload not found.' });
      return true;
    }
    pipelinePackageUploads.delete(uploadId);
    committedPipelinePackages.set(uploadId, upload);
    jsonResponse(response, 200, {
      uploadId,
      digest: upload.expectedDigest,
      package: {
        digest: upload.expectedDigest,
        version: 1,
        resources: upload.manifest?.resources ?? [],
        environmentRequirements: upload.manifest?.environmentRequirements ?? [],
        totalFiles: upload.manifest?.totalFiles ?? 0,
        totalBytes: upload.manifest?.totalBytes ?? 0,
      },
    });
    return true;
  }

  if (
    method === 'GET' &&
    /^\/api\/v1\/(?:canopy\/)?projects\/catalog$/.test(pathname)
  ) {
    const key = keyFromBearer(request);
    const data =
      getScenario(key)?.cloud?.orgProjects?.[url.searchParams.get('context')] ??
      [];
    if (data.some((project) => project.instance?.state === 'CLAIMED')) {
      recordScenarioActivity(key, 'orgProjectValidationRead');
      const delayMs = getScenario(key)?.cloud?.orgProjectValidationDelayMs;
      if (typeof delayMs === 'number' && delayMs > 0) await delay(delayMs);
    }
    // A slow catalog widens the window in which the desktop has asked for a
    // context but holds no answer yet (CAN-3388).
    const catalogDelayMs = getScenario(key)?.cloud?.orgProjectCatalogDelayMs;
    if (typeof catalogDelayMs === 'number' && catalogDelayMs > 0)
      await delay(catalogDelayMs);
    response.setHeader('ETag', '"r1"');
    jsonResponse(response, 200, { data, revision: 'r1', nextCursor: null });
    return true;
  }
  // CAN-3489: opening the desktop Add project dialog re-reads the
  // organization's repositories from GitHub. `createdRepositories` stands in
  // for repositories created on GitHub since the last read: each is listed in
  // that organization's catalog once, as seeding would. `status` scripts the
  // answer (`refreshed` by default).
  if (
    method === 'POST' &&
    pathname === '/api/v1/projects/repositories/refresh'
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const key = keyFromBearer(request);
    const scenario = getScenario(key);
    const body = await readJsonBody(request);
    recordScenarioActivity(key, 'orgProjectRepositoryRefresh');
    const refresh = scenario.cloud?.orgProjectRepositoryRefresh ?? {};
    const context = `org:${body?.organizationId}`;
    const created = refresh.createdRepositories?.[context] ?? [];
    if (created.length > 0) {
      scenario.cloud.orgProjects ??= {};
      const catalog = (scenario.cloud.orgProjects[context] ??= []);
      for (const project of created) {
        if (!catalog.some((row) => row.id === project.id))
          catalog.push(project);
      }
    }
    jsonResponse(response, 200, { status: refresh.status ?? 'refreshed' });
    return true;
  }
  if (method === 'POST' && pathname === '/api/v1/projects/default-chats') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const key = keyFromBearer(request);
    let scenario = getScenario(key);
    // Unregistered credentials share a frozen fallback. Stateful ensure calls
    // need their own scenario so they cannot crash or leak across credentials.
    // Registering resets the key's activity, so carry over what it recorded.
    if (scenario === DEFAULT_SCENARIO && key) {
      const earlierActivity = getScenarioActivity(key);
      scenario = {};
      registerScenario(key, scenario);
      for (const [field, count] of Object.entries(earlierActivity)) {
        for (let index = 0; index < count; index += 1) {
          recordScenarioActivity(key, field);
        }
      }
    }
    const body = await readJsonBody(request);
    const status = scenario.cloud?.orgDefaultChatsEnsureStatus;
    const delayMs = scenario.cloud?.orgDefaultChatsEnsureDelayMs;
    recordScenarioActivity(key, 'orgDefaultChatsEnsure');
    if (typeof delayMs === 'number' && delayMs > 0) await delay(delayMs);
    if (typeof status === 'number' && status !== 200) {
      jsonResponse(response, status, {
        error: status === 404 ? 'Organization not found' : 'Chats unavailable',
      });
      return true;
    }
    if (typeof body?.organizationId !== 'string') {
      jsonResponse(response, 400, { error: 'organizationId is required' });
      return true;
    }
    scenario.cloud ??= {};
    scenario.cloud.orgDefaultChats ??= {};
    const project = (scenario.cloud.orgDefaultChats[body.organizationId] ??= {
      id: body.organizationId,
      organizationId: body.organizationId,
      name: 'Chats',
      description: null,
      kind: 'COWORK',
      purpose: 'default-chats',
      visibility: 'organization',
      memberOwned: false,
      location: 'LOCAL',
      repository: null,
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS',
      listed: true,
      capabilities: { administer: false, use: true, manageCloud: false },
      instance: null,
    });
    jsonResponse(response, 200, project);
    return true;
  }
  // CAN-3453/CAN-3534: a member creates a private Cowork or Code project.
  // The legacy Cowork controls stay supported while the member-project controls
  // can select either of the Code conflict responses.
  if (method === 'POST' && pathname === '/api/v1/projects/member') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const key = keyFromBearer(request);
    const scenario = getScenario(key);
    const body = await readJsonBody(request);
    const receiptKey =
      typeof body?.creationKey === 'string'
        ? JSON.stringify([body.organizationId, body.creationKey])
        : undefined;
    const receipt = receiptKey
      ? scenario.cloud?.orgMemberCreationReceipts?.[receiptKey]
      : undefined;
    if (receipt) {
      if (receipt.payload !== JSON.stringify(body)) {
        jsonResponse(response, 409, {
          error: 'Creation key was already used for another request',
        });
      } else {
        recordScenarioActivity(key, 'orgMemberProjectReplay');
        jsonResponse(response, 200, receipt.project);
      }
      return true;
    }
    recordScenarioActivity(key, 'orgMemberProjectCreate');
    const creationDelay = scenario.cloud?.orgMemberProjectCreateDelayMs;
    if (typeof creationDelay === 'number' && creationDelay > 0)
      await delay(creationDelay);
    if (body?.kind === 'COWORK') recordScenarioActivity(key, 'orgCoworkCreate');
    if (body?.kind === 'CODE') recordScenarioActivity(key, 'orgCodeCreate');
    const status =
      scenario.cloud?.orgMemberProjectCreateStatus ??
      scenario.cloud?.orgCoworkCreateStatus;
    if (typeof status === 'number' && status !== 200) {
      jsonResponse(
        response,
        status,
        status === 409
          ? {
              error: 'You have reached the private project limit',
              code:
                scenario.cloud?.orgMemberProjectCreateConflictCode ??
                'member_project_limit',
            }
          : { error: 'Project creation unavailable' },
      );
      return true;
    }
    if (
      typeof body?.organizationId !== 'string' ||
      (body?.kind !== 'COWORK' && body?.kind !== 'CODE') ||
      typeof body?.name !== 'string' ||
      !body.name.trim() ||
      (body.kind === 'CODE' &&
        body.repository !== null &&
        (body.repository?.host !== 'github.com' ||
          typeof body.repository?.owner !== 'string' ||
          typeof body.repository?.name !== 'string'))
    ) {
      jsonResponse(response, 400, { error: 'Invalid member project request' });
      return true;
    }
    const project = {
      id: randomUUID(),
      organizationId: body.organizationId,
      name: body.name.trim(),
      description: null,
      kind: body.kind,
      purpose: 'project',
      visibility: 'private',
      memberOwned: true,
      location: 'LOCAL',
      repository:
        body.kind === 'CODE' && body.repository
          ? {
              provider: 'github',
              host: 'github.com',
              owner: body.repository.owner,
              name: body.repository.name,
              providerRepoId: null,
              defaultBranch: null,
              verification: 'UNVERIFIED',
            }
          : null,
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      // The web route grants the creator a default-listed user grant.
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS',
      listed: true,
      // The creator administers their own member project (CAN-3453).
      capabilities: { administer: true, use: true, manageCloud: false },
      instance: null,
    };
    scenario.cloud ??= {};
    scenario.cloud.orgProjects ??= {};
    (scenario.cloud.orgProjects[`org:${body.organizationId}`] ??= []).push(
      project,
    );
    scenario.cloud.orgCoworkCreated ??= [];
    if (body.kind === 'COWORK')
      scenario.cloud.orgCoworkCreated.push({ ...body });
    scenario.cloud.orgMemberProjectsCreated ??= [];
    scenario.cloud.orgMemberProjectsCreated.push({ ...body });
    if (receiptKey) {
      scenario.cloud.orgMemberCreationReceipts ??= {};
      scenario.cloud.orgMemberCreationReceipts[receiptKey] = {
        payload: JSON.stringify(body),
        project,
      };
    }
    if (scenario.cloud.orgMemberProjectLoseResponse === true) {
      scenario.cloud.orgMemberProjectLoseResponse = false;
      response.destroy();
      return true;
    }
    jsonResponse(response, 200, project);
    return true;
  }
  // CAN-3532: a member's private multi-repo project for a Personal multi-repo
  // project the desktop converts. Every id must be a single-repository
  // project of that organization's catalog; the same local project always
  // gets the same definition. Counted as `orgMemberMultiRepoCreate`.
  if (method === 'POST' && pathname === '/api/v1/projects/member/multi-repo') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const key = keyFromBearer(request);
    const scenario = getScenario(key);
    const body = await readJsonBody(request);
    recordScenarioActivity(key, 'orgMemberMultiRepoCreate');
    if (
      typeof body?.organizationId !== 'string' ||
      typeof body?.name !== 'string' ||
      typeof body?.localWorkspaceId !== 'string' ||
      !Array.isArray(body?.repositoryProjectIds)
    ) {
      jsonResponse(response, 400, { error: 'Invalid member project request' });
      return true;
    }
    scenario.cloud ??= {};
    scenario.cloud.orgProjects ??= {};
    const catalog = (scenario.cloud.orgProjects[
      `org:${body.organizationId}`
    ] ??= []);
    const holders = body.repositoryProjectIds.map((id) =>
      catalog.find(
        (row) =>
          row.id === id &&
          row.topology !== 'multi-repo' &&
          row.visibility !== 'private' &&
          row.repository,
      ),
    );
    if (holders.some((row) => row === undefined)) {
      jsonResponse(response, 409, {
        error: "Every repository must be one of the organization's projects",
        code: 'repository_mismatch',
      });
      return true;
    }
    scenario.cloud.orgMemberMultiRepoProjects ??= {};
    const receipt = `${body.organizationId}:${body.localWorkspaceId}`;
    const existing = scenario.cloud.orgMemberMultiRepoProjects[receipt];
    const known = catalog.find((row) => row.id === existing);
    if (known) {
      jsonResponse(response, 200, known);
      return true;
    }
    const project = {
      id: randomUUID(),
      organizationId: body.organizationId,
      name: body.name.trim(),
      description: null,
      kind: 'CODE',
      purpose: 'project',
      visibility: 'private',
      memberOwned: true,
      topology: 'multi-repo',
      location: 'LOCAL',
      // A project made from Add project starts empty (CAN-3546).
      repository: holders[0]?.repository ?? null,
      repositoryProjectIds: [...body.repositoryProjectIds],
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS',
      listed: true,
      capabilities: { administer: true, use: true, manageCloud: false },
      instance: null,
    };
    catalog.push(project);
    scenario.cloud.orgMemberMultiRepoProjects[receipt] = project.id;
    jsonResponse(response, 200, project);
    return true;
  }
  // CAN-3546: settings replaced the repositories of the member's own
  // multi-repo project. The same organization-catalog rule as create; the
  // latest list is kept on the row. Counted as `orgMemberMultiRepoUpdate`.
  const memberMultiRepoMatch = pathname.match(
    /^\/api\/v1\/projects\/member\/multi-repo\/([^/]+)$/,
  );
  if (method === 'PATCH' && memberMultiRepoMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const key = keyFromBearer(request);
    const scenario = getScenario(key);
    const body = await readJsonBody(request);
    recordScenarioActivity(key, 'orgMemberMultiRepoUpdate');
    if (scenario.cloud?.orgMemberMultiRepoUpdateStatus) {
      jsonResponse(response, scenario.cloud.orgMemberMultiRepoUpdateStatus, {
        error: 'Forced member project update failure',
      });
      return true;
    }
    if (!Array.isArray(body?.repositoryProjectIds)) {
      jsonResponse(response, 400, { error: 'Invalid member project request' });
      return true;
    }
    const projectId = decodeURIComponent(memberMultiRepoMatch[1]);
    const catalogs = Object.values(scenario.cloud?.orgProjects ?? {});
    const catalog = catalogs.find((rows) =>
      rows.some(
        (row) =>
          row.id === projectId &&
          row.topology === 'multi-repo' &&
          row.memberOwned === true,
      ),
    );
    const project = catalog?.find((row) => row.id === projectId);
    if (!catalog || !project) {
      jsonResponse(response, 404, { error: 'Not found', code: 'not_found' });
      return true;
    }
    const holders = body.repositoryProjectIds.map((id) =>
      catalog.find(
        (row) =>
          row.id === id &&
          row.topology !== 'multi-repo' &&
          row.visibility !== 'private' &&
          row.repository,
      ),
    );
    if (holders.some((row) => row === undefined)) {
      jsonResponse(response, 409, {
        error: "Every repository must be one of the organization's projects",
        code: 'repository_mismatch',
      });
      return true;
    }
    project.repository = holders[0]?.repository ?? null;
    project.repositoryProjectIds = [...body.repositoryProjectIds];
    project.revision += 1;
    jsonResponse(response, 200, project);
    return true;
  }
  const claimMatch = pathname.match(
    /^\/api\/v1\/(?:canopy\/)?projects\/([^/]+)\/instances\/claim$/,
  );
  const instanceMatch = pathname.match(
    /^\/api\/v1\/(?:canopy\/)?projects\/instances\/([^/]+)\/(complete|detach)$/,
  );
  if (method === 'POST' && (claimMatch || instanceMatch)) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const key = keyFromBearer(request);
    const cloud = getScenario(key)?.cloud;
    const projects = [
      ...Object.values(cloud?.orgProjects ?? {}).flat(),
      ...Object.values(cloud?.orgDefaultChats ?? {}),
    ];
    const project = projects.find((row) =>
      claimMatch
        ? row.id === claimMatch[1]
        : row.instance?.id === instanceMatch[1],
    );
    if (!project) {
      jsonResponse(response, 404, { error: 'Project not found' });
      return true;
    }
    const body = await readJsonBody(request);
    // Totals include the organization's default Chats claim (#4159); the
    // per-project counters let a spec count only the project it drives.
    const recordProjectActivity = (field) => {
      recordScenarioActivity(key, field);
      recordScenarioActivity(key, `${field}:${project.id}`);
    };
    if (claimMatch) {
      recordProjectActivity('orgProjectClaim');
      const forcedStatus = cloud?.orgProjectClaimStatus;
      if (typeof forcedStatus === 'number' && forcedStatus !== 200) {
        jsonResponse(response, forcedStatus, {
          error: 'Project setup unavailable',
        });
        return true;
      }
      const delayMs = getScenario(key)?.cloud?.orgProjectClaimDelayMs;
      if (typeof delayMs === 'number' && delayMs > 0) await delay(delayMs);
      if (body?.reclaim !== undefined) {
        // CAN-3129: replace exactly the named lapsed claim, as the server
        // does. Anything else is the server's own 409, never a fresh claim.
        recordProjectActivity('orgProjectReclaim');
        const target = body.reclaim;
        const current = project.instance;
        if (
          !current ||
          current.state !== 'CLAIMED' ||
          current.id !== target?.instanceId ||
          current.operationId !== target?.operationId ||
          current.fencingGeneration !== target?.fencingGeneration ||
          current.localWorkspaceId !== body.localWorkspaceId
        ) {
          jsonResponse(response, 409, {
            error: 'A newer setup of this project superseded this attempt',
            code: 'conflict',
          });
          return true;
        }
        if (current.leaseExpired === true) {
          current.operationId = randomUUID();
          current.fencingGeneration += 1;
          current.leaseExpired = false;
        }
        jsonResponse(response, 200, {
          instanceId: current.id,
          operationId: current.operationId,
          fencingGeneration: current.fencingGeneration,
          state: current.state,
        });
        return true;
      }
      if (!project.instance || project.instance.state === 'DETACHED') {
        project.instance = {
          id: randomUUID(),
          operationId: randomUUID(),
          fencingGeneration: (project.instance?.fencingGeneration ?? 0) + 1,
          state: 'CLAIMED',
          ...body,
        };
      }
      const instance = project.instance;
      jsonResponse(response, 200, {
        instanceId: instance.id,
        operationId: instance.operationId,
        fencingGeneration: instance.fencingGeneration,
        state: instance.state,
      });
    } else {
      const instance = project.instance;
      if (instanceMatch[2] === 'complete') {
        recordProjectActivity('orgProjectComplete');
        // CAN-3129 knobs. `orgProjectClaimLapses` answers that many
        // completions as a claim whose 15-minute lease ran out;
        // `orgProjectSupersedeOnComplete` has another claim of this device
        // move the fence on first. The server answers both with the same 409.
        // Only catalog projects: the organization's default Chats claim
        // completes through this route too and must not consume them.
        const catalogProject = Object.values(cloud?.orgProjects ?? {})
          .flat()
          .includes(project);
        if (
          catalogProject &&
          cloud?.orgProjectSupersedeOnComplete === true &&
          instance.superseded !== true
        ) {
          instance.superseded = true;
          instance.operationId = randomUUID();
          instance.fencingGeneration += 1;
        }
        if (
          catalogProject &&
          typeof cloud?.orgProjectClaimLapses === 'number' &&
          cloud.orgProjectClaimLapses > 0
        ) {
          cloud.orgProjectClaimLapses -= 1;
          instance.leaseExpired = true;
        }
        if (
          instance.leaseExpired === true ||
          body.operationId !== instance.operationId ||
          body.fencingGeneration !== instance.fencingGeneration
        ) {
          jsonResponse(response, 409, {
            error: 'The setup claim is no longer active',
            code: 'conflict',
          });
          return true;
        }
        instance.state = body.outcome === 'ready' ? 'READY' : 'CLAIMED';
      } else {
        recordProjectActivity('orgProjectDetach');
        instance.state = 'DETACHED';
      }
      jsonResponse(response, 200, {
        instanceId: instance.id,
        state: instance.state,
        readyAt: instance.state === 'READY' ? new Date().toISOString() : null,
      });
    }
    return true;
  }
  // CAN-3561: the desktop chat-turn activity signal. Scenarios opt in with
  // `cloud.recordProductActivity`; the label carries the declared client
  // surface, the owner organization (or `none`), and the hashed turn key.
  // Other keys keep the unhandled route, which the desktop drops like an older
  // server's 404, so their recorded activity is unchanged.
  if (
    method === 'POST' &&
    pathname === '/api/v1/product-activity/turns' &&
    getScenario(keyFromBearer(request)).cloud?.recordProductActivity === true
  ) {
    const body = await readJsonBody(request);
    const surface = request.headers['x-canopy-client'] ?? 'none';
    const organization = body?.organizationExternalId ?? 'none';
    recordScenarioActivity(
      keyFromBearer(request),
      `productActivityTurn:${surface}:${organization}:${body?.turnKey}`,
    );
    jsonResponse(response, 202, { accepted: true });
    return true;
  }
  // CAN-3515: record where ambient telemetry is delivered, per worktree and
  // destination, for scenarios that opt in with `cloud.recordTelemetryIngest`.
  // Other keys keep the unhandled route, so their queues behave as before.
  if (
    method === 'POST' &&
    pathname === '/api/v1/canopy/telemetry/ingest' &&
    getScenario(keyFromBearer(request)).cloud?.recordTelemetryIngest === true
  ) {
    const key = keyFromBearer(request);
    const body = await readJsonBody(request);
    const workspace = body?.workspace ?? {};
    const destination = `${body?.shareScope ?? 'private'}:${
      body?.organizationId ?? body?.teamId ?? 'none'
    }`;
    const worktrees = Array.isArray(workspace.worktrees)
      ? workspace.worktrees
      : [];
    for (const worktree of worktrees) {
      const worktreeId = worktree.sourceClientLocalId ?? worktree.clientLocalId;
      recordScenarioActivity(
        key,
        `telemetryIngest:${destination}:${worktreeId}`,
      );
      for (const turn of worktree.turns ?? []) {
        recordScenarioActivity(
          key,
          `telemetryIngestTurn:${destination}:${worktreeId}:${turn.clientTurnId}`,
        );
      }
    }
    jsonResponse(response, 200, {
      workspace: {
        clientLocalId: workspace.clientLocalId,
        externalId: randomUUID(),
        worktrees: worktrees.map((worktree) => ({
          clientLocalId: worktree.clientLocalId,
          externalId: randomUUID(),
          turns: (worktree.turns ?? []).map((turn) => ({
            clientTurnId: turn.clientTurnId,
            externalId: randomUUID(),
          })),
          plans: (worktree.plans ?? []).map((plan) => ({
            clientPlanId: plan.clientPlanId,
            externalId: randomUUID(),
          })),
          pullRequests: (worktree.pullRequests ?? []).map((pr) => ({
            repoId: pr.repoId,
            prNumber: pr.prNumber,
            externalId: randomUUID(),
          })),
          pipelineRuns: (worktree.pipelineRuns ?? []).map((run) => ({
            clientPipelineRunId: run.clientPipelineRunId,
            externalId: randomUUID(),
          })),
          summaries: (worktree.summaries ?? []).map((snapshot) => ({
            clientSnapshotId: snapshot.clientSnapshotId,
            externalId: randomUUID(),
          })),
        })),
      },
    });
    return true;
  }
  // CAN-3418: moving a converted checkout's uploaded Personal activity to the
  // organization, and returning it on move back. Records the call and the
  // checkout it named; the mock keeps no telemetry to move.
  const activityTransferMatch = pathname.match(
    /^\/api\/v1\/(?:canopy\/)?projects\/([^/]+)\/activity-transfer(\/reverse)?$/,
  );
  if (method === 'POST' && activityTransferMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const key = keyFromBearer(request);
    const body = await readJsonBody(request);
    const reverse = activityTransferMatch[2] !== undefined;
    recordScenarioActivity(
      key,
      reverse ? 'orgProjectActivityReturn' : 'orgProjectActivityMove',
    );
    recordScenarioActivity(
      key,
      `${reverse ? 'orgProjectActivityReturn' : 'orgProjectActivityMove'}:${activityTransferMatch[1]}:${body?.localWorkspaceId}`,
    );
    // CAN-3517: a repair move names the kinds the member withholds.
    if (Array.isArray(body?.withheldKinds)) {
      recordScenarioActivity(
        key,
        `orgProjectActivityMove:${activityTransferMatch[1]}:${body?.localWorkspaceId}:withheld=${body.withheldKinds.join(',')}`,
      );
    }
    jsonResponse(response, 200, {
      outcome: reverse ? 'nothing-to-return' : 'nothing-to-move',
      transferId: null,
      counts: null,
    });
    return true;
  }
  // CAN-3517: returning a Personal checkout's activity that was uploaded to
  // an organization before CAN-3515. Records the call and the checkout.
  if (
    method === 'POST' &&
    /^\/api\/v1\/(?:canopy\/)?projects\/personal\/activity-return$/.test(
      pathname,
    )
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const key = keyFromBearer(request);
    const body = await readJsonBody(request);
    recordScenarioActivity(key, 'orgPersonalActivityReturn');
    recordScenarioActivity(
      key,
      `orgPersonalActivityReturn:${body?.localWorkspaceId}`,
    );
    jsonResponse(response, 200, {
      outcome: 'nothing-to-return',
      transferIds: [],
      counts: null,
    });
    return true;
  }
  const preferenceMatch = pathname.match(
    /^\/api\/v1\/(?:canopy\/)?projects\/([^/]+)\/preference$/,
  );
  if (method === 'PUT' && preferenceMatch) {
    const key = keyFromBearer(request);
    const body = await readJsonBody(request);
    const catalogs = getScenario(key)?.cloud?.orgProjects ?? {};
    const project = Object.values(catalogs)
      .flat()
      .find((row) => row.id === preferenceMatch[1]);
    if (!project) {
      jsonResponse(response, 404, { error: 'Project not found' });
      return true;
    }
    project.preference = body.preference;
    project.listed =
      project.capabilities.use &&
      (body.preference === 'ADDED' ||
        (body.preference === 'FOLLOW_DEFAULTS' && project.defaultListed));
    recordScenarioActivity(key, 'orgProjectPreferencePut');
    jsonResponse(response, 200, project);
    return true;
  }

  if (
    method === 'POST' &&
    pathname === '/api/v1/canopy/plugins/curated/events'
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const body = await readJsonBody(request);
    if (
      request.headers['content-type'] !== 'application/json' ||
      typeof body?.curatedPluginKey !== 'string' ||
      body?.eventType !== 'INSTALLED'
    ) {
      jsonResponse(response, 400, { error: 'Invalid curated plugin event.' });
      return true;
    }
    recordScenarioActivity(keyFromBearer(request), 'curatedPluginInstalled');
    response.writeHead(204);
    response.end();
    return true;
  }

  if (
    method === 'PATCH' &&
    pathname === '/api/v1/canopy/account/onboarding-profile'
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }

    const body = await readJsonBody(request);
    const scenarioKey = keyFromBearer(request);
    recordScenarioActivity(scenarioKey, 'onboardingProfilePatch');
    if (Array.isArray(body?.profileRoles)) {
      recordScenarioActivity(
        scenarioKey,
        `onboardingProfileRoles:${body.profileRoles.join(',')}`,
      );
    }
    const onboardingProfileDelayMs =
      getScenario(scenarioKey).cloud?.onboardingProfileDelayMs;
    if (
      typeof onboardingProfileDelayMs === 'number' &&
      onboardingProfileDelayMs > 0
    ) {
      await delay(onboardingProfileDelayMs);
    }
    jsonResponse(response, 200, {
      profileRole: body?.profileRole ?? null,
      profileRoles: body?.profileRoles ?? [],
      profileRoleDetail: body?.profileRoleDetail ?? null,
      attributionSource: body?.attributionSource ?? null,
      attributionSourceDetail: body?.attributionSourceDetail ?? null,
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/canopy/ai-gateway/models') {
    jsonResponse(response, 200, AI_GATEWAY_MODEL_CATALOG);
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/model-routing/resolve') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const scenarioKey = keyFromBearer(request);
    const body = await readJsonBody(request);
    const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
    const modelRouting = getScenario(scenarioKey).cloud?.modelRouting;
    const responseIndex =
      getScenarioActivity(scenarioKey).modelRoutingResolve ?? 0;
    const configuredResponses = Array.isArray(modelRouting?.responses)
      ? modelRouting.responses
      : [];
    const configured =
      configuredResponses[
        Math.min(responseIndex, Math.max(0, configuredResponses.length - 1))
      ];
    const selected =
      candidates.find(
        (candidate) => candidate?.modelId === configured?.selectedModelId,
      ) ??
      candidates.find(
        (candidate) =>
          candidate?.harness === 'claude' &&
          candidate?.modelId !== body?.fallbackModelId,
      ) ??
      candidates.find((candidate) => candidate?.modelId);
    if (
      body?.schemaVersion !== 1 ||
      typeof body?.requestId !== 'string' ||
      typeof selected?.modelId !== 'string'
    ) {
      jsonResponse(response, 400, { error: 'Invalid routing request.' });
      return true;
    }
    recordScenarioActivity(scenarioKey, 'modelRoutingResolve');
    if (typeof body.executionLane === 'string') {
      recordScenarioActivity(
        scenarioKey,
        `modelRoutingLane:${body.executionLane}`,
      );
    }
    if (typeof body.capturedHarness === 'string') {
      recordScenarioActivity(
        scenarioKey,
        `modelRoutingCapturedHarness:${body.capturedHarness}`,
      );
    }
    for (const candidate of candidates) {
      if (typeof candidate?.modelId === 'string') {
        recordScenarioActivity(
          scenarioKey,
          `modelRoutingCandidate:${candidate.modelId}`,
        );
      }
    }
    const delayMs =
      typeof configured?.delayMs === 'number'
        ? configured.delayMs
        : modelRouting?.delayMs;
    if (typeof delayMs === 'number' && delayMs > 0) {
      await delay(delayMs);
    }
    if (typeof configured?.fallbackReason === 'string') {
      recordScenarioActivity(
        scenarioKey,
        `modelRoutingFallback:${configured.fallbackReason}`,
      );
      jsonResponse(response, 200, {
        schemaVersion: 1,
        requestId: body.requestId,
        outcome: 'fallback',
        modelId: body.fallbackModelId,
        fallbackReason: configured.fallbackReason,
        routingCostUsd: 0.0002,
        routingCredits: 0.001,
      });
      return true;
    }
    recordScenarioActivity(
      scenarioKey,
      `modelRoutingSelected:${selected.modelId}`,
    );
    jsonResponse(response, 200, {
      schemaVersion: 1,
      requestId: body.requestId,
      outcome: 'selected',
      modelId: selected.modelId,
      routingCostUsd: 0.0002,
      routingCredits: 0.001,
    });
    return true;
  }

  // Account notification preferences (CAN-2334). Unprefixed like the real
  // v1 route; PATCH is partial and the scenario keeps what was written so a
  // later GET can tell a persisted value from an optimistic one.
  if (
    pathname === '/api/v1/account/notification-preferences' &&
    (method === 'GET' || method === 'PATCH')
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const scenarioKey = keyFromBearer(request);
    const scenario = getScenario(scenarioKey);
    const current = {
      pushEnabled: true,
      installUpdateEmailsEnabled: true,
      ...(scenario.cloud?.notificationPreferences ?? {}),
    };
    if (method === 'GET') {
      recordScenarioActivity(scenarioKey, 'notificationPreferencesRead');
      jsonResponse(response, 200, current);
      return true;
    }
    const body = await readJsonBody(request);
    const keys = body && typeof body === 'object' ? Object.keys(body) : [];
    if (
      keys.length === 0 ||
      keys.some(
        (key) =>
          (key !== 'pushEnabled' && key !== 'installUpdateEmailsEnabled') ||
          typeof body[key] !== 'boolean',
      )
    ) {
      jsonResponse(response, 400, {
        error: 'Send pushEnabled or installUpdateEmailsEnabled as a boolean',
      });
      return true;
    }
    recordScenarioActivity(scenarioKey, 'notificationPreferencesPatch');
    const persisted = { ...current, ...body };
    if (scenarioKey && scenario.cloud) {
      scenario.cloud.notificationPreferences = persisted;
    }
    jsonResponse(response, 200, persisted);
    return true;
  }

  if (
    pathname === '/api/v1/canopy/account/digest-preferences' &&
    (method === 'GET' || method === 'PATCH')
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const scenarioKey = keyFromBearer(request);
    const configured = getScenario(scenarioKey).cloud?.digestPreferences;
    if (method === 'GET') {
      recordScenarioActivity(scenarioKey, 'digestPreferencesRead');
      jsonResponse(response, 200, {
        ...DEFAULT_DIGEST_PREFERENCES,
        ...(configured ?? {}),
      });
      return true;
    }
    const body = await readJsonBody(request);
    // Anchors are optional-with-default on the wire so already-shipped desktop
    // builds that omit them keep saving successfully; mirrors
    // `parseDigestPreferences` in @canopy/protocol/digests.
    const weeklyAnchorDay =
      body?.weeklyAnchorDay ?? DEFAULT_DIGEST_PREFERENCES.weeklyAnchorDay;
    const monthlyAnchorDay =
      body?.monthlyAnchorDay ?? DEFAULT_DIGEST_PREFERENCES.monthlyAnchorDay;
    if (
      typeof body?.daily !== 'boolean' ||
      typeof body?.weekly !== 'boolean' ||
      typeof body?.monthly !== 'boolean' ||
      !Number.isInteger(weeklyAnchorDay) ||
      weeklyAnchorDay < 1 ||
      weeklyAnchorDay > 7 ||
      !Number.isInteger(monthlyAnchorDay) ||
      monthlyAnchorDay < 1 ||
      monthlyAnchorDay > 31
    ) {
      jsonResponse(response, 400, {
        error:
          'daily, weekly, and monthly must be booleans; weeklyAnchorDay must be 1-7 and monthlyAnchorDay must be 1-31',
      });
      return true;
    }
    recordScenarioActivity(scenarioKey, 'digestPreferencesPatch');
    const persisted = {
      daily: body.daily,
      weekly: body.weekly,
      monthly: body.monthly,
      weeklyAnchorDay,
      monthlyAnchorDay,
    };
    // The one place this route keeps state: a later GET must return what was
    // just written, or a spec cannot tell a persisted anchor apart from an
    // optimistic one that never left the renderer. Scoped to a registered
    // scenario so the default (unregistered) scenario stays stateless.
    const scenario = getScenario(scenarioKey);
    if (scenarioKey && scenario.cloud) {
      scenario.cloud.digestPreferences = persisted;
    }
    jsonResponse(response, 200, persisted);
    return true;
  }

  if (
    method === 'GET' &&
    (pathname === '/.well-known/canopy' ||
      pathname === '/.well-known/unstoppable-code')
  ) {
    const scenarioKey = keyFromBearer(request);
    jsonResponse(response, 200, {
      capabilities: withoutWithheldCapabilities(
        CLOUD_CAPABILITIES,
        scenarioKey ? getScenario(scenarioKey).cloud : undefined,
      ),
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/canopy/desktop-auth/guest') {
    // Unauthenticated device-scoped guest-mint route (CAN-934 / CAN-936, WS3).
    // Returns a `csk_`-prefixed guest key so the desktop saves a
    // `credentialSource: 'guest'` credential. The guest-upgrade-nudge spec uses
    // this to seed guest state before asserting the contextual sign-in prompt.
    //
    // A spec that needs its own guest scenario seeds its device id and
    // registers `{ guestToken }` under `guest-device:<clientDeviceId>`, so it
    // never rewrites the `csk_guest_e2e` scenario parallel specs share.
    const body = await readJsonBody(request);
    const deviceGuestToken =
      typeof body?.clientDeviceId === 'string'
        ? getScenario(`guest-device:${body.clientDeviceId}`).guestToken
        : undefined;
    jsonResponse(response, 200, {
      token:
        typeof deviceGuestToken === 'string' &&
        deviceGuestToken.startsWith('csk_')
          ? deviceGuestToken
          : 'csk_guest_e2e',
      userApiKey: { id: 'guest-key-e2e' },
      account: {
        id: MOCK_GUEST_ACCOUNT_ID,
        name: 'Guest E2E',
        email: 'guest-e2e@example.test',
        role: 'VIEWER',
      },
      capabilities: CLOUD_CAPABILITIES,
      organizations: [],
      teams: [],
      enforcedSettings: [],
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/canopy/auth-link') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const body = await readJsonBody(request);
    if (typeof body?.redirectPath !== 'string') {
      jsonResponse(response, 400, { error: 'redirectPath is required.' });
      return true;
    }
    recordScenarioActivity(
      keyFromBearer(request),
      `authLinkMint:${body.redirectPath}`,
    );
    jsonResponse(response, 200, {
      url: `${url.origin}/api/v1/canopy/auth-link/consume?code=e2e-auth-link`,
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/canopy/account') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const scenarioKey = keyFromBearer(request);
    const cloudScenario = getScenario(scenarioKey).cloud;
    const accountDelayMs = cloudScenario?.accountDelayMs;
    if (typeof accountDelayMs === 'number' && accountDelayMs > 0) {
      await delay(accountDelayMs);
    }
    const bearer = (request.headers.authorization ?? '').replace(
      /^Bearer\s+/,
      '',
    );
    const accountPayload = {
      // A scenario may name the account, such as with the UUID a Ledger
      // spec needs for its scopes to sync.
      account: { ...CLOUD_ACCOUNT, ...(cloudScenario?.account ?? {}) },
      // Models an account the server has not yet minted `org-projects-v1`
      // for while the desktop flag is already on (a rollout in progress).
      ...(cloudScenario?.withholdOrgProjectsCapability === true
        ? {
            capabilities: CLOUD_CAPABILITIES.filter(
              (capability) => capability !== 'org-projects-v1',
            ),
          }
        : {}),
      ...(bearer === SUBSCRIPTION_PILL_TRIAL_KEY
        ? {
            // This dedicated fixture exposes every signed-in subscription
            // upgrade surface: Remote Control lacks portal-v1. It also lacks
            // data_sync_control (entitlements below), which no longer gates
            // Privacy, so the pill spec asserts Privacy offers no upgrade.
            capabilities: CLOUD_CAPABILITIES.filter(
              (capability) => capability !== 'portal-v1',
            ),
          }
        : {}),
      // The scoped-links account shares to the organization its picker
      // lists, so it reports that membership.
      ...(bearer === SCOPED_LINKS_CLOUD_API_KEY
        ? { organizations: [SCOPED_LINKS_ORGANIZATION], teams: [] }
        : {}),
      ...(bearer === MODEL_POLICY_CLOUD_API_KEY
        ? {
            capabilities: [...CLOUD_CAPABILITIES, 'enforce_model_policy'],
            organizations: [
              {
                id: MODEL_POLICY_ORGANIZATION_ID,
                name: 'Model Policy E2E',
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            teams: [],
            enforcedSettings: [
              {
                organizationId: MODEL_POLICY_ORGANIZATION_ID,
                organizationName: 'Model Policy E2E',
                policies: [
                  {
                    kind: 'model-policy',
                    blockedModelIds: [MODEL_POLICY_BLOCKED_ID],
                    reviewedModelIds: MODEL_POLICY_REVIEWED_IDS,
                  },
                ],
              },
            ],
          }
        : {}),
      ...(bearer === TELEMETRY_ALL_LOCKED_CLOUD_API_KEY
        ? {
            organizations: [
              {
                id: TELEMETRY_ALL_LOCKED_ORG_ID,
                name: 'Locked Org E2E',
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            teams: [],
            enforcedSettings: [
              {
                organizationId: TELEMETRY_ALL_LOCKED_ORG_ID,
                organizationName: 'Locked Org E2E',
                policies: [
                  {
                    kind: 'telemetry-sync',
                    scopes: {
                      transcripts: true,
                      plans: true,
                      metadata: true,
                      summaries: true,
                    },
                  },
                ],
              },
            ],
          }
        : {}),
      ...(MEMORY_CLOUD_API_KEYS.has(bearer)
        ? {
            capabilities: [...CLOUD_CAPABILITIES, 'memorySearch'],
            organizations: [
              {
                id: MEMORY_FEEDBACK_ORGANIZATION_ID,
                name: MEMORY_FEEDBACK_ORGANIZATION_NAME,
                role: 'MEMBER',
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            // CAN-3457: every eligible org, plus the deprecated single id
            // older desktops read.
            memorySearchOrganizationExternalIds: [
              MEMORY_FEEDBACK_ORGANIZATION_ID,
            ],
            memorySearchOrganizationExternalId: MEMORY_FEEDBACK_ORGANIZATION_ID,
          }
        : {}),
      // CAN-2311: only the org-billing keys carry per-org billing state, so
      // every other spec keeps the key-absent (older server) shape.
      ...(ORG_BILLING_STATE_FIXTURES.has(bearer)
        ? {
            organizations: ORG_LAPSED_ORGANIZATIONS,
            orgBillingStates: ORG_BILLING_STATE_FIXTURES.get(bearer),
          }
        : {}),
      ...(bearer === MODEL_RECOVERY_CONTACT_ADMIN_KEY
        ? {
            organizations: [
              {
                id: MODEL_RECOVERY_CONTACT_ADMIN_ORG_ID,
                name: 'Recovery Contact Admin E2E',
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }
        : {}),
      // The org-funded key needs a member org for the desktop to ask about
      // spendable headroom at all; no `orgBillingStates` (nothing is lapsed).
      ...(bearer === ORG_FUNDED_CREDITS_KEY
        ? { organizations: ORG_FUNDED_ORGANIZATIONS }
        : {}),
      ...(isSharedContainersCloudApiKey(bearer)
        ? {
            organizations: [sharedContainersOrganization(scenarioKey)],
            // Opt-in so existing invite specs keep the Organization default:
            // `sharedContainers.team: true` puts the account in the fixture
            // organization's one team (Ada's), enabling the Team audience.
            ...(getScenario(scenarioKey)?.sharedContainers?.team === true
              ? {
                  teams: [
                    {
                      id: SHARED_CONTAINERS_TEAM_ID,
                      name: 'Shared Containers Team',
                      organization: sharedContainersOrganization(scenarioKey),
                      createdAt: NOW,
                      updatedAt: NOW,
                    },
                  ],
                }
              : {}),
            orgBillingStates: [
              {
                organizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
                organizationName: 'Shared Containers E2E',
                teamsEntitled: true,
              },
            ],
          }
        : {}),
      ...(cloudScenario?.personalModelGateway
        ? { personalModelGateway: cloudScenario.personalModelGateway }
        : {}),
      ...(typeof cloudScenario?.personalOrganizationId === 'string'
        ? { personalOrganizationId: cloudScenario.personalOrganizationId }
        : {}),
      ...(Array.isArray(cloudScenario?.organizations)
        ? { organizations: cloudScenario.organizations }
        : {}),
      // Share dialogs disable Team when the account belongs to no team, so a
      // spec that shares to a team seeds its membership here.
      ...(Array.isArray(cloudScenario?.teams)
        ? { teams: cloudScenario.teams }
        : {}),
      // Symmetric with `organizations` above (CAN-2551). Without this, the
      // hardcoded `teamsEntitled: true` default is the only value a spec can
      // ever observe, so a "billing-lapsed" spec would pass vacuously against
      // unmodified code. Unset leaves every existing spec untouched.
      ...(Array.isArray(cloudScenario?.orgBillingStates)
        ? { orgBillingStates: cloudScenario.orgBillingStates }
        : {}),
      ...(Array.isArray(cloudScenario?.enforcedSettings)
        ? { enforcedSettings: cloudScenario.enforcedSettings }
        : {}),
      ...(Array.isArray(cloudScenario?.extraCapabilities)
        ? {
            capabilities: [
              ...(bearer === MODEL_POLICY_CLOUD_API_KEY
                ? [...CLOUD_CAPABILITIES, 'enforce_model_policy']
                : bearer === SUBSCRIPTION_PILL_TRIAL_KEY
                  ? CLOUD_CAPABILITIES.filter(
                      (capability) => capability !== 'portal-v1',
                    )
                  : cloudScenario?.withholdOrgProjectsCapability === true
                    ? CLOUD_CAPABILITIES.filter(
                        (capability) => capability !== 'org-projects-v1',
                      )
                    : CLOUD_CAPABILITIES),
              ...cloudScenario.extraCapabilities,
            ],
          }
        : {}),
    };
    jsonResponse(
      response,
      200,
      cloudScenario?.withholdSharedContainerDismissalsCapability === true
        ? {
            ...accountPayload,
            capabilities: withoutWithheldCapabilities(
              accountPayload.capabilities ?? CLOUD_CAPABILITIES,
              cloudScenario,
            ),
          }
        : accountPayload,
    );
    return true;
  }

  if (
    method === 'GET' &&
    pathname ===
      `/api/v1/canopy/organizations/${MODEL_RECOVERY_CONTACT_ADMIN_ORG_ID}/billing/credits/spendable`
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    if (keyFromBearer(request) !== MODEL_RECOVERY_CONTACT_ADMIN_KEY) {
      jsonResponse(response, 404, { error: 'Not found.' });
      return true;
    }
    jsonResponse(response, 200, {
      hasSpendableHeadroom: false,
      hasBalanceNow: false,
      canReplenish: true,
      orgCreditPoolCapable: true,
      balanceCredits: 0,
      balanceUsd: 0,
      hasPaymentMethodOnFile: true,
      billingActive: true,
    });
    return true;
  }

  // Per-org credit-pool spend gate. Only the org-funded key reports headroom;
  // every other key (including the lapse fixtures, which must keep reporting no
  // coverage) gets the all-false payload.
  const spendableMatch =
    method === 'GET' ? ORG_CREDITS_SPENDABLE_PATH.exec(pathname) : null;
  if (spendableMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const bearer = (request.headers.authorization ?? '').replace(
      /^Bearer\s+/,
      '',
    );
    // CAN-3463: a scenario can fund or empty each organization's pool
    // independently, so a two-org fixture can prove only the OWNER org's pool
    // is ever probed. `'funded'` has headroom; `'empty'` carries the pool
    // capability with no headroom (the contact-admin state); an object is
    // returned verbatim. Orgs absent from the map report no coverage.
    const spendableById = getScenario(bearer).cloud?.orgSpendableById;
    if (spendableById && typeof spendableById === 'object') {
      const entry = spendableById[spendableMatch[1]];
      jsonResponse(
        response,
        200,
        entry === 'funded'
          ? ORG_FUNDED_SPENDABLE
          : entry === 'empty'
            ? { ...NO_ORG_SPENDABLE, orgCreditPoolCapable: true }
            : entry && typeof entry === 'object'
              ? entry
              : NO_ORG_SPENDABLE,
      );
      return true;
    }
    const covered =
      bearer === ORG_FUNDED_CREDITS_KEY && spendableMatch[1] === ORG_FUNDED_ID;
    jsonResponse(
      response,
      200,
      covered ? ORG_FUNDED_SPENDABLE : NO_ORG_SPENDABLE,
    );
    return true;
  }

  // Feedback report creation (CAN-2682). Returns only `reportId` — no
  // `uploadUrl`/`filePath` — so `submitFeedback` skips the diagnostics upload
  // and commit entirely. Specs that reach here uncheck "Include diagnostics"
  // first, so no bundle is built either; the point is to drive the modal's
  // success branch, not to exercise the attachment pipeline.
  if (pathname === '/api/v1/feedback/reports') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    if (method !== 'POST') {
      jsonResponse(response, 405, { error: 'Method not allowed.' });
      return true;
    }
    const body = await readJsonBody(request);
    // Mirror the real route's validation surface closely enough that a
    // renderer regression sending a bad type or an empty description fails
    // here rather than silently rendering success.
    if (body?.type !== 'bug' && body?.type !== 'idea') {
      jsonResponse(response, 400, { error: 'Invalid feedback report type.' });
      return true;
    }
    if (
      typeof body?.description !== 'string' ||
      body.description.trim().length === 0
    ) {
      jsonResponse(response, 400, { error: 'Description is required.' });
      return true;
    }
    const errorReferenceId = body.error?.referenceId;
    if (
      body.error !== undefined &&
      (typeof errorReferenceId !== 'string' ||
        !/^ERR-[0-9A-HJKMNP-TV-Z]{8}$/.test(errorReferenceId))
    ) {
      jsonResponse(response, 400, {
        error: 'Invalid feedback error reference.',
      });
      return true;
    }
    jsonResponse(response, 200, {
      reportId: 'feedback-report-e2e',
      referenceId: errorReferenceId ?? 'REP-00000000',
      diagnosticsStatus: body.attachDiagnostics
        ? 'unavailable'
        : 'not-requested',
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/canopy/memory/search') {
    const bearer = (request.headers.authorization ?? '').replace(
      /^Bearer\s+/,
      '',
    );
    const body = await readJsonBody(request);
    // CAN-3457: count every search, and which org it targeted, so specs can
    // prove a chat searches only the org that owns its project.
    recordScenarioActivity(bearer, 'memorySearch');
    const searchedOrganization =
      typeof body?.organizationExternalId === 'string'
        ? body.organizationExternalId
        : 'missing';
    recordScenarioActivity(bearer, `memorySearch:${searchedOrganization}`);
    jsonResponse(
      response,
      200,
      MEMORY_CLOUD_API_KEYS.has(bearer) &&
        searchedOrganization === MEMORY_FEEDBACK_ORGANIZATION_ID
        ? {
            searchId: '22222222-2222-4222-8222-222222222222',
            facts: [
              {
                factId: '11111111-1111-4111-8111-111111111111',
                factText:
                  '[Canopy-CORGMEMORY] Releases use a weekly release train.',
                validAt: null,
                sourceTurnIds: ['source-turn-1'],
              },
            ],
            renderedBlock:
              '<org_memory>\n[Canopy-CORGMEMORY] Releases use a weekly release train.\n</org_memory>',
          }
        : { facts: [], renderedBlock: null },
    );
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/canopy/memory/delivered') {
    await readJsonBody(request);
    jsonResponse(response, 200, { recorded: true });
    return true;
  }

  if (pathname === '/api/v1/canopy/memory/feedback') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const bearer = (request.headers.authorization ?? '').replace(
      /^Bearer\s+/,
      '',
    );
    if (!MEMORY_CLOUD_API_KEYS.has(bearer)) {
      jsonResponse(response, 404, { error: 'Not found.' });
      return true;
    }
    if (method === 'GET') {
      jsonResponse(response, 200, { feedback: null, canSubmit: true });
      return true;
    }
    if (method === 'POST') {
      await readJsonBody(request);
      jsonResponse(response, 200, { recorded: false });
      return true;
    }
    jsonResponse(response, 405, { error: 'Method not allowed.' });
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/entitlements') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const scenarioKey = keyFromBearer(request);
    recordScenarioActivity(scenarioKey, 'entitlementsRead');
    const entitlementsDelayMs =
      getScenario(scenarioKey).cloud?.entitlementsDelayMs;
    if (typeof entitlementsDelayMs === 'number' && entitlementsDelayMs > 0) {
      await delay(entitlementsDelayMs);
    }
    // Per-scenario entitlements body. Re-registering the scenario swaps it
    // mid-session, which is how the private-by-default spec moves one signed-in
    // account between paid and free (lapsed) without switching keys.
    const scenarioEntitlements = getScenario(scenarioKey).cloud?.entitlements;
    if (scenarioEntitlements && typeof scenarioEntitlements === 'object') {
      jsonResponse(response, 200, scenarioEntitlements);
      return true;
    }
    // Reuse `scenarioKey` rather than re-parsing the Authorization header: it
    // is the same value, and keeping token parsing in one place avoids the two
    // helpers drifting.
    const bearer = scenarioKey;
    // The Usage tile key resolves to an active paid `Pro` subscription so the
    // tile's native plan chip renders `Pro`.
    if (
      bearer === USAGE_AI_CREDITS_TILE_KEY ||
      isSharedContainersCloudApiKey(bearer)
    ) {
      jsonResponse(response, 200, {
        plan: isSharedContainersCloudApiKey(bearer)
          ? { key: 'business', displayName: 'Business' }
          : { key: 'pro', displayName: 'Pro' },
        source: 'subscription',
        trial: null,
        capabilities: ['data_sync_control'],
        coveringOrgs: [],
        billingManageableOrg: null,
      });
      return true;
    }
    // Only the dedicated subscription-pill key gets a billing grant. Every other
    // key resolves like an unlinked account (404), matching the pre-existing
    // fall-through so the data-sync privacy-gate specs keep their behavior.
    if (
      bearer !== SUBSCRIPTION_PILL_TRIAL_KEY &&
      bearer !== SUBSCRIPTION_PILL_BUSINESS_TRIAL_KEY
    ) {
      jsonResponse(response, 404, { error: 'No linked account.' });
      return true;
    }
    // A real active-trial entitlement: trials grant the Business catalog plan,
    // so the footer shows `Business` while upgrade clicks must ignore the
    // manageable org and resolve to pricing. This exercises the
    // plan/trial/billingManageableOrg wire fields end-to-end through the real
    // entitlements client + IPC seam.
    //
    // `capabilities: []` withholds `data_sync_control`, which no longer gates
    // Settings → Privacy: the pill spec asserts Privacy shows no upgrade
    // prompt for this free-capability trial.
    const endsAt = new Date(Date.now() + 12 * 86_400_000).toISOString();
    const scenarioPresentation =
      getScenario(scenarioKey).cloud?.billingPresentation;
    jsonResponse(response, 200, {
      plan: { key: 'business', displayName: 'Business' },
      source: 'trial',
      trial: { active: true, endsAt },
      capabilities: [],
      coveringOrgs: [],
      billingManageableOrg: { id: 'org-pill-e2e', name: 'Acme E2E' },
      billingPresentation:
        bearer === SUBSCRIPTION_PILL_BUSINESS_TRIAL_KEY
          ? {
              plan: { key: 'business', displayName: 'Business' },
              owner: {
                type: 'organization',
                id: 'org-business-e2e',
                name: 'Business E2E',
              },
              lifecycle: 'trial',
              trialEndsAt: endsAt,
              action: 'subscribe',
            }
          : {
              plan: { key: 'individual', displayName: 'Pro' },
              owner: { type: 'user' },
              lifecycle: 'trial',
              trialEndsAt: endsAt,
              action: 'subscribe',
            },
      // Per-scenario override of the whole presentation (CAN-2590). The default
      // above is USER-owned, which is the realistic shape for this key and is
      // exactly why the Remote Control paywall must NOT name its plan beside a
      // lapsed org's id. That default leaves the plan-named branch unreachable
      // in automation, so a spec that needs it can register an org-owned
      // presentation instead of the mock growing a second signed-in key.
      ...(scenarioPresentation
        ? { billingPresentation: scenarioPresentation }
        : {}),
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/mobile-activation') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    jsonResponse(response, 200, {
      hasMobileActivation: keyFromBearer(request) === MOBILE_ACTIVATION_KEY,
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/ai-credits/subscription') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const bearer = keyFromBearer(request);
    jsonResponse(response, 200, {
      email: CLOUD_ACCOUNT.email,
      active: true,
      plan: 'Pro',
      status: 'active',
      renewsAt: '2026-08-01T00:00:00.000Z',
      ...getScenario(bearer).cloud?.aiCreditsSubscription,
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/ai-credits/balance') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const bearer = keyFromBearer(request);
    const forcedStatus = getScenario(bearer).cloud?.aiCreditsBalanceHttpStatus;
    if (
      typeof forcedStatus === 'number' &&
      Number.isInteger(forcedStatus) &&
      forcedStatus >= 400
    ) {
      jsonResponse(response, forcedStatus, {
        error: `Mock AI Credits balance failure (${forcedStatus})`,
      });
      return true;
    }
    // CAN-5026: `cloud.aiCreditsBalanceWaitFor` names a barrier every balance
    // read waits on until the test releases it (`POST /__mock/barrier`), so a
    // spec can observe the composer while the re-read is in flight. A reset
    // or timed-out barrier still answers, so no request is left hanging.
    const holdFor = getScenario(bearer).cloud?.aiCreditsBalanceWaitFor;
    if (typeof holdFor === 'string' && holdFor.trim()) {
      await waitForBarrier(bearer, holdFor, 60_000).catch(() => {});
    }
    jsonResponse(response, 200, {
      email: CLOUD_ACCOUNT.email,
      // CAN-2311/CAN-2349: every org-billing fixture has NO spendable personal
      // balance, so its org state is what decides coverage. With the default
      // eligible balance the lapsed and contact-admin branches would both stay
      // silent. The RESTORED fixture keeps the same empty balance on purpose:
      // the only thing that changes between lapsed and restored is
      // `teamsEntitled`, so the banner disappearing can only be attributed to
      // the org coming back.
      ...(ORG_BILLING_STATE_FIXTURES.has(bearer) ||
      bearer === MODEL_RECOVERY_CONTACT_ADMIN_KEY
        ? { credits: 0, eligible: false }
        : bearer === ORG_FUNDED_CREDITS_KEY
          ? // Empty personal wallet, funded by the org's shared credit pool —
            // the state the "0 credits" banner used to misreport. The default
            // unkeyed response is deliberately untouched so no existing spec
            // shifts.
            {
              credits: 0,
              eligible: false,
              orgPool: { orgId: ORG_FUNDED_ID, orgName: 'Acme E2E' },
            }
          : { credits: 1234, eligible: true }),
      ...getScenario(bearer).cloud?.aiCreditsBalance,
      ...scopedOrgPoolFor(
        request,
        getScenario(bearer).cloud?.aiCreditsOrgPools,
      ),
    });
    return true;
  }

  // Smart sign-in UD-link CTA account-match check (drives
  // `UnstoppableDomainsLinkPrompt`). The response is keyed off the connected
  // API key so specs can select outcome deterministically: a key containing
  // `linked` reports an already-linked account (client suppresses the prompt),
  // a key containing `match` (e.g. `csk_ud_link_prompt_match_e2e`, checked
  // after the `nomatch` literal) reports an unlinked match (client opens the
  // modal), and any other valid `csk_` key reports NO matching UD e-commerce
  // account. No-match must be the default: the prompt modal overlays the app
  // shell, so an opt-out default would block sidebar/menu clicks in every
  // signed-in spec that does not know about this surface (exactly what broke
  // ai-credits-handoff, subscription-status-pill, and split-pr when this
  // route first shipped with match-by-default).
  if (method === 'GET' && pathname === '/api/v1/ai-credits/account-match') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const bearer = (request.headers.authorization ?? '').replace(
      /^Bearer\s+/,
      '',
    );
    if (bearer.includes('linked')) {
      jsonResponse(response, 200, {
        linked: true,
        matched: false,
        email: null,
      });
      return true;
    }
    // `nomatch` contains the substring `match`; keep this branch first so an
    // explicit no-match key never falls through to the matched branch.
    if (bearer.includes('nomatch')) {
      jsonResponse(response, 200, {
        linked: false,
        matched: false,
        email: null,
      });
      return true;
    }
    if (bearer.includes('match')) {
      jsonResponse(response, 200, {
        linked: false,
        matched: true,
        email: CLOUD_ACCOUNT.email,
      });
      return true;
    }
    jsonResponse(response, 200, {
      linked: false,
      matched: false,
      email: null,
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/ai-credits/handoff-url') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const body = await readJsonBody(request);
    const target = body?.target;
    if (target !== 'manage' && target !== 'purchase') {
      jsonResponse(response, 400, { error: 'invalid_target' });
      return true;
    }
    // Both targets mint an authenticated magic-link handoff to the signed-in
    // `/account/ai-credits` page (CAN-935); `purchase` adds `?purchase=1` so the
    // account page auto-opens the purchase flow. The distinct redirect params
    // let specs assert click-time resolution went through this route.
    const redirect =
      target === 'manage'
        ? '%2Faccount%2Fai-credits'
        : '%2Faccount%2Fai-credits%3Fpurchase%3D1';
    jsonResponse(response, 200, {
      url: `https://ud-staging.com/api/oauth/link?token=e2e-mock&redirect=${redirect}`,
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/canopy/plugins') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    recordScenarioActivity(
      keyFromBearer(request),
      'marketplaceSharedPluginsList',
    );
    jsonResponse(response, 200, { data: [] });
    return true;
  }

  const curatedAutomationMatch = pathname.match(
    /^\/api\/v1\/curated-automations(?:\/([^/]+))?(?:\/package(?:\/blobs\/([^/]+))?)?$/,
  );
  if (method === 'GET' && curatedAutomationMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const [, encodedKey, blobHash] = curatedAutomationMatch;
    const entries =
      getScenario(keyFromBearer(request))?.cloud?.curatedAutomations ?? [];
    if (encodedKey === undefined) {
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const category = url.searchParams.get('category');
      const actionType = url.searchParams.get('actionType');
      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get('limit') ?? 25) || 25),
      );
      const requestedOffset = Number(url.searchParams.get('cursor') ?? 0);
      const offset =
        Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
          ? requestedOffset
          : 0;
      const filtered = entries.filter(
        (entry) =>
          (!query ||
            entry.key.toLowerCase().includes(query) ||
            entry.name.toLowerCase().includes(query) ||
            entry.shortDescription.toLowerCase().includes(query)) &&
          (!category || entry.categories.includes(category)) &&
          (!actionType || entry.actionType === actionType),
      );
      const data = filtered.slice(offset, offset + limit).map((entry) => {
        const { automation, packageDownload, packageBlobs, ...summary } = entry;
        return summary;
      });
      jsonResponse(response, 200, {
        version: 1,
        data,
        nextCursor:
          offset + limit < filtered.length ? String(offset + limit) : null,
      });
      return true;
    }
    const key = decodeURIComponent(encodedKey);
    const entry = entries.find((candidate) => candidate.key === key);
    if (!entry) {
      jsonResponse(response, 404, { error: 'Curated automation not found.' });
      return true;
    }
    const isPackageRequest = pathname.includes('/package');
    if (!isPackageRequest) {
      const { packageDownload, packageBlobs, ...detail } = entry;
      jsonResponse(response, 200, detail);
      return true;
    }
    const expectedDigest = url.searchParams.get('expectedPackageDigest');
    if (
      !entry.packageDownload ||
      expectedDigest !== entry.packageDownload.digest
    ) {
      jsonResponse(response, 404, { error: 'Package not found.' });
      return true;
    }
    if (blobHash === undefined) {
      jsonResponse(response, 200, entry.packageDownload);
      return true;
    }
    const encodedBlob = entry.packageBlobs?.[blobHash];
    if (typeof encodedBlob !== 'string') {
      jsonResponse(response, 404, { error: 'Blob not found.' });
      return true;
    }
    const blob = Buffer.from(encodedBlob, 'base64');
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.byteLength),
    });
    response.end(blob);
    return true;
  }

  const scopedAutomationPackageMatch = pathname.match(
    /^\/api\/v1\/automations\/([^/]+)\/package(?:\/blobs\/([^/]+))?$/,
  );
  if (method === 'GET' && scopedAutomationPackageMatch) {
    const [, automationId, blobHash] = scopedAutomationPackageMatch;
    if (
      !hasValidAuth(request) ||
      automationId !== AUTOMATION_SHARE_ID ||
      !sharedAutomationPackage ||
      url.searchParams.get('expectedPackageDigest') !==
        sharedAutomationPackage.digest
    ) {
      jsonResponse(response, 404, { error: 'Package not found.' });
      return true;
    }
    if (blobHash === undefined) {
      jsonResponse(response, 200, {
        digest: sharedAutomationPackage.digest,
        manifest: sharedAutomationPackage.manifest,
      });
      return true;
    }
    const blob = sharedAutomationPackage.blobs?.get(blobHash);
    if (!blob) {
      jsonResponse(response, 404, { error: 'Blob not found.' });
      return true;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.byteLength),
    });
    response.end(blob);
    return true;
  }

  const automationPublicShareMatch = pathname.match(
    /^\/api\/v1\/canopy\/automations\/([^/]+)\/public-share$/,
  );
  const automationDetailMatch = pathname.match(
    /^\/api\/v1\/canopy\/automations\/([^/]+)$/,
  );
  if (
    pathname === '/api/v1/canopy/automations' ||
    automationDetailMatch ||
    automationPublicShareMatch
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const automationScenario = getScenario(keyFromBearer(request))?.cloud;
    const automationWriteDelayMs = automationScenario?.automationWriteDelayMs;
    if (
      (method === 'POST' || method === 'PUT') &&
      typeof automationWriteDelayMs === 'number' &&
      automationWriteDelayMs > 0
    ) {
      await delay(automationWriteDelayMs);
    }
    if (automationPublicShareMatch) {
      if (method === 'POST') {
        // Re-publishing re-pins the snapshot, so a link carrying the previous
        // pin resolves as `automation_share_changed` — the case the desktop
        // landing must surface rather than silently installing stale content.
        const republished = automationPublicShare !== null;
        automationPublicShare = {
          ...AUTOMATION_PUBLIC_SHARE,
          upToDate: true,
          ...(republished ? { pinnedContentHash: `b2${'a1'.repeat(31)}` } : {}),
        };
        automationPublicSnapshot = structuredClone(sharedAutomationDocument);
        if (
          sharedAutomationPackage &&
          automationPublicSnapshot.capabilityPackage?.digest ===
            sharedAutomationPackage.digest
        ) {
          // A packaged pipeline (document version 5+) publishes the package
          // committed with the scoped share, as the real server does.
          automationPublicPackage = {
            digest: sharedAutomationPackage.digest,
            manifest: sharedAutomationPackage.manifest,
            blobs: sharedAutomationPackage.blobs,
          };
        } else {
          automationPublicPackage = null;
        }
        jsonResponse(response, 200, { publicShare: automationPublicShare });
        return true;
      }
      if (method === 'DELETE') {
        automationPublicShare = null;
        automationPublicSnapshot = null;
        automationPublicPackage = null;
        response.writeHead(204);
        response.end();
        return true;
      }
    } else if (
      method === 'GET' &&
      !automationDetailMatch &&
      Array.isArray(automationScenario?.sharedAutomations)
    ) {
      // A scenario can list its own shared-automation summaries, e.g. shares
      // published by different owners for context scoping (CAN-3448), and
      // page them with `sharedAutomationsPageSize` (the cursor is an offset).
      const all = automationScenario.sharedAutomations;
      const pageSize = Number.isInteger(
        automationScenario.sharedAutomationsPageSize,
      )
        ? automationScenario.sharedAutomationsPageSize
        : all.length;
      const offset = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10);
      const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
      const end = start + pageSize;
      jsonResponse(response, 200, {
        automations: all.slice(start, end),
        nextCursor: end < all.length ? String(end) : null,
      });
      return true;
    } else if (method === 'GET') {
      jsonResponse(
        response,
        200,
        automationDetailMatch
          ? sharedAutomationDetail(
              sharedAutomationDocument,
              automationPublicShare,
            )
          : {
              automations: sharedAutomationCreated
                ? [
                    sharedAutomationSummary(
                      sharedAutomationDocument,
                      automationPublicShare,
                    ),
                  ].filter(isVisibleSharedResource)
                : [],
            },
      );
      return true;
    } else if (method === 'POST' || method === 'PUT') {
      const body = await readJsonBody(request);
      sharedAutomationDocument = body?.automation ?? sharedAutomationDocument;
      sharedAutomationShareScope =
        body?.shareScope ?? sharedAutomationShareScope;
      const team = automationScenario?.teams?.find(
        (candidate) => candidate.id === body?.teamId,
      );
      sharedAutomationOwner =
        sharedAutomationShareScope === 'organization'
          ? {
              type: 'organization',
              id: body?.organizationId,
              name: SCOPED_LINKS_ORGANIZATION.name,
            }
          : sharedAutomationShareScope === 'team'
            ? {
                type: 'team',
                id: body?.teamId,
                name: team?.name ?? 'Platform',
                ...(team?.organization
                  ? {
                      organization: {
                        id: team.organization.id,
                        name: team.organization.name,
                      },
                    }
                  : {}),
              }
            : {
                type: 'user',
                id: CLOUD_ACCOUNT.id,
                name: CLOUD_ACCOUNT.name,
              };
      const committedUpload =
        typeof body?.committedPackageUploadId === 'string'
          ? committedPipelinePackages.get(body.committedPackageUploadId)
          : undefined;
      if (committedUpload?.manifest) {
        sharedAutomationPackage = {
          digest: committedUpload.expectedDigest,
          manifest: committedUpload.manifest,
          blobs: committedUpload.blobs,
        };
      } else if (method === 'POST') {
        sharedAutomationPackage = null;
      }
      if (method === 'POST') {
        sharedAutomationCreated = true;
        automationPublicShare = null;
        automationPublicSnapshot = null;
        automationPublicPackage = null;
      }
      if (method === 'PUT' && body?.revokePublicShare) {
        // Like the real server, a narrower update that names the observed
        // public link removes it in the same write.
        automationPublicShare = null;
        automationPublicSnapshot = null;
        automationPublicPackage = null;
      } else if (method === 'PUT' && automationPublicShare) {
        automationPublicShare = { ...automationPublicShare, upToDate: false };
      }
      jsonResponse(
        response,
        method === 'POST' ? 201 : 200,
        sharedAutomationDetail(sharedAutomationDocument, automationPublicShare),
      );
      return true;
    } else if (method === 'DELETE' && automationDetailMatch) {
      sharedAutomationCreated = false;
      sharedAutomationPackage = null;
      sharedAutomationShareScope = 'private';
      sharedAutomationOwner = {
        type: 'user',
        id: CLOUD_ACCOUNT.id,
        name: CLOUD_ACCOUNT.name,
      };
      automationPublicShare = null;
      automationPublicSnapshot = null;
      automationPublicPackage = null;
      response.writeHead(204);
      response.end();
      return true;
    }
  }

  if (
    method === 'GET' &&
    pathname ===
      `/api/v1/canopy/public-shares/automations/${AUTOMATION_PUBLIC_SHARE_ID}`
  ) {
    if (!automationPublicShare) {
      jsonResponse(response, 404, { error: 'Public share not found.' });
      return true;
    }
    // Mirrors the real route (CAN-3135): pinless resolution stays permanently
    // lenient for legacy links and released clients; a supplied pin that no
    // longer matches is a 409.
    const expectedHashes = url.searchParams.getAll(
      'expectedAutomationContentHash',
    );
    if (
      expectedHashes.length > 1 ||
      (expectedHashes[0] !== undefined &&
        expectedHashes[0] !== automationPublicShare.pinnedContentHash)
    ) {
      response.setHeader('Cache-Control', 'private, no-store');
      jsonResponse(response, 409, {
        error: 'This shared automation changed.',
        code: 'automation_share_changed',
      });
      return true;
    }
    jsonResponse(response, 200, {
      entity: 'automation',
      externalId: AUTOMATION_PUBLIC_SHARE_ID,
      automation: automationPublicSnapshot,
      contentHash: automationPublicShare.pinnedContentHash,
      distributionMode: automationPublicPackage ? 'package' : 'definition_only',
      ...(automationPublicPackage
        ? {
            package: publicAutomationPackageSummary(automationPublicPackage),
          }
        : {}),
      authorUsername: 'portal-e2e',
      updatedAt: NOW,
    });
    return true;
  }

  const automationPublicPackageMatch = pathname.match(
    /^\/api\/v1\/public-shares\/automations\/([^/]+)\/package$/,
  );
  if (method === 'GET' && automationPublicPackageMatch) {
    if (
      automationPublicPackageMatch[1] !== AUTOMATION_PUBLIC_SHARE_ID ||
      !automationPublicPackage ||
      url.searchParams.get('expectedPackageDigest') !==
        automationPublicPackage.digest
    ) {
      jsonResponse(response, 404, { error: 'Package not found.' });
      return true;
    }
    jsonResponse(response, 200, {
      digest: automationPublicPackage.digest,
      manifest: automationPublicPackage.manifest,
    });
    return true;
  }

  const automationPublicPackageBlobMatch = pathname.match(
    /^\/api\/v1\/public-shares\/automations\/([^/]+)\/package\/blobs\/([^/]+)$/,
  );
  if (method === 'GET' && automationPublicPackageBlobMatch) {
    const [, shareId, blobHash] = automationPublicPackageBlobMatch;
    // A published share package serves the author's uploaded blobs.
    const blob = automationPublicPackage?.blobs?.get(blobHash);
    if (
      shareId !== AUTOMATION_PUBLIC_SHARE_ID ||
      !automationPublicPackage ||
      url.searchParams.get('expectedPackageDigest') !==
        automationPublicPackage.digest ||
      !blob
    ) {
      jsonResponse(response, 404, { error: 'Blob not found.' });
      return true;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.byteLength),
    });
    response.end(blob);
    return true;
  }

  if (
    method === 'GET' &&
    pathname ===
      `/api/v1/canopy/public-shares/skills/${SKILL_PACKAGE_PUBLIC_SHARE_ID}`
  ) {
    jsonResponse(response, 200, {
      entity: 'skill',
      externalId: SKILL_PACKAGE_PUBLIC_SHARE_ID,
      name: 'release-notes',
      description: 'Draft release notes from merged pull requests.',
      rawSkill: SKILL_PACKAGE_RAW,
      contentHash: SKILL_PACKAGE_CONTENT_HASH,
      dependencies: [{ kind: 'mcp', name: 'Slack' }],
      distributionMode: 'package',
      package: {
        digest: SKILL_PACKAGE_DIGEST,
        version: 1,
        // The summary the web builds: provider twins in one row, each file
        // counted once.
        resources: [
          {
            id: 'release-notes-claude',
            displayName: '/release-notes',
            kind: 'standalone_skill',
            sourceLabel: 'Custom',
            fileCount: SKILL_PACKAGE_FILES.length,
            totalBytes: SKILL_PACKAGE_TREE_BYTES,
            affectedSteps: [],
            executableFiles: ['scripts/collect.sh'],
          },
        ],
        environmentRequirements: SKILL_PACKAGE_MANIFEST.environmentRequirements,
        totalFiles: SKILL_PACKAGE_FILES.length,
        totalBytes: SKILL_PACKAGE_TREE_BYTES,
      },
      authorUsername: 'portal-e2e',
      updatedAt: NOW,
    });
    return true;
  }

  const skillPublicPackageMatch = pathname.match(
    /^\/api\/v1\/public-shares\/skills\/([^/]+)\/package$/,
  );
  if (method === 'GET' && skillPublicPackageMatch) {
    if (
      skillPublicPackageMatch[1] !== SKILL_PACKAGE_PUBLIC_SHARE_ID ||
      url.searchParams.get('expectedPackageDigest') !== SKILL_PACKAGE_DIGEST
    ) {
      jsonResponse(response, 404, { error: 'Package not found.' });
      return true;
    }
    jsonResponse(response, 200, {
      digest: SKILL_PACKAGE_DIGEST,
      manifest: SKILL_PACKAGE_MANIFEST,
    });
    return true;
  }

  const skillPublicPackageBlobMatch = pathname.match(
    /^\/api\/v1\/public-shares\/skills\/([^/]+)\/package\/blobs\/([^/]+)$/,
  );
  if (method === 'GET' && skillPublicPackageBlobMatch) {
    const blob = SKILL_PACKAGE_BLOBS.get(skillPublicPackageBlobMatch[2]);
    if (
      skillPublicPackageBlobMatch[1] !== SKILL_PACKAGE_PUBLIC_SHARE_ID ||
      !blob ||
      url.searchParams.get('expectedPackageDigest') !== SKILL_PACKAGE_DIGEST
    ) {
      jsonResponse(response, 404, { error: 'Blob not found.' });
      return true;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.byteLength),
    });
    response.end(blob);
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/canopy/agents') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    recordScenarioActivity(
      keyFromBearer(request),
      'marketplaceSharedAgentsList',
    );
    if (keyFromBearer(request) === CAN3310_AGENT_API_KEY) {
      const detail =
        can3310SharedAgents.get(CAN3310_AGENT_API_KEY) ??
        sharedAgentDetail(AGENT_DOCUMENT, null, CAN3310_PACKAGE_SUMMARY);
      const { agent: _agent, ...summary } = detail;
      jsonResponse(response, 200, {
        agents: [summary].filter(isVisibleSharedResource),
        nextCursor: null,
      });
      return true;
    }
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const agents = (
      getScenario(keyFromBearer(request)).cloud?.sharedAgents ?? []
    )
      .filter(isVisibleSharedResource)
      .filter(
        (agent) =>
          !query ||
          `${agent.name} ${agent.instructionsPreview ?? ''}`
            .toLowerCase()
            .includes(query),
      );
    const limit = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get('limit') ?? 25) || 25),
    );
    const offset = Math.max(
      0,
      Number(url.searchParams.get('cursor') ?? 0) || 0,
    );
    jsonResponse(response, 200, {
      agents: agents.slice(offset, offset + limit),
      nextCursor:
        offset + limit < agents.length ? String(offset + limit) : null,
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/canopy/agents') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const body = await readJsonBody(request);
    const detail = withRequestedAudience(
      sharedAgentDetail(
        body?.agent,
        null,
        body?.capabilityPackage ? CAN3310_PACKAGE_SUMMARY : null,
      ),
      body,
      getScenario(keyFromBearer(request)),
    );
    if (keyFromBearer(request) === CAN3310_AGENT_API_KEY) {
      can3310SharedAgents.set(CAN3310_AGENT_API_KEY, detail);
    }
    jsonResponse(response, 201, detail);
    return true;
  }

  const agentPublicShareMatch = pathname.match(
    /^\/api\/v1\/canopy\/agents\/([^/]+)\/public-share$/,
  );
  if (method === 'POST' && agentPublicShareMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    jsonResponse(response, 200, { publicShare: AGENT_PUBLIC_SHARE });
    return true;
  }
  if (method === 'DELETE' && agentPublicShareMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    // Like the real server, revoking deletes only the public-share row: a
    // scenario agent that was user-owned becomes private-only, and the list
    // filter above hides it.
    const scenarioAgent = getScenario(
      keyFromBearer(request),
    ).cloud?.sharedAgents?.find(
      (agent) => agent.id === decodeURIComponent(agentPublicShareMatch[1]),
    );
    if (scenarioAgent) scenarioAgent.publicShare = null;
    response.writeHead(204);
    response.end();
    return true;
  }

  const agentDetailMatch = pathname.match(
    /^\/api\/v1\/canopy\/agents\/([^/]+)$/,
  );
  if (method === 'GET' && agentDetailMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const can3310Detail = can3310SharedAgents.get(CAN3310_AGENT_API_KEY);
    jsonResponse(
      response,
      200,
      keyFromBearer(request) === CAN3310_AGENT_API_KEY && can3310Detail
        ? can3310Detail
        : (getScenario(keyFromBearer(request)).cloud?.sharedAgents?.find(
            (agent) => agent.id === agentDetailMatch[1],
          ) ??
            sharedAgentDetail(
              AGENT_DOCUMENT,
              AGENT_PUBLIC_SHARE,
              keyFromBearer(request) === CAN3310_AGENT_API_KEY
                ? CAN3310_PACKAGE_SUMMARY
                : null,
            )),
    );
    return true;
  }

  const agentPackageMatch = pathname.match(
    /^\/api\/v1\/agents\/([^/]+)\/package$/,
  );
  if (method === 'GET' && agentPackageMatch) {
    if (
      !hasValidAuth(request) ||
      agentPackageMatch[1] !== AGENT_SHARE_ID ||
      url.searchParams.get('expectedPackageDigest') !== SKILL_PACKAGE_DIGEST
    ) {
      jsonResponse(response, 404, { error: 'Package not found.' });
      return true;
    }
    jsonResponse(response, 200, {
      digest: SKILL_PACKAGE_DIGEST,
      manifest: SKILL_PACKAGE_MANIFEST,
    });
    return true;
  }

  const agentPackageBlobMatch = pathname.match(
    /^\/api\/v1\/agents\/([^/]+)\/package\/blobs\/([^/]+)$/,
  );
  if (method === 'GET' && agentPackageBlobMatch) {
    const blob = SKILL_PACKAGE_BLOBS.get(agentPackageBlobMatch[2]);
    if (
      !hasValidAuth(request) ||
      agentPackageBlobMatch[1] !== AGENT_SHARE_ID ||
      !blob ||
      url.searchParams.get('expectedPackageDigest') !== SKILL_PACKAGE_DIGEST
    ) {
      jsonResponse(response, 404, { error: 'Blob not found.' });
      return true;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.byteLength),
    });
    response.end(blob);
    return true;
  }

  const agentPublicPackageMatch = pathname.match(
    /^\/api\/v1\/public-shares\/agents\/([^/]+)\/package$/,
  );
  if (method === 'GET' && agentPublicPackageMatch) {
    if (
      agentPublicPackageMatch[1] !== AGENT_PACKAGE_PUBLIC_SHARE_ID ||
      url.searchParams.get('expectedPackageDigest') !== SKILL_PACKAGE_DIGEST
    ) {
      jsonResponse(response, 404, { error: 'Package not found.' });
      return true;
    }
    jsonResponse(response, 200, {
      digest: SKILL_PACKAGE_DIGEST,
      manifest: SKILL_PACKAGE_MANIFEST,
    });
    return true;
  }

  const agentPublicPackageBlobMatch = pathname.match(
    /^\/api\/v1\/public-shares\/agents\/([^/]+)\/package\/blobs\/([^/]+)$/,
  );
  if (method === 'GET' && agentPublicPackageBlobMatch) {
    const blob = SKILL_PACKAGE_BLOBS.get(agentPublicPackageBlobMatch[2]);
    if (
      agentPublicPackageBlobMatch[1] !== AGENT_PACKAGE_PUBLIC_SHARE_ID ||
      !blob ||
      url.searchParams.get('expectedPackageDigest') !== SKILL_PACKAGE_DIGEST
    ) {
      jsonResponse(response, 404, { error: 'Blob not found.' });
      return true;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.byteLength),
    });
    response.end(blob);
    return true;
  }

  if (
    method === 'GET' &&
    pathname ===
      `/api/v1/canopy/public-shares/agents/${AGENT_PACKAGE_PUBLIC_SHARE_ID}`
  ) {
    jsonResponse(response, 200, {
      entity: 'agent',
      externalId: AGENT_PACKAGE_PUBLIC_SHARE_ID,
      agent: AGENT_DOCUMENT,
      contentHash: AGENT_PUBLIC_SHARE.pinnedContentHash,
      package: CAN3310_PACKAGE_SUMMARY,
      authorUsername: 'portal-e2e',
      updatedAt: NOW,
    });
    return true;
  }

  if (
    method === 'GET' &&
    pathname === `/api/v1/canopy/public-shares/agents/${AGENT_PUBLIC_SHARE_ID}`
  ) {
    jsonResponse(response, 200, {
      entity: 'agent',
      externalId: AGENT_PUBLIC_SHARE_ID,
      agent: AGENT_DOCUMENT,
      contentHash: AGENT_PUBLIC_SHARE.pinnedContentHash,
      authorUsername: 'portal-e2e',
      updatedAt: NOW,
    });
    return true;
  }

  if (
    method === 'GET' &&
    pathname === '/api/v1/canopy/workspace-template-shares'
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    recordScenarioActivity(
      keyFromBearer(request),
      'marketplaceSharedTemplatesList',
    );
    if (keyFromBearer(request) === 'csk_shared_template_picker_e2e') {
      jsonResponse(response, 200, {
        shares: [
          {
            externalId: WORKSPACE_TEMPLATE_SHARE_ID,
            sharePath: `/portal/plugins/project-templates/${WORKSPACE_TEMPLATE_SHARE_ID}`,
            pinnedContentHash: WORKSPACE_TEMPLATE_CONTENT_HASH,
            name: WORKSPACE_TEMPLATE_DOCUMENT.name,
            description: WORKSPACE_TEMPLATE_DOCUMENT.description,
            audience: 'TEAM',
            owner: {
              type: 'team',
              id: 'team-shared-template-e2e',
              name: 'Study Group',
              organization: {
                id: 'org-shared-template-e2e',
                name: 'Canopy University',
              },
            },
            createdBy: {
              id: 'account-template-author-e2e',
              name: 'Template Author',
            },
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      return true;
    }
    jsonResponse(response, 200, {
      shares:
        authoredWorkspaceTemplateShare && !workspaceTemplateShareRevoked
          ? [
              {
                externalId: WORKSPACE_TEMPLATE_SHARE_ID,
                sharePath: `/portal/plugins/project-templates/${WORKSPACE_TEMPLATE_SHARE_ID}`,
                pinnedContentHash: WORKSPACE_TEMPLATE_CONTENT_HASH,
                name: authoredWorkspaceTemplateShare.document.name,
                description:
                  authoredWorkspaceTemplateShare.document.description,
                audience: authoredWorkspaceTemplateShare.audience ?? 'PUBLIC',
                owner: {
                  type: 'user',
                  id: CLOUD_ACCOUNT.id,
                  name: CLOUD_ACCOUNT.name,
                },
                createdBy: { id: CLOUD_ACCOUNT.id, name: CLOUD_ACCOUNT.name },
                createdAt: NOW,
                updatedAt: NOW,
              },
            ]
          : [],
    });
    return true;
  }

  if (
    method === 'POST' &&
    pathname === '/api/v1/canopy/workspace-template-shares'
  ) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const body = await readJsonBody(request);
    if (
      keyFromBearer(request) === 'csk_workspace_template_e2e' &&
      (body?.document?.name !== 'Template Author Draft' ||
        body?.document?.instructions !==
          'Draft author instructions. Use /instructions-only.')
    ) {
      jsonResponse(response, 422, {
        error: 'Workspace template did not contain the current settings draft.',
      });
      return true;
    }
    if (keyFromBearer(request) === 'csk_workspace_template_e2e') {
      authoredWorkspaceTemplateShare = {
        document: body.document,
        audience: body.audience,
        capabilityPackage: body.capabilityPackage,
        packageUpload: committedPipelinePackages.get(
          body.committedPackageUploadId,
        ),
      };
    }
    workspaceTemplateShareRevoked = false;
    jsonResponse(response, 201, {
      externalId: WORKSPACE_TEMPLATE_SHARE_ID,
      sharePath: `/portal/plugins/project-templates/${WORKSPACE_TEMPLATE_SHARE_ID}`,
      pinnedContentHash: WORKSPACE_TEMPLATE_CONTENT_HASH,
    });
    return true;
  }

  const workspaceTemplateShareMatch = pathname.match(
    /^\/api\/v1\/canopy\/workspace-template-shares\/([^/]+)$/,
  );
  if (method === 'PUT' && workspaceTemplateShareMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    workspaceTemplateShareRevoked = false;
    jsonResponse(response, 200, {
      pinnedContentHash: WORKSPACE_TEMPLATE_CONTENT_HASH,
    });
    return true;
  }
  if (method === 'DELETE' && workspaceTemplateShareMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    workspaceTemplateShareRevoked = true;
    response.writeHead(204);
    response.end();
    return true;
  }

  if (
    method === 'GET' &&
    (pathname ===
      `/api/v1/canopy/public-shares/workspaces/${WORKSPACE_TEMPLATE_SHARE_ID}` ||
      pathname ===
        `/api/v1/canopy/public-shares/workspaces/${WORKSPACE_TEMPLATE_RETRY_SHARE_ID}`)
  ) {
    const requestedShareId = pathname.split('/').at(-1);
    const expectedContentHash = url.searchParams.get(
      'expectedWorkspaceTemplateContentHash',
    );
    if (
      expectedContentHash !== null &&
      expectedContentHash !== WORKSPACE_TEMPLATE_CONTENT_HASH
    ) {
      jsonResponse(response, 409, {
        error: 'This shared workspace template changed.',
        code: 'workspace_template_share_changed',
      });
      return true;
    }
    // Count openings, not main's pinned authorization re-read during install.
    if (
      requestedShareId === WORKSPACE_TEMPLATE_RETRY_SHARE_ID &&
      expectedContentHash === null
    ) {
      workspaceTemplateRetryResolveCount += 1;
    }
    if (
      workspaceTemplateShareRevoked &&
      requestedShareId === WORKSPACE_TEMPLATE_SHARE_ID
    ) {
      jsonResponse(response, 404, { error: 'Share not found.' });
      return true;
    }
    const authored =
      requestedShareId === WORKSPACE_TEMPLATE_SHARE_ID
        ? authoredWorkspaceTemplateShare
        : null;
    const uploadedManifest = authored?.packageUpload?.manifest;
    jsonResponse(response, 200, {
      entity: 'workspace',
      externalId: requestedShareId,
      template: authored?.document ?? WORKSPACE_TEMPLATE_DOCUMENT,
      contentHash: WORKSPACE_TEMPLATE_CONTENT_HASH,
      distributionMode: 'package',
      package:
        authored?.capabilityPackage && uploadedManifest
          ? {
              ...authored.capabilityPackage,
              resources: uploadedManifest.resources ?? [],
              environmentRequirements:
                uploadedManifest.environmentRequirements ?? [],
              totalFiles: uploadedManifest.totalFiles ?? 0,
              totalBytes: uploadedManifest.totalBytes ?? 0,
            }
          : CAN3310_PACKAGE_SUMMARY,
      authorUsername: 'portal-e2e',
      updatedAt: NOW,
    });
    return true;
  }

  const blueprintPackageMatch = pathname.match(
    /^\/api\/v1\/public-shares\/blueprints\/([^/]+)\/package$/,
  );
  if (method === 'GET' && blueprintPackageMatch) {
    const authored =
      blueprintPackageMatch[1] === WORKSPACE_TEMPLATE_SHARE_ID
        ? authoredWorkspaceTemplateShare
        : null;
    if (
      authored?.capabilityPackage &&
      authored.packageUpload?.manifest &&
      url.searchParams.get('expectedPackageDigest') ===
        authored.capabilityPackage.digest
    ) {
      jsonResponse(response, 200, {
        digest: authored.capabilityPackage.digest,
        manifest: authored.packageUpload.manifest,
      });
      return true;
    }
    if (
      (blueprintPackageMatch[1] !== WORKSPACE_TEMPLATE_SHARE_ID &&
        blueprintPackageMatch[1] !== WORKSPACE_TEMPLATE_RETRY_SHARE_ID) ||
      url.searchParams.get('expectedPackageDigest') !== SKILL_PACKAGE_DIGEST
    ) {
      jsonResponse(response, 404, { error: 'Package not found.' });
      return true;
    }
    if (
      blueprintPackageMatch[1] === WORKSPACE_TEMPLATE_RETRY_SHARE_ID &&
      workspaceTemplateRetryResolveCount % 2 === 1
    ) {
      jsonResponse(response, 503, { error: 'Package download failed once.' });
      return true;
    }
    jsonResponse(response, 200, {
      digest: SKILL_PACKAGE_DIGEST,
      manifest: SKILL_PACKAGE_MANIFEST,
    });
    return true;
  }

  const blueprintPackageBlobMatch = pathname.match(
    /^\/api\/v1\/public-shares\/blueprints\/([^/]+)\/package\/blobs\/([^/]+)$/,
  );
  if (method === 'GET' && blueprintPackageBlobMatch) {
    const authored =
      blueprintPackageBlobMatch[1] === WORKSPACE_TEMPLATE_SHARE_ID
        ? authoredWorkspaceTemplateShare
        : null;
    const authoredBlob = authored?.packageUpload?.blobs?.get(
      blueprintPackageBlobMatch[2],
    );
    if (
      authoredBlob &&
      url.searchParams.get('expectedPackageDigest') ===
        authored.capabilityPackage?.digest
    ) {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(authoredBlob.byteLength),
      });
      response.end(authoredBlob);
      return true;
    }
    const blob = SKILL_PACKAGE_BLOBS.get(blueprintPackageBlobMatch[2]);
    if (
      (blueprintPackageBlobMatch[1] !== WORKSPACE_TEMPLATE_SHARE_ID &&
        blueprintPackageBlobMatch[1] !== WORKSPACE_TEMPLATE_RETRY_SHARE_ID) ||
      !blob ||
      url.searchParams.get('expectedPackageDigest') !== SKILL_PACKAGE_DIGEST
    ) {
      jsonResponse(response, 404, { error: 'Blob not found.' });
      return true;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.byteLength),
    });
    response.end(blob);
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/canopy/plugins') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const body = await readJsonBody(request);
    jsonResponse(response, 201, {
      externalId: PLUGIN_PUBLIC_SHARE.externalId,
      refKey: PLUGIN_PUBLIC_SHARE.pinnedRefKey,
      ref: body?.ref,
      name: body?.name ?? 'Gamma Tool',
      description: body?.description ?? null,
      marketplaceOrigin: 'codex-builtin:demo/market',
      createdAt: NOW,
      updatedAt: NOW,
      publicShare: null,
    });
    return true;
  }

  const pluginPublicShareMatch = pathname.match(
    /^\/api\/v1\/canopy\/plugins\/([^/]+)\/public-share$/,
  );
  if (method === 'POST' && pluginPublicShareMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    jsonResponse(response, 200, { publicShare: PLUGIN_PUBLIC_SHARE });
    return true;
  }
  if (method === 'DELETE' && pluginPublicShareMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    response.writeHead(204);
    response.end();
    return true;
  }

  const pluginDetailMatch = pathname.match(
    /^\/api\/v1\/canopy\/plugins\/([^/]+)$/,
  );
  if (method === 'GET' && pluginDetailMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    jsonResponse(response, 200, {
      externalId: PLUGIN_PUBLIC_SHARE.externalId,
      refKey: PLUGIN_PUBLIC_SHARE.pinnedRefKey,
      ref: {
        type: 'codex_plugin',
        marketplace: { type: 'codex-builtin', id: 'demo/market' },
        plugin_name: 'gamma-tool',
      },
      name: 'Gamma Tool',
      description: 'gamma-tool (installed)',
      marketplaceOrigin: 'codex-builtin:demo/market',
      createdAt: NOW,
      updatedAt: NOW,
      publicShare: PLUGIN_PUBLIC_SHARE,
    });
    return true;
  }
  if (method === 'DELETE' && pluginDetailMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    response.writeHead(204);
    response.end();
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/canopy/skills') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const cloud = getScenario(keyFromBearer(request)).cloud;
    // Opt-in: filter by the `q` search the way the real server does, so a
    // spec can hide a skill from the inventory Customize lists.
    const query = cloud?.filterSharedSkillsByQuery
      ? (url.searchParams.get('q') ?? '').trim().toLowerCase()
      : '';
    jsonResponse(response, 200, {
      skills: (cloud?.sharedSkills ?? [MARKETPLACE_SHARED_SKILL])
        .filter(isVisibleSharedResource)
        .filter(
          (skill) =>
            query === '' ||
            `${skill.name} ${skill.description}`.toLowerCase().includes(query),
        ),
      nextCursor: null,
    });
    return true;
  }

  const scenarioSkill = getScenario(
    keyFromBearer(request),
  ).cloud?.sharedSkills?.find(
    (skill) => pathname === `/api/v1/canopy/skills/${skill.id}`,
  );
  if (method === 'GET' && scenarioSkill) {
    jsonResponse(response, 200, scenarioSkill);
    return true;
  }

  if (
    method === 'GET' &&
    pathname === `/api/v1/canopy/skills/${MARKETPLACE_SHARED_SKILL.id}`
  ) {
    jsonResponse(response, 200, MARKETPLACE_SHARED_SKILL);
    return true;
  }

  const contextCollection = getScenario(
    keyFromBearer(request),
  ).cloud?.sharedCollections?.find(
    (row) => pathname === `/api/v1/canopy/collections/${row.id}`,
  );
  if (method === 'GET' && contextCollection) {
    jsonResponse(response, 200, contextCollection);
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/canopy/collections') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    jsonResponse(response, 200, {
      collections: (keyFromBearer(request) === CAN3310_COLLECTION_API_KEY
        ? [
            can3310SharedCollections.get(CAN3310_COLLECTION_API_KEY) ??
              CAN3310_SHARED_COLLECTION,
          ]
        : (getScenario(keyFromBearer(request)).cloud?.sharedCollections ?? [
            MARKETPLACE_SHARED_COLLECTION,
          ])
      ).filter(isVisibleSharedCollection),
      nextCursor: null,
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/canopy/collections') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const body = await readJsonBody(request);
    const submittedDocument = JSON.parse(body?.rawCollection ?? '{}');
    const submittedSkills = new Map(
      (body?.customSkills ?? []).map((skill) => [skill.clientKey, skill]),
    );
    const customSkills = [];
    const document = {
      ...submittedDocument,
      items: (submittedDocument.items ?? []).map((item, index) => {
        if (item.type !== 'custom_skill' || !item.clientKey) return item;
        const payload = submittedSkills.get(item.clientKey);
        if (!payload) return item;
        const id = `can3310-custom-skill-${index + 1}`;
        const contentHash = createHash('sha256')
          .update(payload.rawSkill)
          .digest('hex');
        customSkills.push({
          id,
          name: payload.name,
          description: 'Draft release notes from merged pull requests.',
          contentHash,
          shareScope: 'private',
          owner: {
            type: 'user',
            id: CLOUD_ACCOUNT.id,
            name: CLOUD_ACCOUNT.name,
          },
          createdBy: {
            id: CLOUD_ACCOUNT.id,
            name: CLOUD_ACCOUNT.name,
            email: CLOUD_ACCOUNT.email,
          },
          createdAt: NOW,
          updatedAt: NOW,
          canUpdate: true,
          canDelete: true,
          publicShare: null,
          rawSkill: payload.rawSkill,
        });
        return {
          type: 'custom_skill',
          skillId: id,
          skill_name: payload.name,
          contentHash,
          ...(item.required !== undefined ? { required: item.required } : {}),
        };
      }),
    };
    const uploadedPackage = committedPipelinePackages.get(
      body?.committedPackageUploadId,
    );
    const collectionPackageSummary = uploadedPackage
      ? {
          digest: uploadedPackage.expectedDigest,
          version: 1,
          resources: uploadedPackage.manifest.resources.map((resource) => ({
            ...resource,
            fileCount: resource.trees.reduce(
              (total, tree) => total + tree.entries.length,
              0,
            ),
            totalBytes: resource.trees.reduce(
              (total, tree) =>
                total +
                tree.entries.reduce((bytes, entry) => bytes + entry.size, 0),
              0,
            ),
            affectedSteps: [],
          })),
          environmentRequirements:
            uploadedPackage.manifest.environmentRequirements,
          totalFiles: uploadedPackage.manifest.totalFiles,
          totalBytes: uploadedPackage.manifest.totalBytes,
        }
      : CAN3310_PACKAGE_SUMMARY;
    const rawCollection = JSON.stringify(document);
    const detail = withRequestedAudience(
      {
        ...CAN3310_SHARED_COLLECTION,
        name: document.name ?? CAN3310_SHARED_COLLECTION.name,
        description:
          document.description ?? CAN3310_SHARED_COLLECTION.description,
        rawCollection,
        collection: document,
        customSkills,
        distributionMode: body?.capabilityPackage ? 'package' : undefined,
        package: body?.capabilityPackage ? collectionPackageSummary : undefined,
      },
      body,
      getScenario(keyFromBearer(request)),
    );
    if (keyFromBearer(request) === CAN3310_COLLECTION_API_KEY) {
      can3310SharedCollections.set(CAN3310_COLLECTION_API_KEY, detail);
      if (uploadedPackage)
        can3310CollectionPackages.set(
          CAN3310_COLLECTION_API_KEY,
          uploadedPackage,
        );
    }
    jsonResponse(response, 201, detail);
    return true;
  }

  if (
    method === 'GET' &&
    (pathname ===
      `/api/v1/canopy/collections/${MARKETPLACE_SHARED_COLLECTION.id}` ||
      pathname === `/api/v1/canopy/collections/${CAN3310_COLLECTION_ID}`)
  ) {
    jsonResponse(
      response,
      200,
      pathname.endsWith(CAN3310_COLLECTION_ID)
        ? (can3310SharedCollections.get(CAN3310_COLLECTION_API_KEY) ??
            CAN3310_SHARED_COLLECTION)
        : MARKETPLACE_SHARED_COLLECTION,
    );
    return true;
  }

  const collectionPackageMatch = pathname.match(
    /^\/api\/v1\/collections\/([^/]+)\/package$/,
  );
  if (method === 'GET' && collectionPackageMatch) {
    const publishedPackage = can3310CollectionPackages.get(
      keyFromBearer(request),
    );
    if (
      !hasValidAuth(request) ||
      collectionPackageMatch[1] !== CAN3310_COLLECTION_ID ||
      url.searchParams.get('expectedPackageDigest') !==
        (publishedPackage?.expectedDigest ?? SKILL_PACKAGE_DIGEST)
    ) {
      jsonResponse(response, 404, { error: 'Package not found.' });
      return true;
    }
    jsonResponse(response, 200, {
      digest: publishedPackage?.expectedDigest ?? SKILL_PACKAGE_DIGEST,
      manifest: publishedPackage?.manifest ?? SKILL_PACKAGE_MANIFEST,
    });
    return true;
  }

  const collectionPackageBlobMatch = pathname.match(
    /^\/api\/v1\/collections\/([^/]+)\/package\/blobs\/([^/]+)$/,
  );
  if (method === 'GET' && collectionPackageBlobMatch) {
    const publishedPackage = can3310CollectionPackages.get(
      keyFromBearer(request),
    );
    const blob = (publishedPackage?.blobs ?? SKILL_PACKAGE_BLOBS).get(
      collectionPackageBlobMatch[2],
    );
    if (
      !hasValidAuth(request) ||
      collectionPackageBlobMatch[1] !== CAN3310_COLLECTION_ID ||
      !blob ||
      url.searchParams.get('expectedPackageDigest') !==
        (publishedPackage?.expectedDigest ?? SKILL_PACKAGE_DIGEST)
    ) {
      jsonResponse(response, 404, { error: 'Blob not found.' });
      return true;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.byteLength),
    });
    response.end(blob);
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/canopy/pipelines') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }

    const triggerType = url.searchParams.get('triggerType');
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const pipelines =
      getScenario(keyFromBearer(request)).cloud?.sharedPipelines ??
      SHARED_PIPELINES;
    const data = pipelines
      .filter(isVisibleSharedResource)
      .filter((pipeline) => {
        if (triggerType && !pipeline.triggerTypes.includes(triggerType)) {
          return false;
        }
        if (!q) return true;
        return (
          pipeline.name.toLowerCase().includes(q) ||
          pipeline.description.toLowerCase().includes(q)
        );
      })
      .map(toPipelineSummary);

    jsonResponse(response, 200, { data, nextCursor: null });
    return true;
  }

  if (
    method === 'GET' &&
    pathname === '/api/v1/canopy/organizations' &&
    keyFromBearer(request) === SCOPED_LINKS_CLOUD_API_KEY
  ) {
    jsonResponse(response, 200, {
      data: [SCOPED_LINKS_ORGANIZATION],
      nextCursor: null,
    });
    return true;
  }

  // Share-dialog pickers list the scenario's own membership (see
  // seeders/shareMembership.mjs). Scenarios without membership fall through.
  if (
    method === 'GET' &&
    (pathname === '/api/v1/canopy/organizations' ||
      pathname === '/api/v1/canopy/teams') &&
    hasValidAuth(request)
  ) {
    const membership = getScenario(keyFromBearer(request)).cloud;
    const targets =
      pathname === '/api/v1/canopy/teams'
        ? membership?.teams
        : membership?.organizations;
    if (Array.isArray(targets)) {
      jsonResponse(response, 200, {
        data: matchingTargets(targets, url),
        nextCursor: null,
      });
      return true;
    }
  }

  if (method === 'POST' && pathname === '/api/v1/canopy/pipelines') {
    const body = await readJsonBody(request);
    if (keyFromBearer(request) === SCOPED_LINKS_CLOUD_API_KEY) {
      jsonResponse(response, 201, {
        ...SCOPED_LINKS_PIPELINE,
        rawPipeline: body?.rawPipeline ?? SCOPED_LINKS_PIPELINE.rawPipeline,
      });
      return true;
    }
    jsonResponse(response, 201, {
      ...SHARED_PIPELINES[0],
      id: 'shared-can-2293',
      name: 'Public Review Pipeline',
      rawPipeline: body?.rawPipeline ?? SHARED_PIPELINES[0].rawPipeline,
    });
    return true;
  }

  const pipelinePublicShareMatch = pathname.match(
    /^\/api\/v1\/canopy\/pipelines\/([^/]+)\/public-share$/,
  );
  if (method === 'POST' && pipelinePublicShareMatch) {
    jsonResponse(response, 200, { publicShare: PIPELINE_PUBLIC_SHARE });
    return true;
  }
  if (method === 'DELETE' && pipelinePublicShareMatch) {
    response.writeHead(204);
    response.end();
    return true;
  }

  // The Workflows tab lists curated pipeline templates beside shared ones.
  // The default mock has none, so it returns an empty catalog instead of
  // letting the detail route below 404 on the `curated` id (CAN-4261).
  if (method === 'GET' && pathname === '/api/v1/canopy/pipelines/curated') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    jsonResponse(response, 200, { version: 1, data: [], nextCursor: null });
    return true;
  }

  const pipelineDetailMatch = pathname.match(
    /^\/api\/v1\/canopy\/pipelines\/([^/]+)$/,
  );
  if (method === 'GET' && pipelineDetailMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }

    const pipelineId = decodeURIComponent(pipelineDetailMatch[1]);
    if (
      pipelineId === SCOPED_LINKS_PIPELINE_ID &&
      keyFromBearer(request) === SCOPED_LINKS_CLOUD_API_KEY
    ) {
      jsonResponse(response, 200, SCOPED_LINKS_PIPELINE);
      return true;
    }
    const pipelines =
      getScenario(keyFromBearer(request)).cloud?.sharedPipelines ??
      SHARED_PIPELINES;
    const pipeline = pipelines.find((item) => item.id === pipelineId);
    if (!pipeline) {
      jsonResponse(response, 404, { error: 'Pipeline not found.' });
      return true;
    }

    jsonResponse(response, 200, pipeline);
    return true;
  }

  // In-place YAML update for a scenario's own shared pipelines. Mirrors the
  // server: an update that carries no freshly committed package upload
  // detaches the share's package (it pins the previous content hash), turning
  // it `definition_only`. Mutates only the caller's registered scenario, so
  // concurrent workers never observe each other's edits.
  if (method === 'PUT' && pipelineDetailMatch) {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    const scenarioKey = keyFromBearer(request);
    const pipeline = getScenario(scenarioKey).cloud?.sharedPipelines?.find(
      (item) => item.id === decodeURIComponent(pipelineDetailMatch[1]),
    );
    if (!pipeline) return false;
    const body = await readJsonBody(request);
    pipeline.rawPipeline = body?.rawPipeline ?? pipeline.rawPipeline;
    pipeline.updatedAt = new Date().toISOString();
    if (
      body?.distributionMode === 'package' &&
      committedPipelinePackages.has(body.committedPackageUploadId)
    ) {
      recordScenarioActivity(scenarioKey, 'sharedPipelinePackagedUpdate');
    } else {
      recordScenarioActivity(scenarioKey, 'sharedPipelineDetachedUpdate');
      pipeline.distributionMode = 'definition_only';
      delete pipeline.package;
    }
    jsonResponse(response, 200, pipeline);
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/canopy/portal/sessions') {
    if (!hasValidAuth(request)) {
      jsonResponse(response, 401, { error: 'Invalid API key.' });
      return true;
    }
    jsonResponse(response, 201, {
      sessionId: MOCK_SESSION_ID,
      status: 'pending_auth',
      pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      commandCursor: 0,
    });
    return true;
  }

  if (
    method === 'POST' &&
    pathname === `/api/v1/canopy/portal/sessions/${MOCK_SESSION_ID}/commands`
  ) {
    await waitForLongPollTimeout(response, parseLongPollTimeout(url));
    if (response.destroyed || response.writableEnded) {
      return true;
    }

    jsonResponse(response, 200, {
      session: {
        id: MOCK_SESSION_ID,
        status: 'pending_auth',
        connectionStatus: 'pending',
        activatedAt: null,
        lastSeenAt: new Date().toISOString(),
        endedAt: null,
      },
      commands: [],
      nextCursor: 0,
    });
    return true;
  }

  if (
    method === 'POST' &&
    pathname === `/api/v1/canopy/portal/sessions/${MOCK_SESSION_ID}/heartbeat`
  ) {
    jsonResponse(response, 200, { ok: true, status: 'pending_auth' });
    return true;
  }

  if (
    method === 'POST' &&
    pathname === `/api/v1/canopy/portal/sessions/${MOCK_SESSION_ID}/events`
  ) {
    jsonResponse(response, 200, {
      accepted: 0,
      duplicates: 0,
      connectionStatus: 'pending',
    });
    return true;
  }

  if (
    method === 'POST' &&
    pathname === `/api/v1/canopy/portal/sessions/${MOCK_SESSION_ID}/end`
  ) {
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  return false;
}
