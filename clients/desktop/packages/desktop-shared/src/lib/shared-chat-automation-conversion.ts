/**
 * A shared chat automation document as the workflow document a desktop would
 * share for it once converted (CAN-6455). The one-off conversion of server
 * share records and curated entries runs this over each stored document.
 *
 * It takes the path a recipient's copy takes, so a converted record matches
 * what an installed and converted copy would re-share:
 *
 * 1. the install mapping turns the document into a local chat automation,
 *    with placeholder project bindings, as `buildInstallAutomationRequest`
 *    does for a recipient;
 * 2. the chat automation converter turns that into its workflow, its shared
 *    plugins becoming the workflow's `chat_plugins` defaults;
 * 3. the share builder turns the workflow automation into its document, the
 *    workflow inline and its input values stripped, so no placeholder leaves.
 *
 * A document whose meaning the workflow form can't carry exactly is refused
 * and left as it is: one installed with a capability package or with packaged
 * prompt dependencies (installs of those stay chat actions too), one with
 * repository file references or a branch suggestion, which only the install
 * dialog binds, and one the chat converter refuses.
 *
 * Given the package's manifest (`packageManifest`), a document with a
 * capability package converts too: its package is rebound to the workflow's
 * send step and keyed to the workflow, and the converted document points at
 * the rebound package. Storing that package is the caller's job.
 */
import {
  sharedChatDocumentRefusal,
  validateSharedAutomationDocument,
  type SharedAutomationAction,
  type SharedAutomationDocument,
  type SharedChatDocumentRefusal,
} from '@canopy/protocol/automations';
import type { ShareablePluginRef } from '@canopy/protocol/plugins';
import {
  computePipelinePackageDigest,
  isCapabilityPackageManifest,
  type PipelinePackageManifestV1,
  type PipelinePackageRef,
} from '@canopy/protocol/pipelines';
import type { PipelinePluginDefault } from '@canopy/execution-engine/types/pipeline';
import type {
  AutomationAction,
  ChatTabPluginSelections,
  ScheduledActivity,
} from '../types';
import { buildInstallAutomationRequest } from './automation-install';
import { buildSharedAutomationDocument } from './automation-sharing';
import {
  hashPipelineDocumentYaml,
  serializePipelineDocument,
} from './automation-share/pipeline-document';
import { rebindChatAutomationPackage } from './chat-automation-package-rebind';
import {
  chatAutomationToPipeline,
  convertibleChatAutomation,
  type ChatAutomationConversionRefusal,
  type ChatPluginSelection,
} from './chat-automation-conversion';

/** Why a shared chat automation stays as it is. */
export type SharedChatAutomationRefusal =
  /** Not a valid shared automation document. */
  | 'invalid_document'
  /**
   * Its meaning can't travel in the workflow form, by the protocol's rule:
   * a capability package, packaged prompt dependencies, a file reference, a
   * branch suggestion or another run restriction than its action implies.
   */
  | SharedChatDocumentRefusal
  /** The manifest given for its package isn't the one it names. */
  | 'package_mismatch'
  /** Its package can't be rebound to the workflow. */
  | 'package_rebind'
  /** The install mapping refused the document. */
  | 'install_mapping'
  /** The share builder refused the converted workflow automation. */
  | 'share_document'
  | Exclude<ChatAutomationConversionRefusal, 'not_a_chat_action'>;

export type SharedChatAutomationConversion =
  /** Not a chat automation; nothing to convert. */
  | { status: 'not_chat' }
  | {
      status: 'refused';
      reason: SharedChatAutomationRefusal;
      /** Validator or mapping text, when there is any. */
      detail?: string;
    }
  | {
      status: 'converted';
      document: SharedAutomationDocument;
      /**
       * The rebound package the converted document names, when the document
       * had a capability package. The caller stores it before the document.
       */
      packageManifest?: PipelinePackageManifestV1;
    };

export interface ConvertSharedChatAutomationOptions {
  /**
   * The manifest of the document's capability package. Without it a packaged
   * document is refused (`capability_package`).
   */
  packageManifest?: unknown;
  /**
   * Converts a worktree prompt as one that sends into an existing worktree,
   * as a shared container's fork runs it (CAN-6455): the workflow takes a
   * `task_id` input, which the fork binds to its own worktree. Other actions
   * convert as they would without it.
   */
  existingTask?: boolean;
}

