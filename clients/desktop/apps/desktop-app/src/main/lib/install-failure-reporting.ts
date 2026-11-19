import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import {
  AppErrorSchema,
  getAppErrorDefinition,
  type AppError,
} from '@canopy/protocol/app-errors';

/** Static app-error sources for plugin, marketplace and skill install failures. */
export type InstallFailureSource =
  | 'plugin.install'
  | 'plugin.install_built_in'
  | 'plugin.marketplace.add'
  | 'plugin.marketplace.update'
  | 'plugin.marketplace.remove'
  | 'skill.install'
  | 'skill.save_custom'
  | 'skill.update';

/**
 * Report an install, add, update or remove failure that a handler catches and
 * returns as `{ success: false, error }`. Only the static `source`, the
 * classified code and the error's frames leave the process; the message stays
 * in the returned `error` text. Call it from a catch block only: a refusal
 * the handler returns on its own (invalid input, an uninstall still pending)
 * is not an unexpected failure. A thrown validation error classifies as an
 * input error, which the handler never records, and a thrown skill access
 * refusal is skipped.
 *
 * Returns `{ appError }` to spread into the result: the recorded error in
 * wire-safe form (catalog copy, detail reduced to the code) so the renderer
 * links to it instead of recording the failure again; `{}` when nothing was
 * recorded. Never throws: a reporting failure must not change the caller's
 * result.
 */
export function reportInstallFailure(
  error: unknown,
  source: InstallFailureSource,
): { appError?: AppError } {
  try {
    if (isSkillContextRefusal(error)) return {};
    const report = reportMainAppError(error, { source });
    if (report === undefined || report.disposition === 'none') return {};
    return {
      appError: AppErrorSchema.parse({
        ...report.error,
        copy: getAppErrorDefinition(report.error.code).copy,
        detail: { message: report.error.code },
      }),
    };
  } catch {
    return {};
  }
}

/**
 * A skill access or provenance check refused the change: the skill context
 * checks throw `Skill unavailable (<reason>)`, which the catalog host already
 * classifies as a refusal. It is not a failure to report.
 */
function isSkillContextRefusal(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith('Skill unavailable (')
  );
}
