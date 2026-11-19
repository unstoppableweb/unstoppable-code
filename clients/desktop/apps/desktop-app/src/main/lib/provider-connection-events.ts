/** Content-free observations shared by the existing provider lifecycles. */
export const CONNECTION_PROVIDERS = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
  'ollama',
  'model_gateway',
] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
export type ConnectionMethod =
  | 'native_login'
  | 'api_key'
  | 'local'
  | 'provider_runtime';
export type ConnectionSource = 'at_startup' | 'in_app' | 'external_change';
export type ConnectionFailureReason =
  | 'authentication'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'runtime_unavailable'
  | 'storage'
  | 'other';
export interface ProviderConnectionEvent {
  provider: ConnectionProvider;
  connectionMethod: ConnectionMethod;
  connectSource: ConnectionSource;
  failureReason?: ConnectionFailureReason;
}

type Listener = (event: ProviderConnectionEvent) => void;
const listeners = new Set<Listener>();
const connections = new Map<
  string,
  {
    fingerprint: string | null;
    event: ProviderConnectionEvent;
  }
>();

function deliver(listener: Listener, event: ProviderConnectionEvent): void {
  try {
    listener(event);
  } catch {
    // Analytics cannot affect provider setup or another subscriber.
  }
}

function publish(event: ProviderConnectionEvent): void {
  for (const listener of Array.from(listeners)) deliver(listener, event);
}

export function subscribeProviderConnections(listener: Listener): () => void {
  listeners.add(listener);
  for (const connection of Array.from(connections.values())) {
    if (connection.fingerprint !== null)
      deliver(listener, { ...connection.event, connectSource: 'at_startup' });
  }
  return (): void => {
    listeners.delete(listener);
  };
}

/** The fingerprint and scope stay in memory and never enter an event. */
export function observeProviderConnection(options: {
  provider: ConnectionProvider;
  connectionMethod: ConnectionMethod;
  fingerprint: string | null;
  scope?: string;
  via: 'read' | 'in_app';
  /** Update metadata baselines without treating the observation as new setup. */
  baselineOnly?: boolean;
}): void {
  const key = `${options.provider}:${options.scope ?? ''}`;
  const previous = connections.get(key);
  if (previous?.fingerprint === options.fingerprint) return;
  const event: ProviderConnectionEvent = {
    provider: options.provider,
    connectionMethod: options.connectionMethod,
    connectSource: options.baselineOnly
      ? 'at_startup'
      : options.via === 'in_app'
        ? 'in_app'
        : previous === undefined
          ? 'at_startup'
          : 'external_change',
  };
  connections.set(key, { fingerprint: options.fingerprint, event });
  if (options.fingerprint !== null) publish(event);
}

export function recordProviderConnectionFailure(
  provider: ConnectionProvider,
  connectionMethod: ConnectionMethod,
  failureReason: ConnectionFailureReason,
): void {
  publish({
    provider,
    connectionMethod,
    connectSource: 'in_app',
    failureReason,
  });
}

export function classifyConnectionFailure(
  error: unknown,
  signal?: AbortSignal,
): ConnectionFailureReason {
  const value: unknown = signal?.aborted ? signal.reason : error;
  const name: unknown =
    typeof value === 'object' && value !== null && 'name' in value
      ? value.name
      : undefined;
  const code: unknown =
    typeof value === 'object' && value !== null && 'code' in value
      ? value.code
      : undefined;
  if (name === 'TimeoutError' || code === 'ETIMEDOUT') return 'timeout';
  if (signal?.aborted || name === 'AbortError') return 'cancelled';
  if (name === 'SignInWorkerUnavailableError') return 'runtime_unavailable';
  if (code === 'ENOENT') return 'runtime_unavailable';
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC')
    return 'storage';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND')
    return 'network';
  // Provider adapters often wrap typed failures in their bounded user copy.
  // Only the category leaves this process, never the original message.
  const message = error instanceof Error ? error.message : '';
  if (/timed? out|expired/i.test(message)) return 'timeout';
  if (/cancelled|canceled|aborted/i.test(message)) return 'cancelled';
  if (/store|storage|credential.*sav/i.test(message)) return 'storage';
  if (
    /network|check your connection|reach the|fetch failed|couldn't connect/i.test(
      message,
    )
  )
    return 'network';
  if (/runtime|install|download|unavailable|not supported/i.test(message))
    return 'runtime_unavailable';
  if (/sign.in|authenticat|declined|access|credential|401|403/i.test(message))
    return 'authentication';
  return 'other';
}

/** Only failures are automatic; the producer confirms success after commit. */
export async function withProviderConnectionAttempt<T>(
  provider: ConnectionProvider,
  connectionMethod: ConnectionMethod,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    try {
      recordProviderConnectionFailure(
        provider,
        connectionMethod,
        classifyConnectionFailure(error, signal),
      );
    } catch {
      // Even an unreadable rejection must retain the provider's original result.
    }
    throw error;
  }
}

export function resetProviderConnectionEventsForTests(): void {
  connections.clear();
  listeners.clear();
}
