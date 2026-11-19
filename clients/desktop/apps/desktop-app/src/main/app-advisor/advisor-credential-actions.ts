import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
  AppAdvisorJson,
  OllamaState,
} from '@canopy/desktop-shared/types';
import type { RemoteControlState } from '@canopy/desktop-shared/types/remote-control';
import { toAdvisorJson } from './advisor-json';

/**
 * CAN-6008: App Advisor's credential and remote-access actions that call
 * main owners, run only while the session binds the main window's lease
 * (the router refuses them otherwise).
 */
export const ADVISOR_CREDENTIAL_ACTION_TYPES = [
  'canopy_cloud.load_account',
  'canopy_cloud.validate_api_key',
  'canopy_cloud.save_api_key',
  'canopy_cloud.clear_api_key',
  'canopy_cloud.start_oauth_login',
  'canopy_cloud.cancel_oauth_login',
  'canopy_cloud.disconnect',
  'canopy_portal.start',
  'canopy_portal.stop',
  'remote_control.get_state',
  'remote_control.set_allow_incoming',
  'opencode.connection',
  'ollama.install',
] as const;

export type AdvisorCredentialAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_CREDENTIAL_ACTION_TYPES)[number] }
>;

export function isAdvisorCredentialAction(
  action: AppAdvisorAction,
): action is AdvisorCredentialAction {
  return ADVISOR_CREDENTIAL_ACTION_TYPES.some((type) => type === action.type);
}

export type OpenCodeOperation = Extract<
  AppAdvisorAction,
  { type: 'opencode.connection' }
>['operation'];

/** The main owners the window's Settings IPC handlers call. */
export interface AdvisorCredentialActionHost {
  loadCloudAccount(): Promise<unknown>;
  validateCloudApiKey(request: { apiKey?: string }): Promise<unknown>;
  saveCloudApiKey(request: { apiKey: string }): Promise<unknown>;
  clearCloudApiKey(): Promise<unknown>;
  startCloudOAuthLogin(): Promise<unknown>;
  cancelCloudOAuthLogin(): Promise<void>;
  disconnectCloudAccount(): Promise<unknown>;
  /** Device-to-device remote control; null before it starts. */
  remoteControl(): {
    getState(): Promise<RemoteControlState>;
    setAllowIncoming(allow: boolean): Promise<RemoteControlState>;
  } | null;
  /** OpenCode's Settings operations, owned by the main window. */
  openCode(
    operation: OpenCodeOperation,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Best effort: Settings at the Ollama section in the main window. */
  revealOllamaSettings(): Promise<void>;
  installOllama(): Promise<OllamaState>;
}

type Response = Omit<AppAdvisorActionResponse, 'requestId'>;

const REDACTED = '[redacted]';

/**
 * The forms of a key the action carried that could be said back: as sent,
 * and trimmed as Settings uses it. Longest first, so the padded form goes
 * before the trimmed one inside it.
 */
function secretsOf(apiKey: string | undefined): string[] {
  if (apiKey === undefined) return [];
  return [...new Set([apiKey, apiKey.trim()])]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
}

function redactText(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (redacted, secret) => redacted.split(secret).join(REDACTED),
    text,
  );
}

/** Removes a credential the action carried from anything said back. */
function redact(
  value: AppAdvisorJson,
  secrets: readonly string[],
): AppAdvisorJson {
  if (secrets.length === 0) return value;
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, AppAdvisorJson> = {};
    for (const [key, item] of Object.entries(value))
      result[key] = redact(item, secrets);
    return result;
  }
  return value;
}

function failure(
  error: unknown,
  fallback: string,
  secrets: readonly string[] = [],
): Response {
  const message =
    error instanceof Error && error.message ? error.message : fallback;
  return {
    ok: false,
    error: {
      code: 'execution_failed',
      message: redactText(message, secrets),
    },
  };
}

/** What App Advisor may see: no pairing codes or connection errors. */
function summarizeRemoteControlState(
  state: RemoteControlState,
): AppAdvisorJson {
  return {
    signedIn: state.signedIn,
    relayStatus: state.relayStatus,
    allowIncoming: state.allowIncoming,
    hosts: state.hosts.map((host) => ({
      deviceId: host.deviceId,
      name: host.name,
      platform: host.platform,
      online: host.online,
      connection: host.connection,
    })),
    controllers: state.controllers.map((controller) => ({
      deviceId: controller.deviceId,
      name: controller.name,
      platform: controller.platform,
      online: controller.online,
      connected: controller.connected,
    })),
    pendingPairingRequests: state.incomingPairings.length,
  };
}

