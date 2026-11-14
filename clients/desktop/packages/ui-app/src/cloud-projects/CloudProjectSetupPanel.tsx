import type { JSX } from 'react';
import { Button, EmptyState, Notice } from '@canopy/ui-shared';
import {
  ChoiceList,
  ChoiceListRow,
  DialogFormField,
  Surface,
} from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';

/**
 * Set up one of the account's cloud projects on this computer (CAN-5192):
 * the list of projects from the user's other computers, then the repositories
 * to clone and where. Presentational: the host reads the catalog and the
 * project's repositories, runs the setup and reports its progress. Nothing is
 * cloned until the user picks Set up, and only the repositories they kept.
 */

export interface CloudProjectSetupListEntry {
  readonly projectId: string;
  readonly name: string;
  readonly repositoryCount: number;
  readonly state: 'available' | 'setting-up' | 'here' | 'needs-attention';
  /** Repositories added on another computer that this one has not taken. */
  readonly offeredRepositoryCount: number;
  /** Why a setup here stopped; set only with `needs-attention`. */
  readonly errorCode?: CloudProjectSetupErrorCode;
}

export interface CloudProjectSetupRepository {
  readonly repositoryId: string;
  readonly name: string;
  readonly remoteKey: string;
  readonly root: boolean;
}

export type CloudProjectSetupUnavailableReason =
  | 'signed-out'
  | 'not-supported'
  | 'sharing-off'
  | 'offline'
  | 'project-unavailable';

export type CloudProjectSetupErrorCode =
  | 'unavailable'
  | 'already-here'
  | 'busy'
  | 'setup-limit'
  | 'invalid-selection'
  | 'destination-exists'
  | 'needs-credentials'
  | 'clone-failed'
  | 'checkout-blocked'
  | 'checkout-changed'
  | 'workspace-id-in-use'
  | 'project-unavailable'
  | 'offline'
  | 'completion-pending'
  | 'setup-failed';

/**
 * The setup in flight: the repository being cloned, or null once every
 * clone is done and the setup is finishing.
 */
export interface CloudProjectSetupProgressLine {
  readonly repository: {
    readonly name: string;
    readonly index: number;
    readonly count: number;
    readonly percent?: number;
  } | null;
}

export type CloudProjectSetupPanelState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'unavailable';
      readonly reason: CloudProjectSetupUnavailableReason;
    }
  | {
      readonly kind: 'list';
      readonly projects: readonly CloudProjectSetupListEntry[];
    }
  | {
      readonly kind: 'choose';
      readonly projectName: string;
      readonly repositories: readonly CloudProjectSetupRepository[];
      readonly selectedIds: readonly string[];
      readonly destinationRoot: string | null;
      readonly busy: boolean;
      /** The setup in flight, shown as one line such as `Cloning api (1 of 2)…`. */
      readonly progress: CloudProjectSetupProgressLine | null;
      readonly error: CloudProjectSetupErrorCode | null;
    };

export interface CloudProjectSetupPanelProps {
  readonly state: CloudProjectSetupPanelState;
  readonly onChoose: (projectId: string) => void;
  readonly onBack: () => void;
  readonly onToggleRepository: (repositoryId: string) => void;
  readonly onChangeDestination: () => void;
  readonly onStart: () => void;
}

