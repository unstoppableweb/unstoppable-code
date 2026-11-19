/**
 * Organization Agents on this computer (CAN-6237, phase 10a): an Agent the
 * organization makes a default, or a project adds, is imported once through
 * the shared Agent import, and the organization capabilities layer marks the
 * copy it made. It removes that copy when no set on this computer holds the
 * Agent anymore, when the organization's set is refused, or when the
 * organization no longer owns the Agent. A copy the person had already
 * imported is reused and never removed. A copy two sets share stays until
 * neither holds it, a removal that failed is tried again on a later refresh,
 * also after a restart, and each new copy and each removal is published to
 * the Agent registry; a publication that fails never keeps a copy from being
 * recorded as the organization's, nor does a read whose result is dropped
 * because the account changed. An edit of the organization's Agent updates
 * the copy in place, and a copy is usable only in workspaces whose
 * organization set holds it.
 * While organization projects are off (Agents are not kept to the
 * organization's workspaces), no Agent installs, and once they are known to
 * be off every copy the layer made is removed; while the flag is still
 * loading, installed copies stay.
 */
jest.mock('../../canopy-cloud/web-core-connection', () => ({}));
jest.mock('../../ipc/cloud-chats', () => ({}));
jest.mock('../detail-reads', () => ({}));
jest.mock('../../app-advisor/shared-import-port', () => ({}));
jest.mock('../../agents/resource-lanes', () => ({
  agentResourceContextEnabled: (): boolean => true,
}));
// Replay authorization (phase 10b): only its organization admission runs here.
jest.mock('../../pipelines/pipeline-service', () => ({}));
jest.mock('../../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => false,
}));

import type { CatalogProjectSetupGetResult } from '@canopy/protocol/canopy-core';
import type { OrganizationCapabilitySnapshot } from '@canopy/desktop-shared/lib/organization-capabilities';
import type { ConnectorScope } from '@canopy/desktop-shared/lib/connector-scope';
import {
  assertOrganizationPipelineAllowed,
  ORGANIZATION_PIPELINE_SWITCHED_OFF,
  setOrganizationPipelineLookup,
} from '../pipeline-gate';
import { buildSharedPipelineId } from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import type { ExecutionState } from '@canopy/execution-engine/node/pipelines/executor';
import { authorizePipelineReplay } from '../../pipelines/pipeline-replay-authorization';
import {
  createOrganizationCapabilityService,
  type OrganizationCapabilityCache,
  type OrganizationCapabilityService,
} from '../service';

const ORG = 'org-1';
const AGENT = '00000000-0000-4000-8000-00000000a001';
type Entries = CatalogProjectSetupGetResult['effective'];
type Removed = CatalogProjectSetupGetResult['removed'];
type Defaults = CatalogProjectSetupGetResult['organizationDefaults'];
const agentEntry: Entries[number] = {
  item: {
    ref: { kind: 'agent', id: AGENT },
    name: 'Reviewer',
    description: null,
    available: true,
  },
  source: 'organization',
};

const PIPELINE = '00000000-0000-4000-8000-0000000b0001';
const pipelineEntry: Entries[number] = {
  item: {
    ref: { kind: 'pipeline', id: PIPELINE },
    name: 'Release notes',
    description: null,
    available: true,
  },
  source: 'organization',
};

function projectScope(projectId: string): ConnectorScope {
  return { kind: 'org-project', organizationId: ORG, orgProjectId: projectId };
}

interface LocalAgent {
  readonly remote: string;
  hash: string;
}

