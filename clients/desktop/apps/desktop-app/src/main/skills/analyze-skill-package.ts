import type { AnalyzeSkillCapabilityPackageRequest } from '@canopy/desktop-shared/types/skills';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import type { AnalyzeSkillCapabilityPackageInput } from '../pipelines/pipeline-package-service';

export interface AnalyzeSkillFromDiskDeps {
  /** SKILL.md as stored for `sourceId/skillName`; throws when it isn't one. */
  readonly readRawSkill: (skillId: string) => Promise<string>;
  readonly analyze: (
    input: AnalyzeSkillCapabilityPackageInput,
  ) => Promise<PipelinePackageAnalysisSummary>;
}

export class SkillChangedSinceReadError extends Error {
  constructor() {
    super('This skill changed since it was read. Review it again.');
    this.name = 'SkillChangedSinceReadError';
  }
}

/**
 * Analyses a skill the renderer names from the SKILL.md main reads for it
 * (CAN-6403): the renderer's copy is only the one it shows the person, so it
 * must be that same file, or nothing is analysed. An analysis is then always
 * of the named skill's own bytes, and another skill's can't be passed off as
 * its content.
 */
export async function analyzeSkillFromDisk(
  request: AnalyzeSkillCapabilityPackageRequest,
  deps: AnalyzeSkillFromDiskDeps,
): Promise<PipelinePackageAnalysisSummary> {
  const rawSkill = await deps.readRawSkill(
    `${request.sourceId}/${request.skillName}`,
  );
  if (request.rawSkill !== rawSkill) throw new SkillChangedSinceReadError();
  // Only the documented fields: a renderer sets nothing else on an analysis.
  return deps.analyze({
    sourceId: request.sourceId,
    skillName: request.skillName,
    rawSkill,
    ...(request.worktree === undefined ? {} : { worktree: request.worktree }),
    ...(request.dismissedInvocations === undefined
      ? {}
      : { dismissedInvocations: request.dismissedInvocations }),
  });
}
