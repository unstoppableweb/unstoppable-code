import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:net';
import { z } from 'zod';
import type { AccountProxySignInProvider } from '@canopy/desktop-shared/types/account-proxy';
import {
  ACCOUNT_PROXY_SIGN_IN_TIMEOUT_MS,
  accountProxySignInPage,
  sameAccountProxySignInState as sameState,
} from '../../account-proxy/sign-in-pages';
import type {
  AccountProxySignInCallbackParams,
  AccountProxySignInOpenParams,
} from '../remote-protocol';
import { RpcPublicError } from '../transport/rpc-peer';
import { reserveLoopbackPort } from '../../lib/loopback-listeners';

/**
 * Where each provider sends the browser back after sign-in: the fixed
 * `redirect_uri` CLIProxyAPI 8.0.61 registers, `http://localhost:54545/callback`
 * for Claude and `http://localhost:1455/auth/callback` for Codex.
 */
const CLAUDE_CALLBACK_PATH = '/callback';
const CODEX_CALLBACK_PATH = '/auth/callback';
export const ACCOUNT_PROXY_SIGN_IN_CALLBACK_PORTS: Readonly<
  Record<AccountProxySignInProvider, number>
> = { claude: 54545, codex: 1455 };

const E2E_CALLBACK_PORT = z.number().int().min(1).max(65_535).optional();
const E2E_CALLBACK_PORTS_SCHEMA = z.object({
  claude: E2E_CALLBACK_PORT,
  codex: E2E_CALLBACK_PORT,
});

/**
 * The callback ports this build listens on. E2E builds may move them with
 * `CANOPY_E2E_ACCOUNT_PROXY_CALLBACK_PORTS` (`{"claude":n}`), so a spec never
 * competes with a real sign-in on the machine running it.
 */
export function accountProxySignInCallbackPorts(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<AccountProxySignInProvider, number>> {
  const raw = __CANOPY_E2E__
    ? env.CANOPY_E2E_ACCOUNT_PROXY_CALLBACK_PORTS?.trim()
    : undefined;
  if (!raw) return ACCOUNT_PROXY_SIGN_IN_CALLBACK_PORTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ACCOUNT_PROXY_SIGN_IN_CALLBACK_PORTS;
  }
  const ports = E2E_CALLBACK_PORTS_SCHEMA.safeParse(parsed);
  if (!ports.success) return ACCOUNT_PROXY_SIGN_IN_CALLBACK_PORTS;
  return {
    claude: ports.data.claude ?? ACCOUNT_PROXY_SIGN_IN_CALLBACK_PORTS.claude,
    codex: ports.data.codex ?? ACCOUNT_PROXY_SIGN_IN_CALLBACK_PORTS.codex,
  };
}

/** The provider whose callback path `requestUrl` names. */
function callbackProvider(requestUrl: URL): AccountProxySignInProvider | null {
  if (requestUrl.pathname === CLAUDE_CALLBACK_PATH) return 'claude';
  if (requestUrl.pathname === CODEX_CALLBACK_PATH) return 'codex';
  return null;
}

const MAX_CODE_LENGTH = 4096;
const MAX_ERROR_LENGTH = 1024;
const PROBE_TIMEOUT_MS = 1_000;

const PROVIDER_LABELS: Readonly<Record<AccountProxySignInProvider, string>> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * The sign-in errors below are fixed copy with no paths, so they extend
 * `RpcPublicError` and reach the computer that asked for the sign-in.
 */
export class AccountProxySignInPortBusyError extends RpcPublicError {
  readonly code = 'account_proxy_sign_in_port_busy';
  constructor(provider: AccountProxySignInProvider, port: number) {
    const label = PROVIDER_LABELS[provider];
    super(
      `Port ${String(port)} on this computer is in use, so the ${label} sign-in can't finish here. Close what is using it, such as another ${label} sign-in or an account proxy on this computer, and try again.`,
    );
    this.name = 'AccountProxySignInPortBusyError';
  }
}

export interface RemoteAccountProxySignInsOptions {
  /** Opens a page in this computer's browser. */
  openExternal: (url: string) => Promise<void>;
  /** Sends a caught redirect to the computer running the proxy. */
  forward: (callback: AccountProxySignInCallbackParams) => Promise<void>;
  ports?: Readonly<Record<AccountProxySignInProvider, number>>;
  timeoutMs?: number;
  /** Whether something on this computer already answers on `port`. */
  portInUse?: (port: number) => Promise<boolean>;
}

