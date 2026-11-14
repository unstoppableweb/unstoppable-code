import type { JSX } from 'react';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import { useCanopyDesktopSharedContainerRunEnabled } from '@/hooks/useCanopyDesktopSharedContainerRunEnabled';
import { brandText } from '@/lib/brand';
import { ShareLayoutRow } from '@canopy/ui-app/sharing';
import {
  LAYOUT_ROW_LABEL,
  LAYOUT_UPDATE_LABEL,
  PREVIEW_UNAVAILABLE_LABEL,
  START_PAGE_WITHHELD_LABEL,
  artifactBudgetExceededLabel,
  shareSummarySentence,
} from './shareCopy';
import { ShareBudgetPushAction } from './ShareBudgetPushAction';
import { ShareScopeDetails } from './ShareScopeDetails';
import type { UseSharePreviewResult } from './useSharePreview';
import { useCanopyDesktopStartPageEnabled } from '@/hooks/useCanopyDesktopStartPageEnabled';
import { useProjectsStore } from '@/stores/projectsStore';
import { openStartPageSettings } from '@/lib/start-page/save-start-page';
import {
  Stack,
  Button,
  ErrorBanner,
  Surface,
} from '@canopy/ui-shared/components';

export interface ShareScopePanelProps {
  containerType: SharedContainerType;
  share: UseSharePreviewResult;
}

/**
 * What leaves this machine: any blocker that would stop the publish, and the
 * collapsed `Advanced` expander holding the summary and every opt-out.
 *
 * No card and no always-visible sentence: everything is shared by default, so
 * the only things that earn a place on screen are the ones that stop the
 * share. The summary moved behind Advanced with the choices it summarizes.
 *
 * Both panes render this, and neither renders it unconditionally. It answers
 * "what am I about to share, or what did I already share?", so it only belongs
 * on screen when the owner can act on the answer:
 *
 * - **Invite**: only when there is somebody left to invite. Over
 *   "you're the only person in {org}" or "everyone already has access" it is
 *   a scope decision for a share that cannot happen, which is just noise on
 *   the one screen that should read as a dead end.
 * - **Shared with**: only when somebody actually holds a grant. Without
 *   recipients there is no share for it to describe.
 *
 * It renders nothing *while* the preview resolves. The preview is supporting
 * detail and never a gate (see `useSharePreview`), so a pending one degrades
 * to no panel rather than to an empty frame.
 *
 * A preview that *failed* is different, and the difference is the whole point
 * of this state. Both always-visible blockers — the artifact budget and
 * undisclosed repositories — are computed from this object, so returning null
 * on a rejection took them off screen along with the summary and read as "this
 * share has nothing that needs reviewing". One line saying the check did not
 * run is the honest version.
 */
