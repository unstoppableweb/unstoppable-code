import {
  countCapabilityPackageDistinctFiles,
  groupCapabilityPackageProviderTwins,
  isCapabilityPackageSubjectBinding,
  listCapabilityPackageExecutablePaths,
} from '@canopy/protocol/pipelines';
import { useId, useState, type JSX, type ReactNode } from 'react';
import {
  Stack,
  Badge,
  Button,
  Checkbox,
  RichHoverTooltip,
  SettingsSelect,
  Heading,
  ErrorBanner,
  Notice,
} from '@canopy/ui-shared/components';
import { QuestionMarkIcon } from '@canopy/ui-shared/icons';
import {
  formatPipelinePackageExecutableFiles,
  formatPipelinePackageFileSummary,
  pipelinePackageKindLabel,
  pipelinePackageRequirementKindLabel,
  PIPELINE_PACKAGE_PUBLISHER_NO_CREDENTIALS_NOTE,
  PIPELINE_PACKAGE_PUBLISHER_SETUP_HEADING,
} from '@canopy/ui-shared/lib/pipeline-package-display';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageEnvironmentRequirement,
  PipelinePackageInvocationDismissal,
  PipelinePackagePackagedPipeline,
  PipelinePackageReferenceDismissal,
  PipelinePackageResource,
  PipelinePackageWithheldFile,
  PipelinePackageWithheldReason,
  CapabilityPackageWithheldMemberFile,
} from '@canopy/protocol/pipelines';
import {
  computeRequiredResourceIds,
  computeResourceClosureIds,
  describeDependencyReason,
} from './capability-package-closure';
import { CapabilityPackageProblems } from './CapabilityPackageProblems';
import { Surface } from '@canopy/ui-shared/components';

/**
 * Publisher-facing dependency review for a self-contained capability share.
 * The shared share dialog renders it for every resource: a summary row of
 * what the share includes, with a help icon whose tooltip names what is
 * copied, what recipients set up themselves, and what is never included.
 * Only when the publisher has optional files to opt in to does the row offer
 * a disclosure into the analyzed member closure. Blockers always render
 * above the summary, so collapsing never hides why Share is unavailable.
 *
 * Display + selection only: it never reads dependency bytes (the main process
 * keeps them) and never decides whether the share is allowed — the hosting
 * modal owns submission. The selection does not depend on whether the
 * details are open.
 */

const INCLUDED_FILES_HEADING = 'Included files';
const DEFINITION_ONLY_LABEL = 'Definition only';
const LOADING_LABEL = 'Checking included files…';
const REVALIDATING_LABEL = 'Rechecking included files…';
const ANALYSIS_FAILURE_LABEL = "Couldn't check the included files. Try again.";
const RETRY_LABEL = 'Try again';
const PIPELINES_HEADING = 'Pipelines';
const PIPELINES_HELPER =
  'Recipients get their own copy of each pipeline when they install.';
const ACTION_PIPELINE_LABEL = 'Runs this automation';
const SUGGESTED_PIPELINE_HINT = 'The prompt mentions it by name';
const ADD_PIPELINE_LABEL = 'Add a pipeline';
const ADD_PIPELINE_PLACEHOLDER = 'Add a pipeline…';
const ADD_PIPELINE_FAILED_LABEL = "Couldn't add the pipeline. Try again.";
const WITHHELD_HEADING = 'Left out of this share';
const GIT_UNCHECKED_LABEL =
  "Git couldn't check this folder, so files it would ignore may be included.";
const WITHHELD_HELPER =
  'These files stay on this computer. Recipients start without them.';
const WITHHELD_REASON_LABELS: Record<PipelinePackageWithheldReason, string> = {
  denied_name: 'Credential file',
  git_directory: 'Git folder',
  symlink: 'Symbolic link',
  suspected_secret: 'May contain a secret',
  missing_optional_asset: 'Folder not found',
  git_ignored: 'Ignored by Git',
};
const CHOOSE_FILES_LABEL = 'Choose files';
const HIDE_FILES_LABEL = 'Hide files';
const HELP_LABEL = 'About included files';
/** Names a tooltip line lists before folding the rest into `and N more`. */
const HELP_NAMES_SHOWN = 5;
/** A failure reason is diagnostic text from the host; keep it to a line or two. */
const MAX_ERROR_REASON_LENGTH = 240;

function AnalysisFailureReason({
  reason,
  testIdPrefix,
}: {
  reason: string | null | undefined;
  testIdPrefix: string;
}): JSX.Element | null {
  if (!reason) return null;
  return (
    <p
      className="text-xs fg-secondary break-words"
      data-testid={`${testIdPrefix}-dependencies-error-reason`}
      title={reason}
    >
      Details:{' '}
      {reason.length > MAX_ERROR_REASON_LENGTH
        ? `${reason.slice(0, MAX_ERROR_REASON_LENGTH - 1).trimEnd()}…`
        : reason}
    </p>
  );
}

