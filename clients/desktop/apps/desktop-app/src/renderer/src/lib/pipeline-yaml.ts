import * as yaml from 'js-yaml';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  getTriggerInputDefs,
  type Pipeline,
} from '@canopy/execution-engine/types/pipeline';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The editor serializes drafts without aliases. Count repeated references
// each time they would be written, and reject cycles along the current path.
function validateDraftSize(pipeline: Pipeline): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  let characters = 0;
  function visit(value: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64 || characters > 4 * 1024 * 1024) {
      throw new Error(
        'The expanded workflow definition is too large or deeply nested.',
      );
    }
    if (typeof value !== 'object' || value === null) return;
    if (ancestors.has(value)) {
      throw new Error('Workflow aliases must not refer back to themselves.');
    }
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      characters += key.length + (typeof child === 'string' ? child.length : 0);
      visit(child, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(pipeline, 0);
}

/**
 * Parse YAML text and validate the resulting pipeline.
 * Returns the parsed Pipeline on success, or an error string on failure.
 */
export function tryParseAndValidateYaml(
  text: string,
): { success: true; pipeline: Pipeline } | { success: false; error: string } {
  try {
    const pipeline = parsePipelineText(text);
    validateDraftSize(pipeline);
    for (const [id, job] of Object.entries(pipeline.jobs)) {
      if (!job || !Array.isArray(job.steps) || !job.steps.every(isRecord)) {
        return {
          success: false,
          error: `Job "${id}" must define a list of steps.`,
        };
      }
    }
    const collections = pipeline.plugin_collections;
    if (
      collections !== undefined &&
      (!Array.isArray(collections) ||
        collections.some(
          (entry: unknown) => !isRecord(entry) || typeof entry.id !== 'string',
        ))
    ) {
      return {
        success: false,
        error: 'Plugin collections must be a list of collections with IDs.',
      };
    }
    for (const trigger of ['dispatch', 'workflow'] as const) {
      const inputs = getTriggerInputDefs(pipeline.on, trigger);
      if (
        inputs != null &&
        (!isRecord(inputs) || !Object.values(inputs).every(isRecord))
      ) {
        return {
          success: false,
          error:
            trigger === 'dispatch'
              ? 'Dispatch inputs must define their options by input name.'
              : 'Workflow inputs must define their options by input name.',
        };
      }
    }
    const errors = getDraftValidation(pipeline).filter(
      (issue) => issue.type === 'error',
    );
    if (errors.length > 0) {
      return {
        success: false,
        error: errors
          .map(({ path, message }) => `${path}: ${message}`)
          .join('\n'),
      };
    }
    return { success: true, pipeline };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Invalid workflow definition: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
