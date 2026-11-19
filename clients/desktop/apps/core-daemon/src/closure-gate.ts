import {
  captureWindowsClosureContext,
  LocalAuthorityIdentityError,
} from '@canopy/core-platform';
import {
  type PlatformPowerServices,
  type PlatformSecureFileServices,
  type PlatformServices,
  type PlatformSupervisionServices,
  PlatformTrashError,
  type PlatformTrashServices,
} from '@canopy/core-runtime';

export interface ClosureGate {
  /** The only host platform the daemon composes. */
  readonly platform: PlatformServices;
  /** The host's trusted TokenUser observation, gated like identity reads. */
  readonly windowsPrincipal?: () => Promise<string>;
  /** Idempotent: no identity, permission, power or Trash helper starts after it. */
  seal(): void;
}

const SEALED = 'daemon closure sealed';

/**
 * The sole holder of the raw host platform and principal observer for one
 * owned daemon run. Identity, permission and process-table reads, power and
 * Trash requests, the platform's helper launches, check the run's closure
 * context and are refused once sealed. Assertions already held end with their own release. Tree
 * termination is never offered: nothing in the daemon uses it, and its
 * taskkill has no edge.
 */
export function createClosureGate(
  raw: PlatformServices,
  host: { readonly windowsPrincipal?: () => Promise<string> } = {},
): ClosureGate {
  const checkContext = captureWindowsClosureContext();
  let sealed = false;
  const { secureFiles, supervision, power, trash } = raw;
  const { windowsPrincipal } = host;
  const gatedFiles: PlatformSecureFileServices = {
    ...secureFiles,
    syncDirectory: async (path) => {
      checkContext();
      if (sealed) throw new Error(SEALED);
      return secureFiles.syncDirectory(path);
    },
    permissions: async (request) => {
      checkContext();
      if (sealed) return { state: 'unverifiable', reason: SEALED };
      return secureFiles.permissions(request);
    },
  };
  const gatedSupervision: PlatformSupervisionServices = {
    ...supervision,
    killProcessTree: () =>
      Promise.reject(new Error('Process tree termination is unavailable.')),
    inspectProcess: async (request) => {
      checkContext();
      if (sealed) return { state: 'unverifiable', reason: SEALED };
      return supervision.inspectProcess(request);
    },
    readProcessTable: async (request) => {
      checkContext();
      if (sealed) return { kind: 'unavailable', reason: SEALED };
      return supervision.readProcessTable(request);
    },
    ...(supervision.listProcessGroup && {
      listProcessGroup: async (request) => {
        checkContext();
        if (sealed) return { state: 'unverifiable', reason: SEALED };
        return (
          supervision.listProcessGroup?.(request) ?? {
            state: 'unverifiable',
            reason: 'Process groups are unavailable.',
          }
        );
      },
    }),
  };
  const gatedPower: PlatformPowerServices = {
    mechanism: power.mechanism,
    preventSystemSleep: (request) => {
      checkContext();
      if (sealed) return { kind: 'unavailable', reason: SEALED };
      return power.preventSystemSleep(request);
    },
  };
  const gatedTrash: PlatformTrashServices | undefined = trash && {
    trashItem: async (path) => {
      checkContext();
      if (sealed) throw new PlatformTrashError('unavailable', SEALED);
      return trash.trashItem(path);
    },
  };
  return Object.freeze({
    platform: Object.freeze({
      ...raw,
      secureFiles: Object.freeze(gatedFiles),
      supervision: Object.freeze(gatedSupervision),
      power: Object.freeze(gatedPower),
      ...(gatedTrash && { trash: Object.freeze(gatedTrash) }),
    }),
    ...(windowsPrincipal && {
      windowsPrincipal: async (): Promise<string> => {
        checkContext();
        if (sealed)
          throw new LocalAuthorityIdentityError('principal_unavailable');
        return windowsPrincipal();
      },
    }),
    seal: (): void => {
      sealed = true;
    },
  });
}
