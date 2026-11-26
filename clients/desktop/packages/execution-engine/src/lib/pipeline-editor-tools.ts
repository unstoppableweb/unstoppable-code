/**
 * Single source of truth for the embedded pipeline-editor assistant's LLM tool
 * names. The renderer transport is defined in `types.ts`; this file owns the
 * provider-facing Claude MCP / Codex dynamic-tool contract.
 */
import { BRAND } from '@canopy/brand/current';
import type { ChatTabPluginSelections } from '../execution-types';

export type PipelineEditorToolKey =
  | 'ask_user_question'
  | 'pipeline_list'
  | 'pipeline_open'
  | 'pipeline_create'
  | 'pipeline_get_current'
  | 'pipeline_set_yaml'
  | 'pipeline_save'
  | 'pipeline_get_action_definition'
  | 'automation_list'
  | 'automation_get'
  | 'automation_create'
  | 'automation_update'
  | 'navigation_to_list'
  | 'search_deferred_tools'
  | 'load_deferred_tools';

export type PipelineEditorToolProvider = 'claude' | 'codex';

export interface PipelineEditorToolExposure {
  canonicalKey: PipelineEditorToolKey;
  displayName: string;
  claudeToolName: string;
  codexToolName: string;
}

export const PIPELINE_EDITOR_REQUIRED_SKILL_NAME = `${BRAND.internalName}-pipeline-writing`;

export const PIPELINE_EDITOR_REQUIRED_SKILL_REF = {
  sourceId: 'builtin:app',
  skillName: PIPELINE_EDITOR_REQUIRED_SKILL_NAME,
} as const;

