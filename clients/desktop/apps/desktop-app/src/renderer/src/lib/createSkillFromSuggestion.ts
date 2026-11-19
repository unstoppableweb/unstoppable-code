import { useCallback, useRef, useState } from 'react';
import type { Descendant } from 'slate';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  ORG_DEFAULT_COWORK_WORKSPACE_ID_PREFIX,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  SKILL_SUGGESTION_DRAFT_PROMPT_LEAD,
  skillSuggestionChainDraftLead,
  type SkillSuggestion,
  type SkillSuggestionOwner,
} from '@canopy/desktop-shared/lib/skill-suggestions';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/**
 * "Create skill" for a repeat-task suggestion (CAN-385) hands the task to a
 * new Cowork chat with a drafting prompt in the composer, the same shape as
 * Edit with AI. Nothing is sent: the user reviews the prompt first. The chat
 * drafts `SKILL.md` and saves it through the skill tools every chat has.
 */

/** Shown when the drafting chat could not be opened. */
export const CREATE_SKILL_FROM_SUGGESTION_ERROR =
  "Couldn't start the chat. Try again.";

/**
 * The owner's default Cowork workspace. An organization suggestion drafts in
 * that organization's Chats, never in Personal.
 */
export function skillSuggestionWorkspaceId(
  owner: SkillSuggestionOwner,
): string {
  return owner.kind === 'organization'
    ? `${ORG_DEFAULT_COWORK_WORKSPACE_ID_PREFIX}${owner.organizationId}`
    : DEFAULT_COWORK_WORKSPACE_ID;
}

export interface CreateSkillPromptOptions {
  /** Chain skills that are no longer installed. */
  readonly missingSkills?: readonly string[];
}

/** The editable drafting prompt placed in the new chat's composer. */
export function buildCreateSkillFromSuggestionPrompt(
  suggestion: SkillSuggestion,
  options: CreateSkillPromptOptions = {},
): string {
  const lines: string[] = [];
  if (suggestion.kind === 'chain') {
    lines.push(skillSuggestionChainDraftLead(suggestion.chainSkills));
  } else {
    lines.push(SKILL_SUGGESTION_DRAFT_PROMPT_LEAD);
  }
  lines.push('');
  lines.push(`Task: ${suggestion.title}`);
  if (suggestion.summary) lines.push(`What it does: ${suggestion.summary}`);
  lines.push(`Suggested name: ${suggestion.proposedSkillName}`);
  if (suggestion.proposedDescription)
    lines.push(`Description: ${suggestion.proposedDescription}`);
  if (suggestion.parameters.length > 0)
    lines.push(
      `Inputs that change each time: ${suggestion.parameters.join(', ')}`,
    );
  if (suggestion.owner.kind === 'organization')
    lines.push(`This came from my work in ${suggestion.ownerLabel}.`);
  // Private workspaces never put their requests in another chat.
  const examples = suggestion.isPrivate ? [] : suggestion.examples.slice(0, 3);
  if (examples.length > 0) {
    lines.push('');
    lines.push('How I usually ask for it:');
    for (const example of examples) {
      lines.push(`> ${example.replace(/\s*\n\s*/g, ' ')}`);
    }
  }
  lines.push('');
  if (suggestion.kind === 'chain') {
    lines.push(
      "Draft one SKILL.md whose steps invoke each skill in order and pass each step's output to the next. Don't copy the skills' contents.",
    );
    const missing = options.missingSkills ?? [];
    if (missing.length > 0)
      lines.push(
        `These skills aren't installed anymore: ${missing.join(', ')}. Ask me how to handle those steps.`,
      );
  } else {
    lines.push('Draft a SKILL.md for it, with the inputs above as parameters.');
  }
  lines.push(
    'Show me the draft. After I confirm, save it with skills.create_custom and turn it on for this chat. Then ask whether to add it to my default skills so new chats have it too.',
  );
  // A skill drafted from a private workspace is never offered for sharing.
  if (suggestion.owner.kind === 'organization' && !suggestion.isPrivate)
    lines.push(
      `Once it's saved, offer to share it with ${suggestion.ownerLabel} using sharing.open_dialog.`,
    );
  return lines.join('\n');
}