interface CapabilityPackageDependenciesProps {
  /** Reference mode lists recipient setup without claiming files are copied. */
  mode?: 'package' | 'reference';
  analysis: PipelinePackageAnalysisSummary | null;
  /** True while an analysis request is in flight. */
  loading: boolean;
  /** Set when the analysis request itself failed (not a content blocker). */
  errored: boolean;
  /** Why the analysis failed, shown beneath the generic failure copy. */
  errorReason?: string | null;
  /** Optional resource ids the publisher has opted in to. */
  selectedOptionalResourceIds: readonly string[];
  onToggleOptionalResource: (resourceId: string) => void;
  onRetry: () => void;
  /**
   * Tokens the publisher marked as not commands, as echoed by main.
   *
   * Dismissal only exists because pipeline steps carry free-text prompts
   * whose `@skill` tokens are parsed heuristically. A host whose capabilities
   * are explicit refs has no ambiguous token to dismiss, so it omits these
   * three props and no dismissal affordance renders.
   */
  dismissedInvocations?: readonly PipelinePackageInvocationDismissal[];
  onDismissInvocation?: (dismissal: PipelinePackageInvocationDismissal) => void;
  onRestoreInvocation?: (dismissal: PipelinePackageInvocationDismissal) => void;
  /** Pipeline references the publisher left out, as echoed by main. */
  dismissedReferences?: readonly PipelinePackageReferenceDismissal[];
  onDismissReference?: (dismissal: PipelinePackageReferenceDismissal) => void;
  onRestoreReference?: (dismissal: PipelinePackageReferenceDismissal) => void;
  /** Keys of the optional packaged pipelines that ship. */
  selectedPipelineKeys?: readonly string[];
  /** Absent when the host offers no optional pipelines. */
  onTogglePipeline?: (key: string) => void;
  /**
   * Pipelines the author can add to the share by hand. The host saves the
   * choice with the item (an automation's pipeline list) and analyzes again;
   * a rejected promise shows its message beside the control.
   */
  pipelineAdd?: CapabilityPackagePipelineAdd;
  /**
   * Turn one manifest binding into a location label, or `null` to omit it.
   * Formatting a location is the host's job — the component must not know
   * what a job or a step is. Defaults to the pipeline `job.step` form.
   */
  bindingLabelFor?: (binding: {
    jobId: string;
    stepId: string;
  }) => string | null;
  /** Lower-case noun for the resource being shared ("pipeline", "skill"). */
  subjectLabel?: string;
  /**
   * Heading and helper for the files left out; a cloud copy (CAN-6176) has
   * no recipients. Defaults to the share's wording.
   */
  withheldCopy?: { heading: string; helper: string };
  /**
   * Test-id prefix of the hosting dialog, e.g. `share-skill`. Sections get
   * `${testIdPrefix}-dependencies*` and `${testIdPrefix}-dependency-problems*`.
   */
  testIdPrefix: string;
  disabled: boolean;
  /** Opens a repair chat for the blocking problems; absent when unsupported. */
  onFixWithAI?: () => void;
  fixWithAIDisabled?: boolean;
  fixWithAIPending?: boolean;
  fixWithAIFailed?: boolean;
}

/** A pipeline an "Add pipeline" control offers. */
export interface CapabilityPackageAddablePipeline {
  id: string;
  /** Its packaged pipeline key, so one already in the share is not offered. */
  key: string;
  name: string;
}

export interface CapabilityPackagePipelineAdd {
  options: readonly CapabilityPackageAddablePipeline[];
  onAdd: (id: string) => Promise<void>;
}

const DEFAULT_BINDING_LABEL = (binding: {
  jobId: string;
  stepId: string;
}): string => `${binding.jobId}.${binding.stepId}`;

