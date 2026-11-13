/**
 * A chat automation installed with a capability package, converted to a
 * pipeline it owns (CAN-5479). What its native prompt did with the package
 * stays:
 *
 * - every run verifies the install (its record, digest pin, cached package
 *   and action binding) before the pipeline starts, and fails as the native
 *   prompt did;
 * - the generated send step resolves the package's skills and plugins again
 *   for the chat it creates, so the run's state never holds a package path;
 * - the conversion repins the install to the chat action the automation now
 *   shows, so a re-share of an unchanged install still matches it.
 *
 * The send step gets the package only as the converter generated it: the
 * `chat` job's `send` step, in a top-level run the automation started of the
 * pipeline it owns. A session prompt, which sends to an existing chat, never
 * carried the package natively, and doesn't here either.
 *
 * CAN-6065: another schedule of the installed workflow page runs with its
 * owner's install, verified and resolved under the owner's id, so a package
 * update or uninstall of the owner covers every schedule.
 */
import path from 'node:path';
import { CHAT_AUTOMATION_JOB } from '@canopy/desktop-shared/lib/chat-automation-conversion';
import { hashPipelinePackageYaml } from '@canopy/execution-engine/node/pipelines/package-contract';
import type { PipelineHostActionCaller } from '@canopy/execution-engine/node/pipelines/executor/types';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { PipelinePackageCapabilityOverlay } from '@canopy/execution-engine/types/pipeline';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  scheduledUserPipelineId,
  scheduleInstall,
  type ScheduleInstall,
} from './workflow-schedules';

/** The converter's send step (`STEP.send` in the converter). */
export const CHAT_AUTOMATION_SEND_STEP = 'send';

/**
 * The install a run of the activity's workflow applies (its own as owner,
 * else its owner's), when the pipeline creates the chat it sends to.
 */
function ownedPipelinePackage(
  activities: readonly ScheduledActivity[],
  activity: ScheduledActivity,
): ScheduleInstall | undefined {
  const { action } = activity;
  if (
    action.type !== 'worktree_pipeline' ||
    action.inputs?.chat_id !== undefined
  )
    return undefined;
  return scheduleInstall(activities, activity);
}

/** Fails a run of a converted install whose package isn't intact, before it starts. */
export async function verifyOwnedPipelinePackage(
  activities: readonly ScheduledActivity[],
  activity: ScheduledActivity,
): Promise<void> {
  const install = ownedPipelinePackage(activities, activity);
  if (install === undefined) return;
  const { resolveInstalledAutomationPackageOverlay } =
    await import('../pipelines/pipeline-package-service');
  await resolveInstalledAutomationPackageOverlay(
    install.holder.id,
    install.required,
  );
}

export type OwnedPipelineSendCaller = Pick<
  PipelineHostActionCaller,
  'executionId' | 'pipelineId' | 'jobId' | 'stepId' | 'childId' | 'initiator'
>;

/** Whether the execution is a top-level run or a nested one, from its state. */
async function runLineage(
  executionId: string,
): Promise<'top-level' | 'nested' | 'unreadable'> {
  const [{ loadExecutionState }, { getDataDir }] = await Promise.all([
    import('@canopy/execution-engine/node/pipelines/executor/execution-state'),
    import('../lib/paths'),
  ]);
  const state = await loadExecutionState(
    executionId,
    path.join(getDataDir(), 'pipeline-executions'),
  ).catch(() => null);
  if (state === null) return 'unreadable';
  return state.parent_execution_id === undefined ? 'top-level' : 'nested';
}

/**
 * The package overlay for a send step that creates a chat, or `undefined`
 * when the step isn't a converted install's generated send. Throws, as the
 * native prompt did, when the install's package isn't intact.
 */
export async function ownedPipelineSendPackageOverlay(
  caller: OwnedPipelineSendCaller,
): Promise<PipelinePackageCapabilityOverlay | undefined> {
  const { initiator } = caller;
  if (
    initiator?.kind !== 'automation' ||
    caller.jobId !== CHAT_AUTOMATION_JOB ||
    caller.stepId !== CHAT_AUTOMATION_SEND_STEP ||
    caller.childId !== undefined ||
    caller.pipelineId === undefined
  )
    return undefined;
  const { getAutomationsService } = await import('./service');
  const service = getAutomationsService();
  const activity = await service.findActivityForBackgroundAuthorization(
    initiator.automationId,
  );
  if (activity === undefined) return undefined;
  const install = ownedPipelinePackage(await service.allActivities(), activity);
  if (
    install === undefined ||
    scheduledUserPipelineId(activity) !== caller.pipelineId
  )
    return undefined;
  const lineage = await runLineage(caller.executionId);
  if (lineage === 'nested') return undefined;
  // Never a send without the package the automation was installed with.
  if (lineage === 'unreadable')
    throw new Error(
      'This automation’s run could not be read to apply its capability package. Run it again.',
    );
  const { resolveInstalledAutomationPackageOverlay } =
    await import('../pipelines/pipeline-package-service');
  return resolveInstalledAutomationPackageOverlay(
    install.holder.id,
    install.required,
  );
}

/** What a share hashes: the automation's name and action, as it shows them. */
function shareContentHash(activity: ScheduledActivity): string {
  return hashPipelinePackageYaml(
    JSON.stringify({ name: activity.name, action: activity.action }),
  );
}

/**
 * Repins the install of `native`, now `converted`, from the native action to
 * the chat action the converted automation shows, while the install still
 * pins the native one. A failure is logged: the automation runs either way,
 * and its re-share asks for a reinstall.
 */
export async function repinConvertedPackageInstall(
  native: ScheduledActivity,
  converted: ScheduledActivity,
): Promise<void> {
  if (native.installedFrom?.capabilityPackage === undefined) return;
  try {
    const { projectOwnedChatAutomation } =
      await import('./owned-chat-projection');
    const shown = projectOwnedChatAutomation(converted);
    if (shown.action.type === 'worktree_pipeline') return;
    const expected = shareContentHash(native);
    const next = shareContentHash(shown);
    if (expected === next) return;
    const { repinAutomationCapabilityPackageContent } =
      await import('../pipelines/pipeline-package-service');
    await repinAutomationCapabilityPackageContent(native.id, expected, next);
  } catch {
    logMainProcessWarn('Kept an automation’s package pin; it could not move', {
      operation: 'repin-converted-package-install',
    });
  }
}
