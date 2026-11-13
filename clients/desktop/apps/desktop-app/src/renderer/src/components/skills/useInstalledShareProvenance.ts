import { useEffect, useState } from 'react';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  installedShareUpdateAvailable,
  sharedSkillDisplayNames,
  type InstalledShareDisplayNames,
  type InstalledShareProvenanceOptions,
  type InstalledShareSource,
} from '@canopy/ui-app/capability';
import { sharedResourceInstallLink } from '@/lib/sharedResourceInstallLink';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

type SourceRead =
  | {
      readonly key: string | null;
      readonly status: 'loaded';
      readonly names: InstalledShareDisplayNames;
      readonly sourceHash: string;
    }
  | { readonly key: string | null; readonly status: 'failed' | 'pending' };

/**
 * The installed page's provenance for a receipted shared install (CAN-5018):
 * reads the source once per open, account, context and installed hash, and
 * reports `Update available` only when that read shows a changed source.
 * A failed read keeps the receipt's names; it never blocks the page. Only
 * the current read for a team or organization share offers Update.
 */
export function useInstalledShareProvenance(
  installedSkill:
    | Pick<InstalledSkillInfo, 'sourceId' | 'name' | 'installedFromShare'>
    | undefined,
): InstalledShareProvenanceOptions | undefined {
  const origin = installedSkill?.installedFromShare;
  const remoteId = origin?.remoteId;
  const installedHash = origin?.contentHash;
  const accountEpoch = useWorkspaceContextStore((s) => s.accountEpoch);
  const contextKey = useWorkspaceContextStore((s) =>
    serializeWorkspaceContext(s.state.context),
  );
  const organizations = useWorkspaceContextStore((s) => s.state.organizations);
  // The installed hash is part of the key, so a committed update that
  // advances the receipt reads the source again.
  const key =
    remoteId === undefined
      ? null
      : JSON.stringify([
          installedSkill?.sourceId,
          installedSkill?.name,
          remoteId,
          accountEpoch,
          contextKey,
          installedHash,
          origin?.authorizedAt,
          origin?.packageDigest,
          origin?.shareScope,
          origin?.ownerContext,
          origin?.ownerName,
          origin?.teamName,
          origin?.sharedByName,
        ]);
  const [read, setRead] = useState<SourceRead>({ key, status: 'pending' });
  // Reset this component's state during render so returning to an earlier
  // identity cannot display its old live result, even for the first paint.
  if (read.key !== key) setRead({ key, status: 'pending' });

  useEffect(() => {
    if (key === null || remoteId === undefined) return undefined;
    let cancelled = false;
    window.skills.getShared(remoteId).then(
      (detail) => {
        if (cancelled) return;
        setRead({
          key,
          status: 'loaded',
          names: sharedSkillDisplayNames(detail),
          sourceHash: detail.contentHash,
        });
      },
      () => {
        if (!cancelled) setRead({ key, status: 'failed' });
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [key, remoteId]);

  if (!origin || remoteId === undefined) return undefined;
  // A result for another skill, account, context or hash is never shown.
  const current = read.key === key ? read : null;
  const source: InstalledShareSource = {
    kind: 'action',
    onSelect: (): void =>
      useNavigationStore
        .getState()
        .openSkillViewer({ kind: 'shared', skillId: remoteId }),
  };
  if (current?.status === 'loaded') {
    // The same rule as the Customize row's pill (CAN-5309).
    const updateAvailable = installedShareUpdateAvailable(
      origin,
      current.sourceHash,
    );
    // Update opens the same reviewed replacement as the shared skill's own
    // page (CAN-5306). A private or unknown scope has no review here, so its
    // copy shows the status without the action.
    const updateLink = updateAvailable
      ? sharedResourceInstallLink({
          entity: 'skill',
          externalId: remoteId,
          scope: origin.shareScope,
        })
      : null;
    return {
      names: current.names,
      updateAvailable,
      ...(updateLink && installedSkill
        ? {
            onUpdate: (): void =>
              useNavigationStore
                .getState()
                .openShareInstall(updateLink, 'in-app', {
                  sourceId: installedSkill.sourceId,
                  skillName: installedSkill.name,
                }),
          }
        : {}),
      source,
    };
  }
  // Until a read succeeds the receipt's names stand; only a missing
  // organization name is looked up, by exact id in the current account.
  const ownerContext = origin.ownerContext;
  const fallbackOwnerName =
    !origin.ownerName?.trim() && ownerContext?.kind === 'organization'
      ? organizations.find((org) => org.id === ownerContext.organizationId)
          ?.name
      : undefined;
  return {
    names: {
      ...(origin.ownerName?.trim()
        ? { ownerName: origin.ownerName.trim() }
        : fallbackOwnerName
          ? { ownerName: fallbackOwnerName }
          : {}),
      ...(origin.teamName ? { teamName: origin.teamName } : {}),
      ...(origin.sharedByName ? { sharedByName: origin.sharedByName } : {}),
    },
    source,
  };
}
