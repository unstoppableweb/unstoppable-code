import { useMemo, useState, type JSX } from 'react';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import {
  Button,
  DialogModal,
  ErrorBanner,
  Heading,
  LoadingSpinner,
} from '@canopy/ui-shared/components';
import { CapabilityPackageDependencies } from '../sharing/capability-package/CapabilityPackageDependencies';
import {
  computeRequiredResourceIds,
  computeResourceClosureIds,
} from '../sharing/capability-package/capability-package-closure';

/**
 * Every file the copy sends, as `<skill or plugin>/<path>`: the required
 * members and the optional ones ticked, each file once whichever provider
 * tree carries it.
 */
export function cloudCopySentPaths(
  analysis: PipelinePackageAnalysisSummary | null,
  selectedOptionalResourceIds: readonly string[],
): string[] {
  const manifest = analysis?.manifest;
  if (manifest === undefined) return [];
  const included = new Set([
    ...computeRequiredResourceIds(manifest),
    ...computeResourceClosureIds(manifest, selectedOptionalResourceIds),
  ]);
  const paths = new Set<string>();
  for (const resource of manifest.resources) {
    if (!included.has(resource.id)) continue;
    for (const tree of resource.trees)
      for (const entry of tree.entries)
        paths.add(`${tree.rootName}/${entry.path}`);
  }
  return [...paths].sort();
}

const WITHHELD_COPY = {
  heading: 'Not sent',
  helper: 'These stay on this computer. The cloud copy goes without them.',
};

/**
 * Who already sees the copy this adds or updates. A skill linked to a copy
 * the account shares is updated in place, so that audience gets the changes.
 */
export type CloudCopyConsentAudience =
  | 'private'
  | 'public_link'
  | 'team'
  | 'organization';

const SHARED_AUDIENCE_COPY: Record<
  Exclude<CloudCopyConsentAudience, 'private'>,
  string
> = {
  team: 'your team, so your team sees these changes too',
  organization: 'your organization, so everyone in it sees these changes too',
  public_link: 'a public link, so anyone with the link sees these changes too',
};

export interface CloudCopyConsentDialogProps {
  /** The skill or plugin going to the cloud, by its display name. */
  readonly subject: {
    readonly kind: 'skill' | 'plugin';
    readonly name: string;
  };
  /** A cloud copy exists and this replaces it with the current files. */
  readonly replacing: boolean;
  /** Who sees the copy this adds or updates; private for a new copy. */
  readonly audience: CloudCopyConsentAudience;
  /** The cloud-copy analysis of the subject; null until it arrives. */
  readonly analysis: PipelinePackageAnalysisSummary | null;
  readonly loading: boolean;
  /** Why the analysis failed; null while it hasn't. */
  readonly analysisError: string | null;
  readonly selectedOptionalResourceIds: readonly string[];
  readonly onToggleOptionalResource: (resourceId: string) => void;
  readonly onRetry: () => void;
  /** Resolves when the copy is made; rejects with a message to show. */
  readonly onAdd: () => Promise<void>;
  readonly onClose: () => void;
}

/**
 * Asks before a desktop skill or plugin goes to the cloud account as a
 * private copy (CAN-6176 D7, D13). It lists every file that will be sent,
 * and the files that won't: secret-looking, git-ignored or linked files are
 * left out and shown with their reason, never offered as a choice. Optional
 * dependencies start unticked. The data and the upload come from the host.
 */
export function CloudCopyConsentDialog({
  subject,
  replacing,
  audience,
  analysis,
  loading,
  analysisError,
  selectedOptionalResourceIds,
  onToggleOptionalResource,
  onRetry,
  onAdd,
  onClose,
}: CloudCopyConsentDialogProps): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed check leaves nothing to agree to, even an earlier analysis.
  const ready =
    analysis?.state === 'ready' && !loading && analysisError === null;
  const sent = useMemo(
    () => cloudCopySentPaths(analysis, selectedOptionalResourceIds),
    [analysis, selectedOptionalResourceIds],
  );
  const action = replacing ? 'Update cloud copy' : 'Add to cloud';

  const add = async (): Promise<void> => {
    setAdding(true);
    setError(null);
    try {
      await onAdd();
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message !== ''
          ? caught.message
          : `This ${subject.kind} couldn’t be added to your cloud account. Try again.`,
      );
    } finally {
      setAdding(false);
    }
  };

  return (
    <DialogModal
      title={
        replacing
          ? `Update ${subject.name} in your cloud account?`
          : `Add ${subject.name} to your cloud account?`
      }
      maxWidth="lg"
      trapFocus
      closeOnBackdrop={!adding}
      closeOnEscape={!adding}
      closeButtonDisabled={adding}
      dataTestId="cloud-copy-consent"
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {error !== null && (
            <ErrorBanner
              errorSource="cloud-copy-install"
              className=""
              error={error}
              blockMessageFromReplay
            />
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" disabled={adding} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!ready || adding}
              onClick={(): void => {
                void add();
              }}
              data-testid="cloud-copy-consent-add"
            >
              {adding ? <LoadingSpinner decorative /> : null}
              {action}
            </Button>
          </div>
        </div>
      }
    >
      <div
        className="flex flex-col gap-3"
        data-testid="cloud-copy-consent-body"
      >
        {audience === 'private' ? (
          <p>
            Your cloud chats get a private copy of this {subject.kind}, with the
            files listed here. Nothing is shared with a team, and it stays on
            this computer as it is.
          </p>
        ) : (
          <p data-testid="cloud-copy-consent-audience">
            Your cloud chats use the copy of this {subject.kind} you share with{' '}
            {SHARED_AUDIENCE_COPY[audience]}. The files listed here go to that
            copy, and it stays on this computer as it is.
          </p>
        )}
        {subject.kind === 'plugin' && (
          <p data-testid="cloud-copy-consent-plugin-note">
            Its hooks and MCP or LSP settings never go to the cloud.
          </p>
        )}
        <CapabilityPackageDependencies
          analysis={analysis}
          loading={loading}
          errored={analysisError !== null}
          errorReason={analysisError}
          selectedOptionalResourceIds={selectedOptionalResourceIds}
          onToggleOptionalResource={onToggleOptionalResource}
          onRetry={onRetry}
          subjectLabel={subject.kind}
          withheldCopy={WITHHELD_COPY}
          testIdPrefix="cloud-copy"
          disabled={adding}
        />
        {ready && sent.length > 0 && (
          <div
            className="flex flex-col gap-1.5"
            data-testid="cloud-copy-consent-sent"
          >
            <Heading level={4} variant="title">
              Sent
            </Heading>
            <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto text-xs">
              {sent.map((path) => (
                <li
                  key={path}
                  className="break-all fg-secondary"
                  data-testid="cloud-copy-consent-sent-item"
                >
                  {path}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </DialogModal>
  );
}
