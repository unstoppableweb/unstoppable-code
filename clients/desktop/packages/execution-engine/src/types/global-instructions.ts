/**
 * Global Instructions — user-configured system-prompt additions injected into
 * new agent sessions (never resumed ones) as a "User Overall Preferences"
 * block. Configured on the Models settings page with two independent
 * sections: interactive chats and pipeline agents.
 *
 * This module is import-free so the `../types` barrel can re-export its
 * constants/factories at runtime without a require cycle.
 */

export const GLOBAL_INSTRUCTION_HARNESSES = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'copilot',
  'antigravity',
  'opencode',
] as const;

/**
 * Harness (provider) narrowing dimension. Mirrors `AgentProviderType` —
 * declared locally so this module stays import-free.
 */
export type GlobalInstructionHarness =
  (typeof GLOBAL_INSTRUCTION_HARNESSES)[number];

export const GLOBAL_INSTRUCTION_MODES = ['append', 'replace'] as const;

/**
 * How a scoped instruction combines with the overall instruction when it
 * applies to a session. `append` adds after the overall text (and earlier
 * applicable appends); `replace` fully overwrites the constructed global
 * instruction text — the first applicable replace wins and stops processing.
 */
export type GlobalInstructionMode = (typeof GLOBAL_INSTRUCTION_MODES)[number];

export const GLOBAL_INSTRUCTION_WORKSPACE_TYPES = [
  'code',
  'cowork',
  'app-advisor',
] as const;

/**
 * Chat-surface narrowing dimension. `code` = worktree chats, `cowork` =
 * Cowork/standalone chats, `app-advisor` = the App Advisor assistant.
 * Pipeline agents have no workspace type.
 */
export type GlobalInstructionWorkspaceType =
  (typeof GLOBAL_INSTRUCTION_WORKSPACE_TYPES)[number];

/**
 * A narrowly scoped instruction. The narrowing selections form one grouped
 * multi-select: the instruction applies to a session when the session matches
 * ANY selected option (union across harnesses, models, and workspace types).
 * An item with no selections applies to every session in its section.
 */
export interface ScopedGlobalInstruction {
  id: string;
  text: string;
  mode: GlobalInstructionMode;
  /** Selected harnesses (providers). Matches any session on that harness. */
  harnesses: GlobalInstructionHarness[];
  /** Selected model ids. Matches any session using that model. */
  models: string[];
  /**
   * Selected chat workspace types. Only meaningful in the chats section;
   * always empty for the pipelines section.
   */
  workspaceTypes: GlobalInstructionWorkspaceType[];
}

/** One configurable section (chats or pipelines). */
export interface GlobalInstructionsSection {
  /** The top "Overall" instruction applying to every session in the section. */
  overall: string;
  /**
   * Ordered scoped instructions. Order establishes replace priority and the
   * order applicable appends are concatenated.
   */
  scoped: ScopedGlobalInstruction[];
}

export interface GlobalInstructionsConfig {
  chats: GlobalInstructionsSection;
  pipelines: GlobalInstructionsSection;
}

export function createEmptyGlobalInstructionsSection(): GlobalInstructionsSection {
  return { overall: '', scoped: [] };
}

export function createEmptyGlobalInstructionsConfig(): GlobalInstructionsConfig {
  return {
    chats: createEmptyGlobalInstructionsSection(),
    pipelines: createEmptyGlobalInstructionsSection(),
  };
}
