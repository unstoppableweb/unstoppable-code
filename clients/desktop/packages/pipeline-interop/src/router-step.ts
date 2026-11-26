/**
 * The `builtin/router` action's own rules for its `routes` input, shared by
 * the action, the executor and the workflow designer (CAN-4224), so a split
 * the designer draws is the one the router runs.
 */

/**
 * The route labels a router chooses from. A JSON array of strings is taken
 * as written; anything that isn't JSON is a comma-separated list, trimmed,
 * without empty entries.
 */
export function parseRouterRoutes(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    throw new Error('router requires routes');
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((value) => typeof value === 'string')
    ) {
      return parsed;
    }
  } catch {
    const values = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length > 0) {
      return values;
    }
  }
  throw new Error('routes must be a JSON string array or comma-separated list');
}
