import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import { classifySystemError } from '@canopy/desktop-shared/node/lib/app-error-classification';

/** Static app-error sources for plugin failures a chat launch skips past. */
type PluginLaunchFailureSource =
  | 'plugin.claude_projection'
  | 'plugin.mcp_server_read';

/**
 * Report a failure the launch recovers from by leaving the plugin or server
 * out. Only the static `source`, the classified code, an allowlisted errno and
 * the error's frames leave the process; the message and any path stay local.
 * A full disk classifies as an external failure, as elsewhere. Never throws:
 * a reporting failure must not change the launch.
 */
export function reportPluginLaunchFailure(
  error: unknown,
  source: PluginLaunchFailureSource,
): void {
  try {
    reportMainAppError(classifySystemError(error), { source });
  } catch {
    // Reporting is best effort.
  }
}
