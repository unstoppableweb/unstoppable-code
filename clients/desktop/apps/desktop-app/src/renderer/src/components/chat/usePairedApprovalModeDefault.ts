import { useEffect, useState } from 'react';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import type { ApprovalMode } from '@canopy/desktop-shared/types';
import { approvalDefaultCacheKey } from '@/stores/chat/approval-defaults';
import { chatBackendFor } from '@/stores/chat/backend';
import {
  pairedComputerConnectionForProject,
  pairedComputerHasCapability,
  usePairedComputerConnectionStore,
} from '@/stores/chat/paired-computer/connection-store';

export interface PairedApprovalDefaultResult {
  readonly isPaired: boolean;
  /** Resolved host default for the current connection epoch, or undefined when unresolved. */
  readonly mode: ApprovalMode | undefined;
  /** True when this paired tab needs the host default and no lookup has succeeded for the current epoch. */
  readonly isUnresolved: boolean;
}

/**
 * Resolves a paired computer's persisted approval-mode default keyed to the
 * device's connection epoch and `composer` capability. Refetches automatically
 * on reconnect or when `composer` capability returns; reports unresolved if
 * the lookup fails instead of displaying a stale cached mode.
 */
export function usePairedApprovalModeDefault(
  target:
    | {
        readonly projectId: string;
        readonly worktreeId?: string;
      }
    | undefined,
  explicitMode: ApprovalMode | undefined,
): PairedApprovalDefaultResult {
  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const isPaired = projectId !== undefined && isPairedComputerId(projectId);
  const cacheKey = isPaired
    ? approvalDefaultCacheKey(projectId, worktreeId)
    : undefined;

  const connectionEpoch = usePairedComputerConnectionStore((state) => {
    if (!isPaired || projectId === undefined) return 0;
    return (
      pairedComputerConnectionForProject(state, projectId)?.connectionEpoch ?? 0
    );
  });
  const hasComposerCapability = usePairedComputerConnectionStore((state) => {
    if (!isPaired || projectId === undefined) return false;
    return pairedComputerHasCapability(state, projectId, 'composer');
  });

  const [resolved, setResolved] = useState<{
    readonly cacheKey: string;
    readonly connectionEpoch: number;
    readonly mode: ApprovalMode;
  } | null>(null);

  useEffect(() => {
    if (
      !isPaired ||
      projectId === undefined ||
      cacheKey === undefined ||
      explicitMode !== undefined ||
      !hasComposerCapability ||
      connectionEpoch === 0
    ) {
      return;
    }

    let active = true;
    void chatBackendFor({ projectId })
      .approvals.getResolvedDefault({
        projectId,
        ...(worktreeId !== undefined && worktreeId !== ''
          ? { worktreeId }
          : {}),
      })
      .then(
        (mode) => {
          if (!active) return;
          setResolved({ cacheKey, connectionEpoch, mode });
        },
        () => {
          if (!active) return;
          setResolved((current) =>
            current?.cacheKey === cacheKey &&
            current.connectionEpoch === connectionEpoch
              ? null
              : current,
          );
        },
      );

    return (): void => {
      active = false;
    };
  }, [
    cacheKey,
    connectionEpoch,
    explicitMode,
    hasComposerCapability,
    isPaired,
    projectId,
    worktreeId,
  ]);

  if (!isPaired) {
    return { isPaired: false, mode: undefined, isUnresolved: false };
  }
  if (explicitMode !== undefined) {
    return { isPaired: true, mode: explicitMode, isUnresolved: false };
  }

  const currentMode =
    hasComposerCapability &&
    connectionEpoch > 0 &&
    resolved !== null &&
    resolved.cacheKey === cacheKey &&
    resolved.connectionEpoch === connectionEpoch
      ? resolved.mode
      : undefined;

  return {
    isPaired: true,
    mode: currentMode,
    isUnresolved: currentMode === undefined,
  };
}
