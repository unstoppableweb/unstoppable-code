import { useEffect, useRef, useState } from 'react';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { CUSTOM_SKILL_SOURCE_ID } from '@/lib/sharedSkillImport';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

interface InstalledShareSource {
  readonly remoteId: string;
  readonly contentHash: string | undefined;
}

/** One source per receipted shared copy, deduplicated by share. */
function installedShareSources(
  skills: readonly Pick<
    InstalledSkillInfo,
    'sourceId' | 'builtIn' | 'installedFromShare'
  >[],
): InstalledShareSource[] {
  const sources = new Map<string, InstalledShareSource>();
  for (const skill of skills) {
    const origin = skill.installedFromShare;
    if (
      skill.sourceId !== CUSTOM_SKILL_SOURCE_ID ||
      skill.builtIn === true ||
      !origin?.remoteId ||
      sources.has(origin.remoteId)
    )
      continue;
    sources.set(origin.remoteId, {
      remoteId: origin.remoteId,
      contentHash: origin.contentHash,
    });
  }
  return [...sources.values()];
}

function canReadSharedSkills(
  account: CanopyCloudAccountPublicState | null,
): boolean {
  return (
    account !== null &&
    isCanopyCloudConnected(account) &&
    account.capabilities.includes('skills-crud-v1')
  );
}

/**
 * Current source hashes of receipted shared skill copies (CAN-5309), keyed by
 * share id, so a Customize row can show the same Update available as the
 * installed detail (`useInstalledShareProvenance`). Re-resolves when a receipt
 * advances, the account changes or the workspace context switches. A failed
 * read, a signed-out account or a missing capability leaves the share out.
 */
export function useInstalledShareSourceHashes(
  skills: readonly Pick<
    InstalledSkillInfo,
    'sourceId' | 'builtIn' | 'installedFromShare'
  >[],
  account: CanopyCloudAccountPublicState | null,
): ReadonlyMap<string, string> {
  const accountEpoch = useWorkspaceContextStore((s) => s.accountEpoch);
  const contextKey = useWorkspaceContextStore((s) =>
    serializeWorkspaceContext(s.state.context),
  );
  const [hashes, setHashes] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const sources = installedShareSources(skills);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  // Receipt hashes are in the key, so a committed update reads again.
  const sourcesKey = JSON.stringify(sources);
  const canRead = canReadSharedSkills(account);
  const scopeKey = `${account?.account?.id ?? ''}|${accountEpoch}|${contextKey}|${canRead}`;
  const scopeRef = useRef(scopeKey);

  useEffect(() => {
    let cancelled = false;
    const scopeChanged = scopeRef.current !== scopeKey;
    scopeRef.current = scopeKey;
    // A new account or context starts empty. A changed source list keeps the
    // hashes still listed while it reads again, so other rows' pills stay.
    const listed = new Set(sourcesRef.current.map((s) => s.remoteId));
    setHashes((prev) => {
      const kept = scopeChanged
        ? []
        : [...prev].filter(([remoteId]) => listed.has(remoteId));
      return kept.length === prev.size ? prev : new Map(kept);
    });
    if (!canRead || sourcesRef.current.length === 0) return undefined;
    const reads = sourcesRef.current.map((source) =>
      window.skills
        .getShared(source.remoteId)
        .then((detail) => [source.remoteId, detail.contentHash] as const),
    );
    void Promise.allSettled(reads).then((results) => {
      if (cancelled) return;
      const resolved = new Map<string, string>();
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const [remoteId, contentHash] = result.value;
          resolved.set(remoteId, contentHash);
        }
      }
      setHashes(resolved);
    });
    return (): void => {
      cancelled = true;
    };
  }, [canRead, scopeKey, sourcesKey]);

  return hashes;
}
