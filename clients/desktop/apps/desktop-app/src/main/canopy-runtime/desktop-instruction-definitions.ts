import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CORE_COWORK_FOLDER_INSTRUCTIONS,
  CORE_CATALOG_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS,
  CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS,
  CORE_CHAT_TRANSFER_INSTRUCTION_DEFINITIONS,
  CORE_MEMORY_INSTRUCTION_DEFINITIONS,
  CORE_MEMORY_MAINTENANCE_INSTRUCTION_DEFINITIONS,
  CORE_ARCHIVE_INSTRUCTION_DEFINITIONS,
  CORE_CONFIG_INSTRUCTION_DEFINITIONS,
  CORE_INITIATED_WORK_WATCHER_INSTRUCTION_DEFINITIONS,
  CORE_AGENT_DEFERRED_TOOLS_INSTRUCTION_DEFINITIONS,
  CORE_CHAT_VISUAL_STAGE_INSTRUCTION_DEFINITIONS,
  CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS,
  type WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS,
  WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS,
  WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS,
  WORKER_CATALOG_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_LOCAL_MUTATION_INSTRUCTION_DEFINITIONS,
  composeCanopyInstructionRegistries,
  type WorkerFilesystemEntryInstructionDefinitions,
} from '@canopy/protocol/canopy-core';
import { CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/metadata-commands';
import { CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/lifecycle-commands';
import { CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/guarded-commands';
import { CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/source-composition-commands';

// Credential writes are daemon-only: Electron never owns or opens the vault.
const {
  'core.integration.credential.set': daemonCredentialSet,
  'core.integration.credential.clear': daemonCredentialClear,
  ...DESKTOP_BASE_INSTRUCTION_DEFINITIONS
} = CANOPY_INSTRUCTION_DEFINITIONS;
void daemonCredentialSet;
void daemonCredentialClear;

/**
 * The desktop dispatcher's instructions: the composed registry, which carries
 * the entry instructions (CAN-5502) and create/save (CAN-5518), plus the
 * W5 metadata commands (W7a, DM-1: the in-process dispatcher only; the
 * daemon composes them in W7a-3), the lifecycle commands (W7b-3 creates
 * and W7b-2a archive, delete and restore; D-1(a): the in-process dispatcher
 * only), the guarded W5 commands (W7b-1b/1c, D-1(a): the in-process
 * dispatcher only, over the Electron boundaries of W5d2's M-1(a)) and
 * the keyed source, composition, rename and fork lifecycles (W7b-4,
 * D-1(a): this dispatcher only, whose handlers call the Electron boundaries)
 * and `core.chat.question.respond` (CAN-4128), the registry the web core also
 * serves, the catalog selection write, marketplace and install changes and
 * the in-process worker's materialize and release (CAN-4123, this
 * dispatcher only), the skill catalog (CAN-4124, this dispatcher only) and
 * the portable chat transfer instructions (CAN-4113, this dispatcher only),
 * the memory save (CAN-5993), the agent watcher writes (CAN-5994), the
 * deferred tools load (CAN-5995), the ShowVisual staging write
 * (CAN-5996) and the managed delegation controls (CAN-6291), this
 * dispatcher only.
 * Composing throws on a name two maps define, so a registry that later
 * gains one of these fails at startup instead of serving two definitions.
 */
export const DESKTOP_INSTRUCTION_DEFINITIONS =
  composeCanopyInstructionRegistries(
    DESKTOP_BASE_INSTRUCTION_DEFINITIONS,
    CORE_COWORK_FOLDER_INSTRUCTIONS,
    WORKER_GIT_LOCAL_MUTATION_INSTRUCTION_DEFINITIONS,
    WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS,
    WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS,
    WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS,
    CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
    CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS,
    CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS,
    CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS,
    CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS,
    CORE_CATALOG_INSTRUCTION_DEFINITIONS,
    CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS,
    CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
    CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS,
    WORKER_CATALOG_INSTRUCTION_DEFINITIONS,
    CORE_CHAT_TRANSFER_INSTRUCTION_DEFINITIONS,
    CORE_MEMORY_INSTRUCTION_DEFINITIONS,
    CORE_MEMORY_MAINTENANCE_INSTRUCTION_DEFINITIONS,
    CORE_ARCHIVE_INSTRUCTION_DEFINITIONS,
    CORE_CONFIG_INSTRUCTION_DEFINITIONS,
    CORE_INITIATED_WORK_WATCHER_INSTRUCTION_DEFINITIONS,
    CORE_AGENT_DEFERRED_TOOLS_INSTRUCTION_DEFINITIONS,
    CORE_CHAT_VISUAL_STAGE_INSTRUCTION_DEFINITIONS,
    CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS,
  );

export type DesktopInstructionDefinitions =
  typeof DESKTOP_INSTRUCTION_DEFINITIONS;

/** The write and entry instructions the mutation adapter handles. */
export type DesktopMutationInstructionDefinitions =
  typeof WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS &
    WorkerFilesystemEntryInstructionDefinitions;
