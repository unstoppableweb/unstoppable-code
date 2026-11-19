import { parseAgentTranscriptLines } from '@canopy/agent-transcript';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import {
  REMOTE_CONTROL_PIPELINE_CONTENT_PAGE_MAX_CHARS,
  type RemoteControlPipelineContentReadResult,
} from '@canopy/protocol/remote-control/shell';

/**
 * Documents for `portal.pipeline.content.read` (CAN-3717): the readable text
 * the desktop shows for a step or a run's report, cut into bounded pages.
 * Pure; `pipelines-service` resolves and reads the files.
 */
export interface PipelineContentDocument {
  format: RemoteControlPipelineContentReadResult['format'];
  text: string;
}

/** CSI and OSC terminal sequences and other two-byte escapes. */
const TERMINAL_ESCAPE =
  // eslint-disable-next-line no-control-regex -- matches terminal escapes
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

/** A saved command log as plain text, without terminal colors. */
export function plainLogDocument(log: string): PipelineContentDocument {
  return {
    format: 'text',
    text: log.replace(/\r\n?/g, '\n').replace(TERMINAL_ESCAPE, ''),
  };
}

/**
 * The assistant's own text from an agent transcript, through the parser the
 * desktop's rich step view uses, or null when no line is a transcript event
 * (a plain log stays a plain log). Tool calls, results and subagent turns
 * are left out, as provider envelopes are.
 */
export function agentTranscriptDocument(
  transcript: string,
  provider: AgentProviderType | undefined,
): PipelineContentDocument | null {
  const lines = transcript.split(/\r?\n/);
  const { messages, skippedLineCount } = parseAgentTranscriptLines(
    lines,
    provider === 'ollama' ? 'claude' : provider,
  );
  if (skippedLineCount >= lines.length) return null;
  const texts: string[] = [];
  for (const message of messages) {
    if (
      message.role !== 'assistant' ||
      message.hidden === true ||
      message.parentToolUseId !== undefined ||
      message.parentBlockId !== undefined
    ) {
      continue;
    }
    for (const block of message.blocks) {
      if (block.type === 'text' && block.text.trim().length > 0) {
        texts.push(block.text.trim());
      }
    }
  }
  return { format: 'markdown', text: texts.join('\n\n') };
}

/**
 * The report as the desktop's report view shows it: the text report, then
 * the JSON report indented. A text report not saved as Markdown, and the JSON
 * report, are fenced so their content renders verbatim.
 */
export function reportDocument(parts: {
  text?: { content: string; markdown: boolean };
  json?: string;
}): PipelineContentDocument {
  const sections: string[] = [];
  if (parts.text) {
    sections.push(
      parts.text.markdown
        ? parts.text.content
        : fenced('text', parts.text.content),
    );
  }
  if (parts.json !== undefined) {
    const block = fenced('json', indentJson(parts.json));
    sections.push(parts.text ? `## JSON report\n\n${block}` : block);
  }
  return { format: 'markdown', text: sections.join('\n\n') };
}

/**
 * One page starting at [offset], at most {@link REMOTE_CONTROL_PIPELINE_CONTENT_PAGE_MAX_CHARS}
 * long and never ending inside a surrogate pair. Null for an offset outside
 * the document or inside a pair.
 */
export function pipelineContentPage(
  document: PipelineContentDocument,
  offset: number,
  revision: string,
): RemoteControlPipelineContentReadResult | null {
  const { text } = document;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > text.length ||
    isLowSurrogate(text.charCodeAt(offset))
  ) {
    return null;
  }
  let end = Math.min(
    text.length,
    offset + REMOTE_CONTROL_PIPELINE_CONTENT_PAGE_MAX_CHARS,
  );
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  return {
    format: document.format,
    content: text.slice(offset, end),
    offset,
    nextOffset: end,
    length: text.length,
    revision,
  };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function indentJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

/** A code fence longer than any backtick run inside [content]. */
function fenced(language: string, content: string): string {
  const longest = Math.max(
    0,
    ...(content.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${content.replace(/\n$/, '')}\n${fence}`;
}
