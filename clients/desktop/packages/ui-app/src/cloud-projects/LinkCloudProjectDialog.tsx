import { useEffect, useState, type JSX, type ReactNode } from 'react';
import {
  Button,
  ChoiceList,
  ChoiceListRow,
  DialogModal,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/**
 * Links a local project to its cloud project (CAN-5190), so the user's other
 * computers know it as the same project. Presentational: the host finds the
 * candidates, runs the link and owns the busy state and the error. A
 * multi-repository or remote-less project binds only through this choice.
 */

const TITLE = 'Link to cloud project';
const NEW_PROJECT_LABEL = 'New cloud project';
const CANCEL_LABEL = 'Cancel';
const CLOSE_LABEL = 'Close';
const LINK_LABEL = 'Link';
const LINK_BUSY_LABEL = 'Linking…';

export interface LinkCloudProjectCandidate {
  readonly projectId: string;
  readonly name: string;
  readonly matchedRepositories: number;
  readonly totalRepositories: number;
}

export type LinkCloudProjectUnavailableReason =
  | 'signed-out'
  | 'not-supported'
  | 'sharing-off'
  | 'not-personal'
  | 'workspace-unreadable'
  | 'offline';

export type LinkCloudProjectState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'linked'; readonly cloudProjectName: string }
  | {
      readonly kind: 'choose';
      readonly candidates: readonly LinkCloudProjectCandidate[];
      readonly suggestedProjectId: string | null;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: LinkCloudProjectUnavailableReason;
    };

export type LinkCloudProjectErrorCode =
  | 'unavailable'
  | 'not-personal'
  | 'workspace-unreadable'
  | 'project-unavailable'
  | 'too-many-setups'
  | 'busy'
  | 'offline'
  | 'link-failed';

export type LinkCloudProjectTarget =
  | { readonly kind: 'existing'; readonly projectId: string }
  | { readonly kind: 'new' };

export interface LinkCloudProjectDialogProps {
  readonly projectName: string;
  readonly state: LinkCloudProjectState;
  /** True while the link is in flight. */
  readonly busy?: boolean;
  readonly error?: LinkCloudProjectErrorCode | null;
  readonly onLink: (target: LinkCloudProjectTarget) => void;
  readonly onCancel: () => void;
  readonly dataTestId?: string;
}

/**
 * Why the dialog cannot offer a link right now. `projectName` is rendered as
 * given, so the dialog passes it already masked for session replay.
 */
export function linkCloudProjectUnavailableMessage(
  reason: LinkCloudProjectUnavailableReason,
  projectName: ReactNode,
): ReactNode {
  switch (reason) {
    case 'signed-out':
      return 'Sign in to link projects.';
    case 'not-supported':
      return "Linking projects isn't available for your account yet.";
    case 'sharing-off':
      return 'Turn on Show my Personal projects on the web in Privacy settings to link projects.';
    case 'not-personal':
      return <>{projectName} belongs to an organization.</>;
    case 'workspace-unreadable':
      return <>{projectName}&apos;s project settings could not be read.</>;
    case 'offline':
      return "Couldn't reach your cloud projects. Check your connection and try again.";
  }
}

/** The inline sentence for a link that did not happen. */
export function linkCloudProjectErrorMessage(
  code: LinkCloudProjectErrorCode,
  projectName: string,
): string {
  switch (code) {
    case 'unavailable':
      return `Couldn't link ${projectName}. Linking projects isn't available right now.`;
    case 'not-personal':
      return `${projectName} belongs to an organization.`;
    case 'workspace-unreadable':
      return `Couldn't link ${projectName}. Its project settings could not be read.`;
    case 'project-unavailable':
      return `Couldn't link ${projectName}. That cloud project is no longer available.`;
    case 'too-many-setups':
      return `Couldn't link ${projectName}. Your account has too many active project setups.`;
    case 'busy':
      return `${projectName} is already being linked. Wait for that to finish.`;
    case 'offline':
      return `Couldn't link ${projectName}. Check your connection and try again.`;
    case 'link-failed':
      return `Couldn't link ${projectName}. Try again.`;
  }
}

function matchedLabel(candidate: LinkCloudProjectCandidate): string {
  const total = candidate.totalRepositories;
  return `${candidate.matchedRepositories} of ${total} ${total === 1 ? 'repository' : 'repositories'}`;
}

