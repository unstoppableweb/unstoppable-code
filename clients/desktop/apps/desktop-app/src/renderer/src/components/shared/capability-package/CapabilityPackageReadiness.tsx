import { Badge, type BadgeTone } from '@canopy/ui-shared/primitives/Badge';
import { useCallback, useState, type JSX } from 'react';
import {
  formatPipelinePackageSteps,
  formatPipelinePackageExecutableFiles,
  pipelinePackageKindLabel,
  PIPELINE_PACKAGE_INCLUDED_HEADING,
  pipelinePackageRequirementKindLabel,
  PIPELINE_PACKAGE_NOT_INCLUDED_HEADING,
  PIPELINE_PACKAGE_PUBLISHER_NOTE,
  PIPELINE_PACKAGE_SETUP_HEADING,
} from '@canopy/ui-shared/lib/pipeline-package-display';
import { Button } from '@/components/shared/Button';
import type { PipelinePackageReadiness as PipelinePackageReadinessData } from '@canopy/execution-engine/types/pipeline';
import {
  Stack,
  Heading,
  StatusLabel,
  Surface,
} from '@canopy/ui-shared/components';

/**
 * Local readiness of a pipeline's packaged content, shown before Run
 * (Phase 5.4/5.5). Reports which recipient environment requirements are
 * available, missing, or unknown against the *local* machine. An `unknown`
 * check is never presented as available, and an embedded skill/command is
 * never reported missing just because its original private marketplace is
 * absent — that distinction is made by the main-process readiness service.
 */

const UNKNOWN_NOTE = 'Could not be checked on this machine.';

const STATUS_LABELS: Record<
  PipelinePackageReadinessData['requirements'][number]['status'],
  string
> = {
  available: 'Available',
  missing: 'Missing',
  unknown: 'Unknown',
};

const STATUS_TONES: Record<
  PipelinePackageReadinessData['requirements'][number]['status'],
  BadgeTone
> = {
  available: 'info',
  missing: 'danger',
  unknown: 'warning',
};

interface CapabilityPackageReadinessProps {
  readiness: PipelinePackageReadinessData | null;
  /** Definition-only pipelines cannot claim package readiness. */
  definitionOnly?: boolean;
  subjectLabel?:
    | 'pipeline'
    | 'automation'
    | 'skill'
    | 'agent'
    | 'collection'
    | 'project template'
    | 'session';
  /** Keep locally available requirements visible in explicit install reviews. */
  showAvailableRequirements?: boolean;
  stepLabelFor?: typeof formatPipelinePackageSteps;
}

