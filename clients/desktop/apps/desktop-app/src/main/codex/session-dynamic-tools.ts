import type { AssistantMode } from '@canopy/desktop-shared/types';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import type { DynamicToolSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolSpec';
import { buildAppAdvisorDynamicToolSpecs } from '../app-advisor/codex-dynamic-tools';
import { buildPipelineEditorDynamicToolSpecs } from '../pipeline-editor/codex-dynamic-tools';
import { buildCanopyDynamicToolSpecs } from './canopy-dynamic-tools';
import type { AiGatewayToolSchemaProfile } from '@canopy/protocol/ai-gateway-models';

export function buildCodexSessionDynamicToolSpecs(options: {
  assistantMode?: AssistantMode;
  workspaceMode: 'cowork' | 'worktree';
  isCodeReview: boolean;
  includeCodeGraph: boolean;
  includeChatVisuals: boolean;
  interfaceTools: readonly InterfaceToolName[];
  /** Only for a session that passed the Ledger exposure gate. */
  includeLedger?: boolean;
  toolSchemaProfile: AiGatewayToolSchemaProfile;
}): DynamicToolSpec[] {
  if (options.assistantMode === 'app-advisor') {
    return buildAppAdvisorDynamicToolSpecs({
      includeLedger: options.includeLedger === true,
      includeUiState: options.interfaceTools.includes(
        'ui.get_current_ui_state',
      ),
      includeShowFiles:
        options.interfaceTools.includes('ui.show_files') ||
        options.interfaceTools.includes('ui.app_advisor.show_files'),
    });
  }
  if (options.assistantMode === 'pipeline-editor') {
    return buildPipelineEditorDynamicToolSpecs({
      interfaceTools: options.interfaceTools,
    });
  }
  return buildCanopyDynamicToolSpecs({
    mode: options.workspaceMode,
    includeCodeGraph: options.includeCodeGraph,
    includeChatVisuals: options.includeChatVisuals,
    includeShowFiles: options.interfaceTools.includes('ui.show_files'),
    includeLedger: options.includeLedger === true,
    isCodeReview: options.isCodeReview,
    toolSchemaProfile: options.toolSchemaProfile,
  });
}