interface Harness {
  service: OrganizationCapabilityService;
  /** Local Agent copies by id: the share each imports, at which content. */
  readonly agents: Map<string, LocalAgent>;
  readonly imports: string[];
  readonly removed: string[];
  /** Times Agent changes were published to the Agent registry. */
  published(): number;
  stored(projectId?: string): OrganizationCapabilitySnapshot | undefined;
  pending(): readonly string[];
  setEntries(value: Entries, projectId?: string): void;
  /** The organization defaults the project switched off. */
  setRemoved(value: Removed, projectId?: string): void;
  /** The organization's defaults, as the project's setup read lists them. */
  setOrganizationDefaults(value: Defaults, projectId?: string): void;
  refuse(): void;
  ownerBecomes(value: string): void;
  /** The organization edits its Agent: the share's content hash changes. */
  editShare(hash: string): void;
  /** The account changes while the next publication runs. */
  switchAccountOnPublish(accountId: string): void;
  /** Whether `agentId` may be used in `workspaceId` of `projectId`'s set. */
  allowed(
    workspaceId: string,
    agentId: string,
    projectId: string | null,
  ): Promise<boolean>;
  /** The next `count` publications fail. */
  failPublications(count: number): void;
  /** The next `count` removals fail. */
  failRemovals(count: number): void;
  /** Organization projects on, off (a settled verdict) or still loading. */
  setFlag(value: 'on' | 'off' | 'loading'): void;
  /** A new service over the same cache and Agents, as after a restart. */
  restart(): void;
  refresh(projectId?: string): Promise<unknown>;
}

function harness(
  options: { personalCopy?: boolean; agentsEnabled?: boolean } = {},
): Harness {
  const entries = new Map<string, Entries>();
  const removedRefs = new Map<string, Removed>();
  const defaultsFor = new Map<string, Defaults>();
  const entriesFor = (projectId: string): Entries =>
    entries.get(projectId) ?? [agentEntry];
  let refused = false;
  let flag: 'on' | 'off' | 'loading' =
    options.agentsEnabled === false ? 'off' : 'on';
  let owner = ORG;
  let cache: OrganizationCapabilityCache = {
    snapshots: [],
    pendingAgentRemovals: [],
  };
  let next = 0;
  let failing = 0;
  let published = 0;
  let failingPublications = 0;
  let shareHash = 'hash-1';
  let account = 'account-1';
  let accountOnPublish: string | null = null;
  const agents = new Map<string, LocalAgent>();
  if (options.personalCopy)
    agents.set('agent_personal', { remote: AGENT, hash: shareHash });
  const imports: string[] = [];
  const removed: string[] = [];
  const create = (): OrganizationCapabilityService =>
    createOrganizationCapabilityService({
      now: () => 1_000,
      calls: {
        projectSetup: (projectId) =>
          Promise.resolve(
            refused
              ? { kind: 'refused' as const }
              : {
                  kind: 'ok' as const,
                  value: {
                    projectId,
                    organizationId: ORG,
                    revision: 1,
                    organizationDefaultsRevision: 1,
                    organizationDefaults: defaultsFor.get(projectId) ?? [],
                    added: [],
                    removed: removedRefs.get(projectId) ?? [],
                    dismissedRecommendations: [],
                    effective: entriesFor(projectId),
                    canEdit: false,
                  },
                },
          ),
        organizationDefaults: () =>
          Promise.resolve({ kind: 'unavailable' as const }),
      },
      install: {
        getSharedSkill: () => Promise.reject(new Error('no skills here')),
        getSharedPluginRef: () => Promise.reject(new Error('no plugins here')),
        importMarketplacePlugin: () => Promise.resolve(null),
        writeSkill: () => Promise.resolve(),
        skillExists: () => Promise.resolve(false),
        listSkills: () => Promise.resolve([]),
        removeSkill: () => Promise.resolve(),
        agentsEnabled: () => flag === 'on',
        agentsSettledOff: () => flag === 'off',
        importOrganizationAgent: (id, organizationId, organizationCopy) => {
          if (owner !== organizationId) return Promise.resolve(null);
          imports.push(id);
          // The layer's own copy of a changed share is updated in place.
          const own =
            organizationCopy === undefined
              ? undefined
              : agents.get(organizationCopy);
          if (
            organizationCopy !== undefined &&
            own?.remote === id &&
            own.hash !== shareHash
          ) {
            own.hash = shareHash;
            return Promise.resolve({
              agentId: organizationCopy,
              existedBefore: true,
              updated: true,
            });
          }
          // The shared import reuses a copy of this share at this content.
          for (const [agentId, copy] of agents)
            if (copy.remote === id && copy.hash === shareHash)
              return Promise.resolve({ agentId, existedBefore: true });
          next += 1;
          const agentId = `agent_org_${next}`;
          agents.set(agentId, { remote: id, hash: shareHash });
          return Promise.resolve({ agentId, existedBefore: false });
        },
        removeOrganizationAgent: (agentId) => {
          if (failing > 0) {
            failing -= 1;
            return Promise.reject(new Error('the Agent store is busy'));
          }
          if (!agents.delete(agentId)) return Promise.resolve(false);
          removed.push(agentId);
          return Promise.resolve(true);
        },
        publishAgentChanges: () => {
          if (failingPublications > 0) {
            failingPublications -= 1;
            return Promise.reject(
              new Error('the Agent registry refresh failed'),
            );
          }
          published += 1;
          if (accountOnPublish !== null) {
            account = accountOnPublish;
            accountOnPublish = null;
          }
          return Promise.resolve();
        },
      },
      store: {
        read: () => Promise.resolve(cache),
        write: (value) => {
          cache = value;
          return Promise.resolve();
        },
      },
      accountId: () => Promise.resolve(account),
    });
  const t: Harness = {
    service: create(),
    agents,
    imports,
    removed,
    published: () => published,
    stored: (projectId = 'p1') =>
      cache.snapshots.find(
        (snapshot) => snapshot.scope.projectId === projectId,
      ),
    pending: () => cache.pendingAgentRemovals,
    setOrganizationDefaults: (value, projectId = 'p1') => {
      defaultsFor.set(projectId, value);
    },
    setRemoved: (value, projectId = 'p1') => {
      removedRefs.set(projectId, value);
    },
    setEntries: (value, projectId = 'p1') => {
      entries.set(projectId, value);
    },
    refuse: () => {
      refused = true;
    },
    ownerBecomes: (value) => {
      owner = value;
    },
    editShare: (hash) => {
      shareHash = hash;
    },
    switchAccountOnPublish: (accountId) => {
      accountOnPublish = accountId;
    },
    allowed: (workspaceId, agentId, projectId) =>
      t.service.agentAllowed(workspaceId, agentId, () =>
        Promise.resolve(
          projectId === null ? undefined : projectScope(projectId),
        ),
      ),
    failPublications: (count) => {
      failingPublications = count;
    },
    failRemovals: (count) => {
      failing = count;
    },
    setFlag: (value) => {
      flag = value;
    },
    restart: () => {
      t.service = create();
    },
    refresh: (projectId = 'p1') =>
      t.service.refresh({ organizationId: ORG, projectId }),
  };
  return t;
}

