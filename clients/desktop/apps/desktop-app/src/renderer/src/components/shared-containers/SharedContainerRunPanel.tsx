/**
 * Recipient run sheet for a shared container (CAN-2831).
 *
 * A sheet opened from the viewer header rather than a panel kind, so it needs
 * no allowlist entry and cannot be dragged, persisted, or restored into a
 * layout.
 *
 * The sheet has two distinct jobs and shows only one at a time. Before
 * consent it is a decision screen: what would run, and the one-line warning,
 * and nothing else. After consent it is a short to-do list: pick a command and
 * hit Run, with the environment and run-copy controls that support it.
 * Anything that cannot be acted on yet stays hidden rather than rendering
 * disabled — a greyed control reads as a broken feature, not as a locked one.
 *
 * It deliberately explains almost nothing. Running a command opens a terminal
 * pane in the run copy, so this sheet does not mirror command output, name the
 * run copy, or list withheld files: the recipient is looking at the live
 * terminal, and a wall of caveats here buried the one instruction that
 * matters. The single provenance fact that survives is a consent recorded
 * against a DIFFERENT publisher account than the share now shows, which is a
 * reason to revoke rather than a caption.
 *
 * The copy is written for what running actually is. Opening a share is
 * reading; running one executes code written by somebody else on this machine,
 * under this user account. The command list is context for that decision, not
 * a boundary around it — `npm run dev` alone reaches `postinstall` scripts and
 * build config the recipient never sees. That is why the consent modal still
 * says the listed commands are not a limit even though the sheet's own copy is
 * short. Nothing in this file may describe the published list as containment,
 * and nothing may imply the commands are sandboxed. They are not.
 */
import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import type {
  SharedContainerRepositorySummary,
  UserEnvironmentEntryView,
  UserEnvironmentUiMode,
} from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { getScriptDisplayName } from '@canopy/desktop-shared/scripts';
import type { SharedContainerRevisionRunCommand } from '@canopy/protocol/shared-containers';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { EnvironmentVariableEditor } from '@/components/environments/EnvironmentVariableEditor';
import { Button } from '@/components/shared/Button';
import { DeleteConfirmModal } from '@/components/shared/DeleteConfirmModal';
import { DialogModal } from '@/components/shared/DialogModal';
import { brandText } from '@/lib/brand';
import type { SharedContainerRunState } from './useSharedContainerRun';
import {
  Stack,
  Disclosure,
  ErrorBanner,
  Heading,
  FieldError,
  Surface,
} from '@canopy/ui-shared/components';

export interface SharedContainerRunPanelProps {
  run: SharedContainerRunState;
  /** Display name of the person who published the share, when resolved. */
  publisherName?: string;
  /** Owner user id recorded alongside the grant for later display and audit. */
  publisherUserId: string;
  /** Replica repositories, so a command's `repoId` can be shown by name. */
  repositories?: readonly SharedContainerRepositorySummary[];
  onClose: () => void;
}

/**
 * Where a published command runs, in the words the rest of the app uses.
 *
 * `repoId` is a wire value: the synthetic `__workspace_root__` sentinel, or a
 * publisher-side repo id that only means something once it is matched against
 * the recipient's own replica repositories. Neither is copy, so neither is
 * shown until it has been resolved to a name (falling back to the raw id only
 * when the replica list has not arrived).
 */
function runCommandLocationLabel(
  repoId: string,
  repositories: readonly SharedContainerRepositorySummary[],
): string {
  if (repoId === WORKSPACE_ROOT_REPO_ID) return 'Project root';
  return (
    repositories.find((repository) => repository.repoId === repoId)?.repoName ??
    repoId
  );
}

/**
 * One published command: its name, and everything else behind a disclosure.
 *
 * The name is the only thing a recipient needs to pick between commands, and
 * it is the one part written by a human. The shell string and the folder are
 * reference material — worth a click when someone wants it, noise in the way
 * of the decision otherwise.
 *
 * Note this collapses the shell strings on the pre-consent screen too, where
 * they are the context for the decision. That is deliberate: the sheet's own
 * warning and the consent modal both state that the listed commands are not a
 * limit on what runs, so the strings inform the choice without bounding it.
 */
function SharedContainerRunCommandRow({
  command,
  locationLabel,
  showRun,
  runDisabled,
  onRun,
}: {
  command: SharedContainerRevisionRunCommand;
  locationLabel: string;
  showRun: boolean;
  runDisabled: boolean;
  onRun: () => void;
}): JSX.Element {
  return (
    <Surface
      as="li"
      variant="outline"
      size="small"
      data-testid={`shared-container-run-command-${command.name}`}
    >
      <div className="px-2 py-1.5">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-s font-medium fg-primary">
            {getScriptDisplayName(command.name)}
          </p>
          {showRun && (
            <Button
              variant="outline"
              size="sm"
              data-testid={`shared-container-run-command-start-${command.name}`}
              disabled={runDisabled}
              onClick={onRun}
            >
              Run
            </Button>
          )}
        </div>
        <Disclosure
          label="Details"
          dataTestId={`shared-container-run-command-disclosure-${command.name}`}
          toggleTestId={`shared-container-run-command-details-${command.name}`}
        >
          {/* The body keeps its own test id, which specs key on. */}
          <div
            className="flex flex-col gap-0.5"
            data-testid={`shared-container-run-command-details-body-${command.name}`}
          >
            <p
              className={`${POSTHOG_REPLAY_BLOCK_CLASS} break-all font-mono text-xs fg-secondary`}
            >
              {command.command}
            </p>
            <p className="text-xs fg-quaternary">{`Runs in ${locationLabel}`}</p>
          </div>
        </Disclosure>
      </div>
    </Surface>
  );
}