type SharedChatAction = Exclude<
  SharedAutomationAction,
  { type: 'worktree_pipeline' }
>;

/** Stands in for the project a recipient would choose; never shared. */
const PLACEHOLDER_PROJECT_ID = 'shared-chat-automation-conversion-project';
/** Stands in for the worktree a fork binds; never shared. */
const PLACEHOLDER_TASK_ID = 'shared-chat-automation-conversion-task';
/** Stands in for the source of a shared plugin; never shared. */
const PLACEHOLDER_PLUGIN_SOURCE = 'shared-chat-automation-plugin';
/** Stands in for a declined run condition, which keeps `hasRunCondition`. */
const DECLINED_RUN_CONDITION = 'true';
/** A fixed time, so a conversion depends on the document alone. */
const CONVERTED_AT = '1970-01-01T00:00:00.000Z';

function isChatAction(
  action: SharedAutomationAction,
): action is SharedChatAction {
  return action.type !== 'worktree_pipeline';
}

function refuse(
  reason: SharedChatAutomationRefusal,
  detail?: string,
): SharedChatAutomationConversion {
  return {
    status: 'refused',
    reason,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * The shared plugins as local selections that stand for them, and the
 * portability that turns each back into its ref: every shared plugin travels,
 * so each one is a `chat_plugins` default.
 */
function sharedPluginSelections(plugins: readonly ShareablePluginRef[]): {
  selections?: ChatTabPluginSelections;
  portable: (
    selection: ChatPluginSelection,
  ) => PipelinePluginDefault | undefined;
} {
  const refs = new Map<string, PipelinePluginDefault>();
  const selections: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    mcpHttpAuthPreferences: [],
  };
  plugins.forEach((ref, index) => {
    const name = `ref-${String(index)}`;
    if (ref.type === 'skill') {
      selections.skillRefs.push({
        sourceId: PLACEHOLDER_PLUGIN_SOURCE,
        skillName: name,
      });
      refs.set(`skill:${name}`, ref);
    } else {
      selections.pluginRefs.push({
        marketplaceId: PLACEHOLDER_PLUGIN_SOURCE,
        pluginName: name,
      });
      refs.set(`plugin:${name}`, ref);
    }
  });
  return {
    ...(plugins.length > 0 ? { selections } : {}),
    portable: (selection) =>
      selection.kind === 'skill'
        ? selection.sourceId === PLACEHOLDER_PLUGIN_SOURCE
          ? refs.get(`skill:${selection.skillName}`)
          : undefined
        : selection.marketplaceId === PLACEHOLDER_PLUGIN_SOURCE
          ? refs.get(`plugin:${selection.pluginName}`)
          : undefined,
  };
}

function scheduledActivity(
  document: SharedAutomationDocument,
  action: AutomationAction,
): ScheduledActivity {
  const runCondition =
    document.runCondition?.command ??
    (document.hasRunCondition ? DECLINED_RUN_CONDITION : undefined);
  return {
    version: 1,
    id: 'shared-chat-automation-conversion',
    name: document.name,
    enabled: false,
    schedule:
      document.trigger.kind === 'cron'
        ? {
            kind: 'cron',
            expression: document.trigger.expression,
            timezone: 'local',
          }
        : {
            kind: 'one_time',
            runAt: document.trigger.runAt,
            timezone: 'local',
          },
    action,
    createdAt: CONVERTED_AT,
    updatedAt: CONVERTED_AT,
    failureCount: 0,
    ...(runCondition !== undefined ? { ifCommand: runCondition } : {}),
  };
}

/**
 * The manifest given for `required`, once it is the one `required` names.
 */
async function namedManifest(
  required: PipelinePackageRef,
  manifest: unknown,
): Promise<PipelinePackageManifestV1 | null> {
  if (!isCapabilityPackageManifest(manifest)) return null;
  return (await computePipelinePackageDigest(manifest)) === required.digest
    ? manifest
    : null;
}

/**
 * A stored document as the workflow document its converted copy shares, or
 * why it stays as it is. Never throws for a document's content.
 */
export async function convertSharedChatAutomation(
  stored: unknown,
  options: ConvertSharedChatAutomationOptions = {},
): Promise<SharedChatAutomationConversion> {
  const validated = validateSharedAutomationDocument(stored);
  if (!validated.ok) return refuse('invalid_document', validated.error);
  const { document } = validated;
  const { action } = document;
  if (!isChatAction(action)) return { status: 'not_chat' };
  const refusal = sharedChatDocumentRefusal(document, {
    rebindsPackage: options.packageManifest !== undefined,
  });
  if (refusal !== null) return refuse(refusal);
  let sourcePackage: PipelinePackageManifestV1 | undefined;
  if (document.capabilityPackage !== undefined) {
    const named = await namedManifest(
      document.capabilityPackage,
      options.packageManifest,
    );
    if (named === null)
      return refuse(
        'package_mismatch',
        'The manifest is not the package the document names.',
      );
    sourcePackage = named;
  }

  // 1. The local chat automation a recipient's install would create.
  const plugins = sharedPluginSelections(action.plugins);
  const installed = buildInstallAutomationRequest(
    {
      id: 'shared-chat-automation-conversion',
      contentHash: '',
      automation: document,
    },
    {
      ...(action.type === 'worktree_prompt'
        ? { workspaceId: PLACEHOLDER_PROJECT_ID, targetKind: 'single-repo' }
        : action.type === 'standalone_prompt'
          ? { coworkWorkspaceId: PLACEHOLDER_PROJECT_ID, targetKind: 'cowork' }
          : {}),
      ...(plugins.selections !== undefined
        ? { pluginSelections: plugins.selections }
        : {}),
    },
    CONVERTED_AT,
  );
  if (!installed.ok) return refuse('install_mapping', installed.error);
  const installedAction = installed.request.action;
  const chat = scheduledActivity(
    document,
    options.existingTask === true && installedAction.type === 'worktree_prompt'
      ? { ...installedAction, existingWorktreeId: PLACEHOLDER_TASK_ID }
      : installedAction,
  );
  const convertible = convertibleChatAutomation(chat);
  if (!convertible.convertible)
    return convertible.reason === 'not_a_chat_action'
      ? refuse(
          'install_mapping',
          'The install mapping produced no chat action.',
        )
      : refuse(convertible.reason);

  // 2. Its workflow, as the chat automation converter writes it.
  // CAN-5782: Manual alone, which curated records still require
  // (curated publication of Workflow is deferred). An installed copy stays
  // Manual-only until a person turns Workflow on.
  const converted = chatAutomationToPipeline(chat, {
    portable: plugins.portable,
    triggers: ['dispatch'],
  });
  const rawPipeline = serializePipelineDocument(converted.pipeline);
  const pipelineContentHash = await hashPipelineDocumentYaml(rawPipeline);
  if (pipelineContentHash === null)
    return refuse('share_document', 'The workflow could not be hashed.');

  // 3. Its package, bound to the workflow's send step and keyed to it.
  let rebound:
    | { manifest: PipelinePackageManifestV1; packageRef: PipelinePackageRef }
    | undefined;
  if (sourcePackage !== undefined) {
    const result = await rebindChatAutomationPackage(
      sourcePackage,
      rawPipeline,
    );
    if (!result.ok)
      return refuse(
        'package_rebind',
        result.detail !== undefined
          ? `${result.reason}: ${result.detail}`
          : result.reason,
      );
    rebound = { manifest: result.manifest, packageRef: result.packageRef };
  }

  // 4. The document the converted copy shares.
  const shared = buildSharedAutomationDocument(
    scheduledActivity(document, {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId: 'shared-chat-automation-conversion',
      pipelineSource: 'user',
      pipelineName: converted.pipeline.name,
      inputs: converted.inputs,
    }),
    {
      description: document.description,
      pipelineRawContent: rawPipeline,
      pipelineContentHash,
      includeRunCondition: document.runCondition !== undefined,
      ...(rebound !== undefined
        ? { capabilityPackage: rebound.packageRef }
        : {}),
    },
  );
  if (!shared.ok)
    return refuse('share_document', shared.detail ?? shared.reasons.join(', '));
  return {
    status: 'converted',
    document: shared.document,
    ...(rebound !== undefined ? { packageManifest: rebound.manifest } : {}),
  };
}

/**
 * The workflow form a desktop shares in place of a chat document it built
 * (CAN-6455), or `null` when the shared converter refuses the document: the
 * chat form is shared then, as before. A document with a capability package
 * is refused here, as its package binds the chat action.
 */
export async function sharedWorkflowForm(
  document: SharedAutomationDocument,
): Promise<SharedAutomationDocument | null> {
  const converted = await convertSharedChatAutomation(document);
  return converted.status === 'converted' ? converted.document : null;
}
