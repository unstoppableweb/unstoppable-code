import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import {
  OrgProjectRelationshipNotice,
  type OrgProjectRelationshipActions,
} from './OrgProjectRelationshipNotice';
import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type JSX,
} from 'react';
import {
  Button,
  DialogFormField,
  DialogModal,
  Fact,
  FactList,
} from '@canopy/ui-shared/components';
import type {
  OrgProjectPlaceholderState,
  OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import { CHAT_LABEL } from '@canopy/protocol';
import { ORG_PROJECT_STATE_TEXT } from './orgProjectStateText';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';

interface OrgProjectSetupDialogProps {
  relationship?: OrgProjectRelationshipActions;
  project: OrgProjectSummary;
  state?: OrgProjectPlaceholderState;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  unfinished?: boolean;
  /** `destinationRoot` is omitted for a Cowork project, which clones nothing. */
  onStart: (projectId: string, destinationRoot?: string) => Promise<void>;
  /**
   * Set up a Code project that has no GitHub repository from the member's own
   * folder (CAN-3534). The folder is bound in place; nothing is cloned.
   */
  onStartFromFolder: (projectId: string, path: string) => Promise<void>;
  onClose: () => void;
}

/** Desktop-only consent and destination UI over the existing setup coordinator. */
export function OrgProjectSetupDialog({
  project,
  relationship,
  state = 'ready-to-set-up',
  restoreFocusRef,
  unfinished = false,
  onStart,
  onStartFromFolder,
  onClose,
}: OrgProjectSetupDialogProps): JSX.Element {
  const [separate, setSeparate] = useState(false);
  const [destination, setDestination] = useState('');
  const [loaded, setLoaded] = useState(false);
  const pending = useRef(false);
  const closed = useRef(false);
  const [error, setError] = useState<InlineFailure | null>(null);
  const canStart = state === 'ready-to-set-up' && !unfinished;
  // A Cowork project has no repository, branch or destination (CAN-3453):
  // setup creates an empty project on this computer.
  const cowork = project.kind === 'COWORK';
  // A member's Code project with no GitHub repository (CAN-3534) has nothing
  // to clone and so no destination: the member points at its folder instead.
  const withoutRepository = cowork === false && project.repository === null;
  const canChooseFolder = state === 'choose-folder' && !unfinished;
  const latestEligibility = useRef(false);
  useLayoutEffect((): void => {
    latestEligibility.current =
      project.capabilities.use &&
      (canChooseFolder ||
        (canStart && (cowork || Boolean(project.repository))));
  }, [
    canStart,
    canChooseFolder,
    cowork,
    project.repository,
    project.capabilities.use,
  ]);
  const close = (): void => {
    closed.current = true;
    onClose();
  };
  // Opened from a sidebar row, with no navigable route: this modal has no
  // NavigationPage or navigation.go_to_page target.
  useCurrentUiStateReporter('orgProjectSetup.modal', {
    open: true,
    projectId: project.id,
    name: project.name,
    state,
    kind: project.kind,
    canStart:
      canStart &&
      (cowork ||
        (loaded && Boolean(destination) && Boolean(project.repository))),
  });
  useEffect((): (() => void) => {
    closed.current = false;
    let active = true;
    // Neither clones, so neither reads the remembered destination.
    if (cowork || withoutRepository) {
      setLoaded(true);
      return (): void => {
        active = false;
        closed.current = true;
      };
    }
    void window.api
      .loadPreferences()
      .then((preferences): void => {
        if (!active) return;
        if (preferences.__error) {
          setError({ error: 'Choose a destination folder to continue' });
        } else {
          setDestination(preferences.orgProjectDefaultDestinationRoot ?? '');
        }
        setLoaded(true);
      })
      .catch((): void => {
        if (active) {
          setError({ error: 'Choose a destination folder to continue' });
          setLoaded(true);
        }
      });
    return (): void => {
      active = false;
      closed.current = true;
    };
  }, [cowork, withoutRepository]);
  const perform = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setError(null);
    try {
      await action();
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && !closed.current)
        setError(inlineFailure(appError, "Couldn't set up the project."));
    } finally {
      pending.current = false;
    }
  };
  const browse = (): void => {
    void perform(async (): Promise<void> => {
      const result = await window.api.browseForCloneDirectory();
      if (result.canceled || !result.directoryPath) return;
      await window.api.savePreferences({
        orgProjectDefaultDestinationRoot: result.directoryPath,
      });
      setDestination(result.directoryPath);
    });
  };
  return (
    <DialogModal
      title={`Set up ${project.name}`}
      dataTestId="org-project-setup-dialog"
      onClose={close}
      trapFocus
      restoreFocusRef={restoreFocusRef}
      closeOnBackdrop
      closeOnEscape
      showCloseButton
    >
      <div className="flex flex-col gap-4">
        {relationship && separate === false && (
          <OrgProjectRelationshipNotice
            actions={relationship}
            onSetupSeparately={(): void => setSeparate(true)}
          />
        )}
        {cowork === false && project.repository && (
          <FactList layout="stacked" size="s" rowGap="2" labelTone="secondary">
            <Fact
              label="Repository"
              fit="truncate"
              title={`${project.repository.owner}/${project.repository.name}`}
            >
              {project.repository.owner}/{project.repository.name}
            </Fact>
            <Fact
              label="Default branch"
              fit="truncate"
              mono
              title={project.repository.defaultBranch ?? undefined}
            >
              {project.repository.defaultBranch}
            </Fact>
          </FactList>
        )}
        {cowork ? (
          <p
            className="text-s fg-secondary"
            data-testid="org-project-setup-cowork-disclosure"
          >
            {`Creates an empty ${CHAT_LABEL} project on this computer. Chats stay on this computer.`}
          </p>
        ) : withoutRepository ? (
          // Offline or without access there is no folder to ask for yet: the
          // status line below says why, and no destination is offered either.
          state === 'choose-folder' && (
            <p
              className="text-s fg-secondary"
              data-testid="org-project-setup-folder-disclosure"
            >
              This project has no GitHub repository to clone. Choose its folder
              on this computer. Its files stay where they are.
            </p>
          )
        ) : (
          <>
            <DialogFormField
              label="Destination folder"
              htmlFor="org-project-setup-destination"
            >
              <Button
                id="org-project-setup-destination"
                data-testid="org-project-setup-destination"
                variant="secondary"
                disabled={!loaded}
                onClick={browse}
                // A path is long and its tail is the part that identifies it, so
                // the control keeps one line and truncates from the left rather
                // than wrapping a temp directory across the dialog.
                className="w-full justify-between text-left"
              >
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span
                    className="min-w-0 truncate font-mono"
                    dir="rtl"
                    title={destination || undefined}
                  >
                    <bdi dir="ltr">{destination || 'Choose folder'}</bdi>
                  </span>
                  <span className="shrink-0 fg-secondary">Change</span>
                </span>
              </Button>
            </DialogFormField>
            <p className="text-s fg-secondary">
              Cloned with your Git credentials. No scripts run until you open a
              task.
            </p>
          </>
        )}
        {/* `choose-folder` is the dialog's action, not a status: its button
            below says it once. */}
        {state !== 'ready-to-set-up' && state !== 'choose-folder' && (
          <p role="status" className="text-s fg-secondary">
            {ORG_PROJECT_STATE_TEXT[state]}
          </p>
        )}
        <DesktopErrorBanner
          errorSource="org-project-setup-dialog"
          className=""
          error={error?.error}
          {...(error?.details === undefined ? {} : { details: error.details })}
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            data-testid="org-project-setup-cancel"
            onClick={close}
          >
            Cancel
          </Button>
          {canStart && (
            <Button
              variant="primary"
              data-testid="org-project-setup-start"
              disabled={
                cowork ? false : !loaded || !destination || !project.repository
              }
              onClick={(): void => {
                void perform(async (): Promise<void> => {
                  if (cowork === false)
                    await window.api.savePreferences({
                      orgProjectDefaultDestinationRoot: destination,
                    });
                  if (closed.current || !latestEligibility.current) return;
                  await onStart(project.id, cowork ? undefined : destination);
                  // A dialog dismissed meanwhile must not close the next one,
                  // which shares this close callback.
                  if (!closed.current) close();
                });
              }}
            >
              Start
            </Button>
          )}
          {canChooseFolder && (
            <Button
              variant="primary"
              data-testid="org-project-setup-choose-folder"
              onClick={(): void => {
                void perform(async (): Promise<void> => {
                  // Git folders only: a folder that is not a repository is
                  // refused by the picker, before anything is bound.
                  const selected = await window.api.browseForRepo();
                  if (selected === null) return;
                  if (closed.current || !latestEligibility.current) return;
                  await onStartFromFolder(project.id, selected.path);
                  if (!closed.current) close();
                });
              }}
            >
              Choose the project folder
            </Button>
          )}
        </div>
      </div>
    </DialogModal>
  );
}
