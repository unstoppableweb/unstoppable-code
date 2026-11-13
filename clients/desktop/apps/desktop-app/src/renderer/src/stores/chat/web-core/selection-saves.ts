/**
 * Cloud chat selection saves in flight, by the store's chat id (CAN-6175 R5).
 * The picker saves a chat's skills, plugins and MCP servers on the web core
 * and closes at once; a message sent meanwhile waits for the save, so its
 * turn runs with the selection the user just chose.
 */
const saves = new Map<string, Promise<unknown>>();

/** Records a chat's selection save until it settles. */
export function trackSelectionSave(
  chatId: string,
  save: Promise<unknown>,
): void {
  const settled = save.then(
    () => undefined,
    () => undefined,
  );
  saves.set(chatId, settled);
  void settled.then(() => {
    if (saves.get(chatId) === settled) saves.delete(chatId);
  });
}

/** Resolves once the chat's latest selection save settled, saved or not. */
export function selectionSaveSettled(chatId: string): Promise<void> {
  const save = saves.get(chatId);
  return save === undefined ? Promise.resolve() : save.then(() => undefined);
}
