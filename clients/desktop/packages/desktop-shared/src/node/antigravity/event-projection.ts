import { CursorEventProjection } from '../cursor/events';
import {
  antigravityToolDisplay,
  type AntigravityToolRoutes,
} from './tool-display';

/** Routes for a surface with no MCP routes in scope: every MCP title stays raw. */
const EMPTY_ROUTES: AntigravityToolRoutes = {
  canonicalNameFor: (): undefined => undefined,
};

/** The turn's result when Google ends it right after a denied native call. */
export const ANTIGRAVITY_DENIED_STOP_MESSAGE =
  'Google stopped after a denied tool call. Send a follow-up to continue.';

/**
 * The one ACP projection the main Antigravity session, the delegate runner
 * and the pipeline runner share, so native tool arguments and MCP names
 * render identically on every surface. Cursor's error recognition is off:
 * Antigravity's errors are not Cursor's.
 */
export function createAntigravityEventProjection(input: {
  limitMessage: string;
  routes?: AntigravityToolRoutes;
  secretValues?: readonly string[];
  /** Why the host denied a call, shown as its result when the runtime gives none. */
  deniedToolResult?: (toolCallId: string) => string | undefined;
}): CursorEventProjection {
  const routes = input.routes ?? EMPTY_ROUTES;
  return new CursorEventProjection(input.limitMessage, {
    recognizeCursorErrors: false,
    toolDisplay: (tool): { name: string; input: unknown } =>
      antigravityToolDisplay(tool, routes),
    ...(input.secretValues ? { secretValues: input.secretValues } : {}),
    ...(input.deniedToolResult
      ? { toolResultOverride: input.deniedToolResult }
      : {}),
  });
}
