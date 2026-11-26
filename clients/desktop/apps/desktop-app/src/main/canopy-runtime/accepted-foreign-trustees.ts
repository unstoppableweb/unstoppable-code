import type { PlatformPermissionAcceptance } from '@canopy/core-runtime';
import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { logMainProcessWarn } from '../lib/main-process-logging';

/** Which of the folders that opt into `foreignTrustees: 'accept'` was admitted. */
export type AcceptedPathRole =
  | 'data_root'
  | 'runtime'
  | 'runtime_file'
  | 'secure_storage'
  | 'internal_migration';

const OPERATION = 'canopy.daemon_data_folder';

const logged = new Set<string>();
const sent = new Set<AcceptedPathRole>();

/**
 * CAN-7915 (q-7, warn and carry on): main.log names the path and the accepted
 * SIDs, once per path and SID set per launch; telemetry gets only the closed
 * code and role, once per role per launch.
 */
export function reportAcceptedForeignTrustees(
  path: string,
  role: AcceptedPathRole,
  acceptance: PlatformPermissionAcceptance,
): void {
  const trustees = [...acceptance.trustees].sort();
  const key = `${path}\0${trustees.join(',')}`;
  if (!logged.has(key)) {
    logged.add(key);
    logMainProcessWarn(
      'Started with a data folder that other accounts on this computer can open',
      { path, role, trustees, cause: acceptance.cause },
    );
  }
  if (sent.has(role)) return;
  sent.add(role);
  try {
    const context = {
      permission_outcome: 'accepted_foreign_trustee',
      path_role: role,
    };
    const operationKey = createDesktopInstrumentationOperationKey(
      `${OPERATION}:${role}:${Date.now()}`,
    );
    startDesktopOperation(OPERATION, { operationKey, context });
    succeedDesktopOperation(OPERATION, { operationKey, context });
  } catch {
    // Telemetry never affects startup.
  }
}
