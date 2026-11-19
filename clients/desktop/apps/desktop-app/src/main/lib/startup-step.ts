import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';

/**
 * The local console line of each startup migration run through
 * `runStartupStep`. Only the key leaves the machine, as the app-error source.
 */
const STARTUP_MIGRATION_CONSOLE_MESSAGES = {
  'migration.approval_defaults': 'Failed to migrate approval defaults:',
  'migration.chat_summary_model':
    'Failed to migrate chat summary model selection:',
  'migration.local_memory_model': 'Failed to migrate the local memory model:',
  'migration.app_managed_chats':
    'Failed to migrate app-managed chat projects or App Advisor Work Entries:',
  'migration.standalone_chat_to_cowork':
    'Failed to migrate standalone-chat to cowork projects:',
  'migration.cowork_map_cache': 'Failed to load cowork migration map cache:',
  'migration.cowork_work_entries':
    'Failed to migrate cowork chats to work entries:',
  'migration.default_cowork_name':
    'Failed to migrate the default cowork workspace name:',
  'migration.automation_run_history':
    'Failed to migrate automation run history:',
  'migration.claude_worker_modes': 'Failed to migrate Claude worker modes:',
  'migration.sidebar_remote_control':
    'Failed to migrate sidebar Remote Control:',
  'migration.sidebar_more_pages': 'Failed to migrate sidebar More pages:',
  'migration.local_memory_default': 'Failed to migrate local memory default:',
  'migration.sidebar_sort_default': 'Failed to migrate sidebar sort default:',
  'migration.built_in_browser_links':
    'Failed to migrate built-in browser link default:',
} as const satisfies Record<`migration.${string}`, string>;

export type StartupMigrationStepName =
  keyof typeof STARTUP_MIGRATION_CONSOLE_MESSAGES;

/**
 * Fixed names for startup steps whose failure is reported. The name becomes the
 * app-error source (`startup.<name>`), so it must stay a closed literal: never
 * build one from a path, id, or error text.
 */
export type StartupStepName =
  | StartupMigrationStepName
  | 'migration.ledger_last_good'
  | 'migration.ledger_unavailable.damaged'
  | 'migration.ledger_unavailable.newer_version'
  | 'service.background_binding_repair'
  | 'service.automations'
  | 'service.shared_plan'
  | 'service.observability'
  | 'service.copilot_recovery'
  | 'service.interrupted_work_recovery'
  | 'service.interrupted_pipeline_recovery'
  | 'service.remote_control';

const reportedStartupSteps = new Set<StartupStepName>();

/**
 * Report a startup step failure once per session. Only the fixed source and
 * stack frames leave the machine, never the message. Never throws; the caller
 * keeps its own local log line.
 */
export function reportStartupStepFailure(
  name: StartupStepName,
  error: unknown,
): void {
  if (reportedStartupSteps.has(name)) return;
  reportedStartupSteps.add(name);
  try {
    reportMainAppError(error, { source: `startup.${name}` });
  } catch {
    // Reporting must never change how startup continues.
  }
}

/**
 * Run a startup migration. A failure keeps its console line, is reported once,
 * and startup continues.
 */
export async function runStartupStep(
  name: StartupMigrationStepName,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(STARTUP_MIGRATION_CONSOLE_MESSAGES[name], error);
    reportStartupStepFailure(name, error);
  }
}