function repositories(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`;
}

/** Why the list cannot be shown right now. */
export function cloudProjectSetupUnavailableMessage(
  reason: CloudProjectSetupUnavailableReason,
): string {
  switch (reason) {
    case 'signed-out':
      return 'Sign in to see projects from your other computers.';
    case 'not-supported':
      return "Projects from your other computers aren't available for your account yet.";
    case 'sharing-off':
      return 'Turn on Show my Personal projects on the web in Privacy settings to see projects from your other computers.';
    case 'offline':
      return "Couldn't reach your cloud projects. Check your connection and try again.";
    case 'project-unavailable':
      return 'That project is no longer available.';
  }
}

/** The sentence under the form for a setup that did not finish. */
export function cloudProjectSetupErrorMessage(
  code: CloudProjectSetupErrorCode,
  projectName: string,
): string {
  switch (code) {
    case 'unavailable':
      return `Couldn't set up ${projectName}. Setting up projects isn't available right now.`;
    case 'already-here':
      return `${projectName} is already on this computer.`;
    case 'busy':
      return `${projectName} is already being set up. Wait for that to finish.`;
    case 'setup-limit':
      return `Couldn't set up ${projectName}. Your account has too many project setups. Contact support to remove ones you no longer use.`;
    case 'invalid-selection':
      return 'Choose at least one repository.';
    case 'destination-exists':
      return `Couldn't set up ${projectName}. Its folder already exists there. Choose another folder.`;
    case 'needs-credentials':
      return `Couldn't clone ${projectName}. Check that your Git credentials can reach its repositories.`;
    case 'clone-failed':
      return `Couldn't clone ${projectName}. Try again.`;
    case 'checkout-blocked':
      return `Couldn't set up ${projectName}. Its root repository has a file or link where another of its repositories goes.`;
    case 'checkout-changed':
      return `Couldn't finish setting up ${projectName}. Its folder changed after its repositories were cloned. Set it up again in another folder.`;
    case 'workspace-id-in-use':
      return `Couldn't finish setting up ${projectName}. Another project on this computer took its place while it was being set up. Set it up again in another folder.`;
    case 'project-unavailable':
      return `Couldn't set up ${projectName}. That cloud project is no longer available.`;
    case 'offline':
      return `Couldn't set up ${projectName}. Check your connection and try again.`;
    case 'completion-pending':
      return `${projectName} is on this computer. It finishes linking the next time you're online.`;
    case 'setup-failed':
      return `Couldn't set up ${projectName}. Try again.`;
  }
}

function ProgressLine({
  progress,
}: {
  readonly progress: CloudProjectSetupProgressLine;
}): JSX.Element {
  const { repository } = progress;
  if (repository === null) return <>Finishing setup…</>;
  const percent =
    repository.percent === undefined
      ? ''
      : ` ${Math.round(repository.percent)}%`;
  return (
    <>
      Cloning <span className={REPLAY_MASK_CLASS}>{repository.name}</span> (
      {repository.index + 1} of {repository.count})…{percent}
    </>
  );
}

function entryStatus(entry: CloudProjectSetupListEntry): string {
  if (entry.state === 'setting-up') return 'Setting up…';
  if (entry.state === 'needs-attention')
    switch (entry.errorCode) {
      case 'checkout-changed':
        return 'Setup stopped. Its folder changed after its repositories were cloned.';
      case 'workspace-id-in-use':
        return 'Setup stopped. Another project on this computer took its place.';
      default:
        return 'Setup stopped.';
    }
  if (entry.state === 'here')
    return entry.offeredRepositoryCount > 0
      ? `On this computer · ${repositories(entry.offeredRepositoryCount)} not added`
      : 'On this computer';
  return repositories(entry.repositoryCount);
}

function ProjectList({
  projects,
  onChoose,
}: {
  readonly projects: readonly CloudProjectSetupListEntry[];
  readonly onChoose: (projectId: string) => void;
}): JSX.Element {
  if (projects.length === 0)
    return (
      <EmptyState
        title="Nothing to set up yet"
        subtitle="Projects you add on your other computers show here."
      />
    );
  return (
    <Surface as="ul" variant="outline" data-testid="cloud-project-setup-list">
      {projects.map((entry) => (
        <li
          key={entry.projectId}
          className="flex items-center gap-3 px-3 py-2"
          data-testid={`cloud-project-setup-row-${entry.projectId}`}
        >
          <div className="min-w-0 flex-1">
            <p className={`truncate text-s fg-primary ${REPLAY_MASK_CLASS}`}>
              {entry.name}
            </p>
            <p className="text-xs fg-secondary">{entryStatus(entry)}</p>
          </div>
          {entry.state === 'available' || entry.state === 'needs-attention' ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={(): void => onChoose(entry.projectId)}
              data-testid={`cloud-project-setup-choose-${entry.projectId}`}
            >
              {entry.state === 'available' ? 'Set up' : 'Set up again'}
            </Button>
          ) : null}
        </li>
      ))}
    </Surface>
  );
}

