/**
 * The standard Customize grid (CAN-4261): Updates, Installed, Browse and
 * Related rows use two columns from `md`. Shared by me chooses columns from
 * its section width so its public-link badge and actions fit at increased
 * interface scale (CAN-5220).
 */
export const CUSTOMIZE_ROW_GRID_CLASS =
  'grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2';

/**
 * The row ArrowDown (`step` 1) or ArrowUp (-1) moves to in a Customize grid:
 * the nearest item in the next visual row, closest to the current column.
 * In one column that is the adjacent item. Without layout (a zero-height
 * box), it falls back to the adjacent item.
 */
export function gridRowNeighbor(
  items: readonly HTMLElement[],
  index: number,
  step: 1 | -1,
): HTMLElement | undefined {
  const from = items[index]?.getBoundingClientRect();
  if (from === undefined || from.height === 0) return items[index + step];
  let next: HTMLElement | undefined;
  let nextRow = Infinity;
  let nextOffset = Infinity;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const row = (rect.top - from.top) * step;
    if (row < 1 || rect.height === 0) continue;
    const offset = Math.abs(rect.left - from.left);
    const sameRow = Math.abs(row - nextRow) <= 1;
    if ((!sameRow && row < nextRow) || (sameRow && offset < nextOffset)) {
      next = item;
      nextRow = row;
      nextOffset = offset;
    }
  }
  return next;
}
