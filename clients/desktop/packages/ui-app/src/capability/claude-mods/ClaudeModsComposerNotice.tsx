'use client';

import { memo, useState, type JSX } from 'react';
import type {
  ClaudeModPluginDetailsTarget,
  ClaudeModsChatContext,
} from '@canopy/protocol/claude-mods';
import type { ClaudeModsSkippedMod } from '@canopy/ui-shared/components';
import { ClaudeModsSkippedNoticeView } from './ClaudeModsSkippedNotice';

/**
 * Each chat's dismissed forecast, by the Mods it named; this session only.
 * Written only from the dismiss handler, never during render.
 */
const dismissedModsByChat = new Map<string, ReadonlySet<string>>();

export interface ClaudeModsComposerNoticeProps {
  readonly context: ClaudeModsChatContext;
  /** From the chat's discovery: Mods its next launch would leave out. */
  readonly mods: readonly ClaudeModsSkippedMod[];
  /** Opens a catalog plugin's details page. Without it, no plugin links. */
  readonly onOpenDetails?: (details: ClaudeModPluginDetailsTarget) => void;
}

/**
 * Above the composer, before a message is sent: the plugins this chat turned
 * on whose Mod won't load, with the launch notice's controls. Dismissing
 * hides it until it names a Mod the dismissal didn't, so a list that only
 * shrinks (a Mod allowed since) stays hidden. Mount it keyed by chat.
 */
function ClaudeModsComposerNoticeComponent({
  context,
  mods,
  onOpenDetails,
}: ClaudeModsComposerNoticeProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() =>
    dismissedModsByChat.get(context.chatId),
  );
  if (
    mods.length === 0 ||
    (dismissed !== undefined &&
      mods.every((mod) => dismissed.has(mod.pluginId)))
  ) {
    return null;
  }
  return (
    <ClaudeModsSkippedNoticeView
      mods={mods}
      context={context}
      {...(onOpenDetails !== undefined ? { onOpenDetails } : {})}
      placement="composer"
      onDismiss={(): void => {
        const named = new Set(mods.map((mod) => mod.pluginId));
        dismissedModsByChat.set(context.chatId, named);
        setDismissed(named);
      }}
    />
  );
}

export const ClaudeModsComposerNotice = memo(ClaudeModsComposerNoticeComponent);