function sourceBadge(
  visibility: PipelinePackageResource['sourceVisibility'],
): string | null {
  if (visibility === 'private') return 'Private source';
  if (visibility === 'local') return 'Local source';
  return null;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

/** `a, b, c, d, e, and 3 more` — a tooltip list kept to one short line. */
function cappedList(names: readonly string[]): string {
  const shown = names.slice(0, HELP_NAMES_SHOWN).join(', ');
  const hidden = names.length - HELP_NAMES_SHOWN;
  return hidden > 0 ? `${shown}, and ${String(hidden)} more` : shown;
}

/**
 * The lines behind the summary's help icon: what is copied, what recipients
 * set up, what stays private, and what is never included. Lists are capped so
 * a large closure still reads as a tooltip.
 */
function includedHelpLines({
  mode,
  subjectLabel,
  includedResources,
  requirements,
  keptPrivateLabels,
}: {
  mode: 'package' | 'reference';
  subjectLabel: string;
  includedResources: readonly PipelinePackageResource[];
  requirements: readonly PipelinePackageEnvironmentRequirement[];
  keptPrivateLabels: readonly string[];
}): string[] {
  const copied =
    mode === 'reference'
      ? []
      : groupCapabilityPackageProviderTwins(includedResources).flatMap(
          (group) => (group[0] ? [group[0].displayName] : []),
        );
  const lines = [
    mode === 'reference'
      ? 'Only a reference is shared. No files are copied.'
      : copied.length === 0
        ? `Only the ${subjectLabel} definition is shared.`
        : `Copied into this share: ${cappedList(copied)}.`,
  ];
  const executableFiles =
    mode === 'reference'
      ? null
      : formatPipelinePackageExecutableFiles(
          Array.from(
            new Set(
              includedResources.flatMap(listCapabilityPackageExecutablePaths),
            ),
          ).sort(),
        );
  const privateSources =
    mode === 'reference'
      ? []
      : groupCapabilityPackageProviderTwins(includedResources).flatMap(
          (group) =>
            group[0]?.sourceVisibility === 'private'
              ? [group[0].displayName]
              : [],
        );
  if (privateSources.length > 0) {
    lines.push(`From private sources: ${cappedList(privateSources)}.`);
  }
  if (executableFiles !== null) lines.push(`${executableFiles}.`);
  if (requirements.length > 0) {
    lines.push(
      `Recipients set up: ${cappedList(
        requirements.map((requirement) => requirement.displayName),
      )}.`,
    );
  }
  if (keptPrivateLabels.length > 0) {
    lines.push(`Kept private: ${cappedList(keptPrivateLabels)}.`);
  }
  lines.push(
    copied.length === 0
      ? 'Credentials, private configuration, and local files are never included.'
      : 'Credentials, private configuration, and other local files are never included.',
  );
  return lines;
}

function IncludedFilesHelp({
  lines,
  testIdPrefix,
}: {
  lines: readonly string[];
  testIdPrefix: string;
}): JSX.Element {
  // Hover and keyboard focus open the help on their own; a click or tap opens
  // it too, because touch has no hover and these lines are the only place a
  // publisher sees what a share copies, including private and runnable files.
  const [open, setOpen] = useState(false);
  return (
    <RichHoverTooltip
      dataTestId={`${testIdPrefix}-dependencies-help-details`}
      surfacePadding="card"
      surfaceClassName="w-80"
      dismissOnEscape
      open={open}
      onOpenChange={setOpen}
      content={
        <div className="flex flex-col gap-1 text-xs fg-secondary">
          {lines.map((line) => (
            <p key={line} className="break-words">
              {line}
            </p>
          ))}
        </div>
      }
    >
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={HELP_LABEL}
        data-testid={`${testIdPrefix}-dependencies-help`}
        onClick={(): void => {
          setOpen(true);
        }}
        // The 28px circle overhangs the summary line rather than growing it.
        className="-my-1"
      >
        <QuestionMarkIcon aria-hidden="true" />
      </Button>
    </RichHoverTooltip>
  );
}

/**
 * The summary line: files and size of what the selected closure copies, or
 * Definition only, plus how many setup requirements recipients meet.
 */
function includedSummary({
  mode,
  includedResources,
  requirementCount,
  pipelineCount,
  withheldCount,
}: {
  mode: 'package' | 'reference';
  includedResources: readonly PipelinePackageResource[];
  requirementCount: number;
  pipelineCount: number;
  withheldCount: number;
}): string {
  const { files, bytes } =
    mode === 'reference'
      ? { files: 0, bytes: 0 }
      : countCapabilityPackageDistinctFiles(includedResources);
  // Packaged pipelines are counted on their own, so a share that carries
  // only pipelines is not "definition only".
  const parts =
    files > 0
      ? [formatPipelinePackageFileSummary(files, bytes)]
      : pipelineCount > 0
        ? []
        : [DEFINITION_ONLY_LABEL];
  if (pipelineCount > 0) {
    parts.push(plural(pipelineCount, 'pipeline', 'pipelines'));
  }
  if (requirementCount > 0) {
    parts.push(
      plural(requirementCount, 'setup requirement', 'setup requirements'),
    );
  }
  if (withheldCount > 0) {
    parts.push(`${plural(withheldCount, 'file', 'files')} left out`);
  }
  return parts.join(' · ');
}

export function CapabilityPackageDependencies({
  analysis,
  loading,
  errored,
  errorReason,
  selectedOptionalResourceIds,
  onToggleOptionalResource,
  onRetry,
  dismissedInvocations,
  onDismissInvocation,
  onRestoreInvocation,
  dismissedReferences,
  onDismissReference,
  onRestoreReference,
  selectedPipelineKeys = [],
  onTogglePipeline,
  pipelineAdd,
  bindingLabelFor = DEFAULT_BINDING_LABEL,
  subjectLabel = 'workflow',
  withheldCopy = { heading: WITHHELD_HEADING, helper: WITHHELD_HELPER },
  testIdPrefix,
  disabled,
  mode = 'package',
  onFixWithAI,
  fixWithAIDisabled = false,
  fixWithAIPending = false,
  fixWithAIFailed = false,
}: CapabilityPackageDependenciesProps): JSX.Element {
  // Local to this dialog instance, so it survives re-analysis.
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const helperText =
    mode === 'reference'
      ? `Only a reference is shared. Recipients set up the requirements listed here; no files, credentials, or private configuration are copied.`
      : `Choose which optional files to copy into this share. Required files are always copied so recipients can run the ${subjectLabel}.`;
  const emptyDependenciesLabel =
    mode === 'reference'
      ? `No additional setup requirements were detected for this ${subjectLabel}.`
      : `This ${subjectLabel} has no local dependencies to copy.`;
  // Only the very first analysis collapses the section to a bare label. A
  // re-run triggered by a dismissal keeps the previous result on screen and
  // marks itself busy, so marking one token never blanks the list.
  if (loading && analysis === null) {
    return (
      <Stack
        as="section"
        gap="inline"
        data-testid={`${testIdPrefix}-dependencies`}
        data-state="loading"
      >
        <SummaryRow
          testIdPrefix={testIdPrefix}
          summary={LOADING_LABEL}
          toggle={null}
        />
      </Stack>
    );
  }

  if (errored || !analysis) {
    return (
      <Stack
        as="section"
        gap="inline"
        data-testid={`${testIdPrefix}-dependencies`}
        data-state="error"
      >
        <SummaryRow
          testIdPrefix={testIdPrefix}
          summary={null}
          toggle={
            <Button
              type="button"
              variant="secondary"
              size="compact"
              onClick={onRetry}
              disabled={disabled}
              data-testid={`${testIdPrefix}-dependencies-retry`}
            >
              {RETRY_LABEL}
            </Button>
          }
        >
          {/* One alert region, so the reason is announced with the failure. */}
          <Notice
            errorSource="capability-package-dependencies-analysis-label"
            intent="destructive"
            detail={
              <AnalysisFailureReason
                reason={errorReason}
                testIdPrefix={testIdPrefix}
              />
            }
          >
            {ANALYSIS_FAILURE_LABEL}
          </Notice>
        </SummaryRow>
      </Stack>
    );
  }

  const manifest = analysis.manifest;
  const packagedPipelines = analysis.packagedPipelines ?? [];
  const withheld: WithheldItem[] = [
    ...(analysis.withheldFiles ?? []).map(assetWithheldItem),
    ...(analysis.withheldMemberFiles ?? []).map(memberWithheldItem),
  ];
  const manifestResourceIds = new Set(
    (manifest?.resources ?? []).map((resource) => resource.id),
  );
  const shippedPipelineCount = packagedPipelines.filter((pipeline) =>
    manifestResourceIds.has(pipeline.resourceId),
  ).length;
  // Packaged pipelines get their own group, so the file list skips them.
  const resources = (manifest?.resources ?? []).filter(
    (resource) =>
      packagedPipelines.length === 0 || resource.kind !== 'automation_pipeline',
  );
  const requiredIds = manifest
    ? computeRequiredResourceIds(manifest)
    : new Set<string>();
  const selectedClosureIds = manifest
    ? computeResourceClosureIds(manifest, selectedOptionalResourceIds)
    : new Set<string>();
  const includedIds = manifest
    ? computeResourceClosureIds(manifest, [
        ...Array.from(requiredIds),
        ...selectedOptionalResourceIds,
      ])
    : new Set<string>();
  const requirements = manifest?.environmentRequirements ?? [];
  const blockerCount = analysis.blockers.length;
  const includedResources = resources.filter((resource) =>
    includedIds.has(resource.id),
  );
  // The file list is only a choice when something can be opted in to; every
  // other detail fits in the help tooltip.
  const hasOptionalFiles =
    mode === 'package' &&
    resources.some((resource) => !requiredIds.has(resource.id));
  // Without a manifest the renderer has no evidence of emptiness, so it must
  // stay silent rather than claim there is nothing to copy. That missing
  // `manifest !== undefined` clause is what let "No local dependency files
  // were detected." render directly above a wall of failures.
  const showEmptyState =
    !loading &&
    !errored &&
    manifest !== undefined &&
    resources.length === 0 &&
    packagedPipelines.length === 0 &&
    requirements.length === 0 &&
    blockerCount === 0;
  // The problem card above already says what blocks the share, so the
  // summary adds no second count of it.
  const summary =
    blockerCount > 0
      ? null
      : loading
        ? REVALIDATING_LABEL
        : includedSummary({
            mode,
            includedResources,
            requirementCount: requirements.length,
            pipelineCount: shippedPipelineCount,
            withheldCount: withheld.length,
          });

  return (
    <Stack
      as="section"
      gap="item"
      data-testid={`${testIdPrefix}-dependencies`}
      data-state={loading ? 'revalidating' : analysis.state}
      data-busy={loading ? 'true' : 'false'}
    >
      {loading && blockerCount > 0 && (
        <p
          className="text-xs fg-secondary"
          data-testid={`${testIdPrefix}-dependencies-revalidating`}
        >
          {REVALIDATING_LABEL}
        </p>
      )}

      <CapabilityPackageProblems
        blockers={analysis.blockers}
        {...(dismissedInvocations !== undefined
          ? { dismissedInvocations }
          : {})}
        {...(onDismissInvocation !== undefined
          ? { onDismiss: onDismissInvocation }
          : {})}
        {...(onRestoreInvocation !== undefined
          ? { onRestore: onRestoreInvocation }
          : {})}
        {...(dismissedReferences !== undefined ? { dismissedReferences } : {})}
        {...(onDismissReference !== undefined ? { onDismissReference } : {})}
        {...(onRestoreReference !== undefined ? { onRestoreReference } : {})}
        bindingLabelFor={bindingLabelFor}
        disabled={disabled || loading}
        {...(onFixWithAI !== undefined ? { onFixWithAI } : {})}
        fixWithAIDisabled={fixWithAIDisabled}
        fixWithAIPending={fixWithAIPending}
        fixWithAIFailed={fixWithAIFailed}
        testIdPrefix={testIdPrefix}
      />

      <SummaryRow
        testIdPrefix={testIdPrefix}
        summary={summary}
        {...(loading && blockerCount === 0
          ? { summaryTestId: `${testIdPrefix}-dependencies-revalidating` }
          : {})}
        help={
          <IncludedFilesHelp
            lines={includedHelpLines({
              mode,
              subjectLabel,
              includedResources,
              requirements,
              keptPrivateLabels: analysis.unpackageableSelectionLabels ?? [],
            })}
            testIdPrefix={testIdPrefix}
          />
        }
        toggle={
          hasOptionalFiles ? (
            <span className="shrink-0 text-xs">
              <Button
                variant="link"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={(): void => {
                  setExpanded((open) => !open);
                }}
                data-testid={`${testIdPrefix}-dependencies-toggle`}
              >
                {expanded ? HIDE_FILES_LABEL : CHOOSE_FILES_LABEL}
              </Button>
            </span>
          ) : null
        }
      />

      {(packagedPipelines.length > 0 ||
        (pipelineAdd?.options.length ?? 0) > 0) && (
        <PackagedPipelineList
          pipelines={packagedPipelines}
          shippedResourceIds={manifestResourceIds}
          selectedPipelineKeys={selectedPipelineKeys}
          disabled={disabled || loading}
          testIdPrefix={testIdPrefix}
          {...(onTogglePipeline !== undefined ? { onTogglePipeline } : {})}
          {...(pipelineAdd !== undefined ? { pipelineAdd } : {})}
        />
      )}

      {analysis.gitIgnoreCheck === 'unavailable' && (
        <Notice
          intent="attention"
          data-testid={`${testIdPrefix}-dependencies-git-unchecked`}
        >
          {GIT_UNCHECKED_LABEL}
        </Notice>
      )}

      {withheld.length > 0 && (
        <WithheldFileList
          items={withheld}
          copy={withheldCopy}
          testIdPrefix={testIdPrefix}
        />
      )}

      <Stack
        id={detailsId}
        hidden={!expanded || !hasOptionalFiles}
        gap="item"
        data-testid={`${testIdPrefix}-dependencies-details`}
      >
        {expanded && hasOptionalFiles && (
          <>
            <p className="text-xs fg-secondary">{helperText}</p>

            {showEmptyState && (
              <p
                className="text-xs fg-secondary"
                data-testid={`${testIdPrefix}-dependencies-empty`}
              >
                {emptyDependenciesLabel}
              </p>
            )}

            {resources.length > 0 && (
              <ul
                className="divide-y divide-line-base"
                data-testid={`${testIdPrefix}-dependencies-list`}
              >
                {/* A skill packaged for both providers is one folder, so its
                    per-provider resources share a row and toggle together. */}
                {groupCapabilityPackageProviderTwins(resources).map((group) => {
                  const [resource] = group;
                  if (!resource) return null;
                  const ids = group.map((member) => member.id);
                  return (
                    <DependencyRow
                      key={resource.id}
                      resource={resource}
                      group={group}
                      required={ids.some(
                        (id) =>
                          requiredIds.has(id) ||
                          (selectedClosureIds.has(id) &&
                            !selectedOptionalResourceIds.includes(id)),
                      )}
                      checked={ids.every(
                        (id) =>
                          requiredIds.has(id) || selectedClosureIds.has(id),
                      )}
                      reason={
                        manifest
                          ? describeDependencyReason(manifest, resource.id)
                          : null
                      }
                      bindings={Array.from(
                        new Set(
                          (manifest?.bindings ?? [])
                            .flatMap((binding) =>
                              // A whole-share binding has no location to name:
                              // it *is* the share, so it contributes no label
                              // rather than an empty `.` one.
                              isCapabilityPackageSubjectBinding(binding) ||
                              !binding.resourceIds.some((id) =>
                                ids.includes(id),
                              )
                                ? []
                                : [bindingLabelFor(binding)],
                            )
                            .filter((label): label is string => label !== null),
                        ),
                      )}
                      disabled={disabled}
                      testIdPrefix={testIdPrefix}
                      onToggle={(): void => {
                        for (const id of ids) onToggleOptionalResource(id);
                      }}
                    />
                  );
                })}
              </ul>
            )}

            {requirements.length > 0 && (
              <RecipientSetupList
                requirements={requirements}
                bindingLabelFor={bindingLabelFor}
                testIdPrefix={testIdPrefix}
              />
            )}

            {(analysis.unpackageableSelectionLabels?.length ?? 0) > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-medium fg-primary">
                  Kept private when sharing
                </p>
                <ul
                  className="list-disc pl-5 text-xs fg-secondary"
                  data-testid={`${testIdPrefix}-dependencies-unpackageable`}
                >
                  {analysis.unpackageableSelectionLabels?.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Stack>
    </Stack>
  );
}

function SummaryRow({
  testIdPrefix,
  summary,
  summaryTestId,
  help,
  toggle,
  children,
}: {
  testIdPrefix: string;
  summary: string | null;
  summaryTestId?: string;
  /** Rendered right after the value, or after the heading without one. */
  help?: ReactNode;
  toggle: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="flex items-start justify-between gap-3"
      data-testid={`${testIdPrefix}-dependencies-summary`}
    >
      <div className="min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <Heading level={3} variant="title">
            {INCLUDED_FILES_HEADING}
          </Heading>
          {summary === null && help}
        </div>
        {summary !== null && (
          <div className="flex items-center gap-1">
            <p
              className="text-xs fg-secondary"
              {...(summaryTestId !== undefined
                ? { 'data-testid': summaryTestId }
                : {})}
            >
              {summary}
            </p>
            {help}
          </div>
        )}
        {children}
      </div>
      {toggle}
    </div>
  );
}

interface DependencyRowProps {
  /** The resource whose name and source the row shows. */
  resource: PipelinePackageResource;
  /** Every resource the row stands for, including `resource`. */
  group: readonly PipelinePackageResource[];
  required: boolean;
  checked: boolean;
  reason: string | null;
  /**
   * Pre-formatted location labels for the places this resource is bound.
   * Each host formats its own — pipelines render `job.step`, an automation
   * has exactly one implicit location and passes none.
   */
  bindings: readonly string[];
  disabled: boolean;
  testIdPrefix: string;
  onToggle: () => void;
}

function DependencyRow({
  resource,
  group,
  required,
  checked,
  reason,
  bindings,
  disabled,
  testIdPrefix,
  onToggle,
}: DependencyRowProps): JSX.Element {
  const [showSteps, setShowSteps] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const badge = sourceBadge(resource.sourceVisibility);
  // Each file once, however many provider copies carry it.
  const { files: fileCount, bytes: totalBytes } =
    countCapabilityPackageDistinctFiles(group);
  const executableFiles = formatPipelinePackageExecutableFiles(
    Array.from(
      new Set(group.flatMap(listCapabilityPackageExecutablePaths)),
    ).sort(),
  );

  return (
    <li
      className="py-2"
      data-testid={`${testIdPrefix}-dependencies-item-${resource.id}`}
      data-required={required ? 'true' : 'false'}
    >
      <div className="flex items-start gap-2.5">
        {/* Only an optional file is a choice; a required one says so. The
            placeholder keeps every row's text on one column. */}
        {required ? (
          <span aria-hidden="true" className="h-4 w-4 shrink-0" />
        ) : (
          <Checkbox
            checked={checked}
            disabled={disabled}
            onChange={onToggle}
            aria-label={`Include ${resource.displayName}`}
            className="mt-0.5"
          />
        )}
        <Stack gap="tight" className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-s font-medium fg-primary">
              {resource.displayName}
            </span>
            <Badge>{pipelinePackageKindLabel(resource.kind)}</Badge>
            {badge && <Badge tone="warning">{badge}</Badge>}
          </div>
          <p className="text-xs fg-secondary">
            {resource.sourceLabel} ·{' '}
            {formatPipelinePackageFileSummary(fileCount, totalBytes)}
          </p>
          {executableFiles !== null && (
            <p
              className="text-xs fg-primary"
              data-testid="capability-package-executable-files"
            >
              {executableFiles}
            </p>
          )}
          <div className="flex flex-wrap gap-3 text-xs">
            {bindings.length > 0 && (
              <Button
                variant="link"
                aria-expanded={showSteps}
                onClick={(): void => {
                  setShowSteps((open) => !open);
                }}
              >
                Used by {bindings.length}{' '}
                {bindings.length === 1 ? 'step' : 'steps'}
              </Button>
            )}
            {reason && (
              <Button
                variant="link"
                aria-expanded={showReason}
                onClick={(): void => {
                  setShowReason((open) => !open);
                }}
              >
                Why is this included?
              </Button>
            )}
          </div>
          {showSteps && bindings.length > 0 && (
            <p className="text-xs fg-secondary">
              Used by {bindings.join(', ')}
            </p>
          )}
          {showReason && reason && (
            <p className="text-xs fg-secondary">{reason}</p>
          )}
        </Stack>
        {required && (
          <span className="shrink-0 text-xs fg-tertiary">Required</span>
        )}
      </div>
    </li>
  );
}

function pipelineSourceLabel(
  pipeline: PipelinePackagePackagedPipeline,
): string {
  if (pipeline.isActionPipeline) return ACTION_PIPELINE_LABEL;
  return pipeline.source === 'project' ? 'Project pipeline' : 'Your pipeline';
}

/**
 * The pipelines an automation share packages. A pipeline the prompt names by
 * ID is required; one it only mentions by name is a suggestion the author
 * opts in to, which re-runs the analysis.
 */
function PackagedPipelineList({
  pipelines,
  shippedResourceIds,
  selectedPipelineKeys,
  disabled,
  testIdPrefix,
  onTogglePipeline,
  pipelineAdd,
}: {
  pipelines: readonly PipelinePackagePackagedPipeline[];
  shippedResourceIds: ReadonlySet<string>;
  selectedPipelineKeys: readonly string[];
  disabled: boolean;
  testIdPrefix: string;
  onTogglePipeline?: (key: string) => void;
  pipelineAdd?: CapabilityPackagePipelineAdd;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // A suggestion the author has not ticked is not in the share yet, so it
  // stays addable as a required pipeline.
  const inShare = new Set(
    pipelines
      .filter(
        (pipeline) =>
          !pipeline.optional || selectedPipelineKeys.includes(pipeline.key),
      )
      .map((pipeline) => pipeline.key),
  );
  const addable = (pipelineAdd?.options ?? []).filter(
    (option) => !inShare.has(option.key),
  );
  const add = (id: string): void => {
    if (!pipelineAdd || !id) return;
    setAdding(true);
    setAddError(null);
    pipelineAdd
      .onAdd(id)
      .catch((error: unknown) => {
        setAddError(
          error instanceof Error && error.message.trim()
            ? error.message
            : ADD_PIPELINE_FAILED_LABEL,
        );
      })
      .finally(() => {
        setAdding(false);
      });
  };
  // Rows keep one text column only when some row has a checkbox.
  const anyChoosable =
    onTogglePipeline !== undefined &&
    pipelines.some((pipeline) => pipeline.optional);
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid={`${testIdPrefix}-dependencies-pipelines`}
    >
      <Heading level={4} variant="title">
        {PIPELINES_HEADING}
      </Heading>
      <p className="text-xs fg-secondary">{PIPELINES_HELPER}</p>
      {pipelines.length > 0 && (
        <ul className="divide-y divide-line-base">
          {pipelines.map((pipeline) => {
            const shipped = shippedResourceIds.has(pipeline.resourceId);
            const choosable =
              pipeline.optional && onTogglePipeline !== undefined;
            return (
              <li
                key={pipeline.key}
                className="flex items-start gap-2.5 py-2"
                data-testid={`${testIdPrefix}-dependencies-pipeline-${pipeline.key}`}
                data-required={pipeline.optional ? 'false' : 'true'}
                data-included={shipped ? 'true' : 'false'}
              >
                {choosable ? (
                  <Checkbox
                    checked={selectedPipelineKeys.includes(pipeline.key)}
                    disabled={disabled}
                    onChange={(): void => {
                      onTogglePipeline(pipeline.key);
                    }}
                    aria-label={`Include ${pipeline.name}`}
                    data-testid={`${testIdPrefix}-dependencies-pipeline-toggle-${pipeline.key}`}
                    className="mt-0.5"
                  />
                ) : anyChoosable ? (
                  <span aria-hidden="true" className="h-4 w-4 shrink-0" />
                ) : null}
                <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                  <span className="text-s font-medium fg-primary">
                    {pipeline.name}
                  </span>
                  <p className="text-xs fg-secondary">
                    {pipeline.optional
                      ? SUGGESTED_PIPELINE_HINT
                      : pipelineSourceLabel(pipeline)}
                  </p>
                </div>
                {!pipeline.optional && (
                  <span className="shrink-0 text-xs fg-tertiary">Required</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pipelineAdd !== undefined && addable.length > 0 && (
        // An action menu: nothing stays chosen, the placeholder always shows.
        <SettingsSelect
          value={null}
          placeholder={ADD_PIPELINE_PLACEHOLDER}
          width="fill"
          disabled={disabled || adding}
          onValueChange={(value): void => {
            add(value);
          }}
          aria-label={ADD_PIPELINE_LABEL}
          data-testid={`${testIdPrefix}-dependencies-pipeline-add`}
          options={addable.map((option) => ({
            value: option.id,
            label: option.name,
          }))}
        />
      )}
      {addError !== null && (
        <ErrorBanner
          errorSource="packaged-pipeline-list-add"
          className=""
          error={addError}
          testId={`${testIdPrefix}-dependencies-pipeline-add-error`}
        />
      )}
    </div>
  );
}

interface WithheldItem {
  key: string;
  label: string;
  reason: PipelinePackageWithheldReason;
}

function assetWithheldItem(file: PipelinePackageWithheldFile): WithheldItem {
  return {
    key: `asset\0${file.pipelineKey}\0${file.assetId}\0${file.relativePath}`,
    label: file.relativePath
      ? `${file.assetId}/${file.relativePath}`
      : file.assetId,
    reason: file.reason,
  };
}

function memberWithheldItem(
  file: CapabilityPackageWithheldMemberFile,
): WithheldItem {
  return {
    key: `member\0${file.rootName}\0${file.relativePath}`,
    label: `${file.rootName}/${file.relativePath}`,
    reason: file.reason,
  };
}

/** Files the analysis left out, so the author knows what stays here. */
function WithheldFileList({
  items,
  copy,
  testIdPrefix,
}: {
  items: readonly WithheldItem[];
  copy: { heading: string; helper: string };
  testIdPrefix: string;
}): JSX.Element {
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid={`${testIdPrefix}-dependencies-withheld`}
    >
      <Heading level={4} variant="title">
        {copy.heading}
      </Heading>
      <p className="text-xs fg-secondary">{copy.helper}</p>
      <Stack as="ul" gap="tight">
        {items.map((item) => (
          <li
            key={item.key}
            className="flex flex-wrap items-center gap-1.5 text-xs"
            data-testid={`${testIdPrefix}-dependencies-withheld-item`}
            data-reason={item.reason}
          >
            <span className="min-w-0 break-all fg-primary">{item.label}</span>
            <Badge>{WITHHELD_REASON_LABELS[item.reason]}</Badge>
          </li>
        ))}
      </Stack>
    </div>
  );
}

function RecipientSetupList({
  requirements,
  bindingLabelFor,
  testIdPrefix,
}: {
  testIdPrefix: string;
  requirements: readonly PipelinePackageEnvironmentRequirement[];
  bindingLabelFor: (binding: {
    jobId: string;
    stepId: string;
  }) => string | null;
}): JSX.Element {
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid={`${testIdPrefix}-dependencies-recipient-setup`}
    >
      <Heading level={4} variant="title">
        {PIPELINE_PACKAGE_PUBLISHER_SETUP_HEADING}
      </Heading>
      <p className="text-xs fg-secondary">
        {PIPELINE_PACKAGE_PUBLISHER_NO_CREDENTIALS_NOTE}
      </p>
      <Stack as="ul" gap="tight">
        {requirements.map((requirement) => {
          const locations = requirement.affectedSteps
            .map(bindingLabelFor)
            .filter((label): label is string => label !== null);
          return (
            <Surface as="li" variant="inset" key={requirement.id}>
              <div className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-s fg-primary">
                    {requirement.displayName}
                  </span>
                  <Badge>
                    {pipelinePackageRequirementKindLabel(requirement.kind)}
                  </Badge>
                  {requirement.required && <Badge>Required</Badge>}
                </div>
                <p className="mt-0.5 text-xs fg-secondary">
                  {requirement.setupHint}
                </p>
                {locations.length > 0 && (
                  <p className="mt-0.5 text-xs fg-secondary">
                    Affects {locations.join(', ')}
                  </p>
                )}
              </div>
            </Surface>
          );
        })}
      </Stack>
    </div>
  );
}
