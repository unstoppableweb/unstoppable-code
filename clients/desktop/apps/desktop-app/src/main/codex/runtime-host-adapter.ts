import { BRAND } from '@canopy/brand/current';
import {
  configureCodexRuntimeHostHooks,
  GROUP_COMMIT_OWNER_ADMISSION_BUDGET,
  type CodexWorkerResourceRegistration,
} from '@canopy/execution-engine/node/codex-runtime';
import type { ClientInfo } from '@canopy/execution-engine/node/codex-runtime/generated/ClientInfo';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { getResourceMonitorService } from '../resource-monitor';
import {
  registerCodexAppServerProcess,
  unregisterCodexAppServerProcess,
} from './app-server-process-registry';

const FALLBACK_CLIENT_VERSION = '0.0.0';

function isElectronAppLike(value: unknown): value is { getVersion(): string } {
  const getVersion: unknown =
    typeof value === 'object' && value !== null
      ? Reflect.get(value, 'getVersion')
      : undefined;
  return typeof getVersion === 'function';
}

function getDesktopClientInfo(): ClientInfo {
  let version = FALLBACK_CLIENT_VERSION;
  try {
    // Keep Electron behind the host adapter so the shared runtime remains
    // importable by the SEA CLI.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronModule: unknown = require('electron');
    if (typeof electronModule === 'object' && electronModule !== null) {
      const app: unknown = Reflect.get(electronModule, 'app');
      if (isElectronAppLike(app)) {
        version = app.getVersion();
      }
    }
  } catch {
    // Tests and non-Electron import probes use the fallback version.
  }

  return {
    name: BRAND.internalName,
    title: BRAND.displayName,
    version,
  };
}

configureCodexRuntimeHostHooks({
  clientInfo: getDesktopClientInfo,
  productDisplayName: () => BRAND.displayName,
  registerProcess: (registration: CodexWorkerResourceRegistration) =>
    getResourceMonitorService().registerProcess(registration),
  registerProcessOwner: registerCodexAppServerProcess,
  unregisterProcessOwner: unregisterCodexAppServerProcess,
  recordDiagnostic: (event) => {
    getExecutionObservabilityIngest().recordAppDiagnostic(event);
  },
  // Chat storage group-commits, so one
  // chat may have several notification admissions pending, so its commits
  // can share a journal sync.
  ownerAdmissionBudget: () => GROUP_COMMIT_OWNER_ADMISSION_BUDGET,
});
