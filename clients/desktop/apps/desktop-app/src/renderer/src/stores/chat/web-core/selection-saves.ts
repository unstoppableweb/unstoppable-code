/**
 * Cloud chat selection saves in flight, by the store's chat id (CAN-6175 R5).
 * The picker saves a chat's skills, plugins and MCP servers on the web core
 * and closes at once, and a model pick saves through `chat.set_model`; a
 * message sent meanwhile waits for the save, so its turn runs with what the
 * user just chose.
 */
const saves = new Map<string, Promise<unknown>>();

/**
 * Records a chat's selection save until it settles. A save made while
 * another is in flight joins it, so a waiter waits for both: a model pick
 * never lets a send overtake a plugins save still running.
 */
export function trackSelectionSave(
  chatId: string,
  save: Promise<unknown>,
): void {
  const own = save.then(
    () => undefined,
    () => undefined,
  );
  const settled = Promise.all([saves.get(chatId), own]).then(() => undefined);
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
