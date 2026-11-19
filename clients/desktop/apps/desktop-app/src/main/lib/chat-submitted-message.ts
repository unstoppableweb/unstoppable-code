import { isAbsolute, relative, resolve } from 'node:path';
import type {
  ChatAttachmentPromptContext,
  ChatAttachmentPromptKind,
  FileReference,
  PendingSystemInstruction,
} from '@canopy/desktop-shared/types';
import { formatPendingSystemInstructionBlock } from '@canopy/desktop-shared/lib/pending-system-instructions';
import { partitionPluginMentions } from '@canopy/desktop-shared/lib/plugin-mention';
import {
  isExternalAgentSent,
  type AgentSentInfo,
  type ExternalAgentSender,
} from '@canopy/protocol/remote-control/shell/external-agent-sender';

export interface BuildSubmittedMessageTextOptions {
  text: string;
  fileReferences?: FileReference[];
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  attachmentBaseDir?: string;
  /**
   * Working directory the agent will run in. When provided, file references
   * inside this directory are rewritten as paths relative to it; references
   * outside fall back to absolute paths so the agent can still locate them.
   */
  cwd?: string;
  /**
   * How the user authored this message. When 'voice', a short system
   * instruction is prepended guiding the model to prioritize user intent over
   * surface-level transcription errors.
   */
  inputMode?: 'typed' | 'voice';
  /**
   * Trusted sender when another agent sent this message for the user. For an
   * external MCP agent a short system instruction names it so the model knows
   * the user did not type it; a Canopy chat sender's context arrives in its
   * own hidden sender context instead.
   */
  agentSent?: AgentSentInfo;
  pendingSystemInstructions?: PendingSystemInstruction[];
}

const VOICE_SYSTEM_INSTRUCTION =
  "<system_instruction>This message was transcribed from speech; transcription errors may exist. Prioritize the user's intent. Silently fix obvious transcription errors before acting.</system_instruction>";
const IN_APP_BROWSER_RESOURCE_PROMPT_KIND =
  'in-app-browser-resource' satisfies ChatAttachmentPromptKind;
const LINEAR_TICKET_PROMPT_KIND =
  'linear-ticket' satisfies ChatAttachmentPromptKind;

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const normalizedFilePath = resolve(filePath);
  const normalizedDirectory = resolve(directory);
  const relativePath = relative(normalizedDirectory, normalizedFilePath);

  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function validateAttachmentPath(
  filePath: string,
  attachmentBaseDir: string,
): string {
  if (filePath.includes('\n') || filePath.includes('\r')) {
    throw new Error(
      'Invalid attachment path: attachment paths must not contain line breaks',
    );
  }

  if (filePath.toLowerCase().includes('</system_instruction>')) {
    throw new Error(
      'Invalid attachment path: attachment paths must not contain reserved XML markers',
    );
  }

  if (!isAbsolute(filePath)) {
    throw new Error(
      'Invalid attachment path: attachment paths must be absolute',
    );
  }

  if (!isPathInsideDirectory(filePath, attachmentBaseDir)) {
    throw new Error(
      'Invalid attachment path: attachment must live inside the attachments directory',
    );
  }

  return resolve(filePath);
}

