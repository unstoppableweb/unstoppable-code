/**
 * CAN-7228: an agent's `pipeline.save` presents the open workflow editor's
 * own Save, which reaches main through the same IPC as a person's click. Main
 * notes the agent's request, and the next editor save within this window is
 * recorded as the agent's: it never takes an agent's schedule over. A
 * person's save that falls in the window only fails closed.
 */
const AGENT_EDITOR_SAVE_WINDOW_MS = 60_000;

let agentSaveRequestedUntil = 0;

/** An agent asked the open workflow editor to save. */
export function noteAgentRequestedEditorSave(now = Date.now()): void {
  agentSaveRequestedUntil = now + AGENT_EDITOR_SAVE_WINDOW_MS;
}

/** Whether an editor save now is the one an agent asked for. */
export function agentRequestedEditorSavePending(now = Date.now()): boolean {
  return now < agentSaveRequestedUntil;
}

/**
 * Ends the agent's request once its save has an outcome. A save that stopped
 * to confirm its schedules keeps it, so the confirmed retry stays the
 * agent's; one never retried lapses with the window.
 */
export function endAgentRequestedEditorSave(): void {
  agentSaveRequestedUntil = 0;
}
