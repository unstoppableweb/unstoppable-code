/**
 * Chart geometry shared by the recharts module and the lazy-chunk fallbacks,
 * so a placeholder occupies exactly the space the chart will take. Kept free
 * of recharts so the statistics shell can import it eagerly.
 */

/** Height (px) of the horizontal category bar chart for `rowCount` rows. */
export function categoryBarChartHeight(rowCount: number): number {
  return Math.max(160, rowCount * 36 + 24);
}