describe('organization Agents on this computer', () => {
  it('installs a default Agent once and removes the copy when the default leaves', async () => {
    const t = harness();
    await t.service.layerFor('ws', projectScope('p1'));
    await t.refresh();
    await t.refresh();
    expect([...t.agents.keys()]).toEqual(['agent_org_1']);
    expect(t.stored()?.items[0]).toMatchObject({
      status: 'installed',
      agentRef: { agentId: 'agent_org_1', createdByOrganization: true },
    });
    t.setEntries([]);
    await t.refresh();
    expect(t.removed).toEqual(['agent_org_1']);
    expect(t.agents.size).toBe(0);
    expect(t.pending()).toEqual([]);
  });

  it('reuses a copy the person imported and never removes it', async () => {
    const t = harness({ personalCopy: true });
    await t.service.layerFor('ws', projectScope('p1'));
    expect(t.stored()?.items[0]).toMatchObject({
      agentRef: { agentId: 'agent_personal', createdByOrganization: false },
    });
    t.setEntries([]);
    await t.refresh();
    expect(t.removed).toEqual([]);
    expect([...t.agents.keys()]).toEqual(['agent_personal']);
  });

  it('keeps a copy two sets share until neither holds it', async () => {
    const t = harness();
    await t.service.layerFor('ws-1', projectScope('p1'));
    await t.service.layerFor('ws-2', projectScope('p2'));
    expect([...t.agents.keys()]).toEqual(['agent_org_1']);
    // The second set reused the first one's copy: it is still the
    // organization's.
    expect(t.stored('p2')?.items[0]).toMatchObject({
      agentRef: { agentId: 'agent_org_1', createdByOrganization: true },
    });
    t.setEntries([], 'p1');
    await t.refresh('p1');
    expect(t.removed).toEqual([]);
    expect(t.agents.has('agent_org_1')).toBe(true);
    t.setEntries([], 'p2');
    await t.refresh('p2');
    expect(t.removed).toEqual(['agent_org_1']);
  });

  it('removes only the organization copy when the set is refused', async () => {
    const created = harness();
    await created.service.layerFor('ws', projectScope('p1'));
    created.refuse();
    await created.refresh();
    expect(created.removed).toEqual(['agent_org_1']);
    const personal = harness({ personalCopy: true });
    await personal.service.layerFor('ws', projectScope('p1'));
    personal.refuse();
    await personal.refresh();
    expect(personal.removed).toEqual([]);
  });

  it('removes the copy when the organization no longer owns the Agent', async () => {
    const t = harness();
    await t.service.layerFor('ws', projectScope('p1'));
    t.ownerBecomes('another-organization');
    await t.refresh();
    expect(t.stored()?.items[0]).toMatchObject({ status: 'failed' });
    expect(t.removed).toEqual(['agent_org_1']);
  });

  it('tries a failed removal again on a later refresh, also after a restart', async () => {
    const t = harness();
    await t.service.layerFor('ws', projectScope('p1'));
    t.setEntries([]);
    t.failRemovals(2);
    await t.refresh();
    expect(t.agents.has('agent_org_1')).toBe(true);
    expect(t.pending()).toEqual(['agent_org_1']);
    await t.refresh();
    expect(t.agents.has('agent_org_1')).toBe(true);
    t.restart();
    await t.refresh();
    expect(t.removed).toEqual(['agent_org_1']);
    expect(t.pending()).toEqual([]);
  });

  it('publishes a new copy and a removal to the Agent registry', async () => {
    const t = harness();
    await t.service.layerFor('ws', projectScope('p1'));
    expect(t.published()).toBe(1);
    t.setEntries([]);
    t.failRemovals(1);
    await t.refresh();
    expect(t.published()).toBe(1);
    await t.refresh();
    expect(t.published()).toBe(2);
  });

  it("records a copy as the organization's when its publication fails, so it is still removed", async () => {
    const t = harness();
    t.failPublications(1);
    await t.service.layerFor('ws', projectScope('p1'));
    expect(t.agents.has('agent_org_1')).toBe(true);
    expect(t.stored()?.items[0]).toMatchObject({
      status: 'installed',
      agentRef: { agentId: 'agent_org_1', createdByOrganization: true },
    });
    // A later read reuses the copy and keeps it the organization's.
    await t.refresh();
    expect(t.stored()?.items[0]).toMatchObject({
      agentRef: { agentId: 'agent_org_1', createdByOrganization: true },
    });
    t.setFlag('off');
    await t.service.reconcileAgents();
    expect(t.removed).toEqual(['agent_org_1']);
  });

  it('removes the organization copies once organization projects are off, and keeps them while the flag loads', async () => {
    const t = harness();
    await t.service.layerFor('ws-1', projectScope('p1'));
    t.setFlag('loading');
    await t.refresh();
    expect(t.agents.has('agent_org_1')).toBe(true);
    expect(t.stored()?.items[0]).toMatchObject({ status: 'installed' });
    t.setFlag('off');
    // A refresh of another set removes it too.
    t.setEntries([], 'p2');
    await t.refresh('p2');
    expect(t.removed).toEqual(['agent_org_1']);
    // Once for the new copy, once for its removal.
    expect(t.published()).toBe(2);
  });

  it('removes the organization copies at once when the flag turns off, and keeps a personal copy', async () => {
    const created = harness();
    await created.service.layerFor('ws', projectScope('p1'));
    created.setFlag('off');
    created.restart();
    await created.service.reconcileAgents();
    expect(created.removed).toEqual(['agent_org_1']);
    expect(created.pending()).toEqual([]);
    const personal = harness({ personalCopy: true });
    await personal.service.layerFor('ws', projectScope('p1'));
    personal.setFlag('off');
    await personal.service.reconcileAgents();
    expect(personal.removed).toEqual([]);
  });

  it('a later refused read retries a removal that failed when the set was refused', async () => {
    const t = harness();
    await t.service.layerFor('ws', projectScope('p1'));
    t.refuse();
    t.failRemovals(1);
    await t.refresh();
    expect(t.stored()).toBeUndefined();
    expect(t.pending()).toEqual(['agent_org_1']);
    await t.refresh();
    expect(t.removed).toEqual(['agent_org_1']);
    expect(t.pending()).toEqual([]);
  });

  it('updates the copy in place when the organization edits its Agent', async () => {
    const t = harness();
    await t.service.layerFor('ws', projectScope('p1'));
    t.editShare('hash-2');
    await t.refresh();
    expect([...t.agents.entries()]).toEqual([
      ['agent_org_1', { remote: AGENT, hash: 'hash-2' }],
    ]);
    expect(t.removed).toEqual([]);
    expect(t.stored()?.items[0]).toMatchObject({
      agentRef: { agentId: 'agent_org_1', createdByOrganization: true },
    });
    // Published for the new copy and for its update.
    expect(t.published()).toBe(2);
  });

  it('lets a copy run only where the workspace set holds it', async () => {
    const t = harness({ personalCopy: true });
    t.editShare('hash-2');
    await t.service.layerFor('ws-1', projectScope('p1'));
    await t.service.layerFor('ws-2', projectScope('p2'));
    expect(await t.allowed('ws-1', 'agent_org_1', 'p1')).toBe(true);
    t.setEntries([], 'p1');
    await t.refresh('p1');
    expect(await t.allowed('ws-1', 'agent_org_1', 'p1')).toBe(false);
    expect(await t.allowed('ws-2', 'agent_org_1', 'p2')).toBe(true);
    // Not in a Personal workspace either; the person's own copy everywhere.
    expect(await t.allowed('ws-personal', 'agent_org_1', null)).toBe(false);
    expect(await t.allowed('ws-1', 'agent_personal', 'p1')).toBe(true);
    expect(await t.allowed('ws-personal', 'agent_personal', null)).toBe(true);
  });

  it('removes a copy whose read was dropped because the account changed', async () => {
    const t = harness();
    t.switchAccountOnPublish('account-2');
    await t.refresh();
    expect(t.agents.has('agent_org_1')).toBe(true);
    expect(t.stored()).toBeUndefined();
    // The default is dropped: the next read removes the copy it made.
    t.setEntries([]);
    await t.refresh();
    expect(t.removed).toEqual(['agent_org_1']);
  });

  it('installs no Agent while organization projects are off', async () => {
    const t = harness({ agentsEnabled: false });
    await t.service.layerFor('ws', projectScope('p1'));
    expect(t.imports).toEqual([]);
    expect(t.stored()?.items[0]).toMatchObject({ status: 'unsupported' });
  });
});

