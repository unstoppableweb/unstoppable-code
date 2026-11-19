import type { DisplayMessage } from '@/components/chat/types';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import type { StepResult } from '@canopy/execution-engine/types/pipeline';
import { STEP_BILLING_ROUTE_OUTPUT_KEYS } from '@canopy/execution-engine/pipelines/step-billing-route';

export type PipelineLogViewMode = 'plain' | 'rich';

const AGENT_HIDDEN_INPUT_KEYS = new Set(['prompt']);
const AGENT_HIDDEN_OUTPUT_KEYS = new Set(['text_response', 'json_response']);

export interface PipelineStepLogSources {
  plainLogFile?: string;
  richLogFile?: string;
}

export interface PipelineReportFileData {
  content: string;
  filePath: string;
}

export interface PipelineReportContentResult {
  content?: string;
  error?: string;
}

export type ReadPipelineReportFile = (
  executionId: string,
  kind: 'text' | 'json',
) => Promise<IPCResult<PipelineReportFileData>>;

function omitKeys(
  values: Record<string, unknown> | undefined,
  hiddenKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!values) {
    return undefined;
  }

  const filtered = Object.fromEntries(
    Object.entries(values).filter(([key]) => !hiddenKeys.has(key)),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export function resolvePipelineStepLogSources(
  stepResult: StepResult | undefined,
): PipelineStepLogSources {
  return {
    plainLogFile: stepResult?.log_file,
    richLogFile:
      stepResult?.log_format_hint === 'agent'
        ? (stepResult.outputs.transcript_file ?? stepResult.log_file)
        : undefined,
  };
}

export function hasRenderableRichTranscript(
  messages: DisplayMessage[],
): boolean {
  return messages.length > 0;
}

export function getDefaultPipelineLogViewMode(
  messages: DisplayMessage[],
): PipelineLogViewMode {
  return hasRenderableRichTranscript(messages) ? 'rich' : 'plain';
}

export function getDisplayablePipelineStepInputs(
  values: Record<string, unknown> | undefined,
  stepResult: StepResult | undefined,
): Record<string, unknown> | undefined {
  if (stepResult?.log_format_hint !== 'agent') {
    return values;
  }

  return omitKeys(values, AGENT_HIDDEN_INPUT_KEYS);
}

export function getDisplayablePipelineStepOutputs(
  values: Record<string, unknown> | undefined,
  stepResult: StepResult | undefined,
): Record<string, unknown> | undefined {
  // The route keys show as the billing line instead (CAN-7256), for every
  // step: model actions that are not agent-formatted set them too.
  const visible = omitKeys(values, STEP_BILLING_ROUTE_OUTPUT_KEYS);
  if (stepResult?.log_format_hint !== 'agent') {
    return visible;
  }

  return omitKeys(visible, AGENT_HIDDEN_OUTPUT_KEYS);
}

export function formatPipelineReportContent(
  kind: 'text' | 'json',
  content: string,
): string {
  if (kind === 'text') {
    return content;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

export async function loadPipelineReportContent(
  readReportFile: ReadPipelineReportFile,
  executionId: string,
): Promise<PipelineReportContentResult> {
  const textResult = await readReportFile(executionId, 'text');
  if (textResult.success && textResult.data) {
    return {
      content: formatPipelineReportContent('text', textResult.data.content),
    };
  }

  const jsonResult = await readReportFile(executionId, 'json');
  if (jsonResult.success && jsonResult.data) {
    return {
      content: formatPipelineReportContent('json', jsonResult.data.content),
    };
  }

  return {
    error: textResult.error ?? jsonResult.error ?? 'Failed to load report',
  };
}
