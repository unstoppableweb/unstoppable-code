import { useMemo, type JSX, type ReactNode } from 'react';
import {
  formatPipelinePackageExecutableFiles,
  formatPipelinePackageFileSummary,
  formatPipelinePackageSteps,
  pipelinePackageKindLabel,
  PIPELINE_PACKAGE_INCLUDED_HEADING,
  PIPELINE_PACKAGE_NO_CREDENTIALS_NOTE,
  PIPELINE_PACKAGE_NOT_INCLUDED_HEADING,
  PIPELINE_PACKAGE_PUBLISHER_NOTE,
} from '@canopy/ui-shared/lib/pipeline-package-display';
import type { PipelinePackageSummary } from '@canopy/execution-engine/types/pipeline';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { MarkdownFrontmatterContent } from '@canopy/ui-app';
import {
  HEADER_BODY_MARKDOWN_OPTIONS,
  skillContentUnderHeader,
} from '@canopy/ui-app/capability';
import { DescriptionMarkdown } from '@canopy/ui-shared/components/DescriptionMarkdown';
import { DetailPageActions } from '@canopy/ui-shared/components/DetailActionBar';
import { InstalledShareMenu } from '@canopy/ui-shared/components/InstalledShareMenu';
import {
  shareInstallActionLabel,
  shareInstallEntityNoun,
} from '@canopy/ui-app/sharing/share-install-copy';
import { hasMarkdownDescriptionText } from '@canopy/ui-shared/lib/markdown-plain-text';
import { ErrorBanner } from '../shared';
import { Button } from '../shared/Button';
import {
  Stack,
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  Fact,
  FactList,
  Heading,
  Surface,
} from '@canopy/ui-shared/components';
import { SkillPublisherProvenance } from '@canopy/ui-shared/components/SkillPublisherProvenance';
import { parseSkillSource } from '@/lib/skillFrontmatter';
import {
  shareLandingErrorCopy,
  shareLandingRecovery,
} from './shareLandingErrorCopy';
import type { PublicShareLanding } from './usePublicShareLanding';
import { useSkillDependencyReadiness } from './useSkillDependencyReadiness';
import { CapabilityPackageReadiness } from '../shared/capability-package/CapabilityPackageReadiness';

/**
 * The body of a Marketplace skill or plugin page (CAN-3710): the README, the
 * package and the requirements this machine is missing, with the page's
 * actions on the host heading's row. Install never writes from here; it opens
 * the shared install review. Once installed, a skill offers Try now and the
 * shared ⋯ menu; a plugin offers Manage.
 */

// The status stays with its buttons and is the part that gives way, breaking
// even inside a long skill name, so the buttons keep their size.
const ACTION_STATUS_CLASS = 'min-w-0 break-words text-s fg-secondary';

interface MarketplaceSkillDetailBodyProps {
  /** What the page shows, known before its snapshot loads. */
  entity: 'skill' | 'plugin';
  landing: PublicShareLanding;
  /** Invoked after Try now / Manage dispatches its navigation. */
  onNavigate?: () => void;
  /** Opens the shared install review; the page itself never writes. */
  onInstall: () => void;
  /** The page title, which shares its row with the actions. */
  heading?: ReactNode;
  /**
   * Set when the page's shared detail header shows the title and
   * description (CAN-4261): the body draws no title row, publisher line or
   * Name/Description card, drops a repeated `# Title`, and its actions join
   * the header's.
   */
  headerTitle?: string;
  headerDescription?: string;
}

/**
 * The author description shown at the top of the body. A plugin's renders
 * inside its own summary box instead. A skill's description is read from its
 * SKILL.md frontmatter, which the body already lists, so it only renders here
 * when that frontmatter has none.
 */
function bodyDescriptionFor(
  snapshot: PublicShareLanding['snapshot'],
  skillFrontmatter: Record<string, unknown> | undefined,
): string | undefined {
  if (snapshot?.entity !== 'skill') return undefined;
  const listed = skillFrontmatter?.description;
  if (typeof listed === 'string' && listed.trim().length > 0) {
    return undefined;
  }
  return snapshot.description || undefined;
}