function draftFromPrompt(prompt: string): Descendant[] {
  return prompt.split('\n').map((text) => ({
    type: 'paragraph',
    children: [{ text }],
  }));
}

/** Installed refs for a chain's skills, and the names that are gone. */
async function resolveChainSkills(chainSkills: readonly string[]): Promise<{
  skillRefs: ChatTabPluginSelections['skillRefs'];
  missing: string[];
}> {
  if (chainSkills.length === 0) return { skillRefs: [], missing: [] };
  let installed: InstalledSkillInfo[] = [];
  try {
    const result = await window.skills.loadSkills();
    if (result.success && result.data) installed = result.data;
  } catch {
    // An unreadable inventory names every skill as missing; the chat asks.
  }
  const skillRefs: ChatTabPluginSelections['skillRefs'] = [];
  const missing: string[] = [];
  for (const name of Array.from(new Set(chainSkills))) {
    // Chain names are lowercased and may carry a `plugin:` namespace.
    const bare = name.slice(name.lastIndexOf(':') + 1);
    const match =
      installed.find((skill) => skill.name.toLowerCase() === name) ??
      installed.find((skill) => skill.name.toLowerCase() === bare);
    if (match)
      skillRefs.push({ sourceId: match.sourceId, skillName: match.name });
    else missing.push(name);
  }
  return { skillRefs, missing };
}

/**
 * Opens the drafting chat in the owner's default Cowork workspace and puts the
 * prompt in its composer. Rejects, without navigating, when the chat cannot
 * be created (for example the user left the organization).
 */
export async function openCreateSkillFromSuggestionChat(
  suggestion: SkillSuggestion,
): Promise<string> {
  const { skillRefs, missing } =
    suggestion.kind === 'chain'
      ? await resolveChainSkills(suggestion.chainSkills)
      : { skillRefs: [], missing: [] };
  const pluginSelections: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs,
    pluginRefs: [],
  };
  const chatId = await useStandaloneChatStore
    .getState()
    .createStandaloneChatWithMessage({
      message: '',
      chatProjectId: skillSuggestionWorkspaceId(suggestion.owner),
      config: { pluginSelections },
    });
  useChatStore.getState().saveTabDraft(
    chatId,
    draftFromPrompt(
      buildCreateSkillFromSuggestionPrompt(suggestion, {
        missingSkills: missing,
      }),
    ),
  );
  // The modal can be opened from Settings; the chat would open behind it.
  const navigation = useNavigationStore.getState();
  navigation.closeSettings();
  navigation.navigate('chat');
  return chatId;
}

export interface CreateSkillFromSuggestion {
  /** The suggestion whose chat is being opened, if any. */
  pendingId: string | null;
  /**
   * Opens the drafting chat once at a time. `onCreated` runs only after the
   * chat exists, so a failure leaves the suggestion unresolved.
   */
  start: (suggestion: SkillSuggestion, onCreated: () => void) => void;
}

export function useCreateSkillFromSuggestion(): CreateSkillFromSuggestion {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const start = useCallback(
    (suggestion: SkillSuggestion, onCreated: () => void): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPendingId(suggestion.id);
      void openCreateSkillFromSuggestionChat(suggestion)
        .then(onCreated, (error: unknown): void => {
          useGitHubStore
            .getState()
            .addToast(CREATE_SKILL_FROM_SUGGESTION_ERROR, 'error', undefined, {
              caught: error,
            });
        })
        .finally((): void => {
          inFlight.current = false;
          setPendingId(null);
        });
    },
    [],
  );
  return { pendingId, start };
}