function formatFileReferencePath(
  absolutePath: string,
  cwd: string | undefined,
): string {
  if (!cwd || !isAbsolute(absolutePath)) {
    return absolutePath;
  }
  const rel = relative(resolve(cwd), resolve(absolutePath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return absolutePath;
  }
  return rel;
}

/**
 * Slate serializes each `@`-mention by inlining the file reference's
 * `displayPath` into the message text (see `serializeEditorValue`). When we
 * rewrite paths against the agent's working directory, those inline copies
 * must be rewritten too — otherwise the agent sees a path that does not
 * resolve from its cwd. We walk the references in document order and replace
 * each `displayPath` occurrence forward from the previous match so repeated
 * references map to repeated text occurrences.
 */
function rewriteInlineFileReferences(
  text: string,
  fileReferences: FileReference[],
  cwd: string | undefined,
): string {
  if (!cwd || fileReferences.length === 0) {
    return text;
  }
  let result = text;
  let cursor = 0;
  for (const reference of fileReferences) {
    const newPath = formatFileReferencePath(reference.absolutePath, cwd);
    if (newPath === reference.displayPath) {
      const idx = result.indexOf(reference.displayPath, cursor);
      cursor = idx === -1 ? cursor : idx + reference.displayPath.length;
      continue;
    }
    const idx = result.indexOf(reference.displayPath, cursor);
    if (idx === -1) {
      continue;
    }
    result =
      result.slice(0, idx) +
      newPath +
      result.slice(idx + reference.displayPath.length);
    cursor = idx + newPath.length;
  }
  return result;
}

/**
 * Plugin labels come from third-party marketplace manifests. Keep each on one
 * preamble line and free of the reserved instruction marker so a manifest
 * cannot forge extra preamble lines.
 */
function sanitizePreambleLabel(label: string): string {
  return label
    .replace(/<\/?system_instruction>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The agent name is connection metadata an outside client chose. Without
 * angle brackets or line breaks it cannot close the instruction or start a
 * new line.
 */
function externalAgentSystemInstruction(sender: ExternalAgentSender): string {
  const name = sender.clientName
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `<system_instruction>This message was sent by an external agent, ${JSON.stringify(name)} (connection ID ${sender.connectionId}), on the user's behalf through MCP. The user did not type it.</system_instruction>`;
}

function resolveAttachmentPromptContextPaths(
  contexts: ChatAttachmentPromptContext[] | undefined,
  attachmentBaseDir: string,
  promptKind: ChatAttachmentPromptKind,
): Set<string> {
  const paths = new Set<string>();
  for (const context of contexts ?? []) {
    if (context.promptKind !== promptKind) {
      continue;
    }
    try {
      paths.add(
        validateAttachmentPath(context.attachmentPath, attachmentBaseDir),
      );
    } catch {
      // Attachment paths themselves are validated separately; ignore stale or
      // malformed metadata that does not correspond to a valid attachment.
    }
  }
  return paths;
}

export function buildSubmittedMessageText(
  options: BuildSubmittedMessageTextOptions,
): string {
  let submittedText = options.text;

  // Whole-plugin `@` mentions share the file-reference pill but are not
  // paths: they are listed for the agent by name and their inline token is
  // left exactly as typed (never cwd-rewritten).
  const { fileReferences, pluginMentions } = partitionPluginMentions(
    options.fileReferences ?? [],
  );

  // Rewrite inline file tokens BEFORE any preamble is prepended so the
  // forward-scanning rewrite only ever sees the user's own text.
  if (fileReferences.length > 0) {
    submittedText = rewriteInlineFileReferences(
      submittedText,
      fileReferences,
      options.cwd,
    );
  }

  if (pluginMentions.length > 0) {
    submittedText = [
      'Mentioned plugins:',
      ...pluginMentions.map(
        (mention) => `- ${sanitizePreambleLabel(mention.displayPath)}`,
      ),
      '',
      submittedText,
    ].join('\n');
  }

  if (fileReferences.length > 0) {
    submittedText = [
      'Referenced files:',
      ...fileReferences.map(
        (reference) =>
          `- ${formatFileReferencePath(reference.absolutePath, options.cwd)}`,
      ),
      '',
      submittedText,
    ].join('\n');
  }

  if (options.attachmentPaths && options.attachmentPaths.length > 0) {
    if (!options.attachmentBaseDir) {
      throw new Error(
        'Invalid attachment configuration: attachmentBaseDir is required when attachmentPaths are provided',
      );
    }

    const attachmentBaseDir = options.attachmentBaseDir;
    const validatedAttachmentPaths = options.attachmentPaths.map((attachment) =>
      validateAttachmentPath(attachment, attachmentBaseDir),
    );
    const inAppBrowserResourcePaths = resolveAttachmentPromptContextPaths(
      options.attachmentPromptContexts,
      attachmentBaseDir,
      IN_APP_BROWSER_RESOURCE_PROMPT_KIND,
    );
    const linearTicketPaths = resolveAttachmentPromptContextPaths(
      options.attachmentPromptContexts,
      attachmentBaseDir,
      LINEAR_TICKET_PROMPT_KIND,
    );
    const defaultAttachmentPaths = validatedAttachmentPaths.filter(
      (attachmentPath) =>
        !inAppBrowserResourcePaths.has(attachmentPath) &&
        !linearTicketPaths.has(attachmentPath),
    );
    const browserAttachmentPaths = validatedAttachmentPaths.filter(
      (attachmentPath) => inAppBrowserResourcePaths.has(attachmentPath),
    );
    const linearAttachmentPaths = validatedAttachmentPaths.filter(
      (attachmentPath) => linearTicketPaths.has(attachmentPath),
    );

    const attachmentInstructionLines: string[] = [];
    if (defaultAttachmentPaths.length > 0) {
      attachmentInstructionLines.push(
        '<system_instruction>Review these attachments before responding to the user message:',
        ...defaultAttachmentPaths,
        '</system_instruction>',
      );
    }
    if (browserAttachmentPaths.length > 0) {
      if (attachmentInstructionLines.length > 0) {
        attachmentInstructionLines.push('');
      }
      attachmentInstructionLines.push(
        '<system_instruction>Review these in-app browser resource attachments before responding to the user message. They were captured from the in-app browser session and may reference selected UI elements, page URL/title, locators, DOM excerpts, screenshots, viewport/theme, and recent console/network diagnostics:',
        ...browserAttachmentPaths,
        '</system_instruction>',
      );
    }
    if (linearAttachmentPaths.length > 0) {
      if (attachmentInstructionLines.length > 0) {
        attachmentInstructionLines.push('');
      }
      attachmentInstructionLines.push(
        "<system_instruction>Review these Linear ticket snapshot attachments before responding to the user message. Read the referenced markdown file(s) and treat the ticket as the task's source context:",
        ...linearAttachmentPaths,
        '</system_instruction>',
      );
    }

    submittedText = [...attachmentInstructionLines, '', submittedText].join(
      '\n',
    );
  }

  if (options.inputMode === 'voice') {
    submittedText = [VOICE_SYSTEM_INSTRUCTION, '', submittedText].join('\n');
  }

  // A managed delegate's message already carries the broker's own wrapper.
  if (options.agentSent && isExternalAgentSent(options.agentSent)) {
    submittedText = [
      externalAgentSystemInstruction(options.agentSent),
      '',
      submittedText,
    ].join('\n');
  }

  return prependPendingSystemInstructions(
    submittedText,
    options.pendingSystemInstructions,
  );
}

/**
 * Prepend one-shot pending system instructions as the outermost block of a
 * submitted message. {@link buildSubmittedMessageText} applies it last, so a
 * caller may build the rest of the message first and add instructions
 * resolved later (for example, the active plan) with identical output.
 */
export function prependPendingSystemInstructions(
  text: string,
  instructions: PendingSystemInstruction[] | undefined,
): string {
  const pendingInstructionBlock =
    formatPendingSystemInstructionBlock(instructions);
  return pendingInstructionBlock
    ? [pendingInstructionBlock, '', text].join('\n')
    : text;
}
