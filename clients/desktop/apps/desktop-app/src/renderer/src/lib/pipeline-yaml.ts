import * as yaml from 'js-yaml';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import {
  CHAT_AUTOMATION_JOB,
  retitleChatAutomationEntry,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import { getDraftValidation } from './pipelineEditor';

/**
 * Shared Pipeline↔YAML helpers used by both the raw-YAML editor
 * (`usePipelineEditorSession`) and the renderer live-edit bridge
 * (`PipelineEditorRuntimeBridge`). Kept in a plain lib module (rather than
 * exported from the editor component) so the bridge can import them without
 * pulling in a React component and so neither file trips the
 * `react-refresh/only-export-components` rule.
 */

/**
 * Serialize a `Pipeline` to the canonical document YAML (`{ pipeline }`) using
 * the same `js-yaml` options the editor persists with.
 */
export function serializePipelineToYaml(pipeline: Pipeline): string {
  return yaml.dump({ pipeline }, { lineWidth: 120, noRefs: true });
}

/**
 * Parse YAML text and validate the resulting pipeline.
 * Returns the parsed Pipeline on success, or an error string on failure.
 */
export function tryParseAndValidateYaml(
  text: string,
): { success: true; pipeline: Pipeline } | { success: false; error: string } {
  let parsed: Pipeline;
  try {
    parsed = parsePipelineText(text);
  } catch (err: unknown) {
    return {
      success: false,
      error: `Invalid workflow definition: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { success: false, error: 'YAML must define a workflow object' };
  }

  if (!parsed.jobs || typeof parsed.jobs !== 'object') {
    return { success: false, error: 'Workflow must define a "jobs" object' };
  }

  const issues = getDraftValidation(parsed);
  const errors = issues.filter((v) => v.type === 'error');
  if (errors.length > 0) {
    const messages = errors.map((e) => `${e.path}: ${e.message}`);
    return { success: false, error: messages.join('\n') };
  }

  return { success: true, pipeline: parsed };
}

function entryTitleOf(pipeline: Pipeline): unknown {
  return pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps[0]?.with?.title;
}

/**
 * Raw YAML someone typed, with a converted Orchestrator entry's title moved
 * from one generated for any of `previousNames` to the one for `savedName`, the
 * name the save stored (CAN-5782), and every other line as typed: a newer
 * name typed meanwhile isn't saved yet, so the title doesn't follow it. A plain or quoted title
 * line matches. Null when the text
 * doesn't parse, has no such title, or no single line holds it; the result
 * is checked by parsing it again.
 */
export function retitleRawYaml(
  text: string,
  previousNames: readonly string[],
  savedName: string,
): string | null {
  const parsed = tryParseAndValidateYaml(text);
  if (!parsed.success) return null;
  const retitled = retitleChatAutomationEntry(
    parsed.pipeline,
    previousNames,
    savedName,
  );
  const from = entryTitleOf(parsed.pipeline);
  const to = entryTitleOf(retitled);
  if (
    retitled === parsed.pipeline ||
    typeof from !== 'string' ||
    typeof to !== 'string'
  )
    return null;
  // The title as it may be written: plain, double-quoted or single-quoted.
  const forms = new Set([
    yaml.dump(from, { lineWidth: -1 }).trimEnd(),
    JSON.stringify(from),
    `'${from.split("'").join("''")}'`,
  ]);
  const lines = text.split('\n');
  const matches = lines.flatMap((line, index) => {
    const match = /^(\s*(?:-\s+)?title:\s*)(.*?)(\s+#.*)?$/.exec(line);
    return match?.[1] && match[2] !== undefined && forms.has(match[2])
      ? [{ index, prefix: match[1], comment: match[3] ?? '' }]
      : [];
  });
  const [only] = matches;
  if (only === undefined || matches.length !== 1) return null;
  lines[only.index] =
    only.prefix + yaml.dump(to, { lineWidth: -1 }).trimEnd() + only.comment;
  const next = lines.join('\n');
  const check = tryParseAndValidateYaml(next);
  return check.success &&
    JSON.stringify(check.pipeline) === JSON.stringify(retitled)
    ? next
    : null;
}
