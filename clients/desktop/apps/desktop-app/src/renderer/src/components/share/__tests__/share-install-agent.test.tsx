/** @jest-environment jsdom */
/**
 * Installing a shared agent from inside the app takes one click (CAN-4686):
 * the Install on a row or page opens the review, which installs the agent as
 * soon as it is ready, once. The dialog stays as the progress and error
 * surface, so a failure keeps it open with Install to retry. A link from
 * outside the app, an already installed copy and every other kind still wait
 * for the click, so nothing installs unseen.
 *
 * A jsdom suite registered in scripts/golden-suites.mjs (CAN-4686) because no
 * Electron golden opens these pages: it mounts the real install dialog over the landing
 * state the shared hook reports.
 */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DeepLinkShareOpenEvent,
  PublicShareSnapshot,
} from '@canopy/desktop-shared/types';
import type { SharedAgentDetail } from '@canopy/protocol/agents';
import type { PipelinePackageSummary } from '@canopy/execution-engine/types/pipeline';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  openInAppAgentInstall,
  type InAppAgentRevision,
  type PublicShareLanding,
  type usePublicShareLanding as UsePublicShareLanding,
} from '../usePublicShareLanding';
import { ShareInstallModal } from '../ShareInstallModal';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mockLanding: PublicShareLanding;
// Most cases drive the dialog over a reported landing state. With
// `realLanding` the real landing hook runs over the desktop bridge instead,
// so the install reaches the bridge call itself.
let realLanding = false;
jest.mock('../usePublicShareLanding', () => {
  const actual = jest.requireActual<{
    usePublicShareLanding: typeof UsePublicShareLanding;
  }>('../usePublicShareLanding');
  return {
    ...actual,
    usePublicShareLanding: (
      ...args: Parameters<typeof UsePublicShareLanding>
    ): PublicShareLanding =>
      realLanding ? actual.usePublicShareLanding(...args) : mockLanding,
  };
});
jest.mock('@/hooks/useAutomationScope', () => ({
  useAutomationScope: (): { projectsInContext: [] } => ({
    projectsInContext: [],
  }),
}));

// The automation wizard pulls in the terminal; an agent never opens it.
jest.mock('@/components/automations/InstallSharedAutomationModal', () => ({
  InstallSharedAutomationModal: (): null => null,
}));

const AGENT_SNAPSHOT: PublicShareSnapshot = {
  entity: 'agent',
  externalId: 'agent-share',
  sourceRemoteId: 'agent-share',
  agent: {
    version: 1,
    id: 'agent_model_release',
    name: 'Release agent',
    baseModel: 'default',
    instructions: 'Ship it.',
    plugins: [],
  },
  contentHash: 'hash',
  authorUsername: null,
  updatedAt: '2026-02-03T00:00:00.000Z',
};

const PACKAGE: PipelinePackageSummary = {
  digest: 'pp:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  version: 1,
  resources: [],
  environmentRequirements: [],
  totalFiles: 0,
  totalBytes: 0,
};

const SKILL_SNAPSHOT: PublicShareSnapshot = {
  entity: 'skill',
  externalId: 'skill-share',
  name: 'review',
  description: 'Reviews.',
  rawSkill: '---\nname: review\n---\nReview.',
  contentHash: 'hash',
  dependencies: [],
  authorUsername: null,
  updatedAt: '2026-02-03T00:00:00.000Z',
};

const AGENT_LINK: DeepLinkShareOpenEvent = {
  entity: 'agent',
  externalId: 'agent-share',
  intent: 'install',
  audience: 'ORGANIZATION',
};
const SKILL_LINK: DeepLinkShareOpenEvent = {
  entity: 'skill',
  externalId: 'skill-share',
  intent: 'install',
  audience: 'ORGANIZATION',
};

let install: jest.Mock<ReturnType<PublicShareLanding['install']>, []>;

