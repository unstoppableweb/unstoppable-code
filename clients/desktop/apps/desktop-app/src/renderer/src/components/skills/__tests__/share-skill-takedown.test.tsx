/** @jest-environment jsdom */
/**
 * CAN-7226: the skill share dialog commits a package before it updates a
 * linked skill, and that commit refuses a SKILL.md that looks like it holds a
 * secret. A skill shared before the check must still be possible to take
 * down, so "Only me" with the stored text unchanged keeps the cloud's package:
 * no package commit, and exactly one update carrying preservePackage and no
 * package fields. New text, or a wider audience, still commits the package.
 * This drives the real ShareSkillModal share(); only the dialog chrome, link
 * resolution and the preload bridge are replaced.
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SharedSkillDetail } from '@canopy/desktop-shared/types/skills';
import type { DesktopShareResourceDialog } from '@/components/shared/share/DesktopShareResourceDialog';
import { ShareSkillModal } from '../ShareSkillModal';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type DialogProps = ComponentProps<typeof DesktopShareResourceDialog>;
type PackageSelection = NonNullable<
  Parameters<DialogProps['share']>[0]['packageSelection']
>;
let mockDialogProps: DialogProps | null = null;
let reviewedSelection: PackageSelection | null = null;

jest.mock('@/components/shared/share/DesktopShareResourceDialog', () => ({
  DesktopShareResourceDialog: (props: DialogProps): null => {
    mockDialogProps = props;
    return null;
  },
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));
jest.mock('@/lib/share-links', () => ({
  createShareLinkResolver: (): unknown => ({
    linkFromDetail: (): Promise<null> => Promise.resolve(null),
    resolveLink: (): Promise<{ url: string }> =>
      Promise.resolve({ url: 'https://cloud.example/s/skill' }),
  }),
  resolveSharedSkillUrl: (): string => 'https://cloud.example/s/skill',
}));
jest.mock('@/lib/fixShareDependenciesWithAI', () => ({
  shareRepairBinding: (): undefined => undefined,
  skillShareRepairEligibility: (): Record<string, never> => ({}),
}));

// Built at runtime so no secret-shaped literal is committed. The package
// check passes it; only the shared check refuses it.
const STORED_SKILL = `---\nname: deploy-env\ndescription: Deploys.\n---\nRun with NPM_TOKEN=npm_${'x'.repeat(8)} set.\n`;
const EDITED_SKILL = `${STORED_SKILL}More steps.\n`;
const AT = '2026-11-19T00:00:00.000Z';

const detail = (
  overrides: Partial<SharedSkillDetail> = {},
): SharedSkillDetail => ({
  id: 'remote-1',
  name: 'deploy-env',
  description: 'Deploys.',
  contentHash: 'c'.repeat(64),
  shareScope: 'team',
  owner: {
    type: 'team',
    id: 'team-1',
    name: 'Ops',
    organization: { id: 'org-1', name: 'Org' },
  },
  createdBy: { id: 'u1', name: null, email: null },
  createdAt: AT,
  updatedAt: AT,
  canUpdate: true,
  canDelete: true,
  publicShare: null,
  rawSkill: STORED_SKILL,
  ...overrides,
});

interface Bridge {
  readRawSkill: jest.Mock;
  getShared: jest.Mock;
  analyzeCapabilityPackage: jest.Mock;
  commitCapabilityPackage: jest.Mock;
  updateShared: jest.Mock<Promise<unknown>, [request: unknown]>;
  createShared: jest.Mock;
}

let bridge: Bridge;
let root: Root;
let container: HTMLDivElement;

function installBridge(
  localText: string,
  stored: Partial<SharedSkillDetail>,
): void {
  bridge = {
    readRawSkill: jest.fn(() => Promise.resolve(localText)),
    getShared: jest.fn(() => Promise.resolve(detail(stored))),
    analyzeCapabilityPackage: jest.fn(() =>
      Promise.resolve({
        analysisId: 'analysis-1',
        state: 'ready',
        manifest: null,
      }),
    ),
    commitCapabilityPackage: jest.fn(() =>
      Promise.resolve({
        ok: true,
        value: {
          capabilityPackage: { version: 1, digest: 'pp:v1:abc' },
          committedPackageUploadId: 'upload-1',
        },
      }),
    ),
    updateShared: jest.fn<Promise<unknown>, [request: unknown]>(() =>
      Promise.resolve({ ok: true, value: detail({ shareScope: 'private' }) }),
    ),
    createShared: jest.fn(),
  };
  Object.assign(window, { skills: bridge });
}

async function openDialog(
  localText: string,
  stored: Partial<SharedSkillDetail> = {},
): Promise<DialogProps> {
  installBridge(localText, stored);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <ShareSkillModal
        skill={{
          sourceId: 'custom:app',
          name: 'deploy-env',
          remote: {
            accountId: 'acct-1',
            remoteId: 'remote-1',
            contentHash: 'c'.repeat(64),
            shareScope: stored.shareScope ?? 'team',
            sharedAt: AT,
          },
        }}
        onClose={(): void => undefined}
        onOpenAccountSettings={(): void => undefined}
        onShared={(): void => undefined}
      />,
    );
  });
  const first = mockDialogProps;
  if (first === null) throw new Error('dialog not rendered');
  // The dialog's preflight loads the stored copy, as it does before share.
  await act(async () => {
    await first.preflight?.();
  });
  // The reviewed analysis, as the dialog runs it before offering share.
  const port = first.capabilityPackage?.port;
  if (!port) throw new Error('package port missing');
  await act(async () => {
    const analysis = await port.analyze({});
    reviewedSelection = {
      analysisId: analysis.analysisId,
      selectedOptionalResourceIds: [],
      analysis,
    };
  });
  const loaded = mockDialogProps;
  if (loaded === null) throw new Error('dialog not rendered');
  return loaded;
}

/** The selection the dialog reviewed, as its share() receives it. */
function reviewed(): PackageSelection {
  if (reviewedSelection === null) throw new Error('package not analyzed');
  return reviewedSelection;
}

