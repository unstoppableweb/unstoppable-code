export type PluginFileContent = string | Uint8Array;

export interface ClaudePluginManifest {
  name?: string;
  version?: string;
  author?: { name: string; email?: string };
  description?: string;
  homepage?: string;
  skills?: string | string[];
  agents?: string | string[];
  commands?: string | string[];
  apps?: string | string[];
  hooks?: string | string[] | Record<string, unknown>;
  mcpServers?: string | string[] | Record<string, unknown>;
  lspServers?: string | string[] | Record<string, unknown>;
}

export interface ProjectClaudePluginForCodexInput {
  pluginName: string;
  category: string;
  manifest: ClaudePluginManifest | null;
  rawManifest?: Readonly<Record<string, unknown>>;
  files: ReadonlyMap<string, PluginFileContent>;
  pluginRoot?: string;
  qualifiedReferenceMap?: ReadonlyMap<string, string>;
  includeMcpServers?: boolean;
}

export interface ProjectClaudePluginForCodexResult {
  files: ReadonlyMap<string, PluginFileContent>;
  generatedSkillNames: ReadonlyMap<string, string>;
  warnings: string[];
}

export interface PluginSkillMember {
  name: string;
  description: string;
  path: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}

export interface PluginMarkdownMember {
  name: string;
  description: string;
  filePath: string;
}

export interface PluginHookMember {
  event: string;
  matcher?: string;
  hookType: string;
  command?: string;
}

export interface PluginModMember {
  module: string;
  hooksFile: string;
}

export interface PluginMcpServerMember {
  name: string;
  type: 'command' | 'http';
  command?: string;
  args?: string[];
  url?: string;
}

export interface PluginLspServerMember {
  name: string;
  command: string;
  args?: string[];
  languages?: string[];
}

export interface PluginMemberInventory {
  skills: PluginSkillMember[];
  commands: PluginMarkdownMember[];
  agents: PluginMarkdownMember[];
  /** Optional for inventories persisted before compatibility version 5. */
  apps?: PluginMarkdownMember[];
  hooks: PluginHookMember[];
  /** Optional for inventories persisted before Mod members were inventoried. */
  mods?: PluginModMember[];
  mcpServers: PluginMcpServerMember[];
  lspServers: PluginLspServerMember[];
  /**
   * Claude command/agent member key (`command:<name>` / `agent:<name>`) to
   * the deterministic skill name emitted by the Codex projection.
   * Materialized inventories persist this so invocation menus never need to
   * re-read or re-project the plugin tree.
   */
  codexGeneratedSkillNames?: Record<string, string>;
}

export interface PluginMemberCodexNames {
  skillNames: ReadonlyMap<string, string>;
  commandNames: ReadonlyMap<string, string>;
  agentNames: ReadonlyMap<string, string>;
}

export interface BuildPluginMemberInventoryInput {
  files: ReadonlyMap<string, PluginFileContent>;
  manifest: ClaudePluginManifest | null;
}

export interface PluginMcpEnvironmentInput {
  pluginName: string;
  manifest: ClaudePluginManifest | null;
  files: ReadonlyMap<string, PluginFileContent>;
  pluginRoot?: string;
}

export interface ProjectStandaloneMcpServersForCodexInput {
  pluginName: string;
  mcpServers: Readonly<Record<string, unknown>>;
}

export interface ProjectStandaloneMcpServersForCodexResult {
  config: Readonly<Record<string, unknown>>;
  extraEnv: Record<string, string>;
  warnings: string[];
}

export interface ProjectCodexPluginWithoutMcpServersInput {
  files: ReadonlyMap<string, PluginFileContent>;
  manifest: Readonly<Record<string, unknown>>;
}