/** A listener still being started, until it listens or is cancelled. */
interface StartupToken {
  readonly provider: AccountProxySignInProvider;
  readonly state: string;
  cancelled: boolean;
}

interface Startup {
  readonly token: StartupToken;
  readonly done: Promise<Listener>;
}

class SignInCancelledError extends RpcPublicError {
  constructor() {
    super('The sign-in was cancelled.');
    this.name = 'SignInCancelledError';
  }
}

interface Listener {
  readonly state: string;
  readonly provider: AccountProxySignInProvider;
  readonly port: number;
  readonly servers: Server[];
  /** Keeps web preview off the callback port while the listener holds it. */
  readonly releasePort: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  forwarding: boolean;
  closed: boolean;
}

function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Port reuse lets a listener bound to one loopback address sit beside one
 * bound to every address, and take its connections. Probing first leaves a
 * port that anything answers on to its owner.
 */
async function loopbackPortInUse(port: number): Promise<boolean> {
  const [ipv4, ipv6] = await Promise.all([
    answers('127.0.0.1', port),
    answers('::1', port),
  ]);
  return ipv4 || ipv6;
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen({ host, port }, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

const PAGE_STYLE =
  'body{font:15px system-ui,sans-serif;margin:15vh auto;max-width:28rem;padding:0 1.5rem;line-height:1.5}';

function sendPage(
  response: ServerResponse,
  status: number,
  title: string,
  text: string,
): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title><style>${PAGE_STYLE}</style><h1>${title}</h1><p>${text}</p>`,
  );
}

function queryValue(
  params: URLSearchParams,
  name: string,
  maxLength: number,
): string | null {
  const value = params.get(name)?.trim() ?? '';
  return value.length > 0 && value.length <= maxLength ? value : null;
}

/**
 * Account proxy sign-ins that a controlled computer opened in this
 * computer's browser. Each listens on the provider's fixed loopback callback
 * port while it waits, and only for its own path and state; the first
 * matching redirect goes to the controlled computer and the listener closes.
 * One sign-in waits at a time, as on the controlled computer.
 */
export class RemoteAccountProxySignIns {
  private current: Listener | null = null;
  private startup: Startup | null = null;
  private readonly ports: Readonly<Record<AccountProxySignInProvider, number>>;

  constructor(private readonly options: RemoteAccountProxySignInsOptions) {
    this.ports = options.ports ?? ACCOUNT_PROXY_SIGN_IN_CALLBACK_PORTS;
  }

  /** The sign-in this computer is listening for, if any. */
  get listening(): { state: string; port: number } | null {
    const current = this.current;
    return current ? { state: current.state, port: current.port } : null;
  }

  async open(params: AccountProxySignInOpenParams): Promise<void> {
    const url = accountProxySignInPage(params.provider, params.url);
    if (url === null) {
      throw new RpcPublicError(
        'The other computer sent an unexpected sign-in page.',
      );
    }
    const same = (
      entry: { provider: string; state: string } | undefined,
    ): boolean =>
      entry !== undefined &&
      entry.provider === params.provider &&
      sameState(entry.state, params.state);
    let listener: Listener;
    if (this.current && same(this.current)) {
      listener = this.current;
    } else if (this.startup && same(this.startup.token)) {
      listener = await this.startup.done;
    } else {
      this.closeAll();
      const token: StartupToken = {
        provider: params.provider,
        state: params.state,
        cancelled: false,
      };
      const startup: Startup = { token, done: this.startListener(token) };
      this.startup = startup;
      try {
        listener = await startup.done;
      } finally {
        if (this.startup === startup) this.startup = null;
      }
    }
    if (listener.closed) throw new SignInCancelledError();
    try {
      await this.options.openExternal(url);
    } catch (error) {
      this.close(listener);
      throw error;
    }
  }

  /** Stops listening for `state`; other sign-ins are left alone. */
  end(state: string): void {
    const startup = this.startup;
    if (startup && sameState(startup.token.state, state)) this.cancel(startup);
    const current = this.current;
    if (current && sameState(current.state, state)) this.close(current);
  }

  /** Stops every listener: the session closed or the window went away. */
  closeAll(): void {
    if (this.startup) this.cancel(this.startup);
    if (this.current) this.close(this.current);
  }

  private cancel(startup: Startup): void {
    startup.token.cancelled = true;
    if (this.startup === startup) this.startup = null;
  }

  private async startListener(startup: StartupToken): Promise<Listener> {
    const { provider, state } = startup;
    const port = this.ports[provider];
    const portInUse = this.options.portInUse ?? loopbackPortInUse;
    const busy = await portInUse(port);
    if (startup.cancelled) throw new SignInCancelledError();
    if (busy) throw new AccountProxySignInPortBusyError(provider, port);
    const listener: Listener = {
      state,
      provider,
      port,
      servers: [],
      // Reserved before binding: a paired computer's web preview never
      // reaches the callback (CAN-7679).
      releasePort: reserveLoopbackPort(port),
      timer: null,
      forwarding: false,
      closed: false,
    };
    const serve = (
      request: IncomingMessage,
      response: ServerResponse,
    ): void => {
      try {
        this.handle(listener, request, response);
      } catch {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        try {
          sendPage(response, 500, 'Sign-in failed', 'Return to the app.');
        } catch {
          response.destroy();
        }
      }
    };
    try {
      const ipv4 = createServer(serve);
      listener.servers.push(ipv4);
      await listen(ipv4, '127.0.0.1', port);
      if (startup.cancelled) throw new SignInCancelledError();
      const ipv6 = createServer(serve);
      listener.servers.push(ipv6);
      try {
        await listen(ipv6, '::1', port);
      } catch (error) {
        // A computer without IPv6 loopback is reached on 127.0.0.1 alone.
        if (errorCode(error) === 'EADDRINUSE') throw error;
      }
      if (startup.cancelled) throw new SignInCancelledError();
    } catch (error) {
      this.close(listener);
      if (error instanceof SignInCancelledError) throw error;
      if (errorCode(error) === 'EADDRINUSE') {
        throw new AccountProxySignInPortBusyError(provider, port);
      }
      throw new RpcPublicError("This computer couldn't wait for the sign-in.");
    }
    listener.timer = setTimeout(
      () => this.close(listener),
      this.options.timeoutMs ?? ACCOUNT_PROXY_SIGN_IN_TIMEOUT_MS,
    );
    listener.timer.unref?.();
    this.current = listener;
    return listener;
  }

  private handle(
    listener: Listener,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      sendPage(response, 400, 'Bad request', 'There is nothing here.');
      return;
    }
    if (
      request.method !== 'GET' ||
      callbackProvider(requestUrl) !== listener.provider
    ) {
      sendPage(response, 404, 'Not found', 'There is nothing here.');
      return;
    }
    const state = queryValue(requestUrl.searchParams, 'state', 256);
    if (
      listener.closed ||
      state === null ||
      !sameState(state, listener.state)
    ) {
      sendPage(
        response,
        400,
        'Sign-in not found',
        'This page is not for the sign-in the app is waiting on. Start the sign-in again from the app.',
      );
      return;
    }
    const code = queryValue(requestUrl.searchParams, 'code', MAX_CODE_LENGTH);
    const error =
      queryValue(requestUrl.searchParams, 'error', MAX_ERROR_LENGTH) ??
      queryValue(
        requestUrl.searchParams,
        'error_description',
        MAX_ERROR_LENGTH,
      );
    if (code === null && error === null) {
      sendPage(
        response,
        400,
        'Sign-in not finished',
        'The sign-in did not finish. Start it again from the app.',
      );
      return;
    }
    if (listener.forwarding) {
      sendPage(
        response,
        409,
        'Already signing in',
        'This sign-in is already finishing. Return to the app.',
      );
      return;
    }
    listener.forwarding = true;
    void this.options
      .forward({ state: listener.state, code, error })
      .then(
        () =>
          sendPage(
            response,
            200,
            error === null ? 'Almost done' : 'Sign-in cancelled',
            error === null
              ? 'Return to the app. The account appears there once the proxy finishes adding it. You can close this tab.'
              : 'The provider did not sign the account in. Return to the app to try again. You can close this tab.',
          ),
        () =>
          sendPage(
            response,
            502,
            "Sign-in couldn't finish",
            'The other computer did not accept the sign-in. Return to the app to try again.',
          ),
      )
      .finally(() => {
        if (response.writableFinished) this.close(listener);
        else response.once('finish', () => this.close(listener));
      });
  }

  private close(listener: Listener): void {
    if (listener.closed) return;
    listener.closed = true;
    listener.releasePort();
    if (listener.timer) clearTimeout(listener.timer);
    listener.timer = null;
    for (const server of listener.servers) {
      server.close();
      server.closeAllConnections();
    }
    if (this.current === listener) this.current = null;
  }
}
