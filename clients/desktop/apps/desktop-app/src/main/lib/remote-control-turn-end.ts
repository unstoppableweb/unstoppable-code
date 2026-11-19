import type {
  PersistedChatTab,
  RemoteControlChatTurnEnd,
} from '@canopy/desktop-shared/types';

/**
 * How the tab's latest turn ended, for Portal chat summaries: its latest
 * accepted turn, or a later prompt that ended before any provider accepted
 * it. Nothing while the accepted turn has no recorded end, since it may still
 * run. Ends at the same time go to the later prompt: unaccepted ends are
 * recorded in prompt order. Worktree and Cowork chat summaries share it so
 * web consumers see one shape.
 */
export function projectRemoteControlLastTurnEnd(
  tab: PersistedChatTab,
): RemoteControlChatTurnEnd | undefined {
  const accepted = tab.lastAcceptedUserMessageId;
  if (accepted !== undefined && tab.turnEnds?.[accepted] === undefined)
    return undefined;
  let latest: RemoteControlChatTurnEnd | undefined;
  let latestEndedAt = -Infinity;
  for (const userMessageId of [
    ...(accepted === undefined ? [] : [accepted]),
    ...Object.keys(tab.unacceptedTurnEnds ?? {}),
  ]) {
    const end = tab.turnEnds?.[userMessageId];
    if (end === undefined || end.endedAt < latestEndedAt) continue;
    latestEndedAt = end.endedAt;
    latest = {
      userMessageId,
      outcome: end.outcome,
      endedAt: new Date(end.endedAt).toISOString(),
    };
  }
  return latest;
}