export function CapabilityPackageReadiness({
  readiness,
  definitionOnly = false,
  subjectLabel = 'pipeline',
  showAvailableRequirements = false,
  stepLabelFor = formatPipelinePackageSteps,
}: CapabilityPackageReadinessProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const focusSection = useCallback((): void => {
    setExpanded(true);
  }, []);

  if (!readiness) return null;
  const isDefinitionOnly =
    definitionOnly || readiness.distributionMode === 'definition_only';
  const actionable = readiness.requirements.filter(
    (requirement) => requirement.status !== 'available',
  );
  const publisherNotes = readiness.publisherNotes ?? [];
  const includedResources = readiness.includedResources ?? [];
  // A skill's requirements are what its instructions name, and none of them
  // blocks it, so the skill note does not claim it cannot run without them.
  // `pipeline` is the subject id; users call it a workflow (CAN-4651).
  const subjectNoun = subjectLabel === 'pipeline' ? 'workflow' : subjectLabel;
  const setupNote =
    subjectLabel === 'skill'
      ? 'This skill uses these. Set them up before you run it.'
      : subjectLabel === 'pipeline' || subjectLabel === 'automation'
        ? `This ${subjectNoun} needs the following on this machine before it can run.`
        : `This ${subjectNoun} needs the following setup on this machine before it can be used.`;
  const invalidLabel = `This ${subjectNoun}’s packaged dependencies could not be verified.`;
  const showReadinessReview =
    readiness.status !== 'ready' ||
    actionable.length > 0 ||
    isDefinitionOnly ||
    (showAvailableRequirements && readiness.requirements.length > 0);
  if (
    !showReadinessReview &&
    publisherNotes.length === 0 &&
    includedResources.length === 0
  )
    return null;

  return (
    <Surface
      as="section"
      variant="inset"
      className=""
      data-testid="pipeline-trigger-modal-package-readiness"
      data-status={readiness.status}
    >
      <div className="flex flex-col gap-3 px-3 py-2.5">
        {includedResources.length > 0 && (
          <Stack
            gap="inline"
            data-testid="capability-package-included-resources"
          >
            <Stack gap="tight">
              <Heading level={3} variant="title">
                {PIPELINE_PACKAGE_INCLUDED_HEADING}
              </Heading>
              <p className="text-xs fg-secondary">
                {`These capabilities are included with this ${subjectNoun}.`}
              </p>
            </Stack>
            <ul className="flex flex-col gap-1">
              {includedResources.map((resource) => (
                <li key={resource.id} className="text-xs fg-primary">
                  {resource.displayName}
                  <span className="fg-secondary">
                    {' · '}
                    {pipelinePackageKindLabel(resource.kind)}
                  </span>
                  {formatPipelinePackageExecutableFiles(
                    resource.executableFiles ?? [],
                  ) && (
                    <span className="block fg-warning">
                      {formatPipelinePackageExecutableFiles(
                        resource.executableFiles ?? [],
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Stack>
        )}
        {showReadinessReview && (
          <Stack gap="inline">
            <Stack gap="tight">
              <div className="flex items-center justify-between gap-2">
                <Heading level={3} variant="title">
                  {PIPELINE_PACKAGE_SETUP_HEADING}
                </Heading>
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={focusSection}
                  aria-expanded={expanded}
                  data-testid="pipeline-trigger-modal-review-setup"
                >
                  Review setup
                </Button>
              </div>
              <p className="text-xs fg-secondary">{setupNote}</p>
              {readiness.status === 'invalid' && (
                <p className="text-xs">
                  <StatusLabel>{invalidLabel}</StatusLabel>
                </p>
              )}
              {isDefinitionOnly && (
                <p
                  className="text-xs fg-warning"
                  data-testid="pipeline-trigger-modal-definition-only-note"
                >
                  {`This ${subjectNoun} was installed from a definition-only share, so its required dependencies are not included.`}
                </p>
              )}
            </Stack>
            <ul className="flex flex-col gap-1">
              {(expanded || showAvailableRequirements
                ? readiness.requirements
                : actionable
              ).map((requirement) => (
                <li
                  key={requirement.id}
                  data-testid={`pipeline-readiness-${requirement.id}`}
                  data-requirement-status={requirement.status}
                  className="flex flex-wrap items-center gap-1.5 text-xs"
                >
                  <span className="fg-primary">{requirement.displayName}</span>
                  <span className="fg-secondary">
                    {pipelinePackageRequirementKindLabel(requirement.kind)}
                  </span>
                  <Badge tone={STATUS_TONES[requirement.status]}>
                    {STATUS_LABELS[requirement.status]}
                  </Badge>
                  <span className="w-full fg-secondary">
                    {requirement.status === 'unknown'
                      ? UNKNOWN_NOTE
                      : (requirement.detail ?? requirement.setupHint)}
                  </span>
                  {requirement.affectedSteps.length > 0 && (
                    <span className="w-full fg-secondary">
                      Affects {stepLabelFor(requirement.affectedSteps)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Stack>
        )}

        {publisherNotes.length > 0 && (
          <Stack gap="inline" data-testid="pipeline-package-publisher-notes">
            <Stack gap="tight">
              <Heading level={3} variant="title">
                {PIPELINE_PACKAGE_NOT_INCLUDED_HEADING}
              </Heading>
              <p className="text-xs fg-secondary">
                {PIPELINE_PACKAGE_PUBLISHER_NOTE}
              </p>
            </Stack>
            <ul className="flex flex-col gap-1">
              {publisherNotes.map((note) => (
                <li key={note.id} className="text-xs">
                  <span className="fg-primary">{note.label}</span>
                  {note.affectedSteps.length > 0 && (
                    <span className="block fg-secondary">
                      Used by {stepLabelFor(note.affectedSteps)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Stack>
        )}
      </div>
    </Surface>
  );
}