/**
 * Organization pipelines (CAN-6237, phase 10b): nothing is copied. A
 * project's set records the organization pipelines it has, which the shared
 * pipelines source already lists in the organization's workspaces, and the
 * defaults the project switched off, which that source leaves out and
 * refuses there. Outside an organization workspace, or while organization
 * projects are off, no set applies.
 */
describe('organization pipelines on this computer', () => {
  it('records a default pipeline for an organization project, and none for a Personal workspace', async () => {
    const t = harness();
    t.setEntries([pipelineEntry]);
    await t.service.layerFor('ws-1', projectScope('p1'));
    expect(t.stored()?.items[0]).toMatchObject({
      status: 'installed',
      pipelineRef: { remoteId: PIPELINE },
    });
    const pipelines = await t.service.pipelinesFor('ws-1', projectScope('p1'));
    expect([...(pipelines?.held ?? [])]).toEqual([PIPELINE]);
    expect([...(pipelines?.switchedOff ?? [])]).toEqual([]);
    expect(await t.service.pipelinesFor('ws-personal', undefined)).toBe(
      undefined,
    );
  });

  it('switches a default pipeline off in one project only', async () => {
    const t = harness();
    t.setEntries([pipelineEntry], 'p1');
    t.setEntries([pipelineEntry], 'p2');
    await t.service.layerFor('ws-1', projectScope('p1'));
    await t.service.layerFor('ws-2', projectScope('p2'));
    t.setEntries([], 'p1');
    t.setOrganizationDefaults([pipelineEntry.item], 'p1');
    t.setRemoved([{ kind: 'pipeline', id: PIPELINE }], 'p1');
    await t.refresh('p1');
    const off = await t.service.pipelinesFor('ws-1', projectScope('p1'));
    expect([...(off?.held ?? [])]).toEqual([]);
    expect([...(off?.switchedOff ?? [])]).toEqual([PIPELINE]);
    const on = await t.service.pipelinesFor('ws-2', projectScope('p2'));
    expect([...(on?.held ?? [])]).toEqual([PIPELINE]);
    expect([...(on?.switchedOff ?? [])]).toEqual([]);
  });

  it('refuses running a switched-off default in its project, and allows it in another', async () => {
    const t = harness();
    t.setEntries([pipelineEntry], 'p1');
    t.setEntries([pipelineEntry], 'p2');
    await t.service.layerFor('ws-p1', projectScope('p1'));
    await t.service.layerFor('ws-p2', projectScope('p2'));
    t.setEntries([], 'p1');
    t.setOrganizationDefaults([pipelineEntry.item], 'p1');
    t.setRemoved([{ kind: 'pipeline', id: PIPELINE }], 'p1');
    await t.refresh('p1');
    // The lookup every run start and shared read asks, as registered at
    // startup: the project's workspace and its organization scope.
    setOrganizationPipelineLookup((projectId) =>
      t.service.pipelinesFor(`ws-${projectId}`, projectScope(projectId)),
    );
    try {
      await expect(
        assertOrganizationPipelineAllowed('p1', PIPELINE),
      ).rejects.toThrow(ORGANIZATION_PIPELINE_SWITCHED_OFF);
      await expect(
        assertOrganizationPipelineAllowed('p2', PIPELINE),
      ).resolves.toBeUndefined();
      // No workspace (a global run) has no set to apply.
      await expect(
        assertOrganizationPipelineAllowed(undefined, PIPELINE),
      ).resolves.toBeUndefined();
      // Starting a run over, or resuming it, is admitted the same way.
      const replay = (projectId?: string): Promise<unknown> =>
        authorizePipelineReplay({
          pipeline_id: buildSharedPipelineId('server-1', PIPELINE),
          ...(projectId === undefined ? {} : { project_id: projectId }),
        } as ExecutionState);
      await expect(replay('p1')).rejects.toThrow(
        ORGANIZATION_PIPELINE_SWITCHED_OFF,
      );
      await expect(replay('p2')).resolves.toBeUndefined();
      await expect(replay()).resolves.toBeUndefined();
    } finally {
      setOrganizationPipelineLookup(null);
    }
  });

  it('applies a pipeline the project added even when it also removed it', async () => {
    const t = harness();
    // The server keeps removed refs as stored, and an explicit addition wins.
    t.setOrganizationDefaults([pipelineEntry.item]);
    t.setEntries([{ ...pipelineEntry, source: 'project' }]);
    t.setRemoved([{ kind: 'pipeline', id: PIPELINE }]);
    await t.service.layerFor('ws-1', projectScope('p1'));
    const pipelines = await t.service.pipelinesFor('ws-1', projectScope('p1'));
    expect([...(pipelines?.held ?? [])]).toEqual([PIPELINE]);
    expect([...(pipelines?.switchedOff ?? [])]).toEqual([]);
  });

  it('does not count a removed pipeline that is no longer a default as switched off', async () => {
    const t = harness();
    t.setEntries([]);
    t.setRemoved([{ kind: 'pipeline', id: PIPELINE }]);
    await t.service.layerFor('ws-1', projectScope('p1'));
    const pipelines = await t.service.pipelinesFor('ws-1', projectScope('p1'));
    expect([...(pipelines?.switchedOff ?? [])]).toEqual([]);
  });

  it('applies no set while organization projects are off, and keeps it while the flag loads', async () => {
    const t = harness();
    t.setEntries([pipelineEntry]);
    t.setRemoved([{ kind: 'pipeline', id: 'other' }]);
    await t.service.layerFor('ws-1', projectScope('p1'));
    t.setFlag('loading');
    await t.refresh();
    expect(t.stored()?.items[0]).toMatchObject({ status: 'installed' });
    t.setFlag('off');
    await t.refresh();
    expect(t.stored()?.items[0]).toMatchObject({ status: 'unsupported' });
    expect(await t.service.pipelinesFor('ws-1', projectScope('p1'))).toBe(
      undefined,
    );
  });
});