export function CloudProjectSetupPanel({
  state,
  onChoose,
  onBack,
  onToggleRepository,
  onChangeDestination,
  onStart,
}: CloudProjectSetupPanelProps): JSX.Element {
  if (state.kind === 'loading')
    return (
      <p
        className="text-s fg-secondary"
        data-testid="cloud-project-setup-loading"
      >
        Finding your cloud projects…
      </p>
    );
  if (state.kind === 'unavailable')
    return (
      <p
        className="text-s fg-secondary"
        data-testid="cloud-project-setup-unavailable"
      >
        {cloudProjectSetupUnavailableMessage(state.reason)}
      </p>
    );
  if (state.kind === 'list')
    return (
      <div className="flex flex-col gap-3" data-testid="cloud-project-setup">
        <p className="text-s fg-secondary">
          Set up a project you use on another computer. You choose which of its
          repositories to clone.
        </p>
        <ProjectList projects={state.projects} onChoose={onChoose} />
      </div>
    );
  const selected = new Set(state.selectedIds);
  // A project root is always cloned, so its row carries the selection on its
  // own. With none kept, there is nothing to set up: Set up is off and the
  // panel asks for a repository instead of letting the user press it and read
  // a failure (CAN-5192 round 6).
  const nothingSelected = !state.repositories.some(
    (repository) => repository.root || selected.has(repository.repositoryId),
  );
  const notice = nothingSelected ? 'invalid-selection' : state.error;
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="cloud-project-setup-choose"
    >
      <p className="text-s fg-primary">
        Set up <span className={REPLAY_MASK_CLASS}>{state.projectName}</span>
      </p>
      <div className="flex max-h-72 min-h-0 flex-col">
        <ChoiceList
          aria-label="Repositories"
          data-testid="cloud-project-setup-repositories"
        >
          {state.repositories.map((repository) => (
            <ChoiceListRow
              key={repository.repositoryId}
              selected={
                repository.root || selected.has(repository.repositoryId)
              }
              disabled={state.busy || repository.root}
              onClick={(): void => onToggleRepository(repository.repositoryId)}
              trailing={repository.root ? 'Project root' : undefined}
              data-testid={`cloud-project-setup-repository-${repository.repositoryId}`}
            >
              <span className={`block truncate ${REPLAY_MASK_CLASS}`}>
                {repository.name}
              </span>
              {/* `host/owner/name` names the account and its private repository. */}
              <span
                className={`block truncate text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
              >
                {repository.remoteKey}
              </span>
            </ChoiceListRow>
          ))}
        </ChoiceList>
      </div>
      <DialogFormField
        label="Destination folder"
        htmlFor="cloud-project-setup-destination"
      >
        <Button
          id="cloud-project-setup-destination"
          data-testid="cloud-project-setup-destination"
          variant="secondary"
          disabled={state.busy}
          onClick={onChangeDestination}
          className="w-full justify-between text-left"
        >
          {/* A local path names the user's account folder; its tooltip too. */}
          <span
            className={`min-w-0 truncate font-mono ${state.destinationRoot === null ? '' : REPLAY_BLOCK_CLASS}`}
            dir="rtl"
            title={state.destinationRoot ?? undefined}
          >
            <bdi dir="ltr">{state.destinationRoot ?? 'Choose folder'}</bdi>
          </span>
          <span className="shrink-0 fg-secondary">Change</span>
        </Button>
      </DialogFormField>
      <p className="text-s fg-secondary">
        Cloned with your Git credentials. No scripts run until you open a task.
      </p>
      {state.progress !== null ? (
        <p
          role="status"
          className="text-s fg-secondary"
          data-testid="cloud-project-setup-progress"
        >
          <ProgressLine progress={state.progress} />
        </p>
      ) : null}
      {notice !== null ? (
        <Notice
          errorSource="cloud-project-setup-error"
          // What to choose next, not a failure: a hint carries no alert and
          // records no surfaced error.
          intent={
            notice === 'completion-pending' || notice === 'invalid-selection'
              ? 'neutral'
              : 'destructive'
          }
          data-testid="cloud-project-setup-error"
        >
          <span className={REPLAY_BLOCK_CLASS}>
            {cloudProjectSetupErrorMessage(notice, state.projectName)}
          </span>
        </Notice>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={onBack}
          disabled={state.busy}
          data-testid="cloud-project-setup-back"
        >
          Back
        </Button>
        <Button
          variant="primary"
          onClick={onStart}
          disabled={
            state.busy || state.destinationRoot === null || nothingSelected
          }
          data-testid="cloud-project-setup-start"
        >
          {state.busy ? 'Setting up…' : 'Set up'}
        </Button>
      </div>
    </div>
  );
}
