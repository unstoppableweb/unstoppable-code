import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CursorCapabilityProjection } from '../../lib/cursor-capabilities';
import { expandLeadingCursorCommand } from '../../lib/cursor-capabilities';
import { materializeSelectedCapabilityRoot } from '../cursor/capability-root';
import { readAntigravityAttachments } from './prompt';

// Skill payloads have a separate aggregate budget from user attachments.
const MAX_SKILL_PROMPT_BYTES = 4 * 1024 * 1024;

/** Host projection delivers selected content explicitly; native discovery is separate (CAP-02). */
export async function prepareAntigravityCapabilities(input: {
  root: string;
  projection: CursorCapabilityProjection;
  signal: AbortSignal;
}): Promise<{
  instructions: string;
  fingerprint: string;
  notices: string[];
  expandPrompt: (text: string) => string;
}> {
  const prepared = await materializeSelectedCapabilityRoot(
    input.root,
    input.projection,
    {
      verifyContent: true,
      signal: input.signal,
    },
  );
  const skills = input.projection.skills.filter((skill) =>
    prepared.skillIds.includes(skill.id),
  );
  const commands = input.projection.commands.filter((command) =>
    prepared.commandIds.includes(command.id),
  );
  const notices = prepared.warnings.map((warning) =>
    warning.split('Cursor').join('Antigravity'),
  );
  const skillContent: string[] = [];
  let remaining = MAX_SKILL_PROMPT_BYTES;
  for (const skill of skills) {
    input.signal.throwIfAborted();
    try {
      // One bounded read per skill retains UTF-8, link, containment and opened
      // file identity checks without imposing the user attachment count limit.
      // The reader caps each file at 4 MiB; the independent budget below also
      // counts inline wrappers and skill metadata, in projection order.
      const content = await readAntigravityAttachments(
        {
          baseDir: input.root,
          paths: [join(input.root, 'skills', skill.id, 'SKILL.md')],
        },
        input.signal,
      );
      const entry = [
        `Selected skill /${skill.id}: ${skill.label}. Supporting files: ${JSON.stringify(join(input.root, 'skills', skill.id))}.`,
        ...content.flatMap((block) =>
          block.type === 'text' ? [block.text] : [],
        ),
      ].join('\n\n');
      const bytes = Buffer.byteLength(entry) + 2;
      if (bytes > remaining) {
        notices.push(
          `Skill "${skill.label}" was not loaded because it exceeds the remaining 4 MB skill text budget.`,
        );
        continue;
      }
      remaining -= bytes;
      skillContent.push(entry);
    } catch (error) {
      input.signal.throwIfAborted();
      notices.push(
        `Skill "${skill.label}" was not loaded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Inline text is necessary: this runtime ignores embedded resource.text blocks.
  const instructions = [
    'These are the selected capabilities for this turn. Earlier selections may have been removed; use only the current list.',
    ...skillContent,
    ...commands.map(
      (command) => `Selected command /${command.id}: ${command.description}`,
    ),
  ].join('\n\n');
  return {
    instructions,
    fingerprint: createHash('sha256')
      .update(prepared.fingerprint)
      .update(instructions)
      .digest('hex'),
    notices,
    expandPrompt: (text) => expandLeadingCursorCommand(text, commands),
  };
}