function readyLanding(
  snapshot: PublicShareSnapshot,
  overrides: Partial<PublicShareLanding> = {},
): PublicShareLanding {
  return {
    state: { phase: 'ready', snapshot },
    snapshot,
    detecting: false,
    verificationError: '',
    needsRefresh: false,
    refresh: jest.fn(),
    installed: null,
    mayHaveOtherCopy: false,
    installing: false,
    installError: '',
    recordedInstallError: '',
    uninstalling: false,
    uninstallErrorRecorded: false,
    installProgress: '',
    installStatus: '',
    agentReadiness: null,
    agentReadinessLoading: false,
    agentReviewLoading: false,
    workspaceReadiness: null,
    workspaceReadinessLoading: false,
    install,
    tryNow: jest.fn(),
    insertInChat: jest.fn(),
    turnOnInChat: jest.fn(),
    manage: jest.fn(),
    uninstall: jest.fn(),
    installReview: null,
    openingInstallReview: false,
    closeInstallReview: jest.fn(),
    completeInstallReview: jest.fn(),
    retryResolve: jest.fn(),
    signIn: jest.fn(),
    switchAccount: jest.fn(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let onClose: jest.Mock<void, []>;

function mount(
  link: DeepLinkShareOpenEvent,
  origin: 'in-app' | 'deep-link',
): void {
  act(() =>
    root.render(
      <ShareInstallModal link={link} origin={origin} onClose={onClose} />,
    ),
  );
}

/**
 * The in-app Install on a row or page: it names the revision the person saw,
 * then the review opens over it.
 */
function clickInstall(
  link: DeepLinkShareOpenEvent,
  revision: InAppAgentRevision | null = { contentHash: 'hash' },
): void {
  openInAppAgentInstall(link, revision);
  useNavigationStore.getState().consumeShareInstall();
  mount(link, 'in-app');
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

beforeEach(() => {
  install = jest.fn<ReturnType<PublicShareLanding['install']>, []>(() =>
    Promise.resolve(null),
  );
  onClose = jest.fn<void, []>();
  useNavigationStore.getState().setShareInstallBusy(false);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Installing a shared agent from inside the app', () => {
  it('installs once when the review is ready, with no click', async () => {
    mockLanding = readyLanding(AGENT_SNAPSHOT);
    clickInstall(AGENT_LINK);
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);

    // Another render of the same review never installs again.
    mount(AGENT_LINK, 'in-app');
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('waits while the review is still loading, then installs', async () => {
    mockLanding = readyLanding(AGENT_SNAPSHOT, { agentReviewLoading: true });
    clickInstall(AGENT_LINK);
    expect(install).not.toHaveBeenCalled();

    mockLanding = readyLanding(AGENT_SNAPSHOT);
    mount(AGENT_LINK, 'in-app');
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('does not install while the installed copy cannot be verified', async () => {
    mockLanding = readyLanding(AGENT_SNAPSHOT, {
      verificationError: 'Your installed copy could not be checked.',
    });
    clickInstall(AGENT_LINK);
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled();
    expect(byTestId('deep-link-share-retry')).not.toBeNull();
  });

  it('does not install while another copy of the share may be here', async () => {
    // An older revision, an edited import, one that lost its link or one a
    // failed check could not rule out is not the installed target, yet
    // installing would replace or duplicate it.
    mockLanding = readyLanding(AGENT_SNAPSHOT, { mayHaveOtherCopy: true });
    clickInstall(AGENT_LINK);
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled();

    const button = byTestId('deep-link-share-install');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('shows Open for an installed copy and installs nothing', async () => {
    mockLanding = readyLanding(AGENT_SNAPSHOT, {
      installed: { entity: 'agent', agentId: 'agent_model_release' },
    });
    clickInstall(AGENT_LINK);
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled();
    expect(byTestId('deep-link-share-open')).not.toBeNull();
    expect(byTestId('deep-link-share-install')).toBeNull();
  });

  it('never installs unasked after that copy is uninstalled', async () => {
    mockLanding = readyLanding(AGENT_SNAPSHOT, {
      installed: { entity: 'agent', agentId: 'agent_model_release' },
    });
    clickInstall(AGENT_LINK);
    await act(async () => {
      await Promise.resolve();
    });
    // Uninstall from the review's menu returns it to Install.
    mockLanding = readyLanding(AGENT_SNAPSHOT);
    mount(AGENT_LINK, 'in-app');
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled();
    expect(byTestId('deep-link-share-install')).not.toBeNull();
  });

  it.each([
    ['the share was republished since the click', { contentHash: 'older' }],
    [
      'the package changed since the click',
      { contentHash: 'hash', packageDigest: 'sha256:older' },
    ],
    ['the click saw no revision', null],
  ] satisfies [string, InAppAgentRevision | null][])(
    'asks first when %s',
    async (_label, revision) => {
      mockLanding = readyLanding(AGENT_SNAPSHOT);
      clickInstall(AGENT_LINK, revision);
      await act(async () => {
        await Promise.resolve();
      });
      expect(install).not.toHaveBeenCalled();
      expect(byTestId('deep-link-share-install')).not.toBeNull();
    },
  );

  it('installs a packaged agent clicked on with that same package', async () => {
    const packaged: PublicShareSnapshot = {
      ...AGENT_SNAPSHOT,
      distributionMode: 'package',
      package: PACKAGE,
    };
    mockLanding = readyLanding(packaged);
    clickInstall(AGENT_LINK, {
      contentHash: 'hash',
      packageDigest: PACKAGE.digest,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a click that only had the list’s hash', { contentHash: 'hash' }],
    [
      'a click that saw no package',
      { contentHash: 'hash', packageDigest: null },
    ],
  ] satisfies [string, InAppAgentRevision][])(
    'asks first when the share now brings a package after %s',
    async (_label, revision) => {
      // The service can attach a package and keep the content hash, so a
      // package the click never saw is never installed unasked.
      mockLanding = readyLanding({
        ...AGENT_SNAPSHOT,
        distributionMode: 'package',
        package: PACKAGE,
      });
      clickInstall(AGENT_LINK, revision);
      await act(async () => {
        await Promise.resolve();
      });
      expect(install).not.toHaveBeenCalled();
      expect(byTestId('deep-link-share-install')).not.toBeNull();
    },
  );

  it('asks first when the package carries runnable scripts, even for the digest the click recorded', async () => {
    // docs/capability-packages.md: a package with runnable scripts stops on
    // the review for an explicit Install, so the person sees what can run.
    const withScript: PipelinePackageSummary = {
      ...PACKAGE,
      resources: [
        {
          id: 'skill-1',
          displayName: 'review',
          kind: 'standalone_skill',
          sourceLabel: 'Skill',
          fileCount: 2,
          totalBytes: 10,
          affectedSteps: [],
          executableFiles: ['review/scripts/run.sh'],
        },
      ],
    };
    mockLanding = readyLanding({
      ...AGENT_SNAPSHOT,
      distributionMode: 'package',
      package: withScript,
    });
    clickInstall(AGENT_LINK, {
      contentHash: 'hash',
      packageDigest: withScript.digest,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled();
    const button = byTestId('deep-link-share-install');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('does not carry the click over to another account after the share resolved', async () => {
    // The account changed after the click but the resolved share stayed and
    // was checked again: that is not the account that clicked.
    mockLanding = readyLanding(AGENT_SNAPSHOT);
    openInAppAgentInstall(AGENT_LINK, { contentHash: 'hash' });
    useNavigationStore.getState().consumeShareInstall();
    act(() => {
      useWorkspaceContextStore.setState((current) => ({
        accountEpoch: current.accountEpoch + 1,
      }));
    });
    mount(AGENT_LINK, 'in-app');
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled();
    expect(byTestId('deep-link-share-install')).not.toBeNull();
  });

  it('installs a click that saw no package when the share has none', async () => {
    mockLanding = readyLanding(AGENT_SNAPSHOT);
    clickInstall(AGENT_LINK, { contentHash: 'hash', packageDigest: null });
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('does not carry the click over to the account that signs in after a failed resolve', async () => {
    // The first resolve failed for lack of access; the click's approval ends
    // there. Once another account resolves the link, Install is a new click.
    mockLanding = readyLanding(AGENT_SNAPSHOT, {
      state: { phase: 'error', reason: 'not-a-member' },
      snapshot: null,
    });
    clickInstall(AGENT_LINK);
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled();

    mockLanding = readyLanding(AGENT_SNAPSHOT);
    mount(AGENT_LINK, 'in-app');
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled();
    const button = byTestId('deep-link-share-install');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog on the error, and Install tries again', async () => {
    mockLanding = readyLanding(AGENT_SNAPSHOT);
    clickInstall(AGENT_LINK);
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);

    // The install failed: the landing reports it and installs nothing.
    mockLanding = readyLanding(AGENT_SNAPSHOT, {
      installError: 'Network is down',
    });
    mount(AGENT_LINK, 'in-app');
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId('deep-link-share-landing')?.textContent).toContain(
      'Network is down',
    );
    expect(install).toHaveBeenCalledTimes(1);

    const retry = byTestId('deep-link-share-install');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(2);
  });
});

describe('Installs that still wait for the click', () => {
  it('a shared agent link from outside the app', async () => {
    mockLanding = readyLanding(AGENT_SNAPSHOT);
    mount(AGENT_LINK, 'deep-link');
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled();

    const button = byTestId('deep-link-share-install');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('every other kind, even from inside the app', async () => {
    mockLanding = readyLanding(SKILL_SNAPSHOT);
    mount(SKILL_LINK, 'in-app');
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled();
    expect(byTestId('deep-link-share-install')).not.toBeNull();
  });
});

describe('The one install per link', () => {
  it('runs again for another agent link in the same dialog', async () => {
    mockLanding = readyLanding(AGENT_SNAPSHOT);
    clickInstall(AGENT_LINK);
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);

    // An equal link object is the same link: no second install.
    mount({ ...AGENT_LINK }, 'in-app');
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(1);

    // Another agent's link reuses the mounted dialog.
    const other = { ...AGENT_SNAPSHOT, externalId: 'other-agent' };
    mockLanding = readyLanding(other);
    clickInstall({ ...AGENT_LINK, externalId: 'other-agent' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('keeps the dialog when the install throws, and Install tries again', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      install.mockRejectedValueOnce(new Error('bridge gone'));
      mockLanding = readyLanding(AGENT_SNAPSHOT);
      clickInstall(AGENT_LINK);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(install).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().shareInstallBusy).toBe(false);

      const retry = byTestId('deep-link-share-install');
      expect(retry).not.toBeNull();
      await act(async () => {
        retry?.click();
        await Promise.resolve();
      });
      expect(install).toHaveBeenCalledTimes(2);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('The one-click install over the real landing', () => {
  // What the readiness bridge returns: `id` is the share's, the document's
  // `id` is the model's, and the hash is the snapshot's own.
  const SHARE_DETAIL: SharedAgentDetail = {
    id: 'agent-share',
    name: 'Release agent',
    modelId: 'agent_model_release',
    baseModel: 'default',
    instructionsPreview: 'Ship it.',
    contentHash: 'hash',
    shareScope: 'organization',
    owner: { type: 'user', id: 'u', name: 'Me' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-03T00:00:00.000Z',
    createdBy: { id: 'u', name: 'Me', email: null },
    canUpdate: false,
    canDelete: false,
    publicShare: null,
    agent: {
      version: 1,
      id: 'agent_model_release',
      name: 'Release agent',
      baseModel: 'default',
      instructions: 'Ship it.',
      plugins: [],
    },
  };

  function localAgent(
    overrides: Partial<AgentModelDefinition>,
  ): AgentModelDefinition {
    return {
      id: 'agent_model_release',
      name: 'Release agent',
      baseModel: 'default',
      instructions: 'Ship it.',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  const bridge = {
    api: window.api,
    agents: window.agents,
    pipelines: window.pipelines,
  };
  afterEach(() => {
    realLanding = false;
    Object.assign(window, bridge);
  });

  /** Mounts the dialog over the real landing and lets every read settle. */
  async function openOverBridge(options: {
    list: jest.Mock;
    inspected?: SharedAgentDetail;
    /** The share the link resolves to, when it is not the plain agent. */
    snapshot?: PublicShareSnapshot;
  }): Promise<{ importShared: jest.Mock }> {
    realLanding = true;
    const importShared = jest.fn(() =>
      Promise.resolve({
        agent: { id: 'agent_model_release' },
        idChanged: false,
        requestedId: 'agent_model_release',
        finalId: 'agent_model_release',
      }),
    );
    Object.assign(window, {
      api: {
        ...window.api,
        deepLinkResolveShare: jest.fn(() =>
          Promise.resolve({
            ok: true,
            snapshot: options.snapshot ?? AGENT_SNAPSHOT,
          }),
        ),
        deepLinkReportHandoffEvent: jest.fn(() => Promise.resolve()),
      },
      agents: {
        ...window.agents,
        inspectImport: jest.fn(() =>
          Promise.resolve({ agent: options.inspected ?? SHARE_DETAIL }),
        ),
        list: options.list,
        importShared,
      },
      pipelines: { ...window.pipelines },
    });
    clickInstall({ ...AGENT_LINK, audience: 'ORGANIZATION' });
    for (let tick = 0; tick < 10; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    return { importShared };
  }

  it('installs the reviewed share with the plugins it needs, unclicked', async () => {
    const { importShared } = await openOverBridge({
      list: jest.fn(() => Promise.resolve({ agents: [] })),
    });
    expect(importShared).toHaveBeenCalledTimes(1);
    // The bridge's own detail, share id included, not the model's document.
    expect(importShared).toHaveBeenCalledWith({
      agentId: 'agent-share',
      installMissing: true,
      reviewedAgent: SHARE_DETAIL,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('waits for a click when the installed copy could not be looked up', async () => {
    // A failed check rules no copy out, so nothing installs unasked; Install
    // stays the person's own click, as it was before the check could fail.
    const { importShared } = await openOverBridge({
      list: jest.fn(() => Promise.reject(new Error('agents unavailable'))),
    });
    expect(importShared).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const button = byTestId('deep-link-share-install');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(importShared).toHaveBeenCalledTimes(1);
  });

  it('keeps Install on a public agent link whose installed check failed', async () => {
    realLanding = true;
    const publicSnapshot: PublicShareSnapshot = {
      entity: 'agent',
      externalId: 'agent-share',
      agent: SHARE_DETAIL.agent,
      contentHash: 'hash',
      authorUsername: null,
      updatedAt: '2026-02-03T00:00:00.000Z',
    };
    const importPublic = jest.fn(() =>
      Promise.resolve({ id: 'agent_model_release' }),
    );
    Object.assign(window, {
      api: {
        ...window.api,
        deepLinkResolveShare: jest.fn(() =>
          Promise.resolve({ ok: true, snapshot: publicSnapshot }),
        ),
        deepLinkReportHandoffEvent: jest.fn(() => Promise.resolve()),
      },
      agents: {
        ...window.agents,
        detectPublic: jest.fn(() => Promise.reject(new Error('read failed'))),
        list: jest.fn(() => Promise.resolve({ agents: [] })),
        importPublic,
      },
      pipelines: { ...window.pipelines },
    });
    mount(
      { entity: 'agent', externalId: 'agent-share', intent: 'install' },
      'deep-link',
    );
    for (let tick = 0; tick < 10; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(byTestId('deep-link-share-retry')).toBeNull();
    const button = byTestId('deep-link-share-install');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(importPublic).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an older revision of the same share',
      {
        importedFromRemoteId: 'agent-share',
        remoteId: 'agent-share',
        remoteContentHash: 'older-hash',
        importedContentHash: 'local',
        contentHash: 'local',
      },
    ],
    [
      'an import that never recorded the link back',
      { importedFromRemoteId: 'agent-share' },
    ],
    [
      'the author’s own linked copy',
      { remoteId: 'agent-share', remoteContentHash: 'hash' },
    ],
  ] satisfies [string, Partial<AgentModelDefinition>][])(
    'waits for a click when %s is already here',
    async (_label, copy) => {
      const { importShared } = await openOverBridge({
        list: jest.fn(() => Promise.resolve({ agents: [localAgent(copy)] })),
      });
      expect(importShared).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      // The review stays, and its Install is the person's own confirmation.
      const button = byTestId('deep-link-share-install');
      expect(button).not.toBeNull();
      await act(async () => {
        button?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(importShared).toHaveBeenCalledTimes(1);
    },
  );

  it('ignores a local agent that is not a copy of this share', async () => {
    const { importShared } = await openOverBridge({
      list: jest.fn(() =>
        Promise.resolve({
          agents: [
            localAgent({ importedFromRemoteId: 'another-share' }),
            localAgent({ id: 'agent_model_mine' }),
          ],
        }),
      ),
    });
    expect(importShared).toHaveBeenCalledTimes(1);
  });

  describe('for an agent with skill or plugin refs', () => {
    const withRefs = (
      plugins: SharedAgentDetail['agent']['plugins'],
    ): { snapshot: PublicShareSnapshot; inspected: SharedAgentDetail } => ({
      snapshot: {
        ...AGENT_SNAPSHOT,
        agent: { ...SHARE_DETAIL.agent, plugins },
      },
      inspected: {
        ...SHARE_DETAIL,
        agent: { ...SHARE_DETAIL.agent, plugins },
      },
    });

    it('installs unasked when it references no GitHub skill or plugin', async () => {
      const { importShared } = await openOverBridge({
        ...withRefs([
          {
            type: 'skill',
            source: { type: 'builtin', id: 'app' },
            skill_name: 'review',
          },
          {
            type: 'claude_plugin',
            marketplace: { type: 'builtin', id: 'app' },
            plugin_name: 'helper',
          },
        ]),
        list: jest.fn(() => Promise.resolve({ agents: [] })),
      });
      expect(importShared).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalled();
    });

    it('waits for a click when it needs a GitHub skill, and Install then installs', async () => {
      // The installer replaces an installed copy of a GitHub skill, with the
      // person's edits and local files, so the person confirms first.
      const { importShared } = await openOverBridge({
        ...withRefs([
          {
            type: 'skill',
            source: { type: 'github', repo: 'acme/skills' },
            skill_name: 'review',
          },
        ]),
        list: jest.fn(() => Promise.resolve({ agents: [] })),
      });
      expect(importShared).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      const button = byTestId('deep-link-share-install');
      expect(button).not.toBeNull();
      await act(async () => {
        button?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(importShared).toHaveBeenCalledTimes(1);
      expect(importShared).toHaveBeenCalledWith(
        expect.objectContaining({ installMissing: true }),
      );
    });

    it.each([
      [
        'a GitHub plugin',
        {
          type: 'plugin',
          marketplace: { type: 'github', repo: 'acme/plugins' },
          plugin_name: 'helper',
        },
      ],
      [
        'a GitHub Claude plugin',
        {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'acme/plugins' },
          plugin_name: 'helper',
        },
      ],
    ] satisfies [string, SharedAgentDetail['agent']['plugins'][number]][])(
      'waits for a click when it needs %s',
      async (_label, ref) => {
        const { importShared } = await openOverBridge({
          ...withRefs([ref]),
          list: jest.fn(() => Promise.resolve({ agents: [] })),
        });
        expect(importShared).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(byTestId('deep-link-share-install')).not.toBeNull();
      },
    );
  });

  it('refuses a share republished since it was reviewed, and asks for a refresh', async () => {
    // The review read the snapshot with one hash; the import's own read finds
    // another revision, which the person never saw.
    const { importShared } = await openOverBridge({
      list: jest.fn(() => Promise.resolve({ agents: [] })),
      inspected: { ...SHARE_DETAIL, contentHash: 'republished' },
    });
    expect(importShared).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId('deep-link-share-landing')?.textContent).toContain(
      'changed while you were reviewing',
    );
    expect(byTestId('deep-link-share-retry')).not.toBeNull();
    expect(byTestId('deep-link-share-install')).toBeNull();
  });
});