/** The request the one update sent. */
function sentUpdate(): unknown {
  return bridge.updateShared.mock.calls[0]?.[0];
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mockDialogProps = null;
  reviewedSelection = null;
});

describe('taking a stored skill down to "Only me" never commits a package (CAN-7226)', () => {
  it('keeps the stored package: no package commit, one update with preservePackage and no package fields', async () => {
    const dialog = await openDialog(STORED_SKILL);
    await act(async () => {
      await dialog.share({ scope: 'private', packageSelection: reviewed() });
    });
    expect(bridge.commitCapabilityPackage).not.toHaveBeenCalled();
    expect(bridge.updateShared).toHaveBeenCalledTimes(1);
    const sent = sentUpdate();
    expect(sent).toMatchObject({
      skillId: 'remote-1',
      rawSkill: STORED_SKILL,
      shareScope: 'private',
      preservePackage: true,
    });
    expect(sent).not.toHaveProperty('capabilityPackage');
    expect(sent).not.toHaveProperty('committedPackageUploadId');
  });

  it('still commits the package when the text changed', async () => {
    const dialog = await openDialog(EDITED_SKILL);
    await act(async () => {
      await dialog.share({ scope: 'private', packageSelection: reviewed() });
    });
    expect(bridge.commitCapabilityPackage).toHaveBeenCalledTimes(1);
    expect(sentUpdate()).not.toHaveProperty('preservePackage');
  });

  it('still commits the package for a skill that is already private, so its supporting files reach the cloud', async () => {
    const dialog = await openDialog(STORED_SKILL, {
      shareScope: 'private',
      owner: { type: 'user', id: 'u1', name: null },
    });
    await act(async () => {
      await dialog.share({ scope: 'private', packageSelection: reviewed() });
    });
    expect(bridge.commitCapabilityPackage).toHaveBeenCalledTimes(1);
    expect(sentUpdate()).not.toHaveProperty('preservePackage');
  });

  it('still commits the package for a wider audience', async () => {
    const dialog = await openDialog(STORED_SKILL);
    await act(async () => {
      await dialog.share({
        scope: 'organization',
        organizationId: 'org-1',
        packageSelection: reviewed(),
      });
    });
    expect(bridge.commitCapabilityPackage).toHaveBeenCalledTimes(1);
    expect(sentUpdate()).not.toHaveProperty('preservePackage');
  });
});
