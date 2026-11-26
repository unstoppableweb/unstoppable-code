const inputListeners = new Map<string, Set<() => void>>();

/** Observes user input intent without exposing terminal data. */
export function subscribeTerminalInput(
  terminalId: string,
  listener: () => void,
): () => void {
  let listeners = inputListeners.get(terminalId);
  if (!listeners) {
    listeners = new Set();
    inputListeners.set(terminalId, listeners);
  }
  listeners.add(listener);
  return (): void => {
    if (listeners.delete(listener) && listeners.size === 0)
      inputListeners.delete(terminalId);
  };
}

export function notifyTerminalInput(terminalId: string): void {
  for (const listener of inputListeners.get(terminalId) ?? []) listener();
}