export function MarketplaceSkillDetailBody({
  entity,
  landing,
  onNavigate,
  onInstall,
  heading,
  headerTitle,
  headerDescription,
}: MarketplaceSkillDetailBodyProps): JSX.Element {
  const headerOwned = headerTitle !== undefined;
  const { state, snapshot, installError } = landing;
  const recovery =
    state.phase === 'error'
      ? shareLandingRecovery(state.reason, landing)
      : undefined;
  const skillPackage =
    snapshot?.entity === 'skill' && snapshot.distributionMode === 'package'
      ? snapshot.package
      : undefined;
  // A skill's requirements are checked against this machine for every share,
  // including ones published before packages, so its page lists them once,
  // with their status, instead of in the package summary too.
  const skillReadiness = useSkillDependencyReadiness(
    snapshot?.entity === 'skill' ? snapshot.dependencies : null,
  );
  const parsedSkill = useMemo(
    () =>
      snapshot?.entity === 'skill' ? parseSkillSource(snapshot.rawSkill) : null,
    [snapshot],
  );
  const bodyDescription = headerOwned
    ? undefined
    : bodyDescriptionFor(snapshot, parsedSkill?.frontmatter);
  const shownSkill =
    headerOwned && parsedSkill
      ? skillContentUnderHeader(
          parsedSkill,
          { title: headerTitle, description: headerDescription },
          snapshot?.entity === 'skill' && snapshot.name ? [snapshot.name] : [],
        )
      : parsedSkill;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* `min-h-9.5` is the bordered kebab's height, the tallest a one-line
          row gets, so while the title and actions share a line the body below
          holds still when the snapshot brings the action or Install resolves
          into Try now. The actions wrap under a heading too long to share a
          line with, and the row grows by that line. */}
      {headerOwned ? (
        <BodyActions
          landing={landing}
          onNavigate={onNavigate}
          onInstall={onInstall}
          statusInHeader
        />
      ) : (
        <div className="flex min-h-9.5 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5">
          {heading}
          <BodyActions
            landing={landing}
            onNavigate={onNavigate}
            onInstall={onInstall}
          />
        </div>
      )}
      {/* The page scrolls as a whole, so this body never bounds its height;
          `overflow-y-auto` still keeps a wide README table or code line
          scrolling inside the body instead of widening the page.

          A flex column with `gap`, not a block with `space-y-*`. Tailwind emits
          `space-y-*` as a zero-specificity `:where(& > :not(:last-child))`
          margin, so against `MarkdownFrontmatterContent` — a fragment whose
          children carry their own `mb-4` — the child's margin simply wins and
          the intended rhythm is silently dropped. Flex `gap` is a property of
          this container instead, so it composes with those margins rather than
          losing to them. */}
      <div
        data-testid="deep-link-share-body"
        // Blocked from session replay: the shared snapshot (SKILL.md text).
        // The host's title and the action row stay recorded.
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-5 py-4`}
      >
        {state.phase === 'loading' && (
          <DelayedLoadingPlaceholder
            className=""
            slowNote={`Still loading shared ${entity}…`}
          >
            <div className="box-content flex min-h-full flex-1 py-12">
              <CenteredLoadingSpinner className="" />
            </div>
          </DelayedLoadingPlaceholder>
        )}
        {state.phase === 'error' && (
          <Stack data-testid="deep-link-share-error" gap="inline">
            <ErrorBanner
              errorSource="marketplace-skill-detail-body"
              error={shareLandingErrorCopy(state.reason, entity)}
              className="mb-0"
            />
            {recovery !== undefined && (
              <Button
                className="self-start"
                variant="primary"
                size="compact"
                data-testid={recovery.testId}
                onClick={recovery.onClick}
              >
                {recovery.label}
              </Button>
            )}
          </Stack>
        )}
        {/* A failure reports under the action row, not under the README. */}
        {installError !== '' && (
          <ErrorBanner
            errorSource="marketplace-skill-detail-body-install"
            error={installError}
            className="mb-0"
          />
        )}
        {snapshot?.entity === 'skill' && snapshot.publisher && (
          <>
            {/* Under the shared header the publisher is in its meta line. */}
            {!headerOwned && (
              <p className="text-s fg-secondary">{snapshot.publisher.name}</p>
            )}
            <SkillPublisherProvenance publisher={snapshot.publisher} />
          </>
        )}
        {hasMarkdownDescriptionText(bodyDescription) && (
          <DescriptionMarkdown dataTestId="share-description">
            {bodyDescription}
          </DescriptionMarkdown>
        )}
        {snapshot?.entity === 'skill' && (
          <MarkdownFrontmatterContent
            loading={false}
            error=""
            content={shownSkill}
            {...(headerOwned
              ? { markdownOptions: HEADER_BODY_MARKDOWN_OPTIONS }
              : {})}
            emptyText="This skill has no content."
          />
        )}
        {skillPackage && <PackageReview summary={skillPackage} />}
        {skillReadiness && (
          <div className="pb-4" data-testid="deep-link-share-skill-readiness">
            <CapabilityPackageReadiness
              readiness={skillReadiness}
              subjectLabel="skill"
            />
          </div>
        )}
        {snapshot?.entity === 'plugin' && (
          <Surface
            variant="group"
            padding="default"
            data-testid="deep-link-plugin-summary"
          >
            {hasMarkdownDescriptionText(snapshot.description) ? (
              <DescriptionMarkdown dataTestId="share-description">
                {snapshot.description}
              </DescriptionMarkdown>
            ) : (
              <p className="text-s fg-secondary">No description provided.</p>
            )}
            <FactList placement="mt-3" columnGap="2" valueTone="secondary">
              <Fact
                label={<span className="font-medium fg-primary">Source</span>}
              >
                {snapshot.marketplaceOrigin}
              </Fact>
            </FactList>
          </Surface>
        )}
      </div>
    </div>
  );
}

/**
 * The page's actions in its action bar: the installed status and ⋯ menu as
 * secondaries, then the one primary. Renders nothing until there is a
 * snapshot to act on.
 */
function BodyActions({
  landing,
  onNavigate,
  onInstall,
  statusInHeader = false,
}: {
  landing: PublicShareLanding;
  onNavigate?: () => void;
  onInstall: () => void;
  /** The page header's meta shows the installed status instead. */
  statusInHeader?: boolean;
}): JSX.Element | null {
  const { snapshot, detecting, installed, installStatus } = landing;
  if (snapshot?.entity !== 'skill' && snapshot?.entity !== 'plugin') {
    return null;
  }
  const entity = snapshot.entity;

  let primary: JSX.Element;
  if (installed === null) {
    primary = (
      <Button
        variant="primary"
        size="compact"
        data-testid="deep-link-share-install"
        onClick={onInstall}
        disabled={detecting}
      >
        {shareInstallActionLabel(entity, 'install')}
      </Button>
    );
  } else if (installed.entity === 'skill') {
    primary = (
      <Button
        variant="primary"
        size="compact"
        data-testid="deep-link-share-try"
        onClick={(): void => {
          landing.tryNow(onNavigate);
        }}
      >
        Try now
      </Button>
    );
  } else {
    // A plugin opens its management surface: its marketplace can carry
    // several plugins, so removing one belongs to the Plugins page.
    primary = (
      <Button
        variant="primary"
        size="compact"
        data-testid="deep-link-share-manage"
        onClick={(): void => {
          landing.manage(onNavigate);
        }}
      >
        Manage
      </Button>
    );
  }

  return (
    <DetailPageActions
      secondary={
        installed !== null ? (
          <>
            {!statusInHeader && (
              <span
                className={ACTION_STATUS_CLASS}
                role="status"
                data-testid="deep-link-share-installed-status"
              >
                {installStatus !== ''
                  ? installStatus
                  : installed.entity === 'skill'
                    ? `Installed as “${installed.skillName}”.`
                    : 'Installed.'}
              </span>
            )}
            {/* The shared installed ⋯ menu: Manage, and Uninstall behind a
                confirm named for the outcome. */}
            {installed.entity === 'skill' && (
              <InstalledShareMenu
                placement="below"
                uninstallTitle={`Uninstall this ${shareInstallEntityNoun(entity)}?`}
                testIds={{
                  kebab: 'deep-link-share-kebab',
                  menu: 'deep-link-share-menu',
                  manage: 'deep-link-share-manage',
                  uninstall: 'deep-link-share-uninstall',
                  uninstallConfirm: 'deep-link-share-uninstall-confirm',
                  uninstallDialog: 'deep-link-share-uninstall-dialog',
                }}
                onManage={(): void => {
                  landing.manage(onNavigate);
                }}
                onUninstall={landing.uninstall}
              />
            )}
          </>
        ) : undefined
      }
      primary={primary}
    />
  );
}

/**
 * What a packaged skill copies locally. Read-only: the requirements it needs
 * are listed with their local status beside it instead.
 */
function PackageReview({
  summary,
}: {
  summary: PipelinePackageSummary;
}): JSX.Element {
  return (
    <Surface
      as="section"
      gap="item"
      variant="inset"
      data-testid="deep-link-share-package-summary"
    >
      <div className="flex flex-col gap-3 px-3 py-2.5">
        <div>
          <Heading level={3} variant="title">
            {PIPELINE_PACKAGE_INCLUDED_HEADING}
          </Heading>
          <p className="text-xs fg-secondary">
            {formatPipelinePackageFileSummary(
              summary.totalFiles,
              summary.totalBytes,
            )}
          </p>
        </div>
        <ul className="flex flex-col gap-1.5">
          {summary.resources.map((resource) => (
            <li key={resource.id} className="text-xs">
              <span className="fg-primary">{resource.displayName}</span>{' '}
              <span className="fg-secondary">
                {pipelinePackageKindLabel(resource.kind)} ·{' '}
                {resource.sourceLabel} ·{' '}
                {formatPipelinePackageFileSummary(
                  resource.fileCount,
                  resource.totalBytes,
                )}
              </span>
              {resource.executableFiles &&
                resource.executableFiles.length > 0 && (
                  <span
                    className="block fg-primary"
                    data-testid="deep-link-share-package-executable-files"
                  >
                    {formatPipelinePackageExecutableFiles(
                      resource.executableFiles,
                    )}
                  </span>
                )}
              {resource.affectedSteps.length > 0 && (
                <span className="block fg-secondary">
                  Used by {formatPipelinePackageSteps(resource.affectedSteps)}
                </span>
              )}
            </li>
          ))}
        </ul>
        {(summary.publisherNotes?.length ?? 0) > 0 && (
          <Stack gap="tight" data-testid="deep-link-share-package-notes">
            <div className="flex flex-col gap-0">
              <Heading level={3} variant="title">
                {PIPELINE_PACKAGE_NOT_INCLUDED_HEADING}
              </Heading>
              <p className="text-xs fg-secondary">
                {PIPELINE_PACKAGE_PUBLISHER_NOTE}
              </p>
            </div>
            <ul className="flex flex-col gap-1">
              {summary.publisherNotes?.map((note) => (
                <li key={note.id} className="text-xs">
                  <span className="fg-primary">{note.label}</span>
                  {note.affectedSteps.length > 0 && (
                    <span className="block fg-secondary">
                      Used by {formatPipelinePackageSteps(note.affectedSteps)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Stack>
        )}
        <p className="text-xs fg-secondary">
          {PIPELINE_PACKAGE_NO_CREDENTIALS_NOTE}
        </p>
      </div>
    </Surface>
  );
}
