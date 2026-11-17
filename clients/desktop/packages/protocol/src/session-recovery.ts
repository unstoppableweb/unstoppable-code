/** A provider rejected resume before accepting a prompt. Never authorizes replay. */
export interface SessionResumeFailure {
  kind: 'resume-failed';
  provider: 'antigravity';
  sessionId: string;
}

export function readSessionResumeFailure(
  value: unknown,
): SessionResumeFailure | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    value.kind !== 'resume-failed' ||
    !('provider' in value) ||
    value.provider !== 'antigravity' ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    value.sessionId.length > 1024
  )
    return undefined;
  return {
    kind: value.kind,
    provider: value.provider,
    sessionId: value.sessionId,
  };
}

/** Only the latest user turn may offer recovery; later user input retires it. */
export function resumeFailureUserIndex<T extends { role: string }>(
  messages: readonly T[],
  failuresFor: (message: T) => readonly unknown[],
): number | undefined {
  let failed = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'user') return failed ? index : undefined;
    if (
      failuresFor(message).some((failure) => readSessionResumeFailure(failure))
    )
      failed = true;
    // A subsequent assistant response means that recovery offer is obsolete.
    else if (message.role === 'assistant' && !failed) return undefined;
  }
  return undefined;
}
