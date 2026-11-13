/** Shared count copy for the Cursor rules review and its result toast. */
export function ruleCountLabel(count: number): string {
  return count === 1 ? '1 rule' : `${count} rules`;
}