const REMOTE_CONTROL_UNAVAILABLE: Response = {
  ok: false,
  error: {
    code: 'surface_unavailable',
    message: 'Remote control is not available.',
  },
};

/**
 * What a Remote Control action asks for. `canopy_portal.start` and `stop`
 * keep their names but turn Allow incoming on and off (CAN-5986).
 */
type RemoteControlRequest =
  | { kind: 'get_state' }
  | { kind: 'set_allow_incoming'; enabled: boolean };

async function remoteControlAction(
  request: RemoteControlRequest,
  host: AdvisorCredentialActionHost,
): Promise<Response> {
  const remote = host.remoteControl();
  if (!remote) return REMOTE_CONTROL_UNAVAILABLE;
  let state: RemoteControlState;
  try {
    state = await remote.getState();
  } catch {
    return REMOTE_CONTROL_UNAVAILABLE;
  }
  if (!state.available) return REMOTE_CONTROL_UNAVAILABLE;
  try {
    if (request.kind === 'get_state')
      return { ok: true, result: summarizeRemoteControlState(state) };
    const next = await remote.setAllowIncoming(request.enabled);
    return { ok: true, result: { allowIncoming: next.allowIncoming } };
  } catch (error) {
    return failure(error, 'Remote control failed.');
  }
}

function ollamaResult(state: OllamaState): Response {
  if (!state.installation.ready)
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: state.error ?? 'Ollama installation could not be completed.',
      },
    };
  return {
    ok: true,
    result: {
      mode: state.mode,
      status: state.status,
      installation: {
        ready: state.installation.ready,
        version: state.installation.version,
        source: state.installation.source,
        automaticInstallSupported: state.installation.automaticInstallSupported,
      },
      ...(state.error ? { error: state.error } : {}),
    },
  };
}

async function run(
  action: AdvisorCredentialAction,
  host: AdvisorCredentialActionHost,
  signal?: AbortSignal,
): Promise<Response> {
  switch (action.type) {
    case 'canopy_cloud.load_account':
      return { ok: true, result: toAdvisorJson(await host.loadCloudAccount()) };
    case 'canopy_cloud.validate_api_key': {
      const secrets = secretsOf(action.apiKey);
      try {
        const status = await host.validateCloudApiKey(
          action.apiKey === undefined ? {} : { apiKey: action.apiKey.trim() },
        );
        return { ok: true, result: redact(toAdvisorJson(status), secrets) };
      } catch (error) {
        return failure(error, 'Failed to validate the API key.', secrets);
      }
    }
    case 'canopy_cloud.save_api_key': {
      const secrets = secretsOf(action.apiKey);
      try {
        const saved = await host.saveCloudApiKey({
          apiKey: action.apiKey.trim(),
        });
        return { ok: true, result: redact(toAdvisorJson(saved), secrets) };
      } catch (error) {
        return failure(error, 'Failed to save the API key.', secrets);
      }
    }
    case 'canopy_cloud.clear_api_key':
      return { ok: true, result: toAdvisorJson(await host.clearCloudApiKey()) };
    case 'canopy_cloud.start_oauth_login':
      return {
        ok: true,
        result: toAdvisorJson(await host.startCloudOAuthLogin()),
      };
    case 'canopy_cloud.cancel_oauth_login':
      await host.cancelCloudOAuthLogin();
      return { ok: true };
    case 'canopy_cloud.disconnect':
      return {
        ok: true,
        result: toAdvisorJson(await host.disconnectCloudAccount()),
      };
    case 'canopy_portal.start':
      return remoteControlAction(
        { kind: 'set_allow_incoming', enabled: true },
        host,
      );
    case 'canopy_portal.stop':
      return remoteControlAction(
        { kind: 'set_allow_incoming', enabled: false },
        host,
      );
    case 'remote_control.get_state':
      return remoteControlAction({ kind: 'get_state' }, host);
    case 'remote_control.set_allow_incoming':
      return remoteControlAction(
        { kind: 'set_allow_incoming', enabled: action.enabled },
        host,
      );
    case 'opencode.connection': {
      const value = await host.openCode(action.operation, signal);
      return { ok: true, result: { value: toAdvisorJson(value ?? null) } };
    }
    case 'ollama.install':
      void host.revealOllamaSettings().catch(() => undefined);
      return ollamaResult(await host.installOllama());
  }
}

export async function dispatchAdvisorCredentialAction(
  action: AdvisorCredentialAction,
  host: AdvisorCredentialActionHost,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await run(action, host, signal);
  } catch (error) {
    return failure(error, 'The action failed.');
  }
}