export function ShareScopePanel({
  containerType,
  share,
}: ShareScopePanelProps): JSX.Element | null {
  // Hooks run before the early return: `share.preview` is null on the first
  // render of every open, and a conditional hook would violate the rules of
  // hooks on the render where it resolves.
  const runSharingSupported = useCanopyDesktopSharedContainerRunEnabled();
  const startPageEnabled = useCanopyDesktopStartPageEnabled();

  if (!share.preview) {
    if (!share.previewFailed) return null;
    return (
      <div data-testid="shared-container-invite-modal-file-review">
        <p
          className="text-xs fg-secondary"
          role="status"
          data-testid="shared-container-invite-modal-preview-unavailable"
        >
          {PREVIEW_UNAVAILABLE_LABEL}
        </p>
      </div>
    );
  }

  return (
    /* The budget renders as copy only once it is exceeded, so the raw
       counts stay available here for UI automation that drives the scope
       across the limit. The owner never reads them. */
    <Stack
      gap="inline"
      data-testid="shared-container-invite-modal-file-review"
      data-artifact-budget-used={String(share.artifactBudgetUsed)}
      data-artifact-budget-limit={String(share.artifactBudgetLimit)}
    >
      {/*
        Blockers live outside the expander on purpose. The preview leaves
        these repositories out of its counts, but the publisher does not
        publish the rest without them: an unresolvable GitHub remote or
        commit is the `undisclosable-repository` refusal and it stops the
        whole revision.
      */}
      {share.undisclosedRepositoryCount > 0 && (
        <ErrorBanner
          errorSource="shared-container-invite-modal-undisclosed-repositories"
          className=""
          testId="shared-container-invite-modal-undisclosed-repositories"
          error={`${brandText.appName} could not resolve a pushed GitHub remote and commit for ${share.undisclosedRepositoryCount === 1 ? '1 repository' : `${share.undisclosedRepositoryCount} repositories`} in this project, so nothing publishes until that is fixed. Push ${share.undisclosedRepositoryCount === 1 ? 'it' : 'them'} to GitHub, or remove ${share.undisclosedRepositoryCount === 1 ? 'it' : 'them'} from this project.`}
        />
      )}
      {/*
        Surfaced only once publishing would refuse, and never collapsed: a
        budget the owner is comfortably inside is noise, but a budget that
        blocks the invite needs the remedy alongside it.
      */}
      {share.artifactBudgetExceeded && (
        <Stack gap="inline">
          <ErrorBanner
            errorSource="shared-container-invite-modal-artifact-budget"
            className=""
            testId="shared-container-invite-modal-artifact-budget"
            error={artifactBudgetExceededLabel(
              share.artifactBudgetUsed,
              share.artifactBudgetLimit,
            )}
          />
          <ShareBudgetPushAction
            budgetPush={share.budgetPush}
            dataTestId="shared-container-invite-modal-artifact-budget-push"
          />
        </Stack>
      )}

      {startPageEnabled && share.preview.startPage && (
        <Surface variant="outline" data-testid="shared-container-start-page">
          <div className="flex flex-col gap-1 px-3 py-2 text-xs fg-secondary">
            <div>
              <span>{`Opens to: ${share.preview.startPage.label}`}</span>
              <span aria-hidden="true"> · </span>
              <Button
                variant="link"
                onClick={() => {
                  const project = useProjectsStore
                    .getState()
                    .projects.find(
                      (candidate) => candidate.id === share.projectId,
                    );
                  if (project?.type === 'cowork') {
                    openStartPageSettings(share.projectId, 'local');
                    return;
                  }
                  void window.api
                    .resolveProjectStartPage({
                      projectId: share.projectId,
                      worktreeId: share.worktreeId,
                    })
                    .then((resolved) =>
                      openStartPageSettings(
                        share.projectId,
                        resolved?.source === 'source' ? 'source' : 'local',
                        undefined,
                        share.worktreeId,
                      ),
                    );
                }}
              >
                Change
              </Button>
            </div>
            {/* The layout wins over the start page while it is on, so the
              withheld note only decides anything once it is off. */}
            {!share.preferredLayoutEnabled &&
              share.preview.startPage.status === 'withheld' && (
                <p>{START_PAGE_WITHHELD_LABEL}</p>
              )}
          </div>
        </Surface>
      )}

      <ShareLayoutRow
        enabled={share.preferredLayoutEnabled}
        saving={share.fileScopeSaving}
        label={LAYOUT_ROW_LABEL}
        updateLabel={
          share.preferredLayoutPinnedAt === null
            ? undefined
            : LAYOUT_UPDATE_LABEL
        }
        onToggle={share.handlePreferredLayoutToggle}
        onUpdate={share.handlePreferredLayoutUpdate}
        testId="shared-container-layout-row"
      />

      <ShareScopeDetails
        preview={share.preview}
        containerType={containerType}
        summary={shareSummarySentence(share.summaryLines, containerType)}
        snapshotRepositoryCount={share.snapshotRepositoryCount}
        snapshotRepositoryNames={share.snapshotRepositoryNames}
        approvedExcludedPaths={share.approvedExcludedPaths}
        includedFilePaths={share.includedFilePaths}
        fileScopeIsAllowlist={share.fileScopeIsAllowlist}
        includedNoteIds={share.includedNoteIds}
        includedPromptIds={share.includedPromptIds}
        candidateDirectories={share.candidateDirectories}
        selectableFilePaths={share.selectableFilePaths}
        withheldFileCount={share.withheldFileCount}
        withheldFilePaths={share.withheldFilePaths}
        withheldSymlinkPaths={share.withheldSymlinkPaths}
        runSharingSupported={runSharingSupported}
        runSharingEnabled={share.runSharingEnabled}
        includedRunScripts={share.includedRunScripts}
        availableRunScripts={share.preview.availableRunScripts ?? []}
        fileScopeSaving={share.fileScopeSaving}
        onFileScopeChange={share.handleFileScopeChange}
        onDirectoryScopeChange={share.handleDirectoryScopeChange}
        onNoteScopeChange={share.handleNoteScopeChange}
        onPromptScopeChange={share.handlePromptScopeChange}
        onRunSharingChange={share.handleRunSharingChange}
        onRunScriptScopeChange={share.handleRunScriptScopeChange}
      />
    </Stack>
  );
}
