/**
 * A chat automation's capability package as the package its converted
 * workflow needs (CAN-6455 follow-up, phase 01).
 *
 * A chat automation's package binds its skills and plugins to the chat
 * action (`automation/action`) and is keyed to the shared document. Once
 * converted, the automation runs the converter's workflow, whose `chat` job's
 * `send` step creates the chat. A shared workflow's package binds to its real
 * steps and is keyed to the workflow YAML, so the desktop verifies it against
 * the bundled workflow and gives the send step the resources bound to it.
 *
 * The rebound package keeps every resource and file tree as it is (so the
 * stored files can be reused), moves the action binding to `chat/send`, keys
 * the manifest to the converted YAML and recomputes the fingerprint. A
 * package that holds anything a chat action's package can't (a packaged
 * pipeline, a definition, a binding to another step) is refused.
 */
import {
  computePipelinePackageDigest,
  isCapabilityPackageManifest,
  validatePipelinePackageManifest,
  type PipelinePackageBinding,
  type PipelinePackageManifestV1,
  type PipelinePackageRef,
  type PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import { hashPipelineDocumentYaml } from './automation-share/pipeline-document';
import { CHAT_AUTOMATION_JOB } from './chat-automation-conversion';

/** The binding a chat automation's package uses for its action. */
const ACTION_JOB = 'automation';
const ACTION_STEP = 'action';
/** The converter's send step (`STEP.send` in the converter). */
const SEND_STEP = 'send';

/** Resource kinds a chat action's package carries: skills and plugin parts. */
const CHAT_RESOURCE_KINDS: ReadonlySet<PipelinePackageResource['kind']> =
  new Set([
    'standalone_skill',
    'plugin_skill',
    'plugin_command',
    'plugin_agent',
  ]);

export type ChatAutomationPackageRebindRefusal =
  /** The manifest isn't a valid package manifest. */
  | 'invalid_manifest'
  /** A resource a chat action's package doesn't carry, such as a pipeline. */
  | 'unsupported_resource'
  /** A binding, requirement or note on something other than the action. */
  | 'unexpected_binding'
  /** The converted workflow couldn't be hashed. */
  | 'unhashable_pipeline'
  /** The rebound manifest didn't validate. */
  | 'invalid_rebound_manifest';

export type ChatAutomationPackageRebind =
  | {
      ok: true;
      manifest: PipelinePackageManifestV1;
      packageRef: PipelinePackageRef;
    }
  | {
      ok: false;
      reason: ChatAutomationPackageRebindRefusal;
      detail?: string;
    };

function refuse(
  reason: ChatAutomationPackageRebindRefusal,
  detail?: string,
): ChatAutomationPackageRebind {
  return { ok: false, reason, ...(detail !== undefined ? { detail } : {}) };
}

function isActionStep(step: { jobId: string; stepId: string }): boolean {
  return step.jobId === ACTION_JOB && step.stepId === ACTION_STEP;
}

/** `steps` on the action, as the send step; `null` when one is elsewhere. */
function sendSteps(
  steps: ReadonlyArray<{ jobId: string; stepId: string }>,
): Array<{ jobId: string; stepId: string }> | null {
  if (!steps.every(isActionStep)) return null;
  return steps.length > 0
    ? [{ jobId: CHAT_AUTOMATION_JOB, stepId: SEND_STEP }]
    : [];
}

/** Each id once, in first-seen order. */
function unique(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

/**
 * The package `manifest` (a chat automation's) as the package the workflow
 * `convertedPipelineYaml` needs, with its fingerprint. Pure: the same inputs
 * always give the same manifest and fingerprint.
 */
export async function rebindChatAutomationPackage(
  manifest: unknown,
  convertedPipelineYaml: string,
): Promise<ChatAutomationPackageRebind> {
  if (!isCapabilityPackageManifest(manifest)) {
    const validated = validatePipelinePackageManifest(manifest);
    return refuse(
      'invalid_manifest',
      validated.ok ? undefined : validated.errors.join('; '),
    );
  }
  const source = manifest;

  const unsupported = source.resources.find(
    (resource) => !CHAT_RESOURCE_KINDS.has(resource.kind),
  );
  if (unsupported !== undefined)
    return refuse(
      'unsupported_resource',
      `${unsupported.id} is a ${unsupported.kind}.`,
    );

  const boundIds: string[] = [];
  for (const binding of source.bindings) {
    if (!('jobId' in binding) || !isActionStep(binding))
      return refuse(
        'unexpected_binding',
        'A binding names something other than the chat action.',
      );
    boundIds.push(...binding.resourceIds);
  }
  const bindings: PipelinePackageBinding[] =
    boundIds.length > 0
      ? [
          {
            jobId: CHAT_AUTOMATION_JOB,
            stepId: SEND_STEP,
            resourceIds: unique(boundIds),
          },
        ]
      : [];

  const environmentRequirements: PipelinePackageManifestV1['environmentRequirements'] =
    [];
  for (const requirement of source.environmentRequirements) {
    const affectedSteps = sendSteps(requirement.affectedSteps);
    if (affectedSteps === null)
      return refuse(
        'unexpected_binding',
        `Requirement ${requirement.id} names a step other than the chat action.`,
      );
    environmentRequirements.push({ ...requirement, affectedSteps });
  }
  const publisherNotes: NonNullable<
    PipelinePackageManifestV1['publisherNotes']
  > = [];
  for (const note of source.publisherNotes ?? []) {
    const affectedSteps = sendSteps(note.affectedSteps);
    if (affectedSteps === null)
      return refuse(
        'unexpected_binding',
        `Note ${note.id} names a step other than the chat action.`,
      );
    publisherNotes.push({ ...note, affectedSteps });
  }

  const pipelineContentHash = await hashPipelineDocumentYaml(
    convertedPipelineYaml,
  );
  if (pipelineContentHash === null) return refuse('unhashable_pipeline');

  const rebound: PipelinePackageManifestV1 = {
    version: source.version,
    pipelineContentHash,
    resources: source.resources,
    bindings,
    environmentRequirements,
    ...(source.publisherNotes !== undefined ? { publisherNotes } : {}),
    totalFiles: source.totalFiles,
    totalBytes: source.totalBytes,
  };
  const checked = validatePipelinePackageManifest(rebound);
  if (!checked.ok)
    return refuse('invalid_rebound_manifest', checked.errors.join('; '));
  return {
    ok: true,
    manifest: rebound,
    packageRef: {
      version: 1,
      digest: await computePipelinePackageDigest(rebound),
    },
  };
}
