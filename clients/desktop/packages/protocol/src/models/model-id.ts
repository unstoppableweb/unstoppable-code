/**
 * Persisted keys are intentionally broader than the current catalog so stale
 * assignments survive temporary catalog removal. Whitespace/control bytes are
 * rejected because model ids are serialized as object keys and command data.
 */
export function isSyntacticallyValidModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || /\s/.test(character);
    })
  );
}