const NEW_TARGET = 'new';

export function LinkCloudProjectDialog({
  projectName,
  state,
  busy = false,
  error = null,
  onLink,
  onCancel,
  dataTestId = 'link-cloud-project-dialog',
}: LinkCloudProjectDialogProps): JSX.Element {
  const suggested =
    state.kind === 'choose'
      ? (state.suggestedProjectId ?? NEW_TARGET)
      : NEW_TARGET;
  const [selected, setSelected] = useState(suggested);
  // A fresh list starts from its suggestion.
  useEffect(() => {
    setSelected(suggested);
  }, [suggested]);
  const close = busy ? (): void => {} : onCancel;
  const choosing = state.kind === 'choose';

  return (
    <DialogModal
      inset="flush"
      onClose={close}
      title={TITLE}
      maxWidth="sm"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeButtonDisabled={busy}
      dataTestId={dataTestId}
      trapFocus
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onCancel}
            disabled={busy}
            data-testid="link-cloud-project-cancel"
          >
            {choosing ? CANCEL_LABEL : CLOSE_LABEL}
          </Button>
          {choosing ? (
            <Button
              variant="primary"
              onClick={(): void => {
                onLink(
                  selected === NEW_TARGET
                    ? { kind: 'new' }
                    : { kind: 'existing', projectId: selected },
                );
              }}
              disabled={busy}
              data-testid="link-cloud-project-link"
            >
              {busy ? LINK_BUSY_LABEL : LINK_LABEL}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-3 px-6 py-4">
        {state.kind === 'loading' ? (
          <p
            className="text-s fg-secondary"
            data-testid="link-cloud-project-loading"
          >
            Finding your cloud projects…
          </p>
        ) : null}
        {state.kind === 'linked' ? (
          <p
            className="text-s fg-secondary"
            data-testid="link-cloud-project-linked"
          >
            <span className={REPLAY_MASK_CLASS}>{projectName}</span>
            {state.cloudProjectName === projectName ? (
              ' is linked to its cloud project.'
            ) : (
              <>
                {' '}
                is linked to the cloud project{' '}
                <span className={REPLAY_MASK_CLASS}>
                  {state.cloudProjectName}
                </span>
                .
              </>
            )}
          </p>
        ) : null}
        {state.kind === 'unavailable' ? (
          <p
            className="text-s fg-secondary"
            data-testid="link-cloud-project-unavailable"
          >
            {linkCloudProjectUnavailableMessage(
              state.reason,
              <span className={REPLAY_MASK_CLASS}>{projectName}</span>,
            )}
          </p>
        ) : null}
        {state.kind === 'choose' ? (
          <>
            <p className="text-s fg-secondary">
              Choose the cloud project{' '}
              <span className={REPLAY_MASK_CLASS}>{projectName}</span> belongs
              to, so your other computers know it as the same project.
            </p>
            {/* The list scrolls inside this height; ChoiceList owns its edge. */}
            <div className="flex max-h-72 min-h-0 flex-col">
              <ChoiceList
                aria-label="Cloud project"
                kind="radio"
                data-testid="link-cloud-project-choices"
              >
                {state.candidates.map((candidate) => (
                  <ChoiceListRow
                    key={candidate.projectId}
                    kind="radio"
                    selected={selected === candidate.projectId}
                    disabled={busy}
                    onClick={(): void => setSelected(candidate.projectId)}
                    trailing={matchedLabel(candidate)}
                    data-testid={`link-cloud-project-choice-${candidate.projectId}`}
                  >
                    <span className={REPLAY_MASK_CLASS}>{candidate.name}</span>
                  </ChoiceListRow>
                ))}
                <ChoiceListRow
                  kind="radio"
                  selected={selected === NEW_TARGET}
                  disabled={busy}
                  onClick={(): void => setSelected(NEW_TARGET)}
                  data-testid="link-cloud-project-choice-new"
                >
                  {NEW_PROJECT_LABEL}
                </ChoiceListRow>
              </ChoiceList>
            </div>
          </>
        ) : null}
        {error !== null ? (
          <ErrorBanner
            errorSource="link-cloud-project-error"
            className=""
            // The sentence names the user-authored project.
            blockMessageFromReplay
            testId="link-cloud-project-error"
            error={linkCloudProjectErrorMessage(error, projectName)}
          />
        ) : null}
      </div>
    </DialogModal>
  );
}