export function SharedContainerRunPanel({
  run,
  publisherName,
  publisherUserId,
  repositories = [],
  onClose,
}: SharedContainerRunPanelProps): JSX.Element | null {
  const [confirming, setConfirming] = useState<
    'allow' | 'revoke' | 'refresh' | null
  >(null);
  const [draft, setDraft] = useState<UserEnvironmentEntryView[]>([]);
  const [envInvalid, setEnvInvalid] = useState<string | null>(null);
  const [envMode, setEnvMode] = useState<UserEnvironmentUiMode>('key-value');
  const status = run.status;
  const storedValues = status?.values;

  // The stored values are authoritative. Adopting them whenever they change
  // keeps the editor from drifting after "Add placeholders" or a save, both of
  // which return normalized entries that may differ from what was typed.
  useEffect(() => {
    setDraft(storedValues ? [...storedValues] : []);
  }, [storedValues]);

  // "Unset" is derived by main against the env it will actually pass to the
  // process, never stored, so these two lists are read straight off the status
  // rather than recomputed here.
  const unsetNames = useMemo(
    () => status?.unsetRequiredEnv ?? [],
    [status?.unsetRequiredEnv],
  );
  const requiredNames = useMemo(
    () => status?.run?.requiredEnv ?? [],
    [status?.run?.requiredEnv],
  );
  const setNames = useMemo(
    () => requiredNames.filter((name) => !unsetNames.includes(name)),
    [requiredNames, unsetNames],
  );

  if (run.availability !== 'available' || !status?.run) return null;

  const allowed = status.allowed;
  // The publisher's name, and another publisher's account id, identify a
  // person: replay records a box for each. The generic fallback is recorded.
  const publisherLabel: ReactNode =
    publisherName === undefined ? (
      'the person who shared this'
    ) : (
      <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{publisherName}</span>
    );
  const consentedPublisherId = status.publisherUserId;
  const publisherMismatch =
    consentedPublisherId !== undefined &&
    consentedPublisherId !== publisherUserId;

  return (
    <DialogModal
      onClose={onClose}
      title="Run this share"
      maxWidth="lg"
      dataTestId="shared-container-run-panel"
    >
      <Stack gap="group">
        <p className="text-s fg-secondary">
          {allowed ? (
            publisherMismatch ? (
              <>
                You allowed publisher account{' '}
                <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                  {consentedPublisherId}
                </span>{' '}
                to run code here, not {publisherLabel}. Turn running off if that
                is wrong.
              </>
            ) : (
              'Pick a command below and hit Run.'
            )
          ) : (
            <>
              Runs {publisherLabel}&apos;s code on this device, with your files
              and your permissions. {brandText.appName} does not sandbox it.
            </>
          )}
        </p>

        <section
          className="flex flex-col gap-1.5"
          data-testid="shared-container-run-commands"
        >
          <Heading level={3} variant="label">
            Published commands
          </Heading>
          {status.run.commands.length === 0 ? (
            <p className="text-xs fg-secondary">
              {publisherLabel} did not publish any commands.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {status.run.commands.map((command) => (
                <SharedContainerRunCommandRow
                  key={command.name}
                  command={command}
                  locationLabel={runCommandLocationLabel(
                    command.repoId,
                    repositories,
                  )}
                  showRun={allowed}
                  runDisabled={
                    run.pending ||
                    run.commandPending ||
                    status.runCopyNeedsRefresh
                  }
                  onRun={(): void => {
                    // Dispatch and dismiss, in that order and without
                    // awaiting: `runScript` resolves when the command
                    // FINISHES, not when it starts, so gating the close on it
                    // left the sheet covering the terminal for the whole run.
                    // The terminal opens immediately and is what the recipient
                    // needs to watch. A refusal still reaches them:
                    // `runCommand` raises a toast, which outlives the
                    // dismissed sheet.
                    void run.runCommand(command.name);
                    onClose();
                  }}
                />
              ))}
            </ul>
          )}
        </section>

        {allowed && requiredNames.length > 0 && (
          <section
            className="flex flex-col gap-1.5"
            data-testid="shared-container-run-environment"
          >
            <Heading level={3} variant="label">
              Environment variables
            </Heading>
            <>
              <p className="text-xs fg-secondary">
                Names {publisherLabel} listed, as a hint. Values are never
                shared and the list may be incomplete.
              </p>
              {unsetNames.length > 0 && (
                <p
                  className="break-all text-xs fg-secondary"
                  data-testid="shared-container-run-env-unset"
                >
                  {`Not set yet: ${unsetNames.join(', ')}`}
                </p>
              )}
              {setNames.length > 0 && (
                <p
                  className="break-all text-xs fg-secondary"
                  data-testid="shared-container-run-env-set"
                >
                  {`Set: ${setNames.join(', ')}`}
                </p>
              )}
              {unsetNames.length > 0 && (
                <Button
                  className="self-start"
                  variant="outline"
                  size="sm"
                  data-testid="shared-container-run-env-placeholders"
                  disabled={run.pending}
                  onClick={(): void => {
                    void run.addPlaceholders();
                  }}
                >
                  Add placeholders
                </Button>
              )}
              <EnvironmentVariableEditor
                variables={draft}
                uiMode={envMode}
                encryptionAvailable
                readOnly={run.pending}
                testId="shared-container-run-env-editor"
                onVariablesChange={setDraft}
                onUiModeChange={setEnvMode}
                onValidationChange={setEnvInvalid}
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="shared-container-run-env-save"
                  disabled={run.pending || envInvalid !== null}
                  onClick={(): void => {
                    void run.saveEnvironment(draft);
                  }}
                >
                  Save values
                </Button>
                {envInvalid !== null && (
                  <FieldError id="shared-container-run-env-error">
                    {envInvalid}
                  </FieldError>
                )}
              </div>
            </>
          </section>
        )}

        {allowed && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="shared-container-run-refresh"
              disabled={run.pending}
              onClick={(): void => {
                if (status.hasRunningProcesses) setConfirming('refresh');
                else void run.refreshRunCopy();
              }}
            >
              Update run copy
            </Button>
            <span className="text-xs fg-secondary">
              {status.runCopyNeedsRefresh && (
                <strong
                  className="font-medium fg-primary"
                  data-testid="shared-container-run-update-available"
                >
                  {'New version available. '}
                </strong>
              )}
              Updating replaces shared files with the latest version, even ones
              you changed. Files you added stay.
            </span>
          </div>
        )}

        <ErrorBanner
          errorSource="shared-container-run-error"
          className=""
          error={run.error}
          testId="shared-container-run-error"
        />

        <div className="flex justify-end gap-2">
          {allowed && (
            <Button
              variant="outline"
              size="lg"
              data-testid="shared-container-run-revoke"
              disabled={run.pending}
              onClick={(): void => setConfirming('revoke')}
            >
              Turn off running
            </Button>
          )}
          <Button variant="outline" size="lg" onClick={onClose}>
            Close
          </Button>
          {!allowed && (
            <Button
              variant="primary"
              size="lg"
              data-testid="shared-container-run-allow"
              disabled={run.pending || publisherUserId.length === 0}
              onClick={(): void => setConfirming('allow')}
            >
              Allow this share to run
            </Button>
          )}
        </div>
      </Stack>

      {confirming === 'allow' && (
        <DeleteConfirmModal
          title="Allow this share to run code?"
          message={
            <p className="text-s fg-secondary">
              This runs {publisherLabel}&apos;s code on this device, as you. It
              can read and change your files, and {brandText.appName} does not
              sandbox it. The commands listed are not a limit on what runs. You
              can turn this off at any time.
            </p>
          }
          confirmLabel="Allow"
          pendingLabel="Allowing…"
          confirmTone="primary"
          pending={run.pending}
          dataTestId="shared-container-run-allow-modal"
          confirmTestId="shared-container-run-allow-confirm"
          onCancel={(): void => setConfirming(null)}
          onConfirm={(): void => {
            void run.allowRun(publisherUserId).then((ok) => {
              if (ok) setConfirming(null);
            });
          }}
        />
      )}
      {confirming === 'revoke' && (
        <DeleteConfirmModal
          title="Turn off running for this share?"
          message="Anything still running stops, terminal tabs close, and the published commands become unavailable until you allow running again. The shared files stay where they are."
          confirmLabel="Turn off"
          pendingLabel="Turning off…"
          pending={run.pending}
          dataTestId="shared-container-run-revoke-modal"
          confirmTestId="shared-container-run-revoke-confirm"
          onCancel={(): void => setConfirming(null)}
          onConfirm={(): void => {
            void run.revokeRun().then((ok) => {
              if (ok) setConfirming(null);
            });
          }}
        />
      )}
      {confirming === 'refresh' && (
        <DeleteConfirmModal
          title="Stop running processes and update?"
          message="Updating first stops every command and terminal for this share. It then replaces shared paths with the publisher's latest files; files you created yourself remain."
          confirmLabel="Stop and update"
          pendingLabel="Stopping and updating…"
          pending={run.pending}
          dataTestId="shared-container-run-refresh-modal"
          confirmTestId="shared-container-run-refresh-confirm"
          onCancel={(): void => setConfirming(null)}
          onConfirm={(): void => {
            void run.refreshRunCopy({ stopRunning: true }).then((ok) => {
              if (ok) setConfirming(null);
            });
          }}
        />
      )}
    </DialogModal>
  );
}