export function withRequiredPipelineEditorSkill(
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections {
  const base: ChatTabPluginSelections = selections ?? {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
  return {
    ...base,
    skillRefs: [
      ...(base.skillRefs ?? []).filter(
        (ref) => ref.skillName !== PIPELINE_EDITOR_REQUIRED_SKILL_NAME,
      ),
      PIPELINE_EDITOR_REQUIRED_SKILL_REF,
    ],
  };
}

const CLAUDE_NAMESPACE_PREFIX = `mcp__${BRAND.tools.namespace}_pipeline_editor__`;
const CODEX_NAMESPACE_PREFIX = `${BRAND.tools.namespace}_pipeline_editor_`;

function claudePipelineEditorTool(displayName: string): string {
  return `${CLAUDE_NAMESPACE_PREFIX}${displayName}`;
}

function codexPipelineEditorTool(suffix: string): string {
  return `${CODEX_NAMESPACE_PREFIX}${suffix}`;
}

export const PIPELINE_EDITOR_TOOL_REGISTRY: Record<
  PipelineEditorToolKey,
  PipelineEditorToolExposure
> = {
  ask_user_question: {
    canonicalKey: 'ask_user_question',
    displayName: 'AskUserQuestion',
    claudeToolName: claudePipelineEditorTool('AskUserQuestion'),
    codexToolName: codexPipelineEditorTool('ask_user_question'),
  },
  pipeline_list: {
    canonicalKey: 'pipeline_list',
    displayName: 'ListPipelines',
    claudeToolName: claudePipelineEditorTool('ListPipelines'),
    codexToolName: codexPipelineEditorTool('pipeline_list'),
  },
  pipeline_open: {
    canonicalKey: 'pipeline_open',
    displayName: 'OpenPipeline',
    claudeToolName: claudePipelineEditorTool('OpenPipeline'),
    codexToolName: codexPipelineEditorTool('pipeline_open'),
  },
  pipeline_create: {
    canonicalKey: 'pipeline_create',
    displayName: 'CreatePipeline',
    claudeToolName: claudePipelineEditorTool('CreatePipeline'),
    codexToolName: codexPipelineEditorTool('pipeline_create'),
  },
  pipeline_get_current: {
    canonicalKey: 'pipeline_get_current',
    displayName: 'GetCurrentPipeline',
    claudeToolName: claudePipelineEditorTool('GetCurrentPipeline'),
    codexToolName: codexPipelineEditorTool('pipeline_get_current'),
  },
  pipeline_set_yaml: {
    canonicalKey: 'pipeline_set_yaml',
    displayName: 'SetPipelineYaml',
    claudeToolName: claudePipelineEditorTool('SetPipelineYaml'),
    codexToolName: codexPipelineEditorTool('pipeline_set_yaml'),
  },
  pipeline_save: {
    canonicalKey: 'pipeline_save',
    displayName: 'SavePipeline',
    claudeToolName: claudePipelineEditorTool('SavePipeline'),
    codexToolName: codexPipelineEditorTool('pipeline_save'),
  },
  pipeline_get_action_definition: {
    canonicalKey: 'pipeline_get_action_definition',
    displayName: 'GetBuiltinActionDefinition',
    claudeToolName: claudePipelineEditorTool('GetBuiltinActionDefinition'),
    codexToolName: codexPipelineEditorTool('pipeline_get_action_definition'),
  },
  automation_list: {
    canonicalKey: 'automation_list',
    displayName: 'ListAutomations',
    claudeToolName: claudePipelineEditorTool('ListAutomations'),
    codexToolName: codexPipelineEditorTool('automation_list'),
  },
  automation_get: {
    canonicalKey: 'automation_get',
    displayName: 'GetAutomation',
    claudeToolName: claudePipelineEditorTool('GetAutomation'),
    codexToolName: codexPipelineEditorTool('automation_get'),
  },
  automation_create: {
    canonicalKey: 'automation_create',
    displayName: 'CreateAutomation',
    claudeToolName: claudePipelineEditorTool('CreateAutomation'),
    codexToolName: codexPipelineEditorTool('automation_create'),
  },
  automation_update: {
    canonicalKey: 'automation_update',
    displayName: 'UpdateAutomation',
    claudeToolName: claudePipelineEditorTool('UpdateAutomation'),
    codexToolName: codexPipelineEditorTool('automation_update'),
  },
  navigation_to_list: {
    canonicalKey: 'navigation_to_list',
    displayName: 'NavigateToPipelineList',
    claudeToolName: claudePipelineEditorTool('NavigateToPipelineList'),
    codexToolName: codexPipelineEditorTool('navigation_to_list'),
  },
  search_deferred_tools: {
    canonicalKey: 'search_deferred_tools',
    displayName: 'SearchDeferredTools',
    claudeToolName: claudePipelineEditorTool('SearchDeferredTools'),
    codexToolName: codexPipelineEditorTool('search_deferred_tools'),
  },
  load_deferred_tools: {
    canonicalKey: 'load_deferred_tools',
    displayName: 'LoadDeferredTools',
    claudeToolName: claudePipelineEditorTool('LoadDeferredTools'),
    codexToolName: codexPipelineEditorTool('load_deferred_tools'),
  },
};

export const PIPELINE_EDITOR_TOOL_ENTRIES: readonly PipelineEditorToolExposure[] =
  [
    PIPELINE_EDITOR_TOOL_REGISTRY.ask_user_question,
    PIPELINE_EDITOR_TOOL_REGISTRY.pipeline_list,
    PIPELINE_EDITOR_TOOL_REGISTRY.pipeline_open,
    PIPELINE_EDITOR_TOOL_REGISTRY.pipeline_create,
    PIPELINE_EDITOR_TOOL_REGISTRY.pipeline_get_current,
    PIPELINE_EDITOR_TOOL_REGISTRY.pipeline_set_yaml,
    PIPELINE_EDITOR_TOOL_REGISTRY.pipeline_save,
    PIPELINE_EDITOR_TOOL_REGISTRY.pipeline_get_action_definition,
    PIPELINE_EDITOR_TOOL_REGISTRY.automation_list,
    PIPELINE_EDITOR_TOOL_REGISTRY.automation_get,
    PIPELINE_EDITOR_TOOL_REGISTRY.automation_create,
    PIPELINE_EDITOR_TOOL_REGISTRY.automation_update,
    PIPELINE_EDITOR_TOOL_REGISTRY.navigation_to_list,
    PIPELINE_EDITOR_TOOL_REGISTRY.search_deferred_tools,
    PIPELINE_EDITOR_TOOL_REGISTRY.load_deferred_tools,
  ];

export const PIPELINE_EDITOR_TOOL_KEYS: readonly PipelineEditorToolKey[] = [
  'ask_user_question',
  'pipeline_list',
  'pipeline_open',
  'pipeline_create',
  'pipeline_get_current',
  'pipeline_set_yaml',
  'pipeline_save',
  'pipeline_get_action_definition',
  'automation_list',
  'automation_get',
  'automation_create',
  'automation_update',
  'navigation_to_list',
  'search_deferred_tools',
  'load_deferred_tools',
] as const;

const PIPELINE_EDITOR_MCP_DISPLAY_TO_KEY: ReadonlyMap<
  string,
  PipelineEditorToolKey
> = new Map(
  PIPELINE_EDITOR_TOOL_ENTRIES.map((entry) => [
    entry.displayName,
    entry.canonicalKey,
  ]),
);

const PIPELINE_EDITOR_CODEX_SUFFIX_TO_KEY: ReadonlyMap<
  string,
  PipelineEditorToolKey
> = new Map([
  ['ask_user_question', 'ask_user_question'],
  ['pipeline_list', 'pipeline_list'],
  ['pipeline_open', 'pipeline_open'],
  ['pipeline_create', 'pipeline_create'],
  ['pipeline_get_current', 'pipeline_get_current'],
  ['pipeline_set_yaml', 'pipeline_set_yaml'],
  ['pipeline_save', 'pipeline_save'],
  ['pipeline_get_action_definition', 'pipeline_get_action_definition'],
  ['automation_list', 'automation_list'],
  ['automation_get', 'automation_get'],
  ['automation_create', 'automation_create'],
  ['automation_update', 'automation_update'],
  ['navigation_to_list', 'navigation_to_list'],
  ['search_deferred_tools', 'search_deferred_tools'],
  ['load_deferred_tools', 'load_deferred_tools'],
]);

function getBrandedPipelineEditorToolKey(
  toolName: string,
): PipelineEditorToolKey | null {
  const mcpMatch = toolName.match(/^mcp__(.+)_pipeline_editor__(.+)$/);
  if (mcpMatch) {
    return PIPELINE_EDITOR_MCP_DISPLAY_TO_KEY.get(mcpMatch[2]) ?? null;
  }

  const codexMatch = toolName.match(
    /^(.+)_pipeline_editor_(ask_user_question|pipeline_list|pipeline_open|pipeline_create|pipeline_get_current|pipeline_set_yaml|pipeline_save|pipeline_get_action_definition|automation_list|automation_get|automation_create|automation_update|navigation_to_list|search_deferred_tools|load_deferred_tools)$/,
  );
  if (codexMatch) {
    return PIPELINE_EDITOR_CODEX_SUFFIX_TO_KEY.get(codexMatch[2]) ?? null;
  }

  return null;
}

export function getPipelineEditorProviderToolName(
  key: PipelineEditorToolKey,
  provider: PipelineEditorToolProvider,
): string {
  const exposure = PIPELINE_EDITOR_TOOL_REGISTRY[key];
  return provider === 'claude'
    ? exposure.claudeToolName
    : exposure.codexToolName;
}

export function getCanonicalPipelineEditorToolKey(
  toolName: string | null | undefined,
): PipelineEditorToolKey | null {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return null;
  }
  for (const exposure of PIPELINE_EDITOR_TOOL_ENTRIES) {
    if (
      toolName === exposure.claudeToolName ||
      toolName === exposure.codexToolName
    ) {
      return exposure.canonicalKey;
    }
  }
  return getBrandedPipelineEditorToolKey(toolName);
}

export function isPipelineEditorToolName(
  toolName: string | null | undefined,
): boolean {
  return getCanonicalPipelineEditorToolKey(toolName) !== null;
}
