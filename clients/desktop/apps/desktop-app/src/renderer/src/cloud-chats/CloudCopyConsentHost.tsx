import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { CloudCapabilityUploadRow } from '@canopy/app-state/core-cowork';
import { CatalogEntryPublishResultSchema } from '@canopy/protocol/canopy-core';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import type { CloudCopyAnalyzeResult } from '@canopy/desktop-shared/types';
import {
  CloudCopyConsentDialog,
  type CloudCopyConsentAudience,
} from '@canopy/ui-app/capability';
import { ConfirmDialog } from '@canopy/ui-shared';
import { toAppError } from '@canopy/protocol/app-errors';
import { useCanopyCloudAccountState } from '../hooks/useCanopyCloudAccountState';

/** What COMPOSER's cloud plugin picker passes for a `needs_upload` row (R5d). */
export interface CloudCopyConsentRequest {
  /** A row `needsCloudUpload` accepts: a desktop entry the cloud lacks. */
  readonly row: CloudCapabilityUploadRow;
  /** The account the cloud chat belongs to; the copy is refused for another. */
  readonly accountId: string;
  /** The web core entry to select: the cloud copy, not the desktop entry. */
  readonly onDone: (cloudEntryId: string) => void;
  readonly onCancel: () => void;
}

const REFUSALS: Record<
  Extract<CloudCopyAnalyzeResult, { ok: false }>['reason'],
  string
> = {
  disabled: 'Cloud chats are turned off on this computer.',
  'signed-out': 'Sign in to add this to your cloud account.',
  'account-mismatch':
    'This computer is signed in to a different account than this cloud chat.',
  unsupported: 'This can’t be added to the cloud from here.',
  'not-found': 'This isn’t on this computer any more.',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The desktop side of the picker's cloud-copy slot (CAN-6176 9c): analyses a
 * desktop skill or plugin in main, shows the shared consent dialog, and on
 * Add publishes it through the local core's `core.catalog.entry.publish`
 * with the package the person agreed to. A server copy (#8711) joins here
 * when that dialog lands.
 */
export function CloudCopyConsentHost({
  row,
  accountId,
  onDone,
  onCancel,
}: CloudCopyConsentRequest): JSX.Element {
  const entry = row.localEntry;
  const kind =
    row.state.action === 'publish_skill'
      ? 'skill'
      : row.state.action === 'publish_plugin'
        ? 'plugin'
        : null;
  const [analysis, setAnalysis] =
    useState<PipelinePackageAnalysisSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [audience, setAudience] = useState<CloudCopyConsentAudience>('private');
  const generation = useRef(0);
  // A sign-in change while the dialog is open analyses again, so the dialog
  // refuses a copy for any account but the chat's (CAN-6176).
  const signedInAccountId =
    useCanopyCloudAccountState().account?.account?.id ?? null;

  const analyze = useCallback(async (): Promise<void> => {
    if (kind === null) return;
    const current = ++generation.current;
    setLoading(true);
    setAnalysisError(null);
    try {
      const result = await window.api.cloudCopy.analyze({
        entryId: entry.entryId,
        expectedAccountId: accountId,
      });
      if (current !== generation.current) return;
      if (result.ok) {
        setAnalysis(result.analysis);
        setAudience(result.audience);
        setSelected([]);
      } else {
        setAnalysis(null);
        setAnalysisError(REFUSALS[result.reason]);
      }
    } catch (caught) {
      if (current !== generation.current) return;
      setAnalysis(null);
      setAnalysisError(
        toAppError(caught)?.detail.message.trim() ||
          'The files couldn’t be checked.',
      );
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [entry, kind, accountId, signedInAccountId]);

  useEffect(() => {
    void analyze();
  }, [analyze]);

  if (kind === null)
    return (
      <ConfirmDialog
        title={`Add ${row.name} to your cloud account?`}
        message="This can’t be added to the cloud from here yet."
        confirmLabel="Close"
        onConfirm={onCancel}
        onCancel={onCancel}
      />
    );

  const add = async (): Promise<void> => {
    if (analysis === null) return;
    const reply = await window.canopyCore.invoke({
      kind: 'request',
      method: 'core.catalog.entry.publish',
      params: {
        entryId: entry.entryId,
        kind,
        expectedRevision: entry.revision,
        visibility: 'private',
        teamId: null,
        organizationId: null,
        package: {
          analysisId: analysis.analysisId,
          selectedOptionalResourceIds: [...selected],
        },
        expectedAccountId: accountId,
        _meta: { idempotencyKey: crypto.randomUUID() },
      },
    });
    if (!reply.ok) {
      // A stale or blocked package is checked again, so the dialog shows
      // what would go now.
      const code = isRecord(reply.error) ? reply.error.code : undefined;
      if (
        code === 'core.catalog.packageStale' ||
        code === 'core.catalog.packageBlocked' ||
        code === 'core.catalog.accountMismatch'
      )
        void analyze();
      throw new Error(reply.error.message);
    }
    const published = CatalogEntryPublishResultSchema.safeParse(reply.value);
    if (!published.success)
      throw new Error('The cloud returned an unexpected answer. Try again.');
    onDone(published.data.remoteEntryId);
  };

  return (
    <CloudCopyConsentDialog
      subject={{ kind, name: row.name }}
      replacing={row.state.reason === 'changed'}
      audience={audience}
      analysis={analysis}
      loading={loading}
      analysisError={analysisError}
      selectedOptionalResourceIds={selected}
      onToggleOptionalResource={(resourceId): void =>
        setSelected((current) =>
          current.includes(resourceId)
            ? current.filter((id) => id !== resourceId)
            : [...current, resourceId],
        )
      }
      onRetry={(): void => {
        void analyze();
      }}
      onAdd={add}
      onClose={onCancel}
    />
  );
}
