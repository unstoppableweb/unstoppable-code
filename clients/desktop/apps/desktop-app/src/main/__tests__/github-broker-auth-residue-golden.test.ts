// CAN-4176 golden: where a GitHub credential exists while the broker sends a
// request. It drives the real broker, credential port and Octokit client;
// only the token sources and the HTTP transport are replaced. The Octokit
// package is ESM, so it is loaded through Node's own module loader rather
// than Jest's. Each fake token
// is reported by its label, so no output carries a token. It pins that the
// cached client holds no credential, that every HTTP request (REST, GraphQL,
// each page, each retry) is authorized again from its lease, that hooks
// outside the auth strategy and the client's logger never see the header,
// that the header is gone from every endpoint object once its request settles
// (success, failure or abort), that a lease's fingerprint and scope id never
// reach diagnostics, logs or errors, and that a lease whose credential changed
// or was revoked is refused before anything is sent. A change here is a behaviour change: re-record
// deliberately with `pnpm test <this file> -u` and review the snapshot diff.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import type { Octokit } from '@octokit/rest';
import type * as BrokerModule from '../lib/github-broker';
import type * as CredentialPortModule from '../lib/github-broker/credential-port';

const TOKENS = {
  defaultOne: 'ghp_default_one_0000000000000000000000',
  defaultTwo: 'ghp_default_two_0000000000000000000000',
  pat: 'github_pat_stored',
  patReplaced: 'github_pat_replaced',
  cli: 'gho_cli_000000000000000000000000000000',
};
const LABELS = new Map<string, string>(
  Object.entries(TOKENS).map(([name, token]) => [token, name]),
);
const sources = {
  resolved: TOKENS.defaultOne,
  pat: TOKENS.pat,
  cli: TOKENS.cli,
};
const tokenReads: string[] = [];
// Runs on a given default-credential read, counted from 1, to change the
// credential at an exact point in an attempt.
const onDefaultRead = new Map<number, () => void>();
// Default-credential reads, counted from 1, that never settle.
const stalledDefaultReads = new Set<number>();
jest.mock('../lib/github-auth', () => ({
  resolveGitHubToken: (): Promise<string> => {
    tokenReads.push('default');
    // The value is read first, so a hook that changes the credential here
    // models a reset landing while this read is still in flight.
    const value = sources.resolved;
    const count = tokenReads.filter((read) => read === 'default').length;
    onDefaultRead.get(count)?.();
    if (stalledDefaultReads.has(count))
      return new Promise<string>(() => undefined);
    return Promise.resolve(value);
  },
  resolveGitHubTokenWithSource: (): Promise<{
    token: string;
    source: string;
  }> => {
    tokenReads.push('resolved');
    return Promise.resolve({ token: sources.resolved, source: 'pat' });
  },
  loadStoredPat: (): Promise<string> => {
    tokenReads.push('pat');
    return Promise.resolve(sources.pat);
  },
  loadGhCliToken: (): Promise<string> => {
    tokenReads.push('gh-cli');
    return Promise.resolve(sources.cli);
  },
  invalidateTokenCache: (): void => undefined,
}));
const logged: string[] = [];
jest.mock('../lib/main-process-logging', () => {
  const record =
    (level: string) =>
    (message: string, context?: unknown): void => {
      logged.push(
        `${level} ${message}${context === undefined ? '' : ` ${inspect(context)}`}`,
      );
    };
  return {
    logMainProcessInfo: record('info'),
    logMainProcessWarn: record('warn'),
    logMainProcessError: record('error'),
    logMainProcessDebug: record('debug'),
  };
});

// Every request the client sends, every page included, goes to this
// transport; the default refuses, so nothing reaches the network.
const refuseNetwork: typeof fetch = () =>
  Promise.reject(new Error('No fake GitHub transport is installed.'));
let currentFetch: typeof fetch = refuseNetwork;
function hasOctokit(value: unknown): value is { Octokit: typeof Octokit } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Octokit' in value &&
    typeof value.Octokit === 'function'
  );
}
jest.mock('../lib/github-octokit-loader', () => ({
  loadOctokitConstructor: (): unknown => {
    const nodeModule = process.getBuiltinModule('node:module');
    const octokitRest: unknown =
      nodeModule.createRequire(__filename)('@octokit/rest');
    if (!hasOctokit(octokitRest)) {
      throw new Error('@octokit/rest did not load.');
    }
    return octokitRest.Octokit.defaults({
      request: {
        fetch: (input: string, init?: RequestInit): Promise<Response> =>
          currentFetch(input, init),
      },
    });
  },
}));

let broker: BrokerModule.GitHubBroker;
let brokerModule: typeof BrokerModule;
let port: CredentialPortModule.GitHubBrokerCredentialPort;

beforeEach(async () => {
  jest.useFakeTimers({
    now: Date.parse('2026-11-16T10:00:00.000Z'),
    doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'],
  });
  jest.resetModules();
  tokenReads.length = 0;
  logged.length = 0;
  scopeMarkers.length = 0;
  merges.length = 0;
  onDefaultRead.clear();
  stalledDefaultReads.clear();
  debugCalls.length = 0;
  currentFetch = refuseNetwork;
  sources.resolved = TOKENS.defaultOne;
  sources.pat = TOKENS.pat;
  sources.cli = TOKENS.cli;
  brokerModule = await import('../lib/github-broker');
  broker = brokerModule.getGitHubBroker();
  port = (
    await import('../lib/github-broker/credential-port')
  ).getGitHubBrokerCredentialPort();
});

afterEach(() => {
  brokerModule.resetGitHubBrokerForTests();
  jest.useRealTimers();
});

/** Replace every fake token in `text` with its label. */
function redact(text: string): string {
  let result = text;
  for (const [token, name] of LABELS) {
    result = result.split(token).join(`<${name}>`);
  }
  return result;
}

function containsToken(value: unknown): boolean {
  const text =
    typeof value === 'string'
      ? value
      : inspect(value, { depth: 12, showHidden: true });
  return Object.values(TOKENS).some((token) => text.includes(token));
}

/** Pinned-lease scope ids and their bare fingerprints, set per test. */
const scopeMarkers: string[] = [];
function rememberScope(
  lease: CredentialPortModule.GitHubBrokerCredentialLease,
): void {
  const scope = port.scopeId(lease);
  scopeMarkers.push(scope, scope.replace(/^custom:/, ''));
}
function containsScope(value: unknown): boolean {
  const text =
    typeof value === 'string'
      ? value
      : inspect(value, { depth: 12, showHidden: true });
  return scopeMarkers.some((marker) => text.includes(marker));
}

/**
 * Every endpoint object the client merges (REST, GraphQL and the paginated
 * pulls route), with the first
 * argument it was merged from. Octokit merges a request's options from its
 * route, the auth hook merges its endpoint from those options, and Octokit
 * merges that endpoint once more to send it, so the auth hook's endpoint is
 * the one merged from a merged object and merged from again.
 */
type Merged = { headers: object };
function isMerged(value: unknown): value is Merged {
  return (
    typeof value === 'object' &&
    value !== null &&
    'headers' in value &&
    typeof value.headers === 'object' &&
    value.headers !== null
  );
}
const merges: Array<{ from: unknown; merged: Merged }> = [];
const tracked = new WeakSet<object>();
function trackEndpoint(endpoint: Octokit['request']['endpoint']): void {
  if (tracked.has(endpoint)) return;
  tracked.add(endpoint);
  const merge: unknown = endpoint.merge;
  if (typeof merge !== 'function') return;
  Object.assign(endpoint, {
    merge: (...args: unknown[]): unknown => {
      const merged: unknown = Reflect.apply(merge, endpoint, args);
      if (isMerged(merged)) merges.push({ from: args[0], merged });
      return merged;
    },
  });
}
function trackEndpoints(octokit: Octokit): void {
  trackEndpoint(octokit.request.endpoint);
  trackEndpoint(octokit.graphql.endpoint);
  trackEndpoint(octokit.rest.pulls.list.endpoint);
}
function carriesAuthorization(endpoint: Merged): boolean {
  return Object.keys(endpoint.headers).some(
    (name) => name.toLowerCase() === 'authorization',
  );
}
/** The auth hook's endpoint objects, and how many still carry the header. */
function headerResidue(): { hookEndpoints: number; carryingHeader: number } {
  const mergedObjects = new Set<unknown>(merges.map(({ merged }) => merged));
  const mergedFrom = new Set(merges.map(({ from }) => from));
  const hookEndpoints = merges
    .filter(
      ({ from, merged }) => mergedObjects.has(from) && mergedFrom.has(merged),
    )
    .map(({ merged }) => merged);
  return {
    hookEndpoints: hookEndpoints.length,
    carryingHeader: hookEndpoints.filter(carriesAuthorization).length,
  };
}

interface FakeReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface SentRequest {
  method: string;
  path: string;
  authorization: string;
}

/**
 * A fake GitHub transport: answers each request from `reply` and records the
 * method, path and authorization label it was sent with.
 */
function transport(
  sent: SentRequest[],
  reply: (path: string, call: number) => FakeReply,
): typeof fetch {
  let calls = 0;
  return (input, init) => {
    calls += 1;
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = new Headers(init?.headers);
    sent.push({
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      authorization: redact(headers.get('authorization') ?? 'none'),
    });
    const answer = reply(url.pathname, calls);
    return Promise.resolve(
      new Response(answer.status === 304 ? null : JSON.stringify(answer.body), {
        status: answer.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': String(
            Math.floor(Date.parse('2026-11-16T11:00:00.000Z') / 1000),
          ),
          'x-ratelimit-resource': 'core',
          ...answer.headers,
        },
      }),
    );
  };
}

/** Hooks registered on the client after construction, as any plugin would. */
function watchOuterHooks(octokit: Octokit, seen: string[]): void {
  octokit.hook.wrap('request', async (request, options) => {
    seen.push(redact(String(options.headers.authorization ?? 'none')));
    return request(options);
  });
}

/**
 * What Octokit's own debug log receives. `@octokit/plugin-request-log` logs
 * each request's full options at debug level, so this sees whatever headers
 * the options carry when that plugin's hook runs.
 */
const debugCalls: string[] = [];
function captureDebug(octokit: Octokit): void {
  Object.assign(octokit.log, {
    debug: (message: string, info?: unknown): void => {
      debugCalls.push(
        `${message} ${inspect(info, { depth: 6 })}`.replace(/\s+/g, ' '),
      );
    },
  });
}

function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => ({
      error: brokerModule.isGitHubBrokerError(error) ? error.code : 'other',
      carriesToken: containsToken(error),
      carriesScope: containsScope(error),
    }),
  );
}

const READ = {
  priority: 'interactive',
  operation: 'read',
  idempotency: 'safe',
  timeoutMs: 30_000,
} as const;

/**
 * One cached-data guard for every conditional read: the broker shares an
 * in-flight read only between callers that pass the same guard.
 */
function hasTitle(value: unknown): value is { title: string } {
  return typeof value === 'object' && value !== null && 'title' in value;
}

describe('credential residue', () => {
  it('authorizes REST, GraphQL and every page from the lease, and the client keeps no credential', async () => {
    const sent: SentRequest[] = [];
    const outerHooks: string[] = [];
    currentFetch = transport(sent, (path): FakeReply => {
      if (path === '/graphql') {
        return { status: 200, body: { data: { viewer: { login: 'octo' } } } };
      }
      if (path === '/repos/acme/app/pulls') {
        const page = sent.filter((request) =>
          request.path.startsWith('/repos/acme/app/pulls'),
        ).length;
        return {
          status: 200,
          body: [{ number: page }],
          headers:
            page === 1
              ? {
                  link: '<https://api.github.com/repos/acme/app/pulls?per_page=1&page=2>; rel="next"',
                }
              : {},
        };
      }
      return { status: 200, body: { full_name: 'acme/app' } };
    });
    let client: Octokit | undefined;
    await broker.execute(async (octokit) => {
      client = octokit;
      trackEndpoints(octokit);
      captureDebug(octokit);
      watchOuterHooks(octokit, outerHooks);
      const response = await octokit.request('GET /repos/{owner}/{repo}', {
        owner: 'acme',
        repo: 'app',
      });
      return { status: response.status, data: response.data };
    }, READ);
    await broker.execute(
      async (octokit) => {
        const data = await octokit.graphql('query { viewer { login } }');
        return { status: 200, data };
      },
      { ...READ, resource: 'graphql' },
    );
    const pinned = await port.lease('pat');
    if (pinned) rememberScope(pinned.lease);
    await broker.execute(
      async (octokit) => {
        const data = await octokit.paginate(octokit.rest.pulls.list, {
          owner: 'acme',
          repo: 'app',
          per_page: 1,
        });
        return { status: 200, data };
      },
      { ...READ, ...(pinned ? { credential: pinned.lease } : {}) },
    );
    if (!client) throw new Error('The broker did not hand over its client.');
    const auth = await client.auth();
    expect({
      sent,
      outerHooks,
      clientAuth: auth,
      clientDefaultsCarryToken: containsToken(client.request.endpoint.DEFAULTS),
      clientCarriesToken: containsToken(client),
      leaseCarriesToken: containsToken(pinned?.lease),
      leaseAsJson: JSON.stringify(pinned?.lease),
      headerResidue: headerResidue(),
      debugLogged: debugCalls.length,
      debugCarriesHeader: debugCalls.some(
        (line) => line.includes('authorization') || containsToken(line),
      ),
      retryOrThrottlePlugin: 'retry' in client || 'throttle' in client,
      diagnosticsCarryScope: containsScope(broker.getQuotaDiagnostics()),
      logsCarryScope: logged.some((line) => containsScope(line)),
      tokenReads,
      logged: logged.map((line) =>
        redact(line).replace(/ in \d+ms$/, ' in <ms>'),
      ),
    }).toMatchSnapshot();
  });

  it('authorizes each retry again, so a retry carries the credential current at that attempt', async () => {
    const sent: SentRequest[] = [];
    currentFetch = transport(sent, (_path, call) => {
      if (call === 1) {
        sources.resolved = TOKENS.defaultTwo;
        return { status: 502, body: { message: 'Bad gateway' } };
      }
      return { status: 200, body: { full_name: 'acme/app' } };
    });
    const result = broker.execute(async (octokit) => {
      trackEndpoints(octokit);
      const response = await octokit.request('GET /repos/{owner}/{repo}', {
        owner: 'acme',
        repo: 'app',
      });
      return { status: response.status, data: response.data };
    }, READ);
    await jest.advanceTimersByTimeAsync(10_000);
    expect({
      outcome: await outcome(result),
      sent,
      headerResidue: headerResidue(),
      tokenReads,
      logged: logged.map((line) =>
        redact(line).replace(/ in \d+ms$/, ' in <ms>'),
      ),
    }).toMatchSnapshot();
  });

  it('refuses a lease whose credential changed or was revoked before sending anything, and a 404 error carries no token', async () => {
    const sent: SentRequest[] = [];
    currentFetch = transport(sent, () => ({
      status: 404,
      body: { message: 'Not Found' },
    }));
    const request = async (
      octokit: Octokit,
    ): Promise<BrokerModule.GitHubRawResponse<unknown>> => {
      trackEndpoints(octokit);
      const response = await octokit.request('GET /repos/{owner}/{repo}', {
        owner: 'acme',
        repo: 'app',
      });
      return { status: response.status, data: response.data };
    };
    const pat = await port.lease('pat');
    const cli = await port.lease('gh-cli');
    if (!pat || !cli) throw new Error('No credential to lease.');
    rememberScope(pat.lease);
    rememberScope(cli.lease);
    const notFound = await outcome(
      broker.execute(request, { ...READ, credential: pat.lease }),
    );
    sources.pat = TOKENS.patReplaced;
    const replaced = await outcome(
      broker.execute(request, { ...READ, credential: pat.lease }),
    );
    port.revoke(cli.lease);
    const revoked = await outcome(
      broker.execute(request, { ...READ, credential: cli.lease }),
    );
    sources.resolved = '';
    const noDefault = await outcome(broker.execute(request, READ));
    expect({
      grants: {
        pat: { source: pat.source, tokenFamily: pat.tokenFamily },
        cli: { source: cli.source, tokenFamily: cli.tokenFamily },
      },
      notFound,
      replaced,
      revoked,
      noDefault,
      sent,
      headerResidue: headerResidue(),
      diagnosticsCarryScope: containsScope(broker.getQuotaDiagnostics()),
      logsCarryScope: logged.some((line) => containsScope(line)),
      scopes: {
        pat: port.scopeId(pat.lease).replace(/[0-9a-f]{64}/, '<sha256>'),
        distinct: port.scopeId(pat.lease) !== port.scopeId(cli.lease),
        default: port.scopeId(port.defaultLease),
      },
      logged: logged.map((line) =>
        redact(line).replace(/ in \d+ms$/, ' in <ms>'),
      ),
    }).toMatchSnapshot();
  });

  it('drops a stored token or bearer prefix, as Octokit token auth does', async () => {
    const sent: SentRequest[] = [];
    currentFetch = transport(sent, () => ({
      status: 200,
      body: { full_name: 'acme/app' },
    }));
    const read = (): Promise<unknown> =>
      broker.execute(async (octokit) => {
        const response = await octokit.request('GET /repos/{owner}/{repo}', {
          owner: 'acme',
          repo: 'app',
        });
        return { status: response.status, data: response.data };
      }, READ);
    for (const stored of [
      TOKENS.defaultOne,
      `token ${TOKENS.defaultOne}`,
      `Bearer ${TOKENS.defaultOne}`,
    ]) {
      sources.resolved = stored;
      await read();
    }
    expect(sent.map((request) => request.authorization)).toMatchSnapshot();
  });

  it('checks every lease that joins a shared read, not only the one that started it', async () => {
    const sent: SentRequest[] = [];
    const record = transport(sent, () => ({
      status: 200,
      body: { title: 'shared' },
      headers: { etag: '"v1"' },
    }));
    let release: () => void = () => undefined;
    currentFetch = (input, init): Promise<Response> => {
      const response = record(input, init);
      return new Promise((resolve) => {
        release = (): void => resolve(response);
      });
    };
    const starter = await port.lease('pat');
    const revokedBeforeJoining = await port.lease('pat');
    const revokedAfterJoining = await port.lease('pat');
    if (!starter || !revokedBeforeJoining || !revokedAfterJoining) {
      throw new Error('No credential to lease.');
    }
    port.revoke(revokedBeforeJoining.lease);
    const sharedRead = (
      credential: CredentialPortModule.GitHubBrokerCredentialLease,
    ): Promise<unknown> =>
      outcome(
        broker.execute(
          async (octokit, conditionalHeaders) => {
            const response = await octokit.request(
              'GET /repos/{owner}/{repo}/pulls/{pull_number}',
              {
                owner: 'acme',
                repo: 'app',
                pull_number: 7,
                headers: conditionalHeaders,
              },
            );
            return { status: response.status, data: response.data };
          },
          {
            ...READ,
            priority: 'watcher',
            resourceKey: 'repos/acme/app/pulls/7',
            conditional: true,
            isCachedData: hasTitle,
            credential,
          },
        ),
      );
    const started = sharedRead(starter.lease);
    for (let tick = 0; tick < 20 && sent.length === 0; tick += 1) {
      await jest.advanceTimersByTimeAsync(10);
    }
    const joinedWhileRevoked = sharedRead(revokedBeforeJoining.lease);
    const joinedThenRevoked = sharedRead(revokedAfterJoining.lease);
    await jest.advanceTimersByTimeAsync(10);
    port.revoke(revokedAfterJoining.lease);
    release();
    await jest.advanceTimersByTimeAsync(100);
    expect({
      requestsSent: sent.length,
      started: await started,
      joinedWhileRevoked: await joinedWhileRevoked,
      joinedThenRevoked: await joinedThenRevoked,
    }).toMatchSnapshot();
  });

  it('serves conditional-cache data only to a caller whose own lease still holds', async () => {
    const sent: SentRequest[] = [];
    let revokeDuringRequest: CredentialPortModule.GitHubBrokerCredentialLease | null =
      null;
    currentFetch = transport(sent, (_path, call) => {
      if (revokeDuringRequest) port.revoke(revokeDuringRequest);
      return call === 1
        ? { status: 200, body: { title: 'cached' }, headers: { etag: '"v1"' } }
        : { status: 304, body: null, headers: { etag: '"v1"' } };
    });
    const conditionalRead = (
      credential: CredentialPortModule.GitHubBrokerCredentialLease,
    ): Promise<unknown> =>
      broker
        .execute(
          async (octokit, conditionalHeaders) => {
            const response = await octokit.request(
              'GET /repos/{owner}/{repo}/pulls/{pull_number}',
              {
                owner: 'acme',
                repo: 'app',
                pull_number: 9,
                headers: conditionalHeaders,
              },
            );
            return {
              status: response.status,
              headers: response.headers,
              data: response.data,
            };
          },
          {
            ...READ,
            resourceKey: 'repos/acme/app/pulls/9',
            conditional: true,
            isCachedData: hasTitle,
            credential,
          },
        )
        .then(
          (result) => ({ status: result.status, data: result.data }),
          (error: unknown) => ({
            error: brokerModule.isGitHubBrokerError(error)
              ? error.code
              : 'other',
          }),
        );
    const first = await port.lease('pat');
    const second = await port.lease('pat');
    const revoked = await port.lease('pat');
    const revokedInFlight = await port.lease('pat');
    if (!first || !second || !revoked || !revokedInFlight) {
      throw new Error('No credential to lease.');
    }
    const fresh = await conditionalRead(first.lease);
    const replayed = await conditionalRead(second.lease);
    port.revoke(revoked.lease);
    const sentBeforeRevokedRead = sent.length;
    const revokedRead = await conditionalRead(revoked.lease);
    const sentByRevokedRead = sent.length - sentBeforeRevokedRead;
    revokeDuringRequest = revokedInFlight.lease;
    const revokedDuringReplay = await conditionalRead(revokedInFlight.lease);
    expect({
      fresh,
      replayed,
      revokedRead,
      sentByRevokedRead,
      revokedDuringReplay,
      sent: sent.map(({ method, path }) => `${method} ${path}`),
    }).toMatchSnapshot();
  });

  it('discards a result when the credential is reset during the final lease check, and reissues', async () => {
    const sent: SentRequest[] = [];
    currentFetch = transport(sent, (_path, call) => ({
      status: 200,
      body: { served: call },
    }));
    // Default reads per attempt: the pre-attempt check, the auth hook, then
    // the final check before the result is handed over.
    onDefaultRead.set(3, () => {
      sources.resolved = TOKENS.defaultTwo;
      broker.resetCredentials();
    });
    const result = await broker.execute(async (octokit) => {
      const response = await octokit.request('GET /repos/{owner}/{repo}', {
        owner: 'acme',
        repo: 'app',
      });
      const data: unknown = response.data;
      return { status: response.status, data };
    }, READ);
    expect({ data: result.data, sent }).toMatchSnapshot();
  });

  it('returns a write GitHub applied once, even when the credential is reset while it is in flight', async () => {
    const sent: SentRequest[] = [];
    currentFetch = transport(sent, () => {
      sources.resolved = TOKENS.defaultTwo;
      broker.resetCredentials();
      return { status: 201, body: { number: 42 } };
    });
    const outcome = await broker
      .execute(
        async (octokit) => {
          const response = await octokit.request(
            'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
            { owner: 'acme', repo: 'app', issue_number: 7, body: 'hello' },
          );
          return { status: response.status, data: response.data };
        },
        {
          priority: 'interactive',
          operation: 'mutation',
          idempotency: 'unsafe',
          timeoutMs: 30_000,
        },
      )
      .then(
        (result) => ({ kind: result.kind, status: result.status }),
        (error: unknown) => ({
          error: brokerModule.isGitHubBrokerError(error) ? error.code : 'other',
        }),
      );
    expect({ outcome, sent }).toMatchSnapshot();
  });

  it('refuses a starter whose lease is revoked mid-read, while joiners with their own valid leases get the result', async () => {
    const sent: SentRequest[] = [];
    const record = transport(sent, () => ({
      status: 200,
      body: { title: 'shared' },
      headers: { etag: '"v1"' },
    }));
    let release: () => void = () => undefined;
    currentFetch = (input, init): Promise<Response> => {
      const response = record(input, init);
      return new Promise((resolve) => {
        release = (): void => resolve(response);
      });
    };
    const starter = await port.lease('pat');
    const joinerA = await port.lease('pat');
    const joinerB = await port.lease('pat');
    if (!starter || !joinerA || !joinerB)
      throw new Error('No credential to lease.');
    const sharedRead = (
      credential: CredentialPortModule.GitHubBrokerCredentialLease,
    ): Promise<unknown> =>
      outcome(
        broker.execute(
          async (octokit, conditionalHeaders) => {
            const response = await octokit.request(
              'GET /repos/{owner}/{repo}/pulls/{pull_number}',
              {
                owner: 'acme',
                repo: 'app',
                pull_number: 11,
                headers: conditionalHeaders,
              },
            );
            return {
              status: response.status,
              headers: response.headers,
              data: response.data,
            };
          },
          {
            ...READ,
            priority: 'watcher',
            resourceKey: 'repos/acme/app/pulls/11',
            conditional: true,
            isCachedData: hasTitle,
            credential,
          },
        ),
      );
    const started = sharedRead(starter.lease);
    for (let tick = 0; tick < 20 && sent.length === 0; tick += 1) {
      await jest.advanceTimersByTimeAsync(10);
    }
    const joinedA = sharedRead(joinerA.lease);
    const joinedB = sharedRead(joinerB.lease);
    await jest.advanceTimersByTimeAsync(10);
    port.revoke(starter.lease);
    release();
    await jest.advanceTimersByTimeAsync(100);
    expect({
      requestsSent: sent.length,
      starter: await started,
      joinerA: await joinedA,
      joinerB: await joinedB,
    }).toMatchSnapshot();
  });

  it('caches nothing on behalf of a lease revoked while its read was in flight', async () => {
    const sentIfNoneMatch: string[] = [];
    const record = transport([], () => ({
      status: 200,
      body: { title: 'fresh' },
      headers: { etag: '"v1"' },
    }));
    let holdNext = true;
    let release: () => void = () => undefined;
    currentFetch = (input, init): Promise<Response> => {
      sentIfNoneMatch.push(
        new Headers(init?.headers).get('if-none-match') ?? 'none',
      );
      const response = record(input, init);
      if (!holdNext) return response;
      holdNext = false;
      return new Promise((resolve) => {
        release = (): void => resolve(response);
      });
    };
    const read = (
      credential: CredentialPortModule.GitHubBrokerCredentialLease,
    ): Promise<unknown> =>
      broker
        .execute(
          async (octokit, conditionalHeaders) => {
            const response = await octokit.request(
              'GET /repos/{owner}/{repo}/pulls/{pull_number}',
              {
                owner: 'acme',
                repo: 'app',
                pull_number: 12,
                headers: conditionalHeaders,
              },
            );
            return {
              status: response.status,
              headers: response.headers,
              data: response.data,
            };
          },
          {
            ...READ,
            resourceKey: 'repos/acme/app/pulls/12',
            conditional: true,
            isCachedData: hasTitle,
            credential,
          },
        )
        .then(
          (result) => ({ status: result.status }),
          (error: unknown) => ({
            error: brokerModule.isGitHubBrokerError(error)
              ? error.code
              : 'other',
          }),
        );
    const revoked = await port.lease('pat');
    const valid = await port.lease('pat');
    if (!revoked || !valid) throw new Error('No credential to lease.');
    const inFlight = read(revoked.lease);
    for (let tick = 0; tick < 20 && sentIfNoneMatch.length === 0; tick += 1) {
      await jest.advanceTimersByTimeAsync(10);
    }
    port.revoke(revoked.lease);
    release();
    await jest.advanceTimersByTimeAsync(100);
    const revokedRead = await inFlight;
    const firstValidRead = await read(valid.lease);
    const secondValidRead = await read(valid.lease);
    expect({
      revokedRead,
      firstValidRead,
      secondValidRead,
      ifNoneMatchSent: sentIfNoneMatch,
    }).toMatchSnapshot();
  });

  it('sends nothing under a credential reset while the lease was being authorized, and reissues a write under the new one', async () => {
    const sent: SentRequest[] = [];
    currentFetch = transport(sent, () => ({
      status: 201,
      body: { number: 43 },
    }));
    // Default reads per attempt: the pre-attempt check, then the auth hook.
    onDefaultRead.set(2, () => {
      sources.resolved = TOKENS.defaultTwo;
      broker.resetCredentials();
    });
    const pending = broker
      .execute(
        async (octokit) => {
          const response = await octokit.request(
            'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
            { owner: 'acme', repo: 'app', issue_number: 8, body: 'hello' },
          );
          return { status: response.status, data: response.data };
        },
        {
          priority: 'interactive',
          operation: 'mutation',
          idempotency: 'unsafe',
          timeoutMs: 30_000,
        },
      )
      .then(
        (result) => ({ kind: result.kind, status: result.status }),
        (error: unknown) => ({
          error: brokerModule.isGitHubBrokerError(error) ? error.code : 'other',
        }),
      );
    await jest.advanceTimersByTimeAsync(5_000);
    const outcome = await pending;
    expect({ outcome, sent }).toMatchSnapshot();
  });

  it('keeps the timeout and cancellation when the final lease check stalls', async () => {
    const sent: SentRequest[] = [];
    currentFetch = transport(sent, () => ({
      status: 200,
      body: { full_name: 'acme/app' },
    }));
    const read = (signal?: AbortSignal): Promise<unknown> =>
      outcome(
        broker.execute(
          async (octokit) => {
            const response = await octokit.request(
              'GET /repos/{owner}/{repo}',
              { owner: 'acme', repo: 'app' },
            );
            return { status: response.status, data: response.data };
          },
          { ...READ, timeoutMs: 2_000, ...(signal ? { signal } : {}) },
        ),
      );
    // Default reads per attempt: the pre-attempt check, the auth hook, then
    // the final check before the result is handed over.
    stalledDefaultReads.add(3);
    const timedOut = read();
    await jest.advanceTimersByTimeAsync(2_500);
    stalledDefaultReads.add(6);
    const controller = new AbortController();
    const aborted = read(controller.signal);
    await jest.advanceTimersByTimeAsync(100);
    controller.abort();
    await jest.advanceTimersByTimeAsync(100);
    expect({
      timedOut: await timedOut,
      aborted: await aborted,
      requestsSent: sent.length,
    }).toMatchSnapshot();
  });

  it('refuses a lease revoked between retries, without reusing the earlier header', async () => {
    const sent: SentRequest[] = [];
    const pinned = await port.lease('pat');
    if (!pinned) throw new Error('No credential to lease.');
    currentFetch = transport(sent, () => {
      port.revoke(pinned.lease);
      return { status: 502, body: { message: 'Bad gateway' } };
    });
    const result = outcome(
      broker.execute(
        async (octokit) => {
          trackEndpoints(octokit);
          const response = await octokit.request('GET /repos/{owner}/{repo}', {
            owner: 'acme',
            repo: 'app',
          });
          return { status: response.status, data: response.data };
        },
        { ...READ, credential: pinned.lease },
      ),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    expect({
      outcome: await result,
      sent,
      headerResidue: headerResidue(),
    }).toMatchSnapshot();
  });

  it('gives each credential its own scope, stable across a restart, and accepts only leases at the type level', async () => {
    const pat = await port.lease('pat');
    const cli = await port.lease('gh-cli');
    if (!pat || !cli) throw new Error('No credential to lease.');
    const before = {
      pat: port.scopeId(pat.lease),
      cli: port.scopeId(cli.lease),
    };
    jest.resetModules();
    const restarted = (
      await import('../lib/github-broker/credential-port')
    ).getGitHubBrokerCredentialPort();
    const patAgain = await restarted.lease('pat');
    if (!patAgain) throw new Error('No credential to lease.');
    // @ts-expect-error a raw token string is not a lease.
    const rawToken: CredentialPortModule.GitHubBrokerCredentialLease =
      TOKENS.pat;
    const rawTokenRefused = await restarted.authorize(rawToken).then(
      () => 'authorized',
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'untyped',
    );
    expect({
      distinct: before.pat !== before.cli,
      stableAcrossRestart: restarted.scopeId(patAgain.lease) === before.pat,
      derivedFromCredentialOnly:
        before.pat ===
        `custom:${createHash('sha256').update(TOKENS.pat).digest('hex')}`,
      rawTokenRefused,
    }).toMatchSnapshot();
  });

  it('drops the authorization header when a request is redirected to another origin', async () => {
    jest.useRealTimers();
    const listen = async (server: Server): Promise<number> => {
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('The test server has no port.');
      }
      return address.port;
    };
    const seen: Record<string, string> = {};
    const target = createServer((request, response) => {
      seen.target = redact(request.headers.authorization ?? 'none');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ archive: true }));
    });
    const targetPort = await listen(target);
    const origin = createServer((request, response) => {
      seen.origin = redact(request.headers.authorization ?? 'none');
      response.writeHead(302, {
        location: `http://127.0.0.1:${String(targetPort)}/archive.tar.gz`,
      });
      response.end();
    });
    const originPort = await listen(origin);
    currentFetch = fetch;
    try {
      const result = await broker.execute(async (octokit) => {
        const response = await octokit.request(
          `GET http://127.0.0.1:${String(originPort)}/repos/acme/app/tarball/main`,
        );
        const data: unknown = response.data;
        return { status: response.status, data };
      }, READ);
      expect({
        status: result.status,
        sentToOrigin: seen.origin,
        sentToRedirectTarget: seen.target,
      }).toMatchSnapshot();
    } finally {
      origin.close();
      target.close();
    }
  });

  it('removes the header when an in-flight request is aborted', async () => {
    const sent: SentRequest[] = [];
    const record = transport(sent, () => ({ status: 200, body: {} }));
    currentFetch = (input, init): Promise<Response> => {
      void record(input, init);
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const abort = (): void =>
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    };
    const controller = new AbortController();
    const result = outcome(
      broker.execute(
        async (octokit) => {
          trackEndpoints(octokit);
          const response = await octokit.request('GET /repos/{owner}/{repo}', {
            owner: 'acme',
            repo: 'app',
          });
          return { status: response.status, data: response.data };
        },
        { ...READ, signal: controller.signal },
      ),
    );
    for (let tick = 0; tick < 20 && sent.length === 0; tick += 1) {
      await jest.advanceTimersByTimeAsync(10);
    }
    const inFlight = headerResidue();
    controller.abort();
    await jest.advanceTimersByTimeAsync(1_000);
    expect({
      sentBeforeAbort: sent,
      inFlight,
      outcome: await result,
      afterAbort: headerResidue(),
    }).toMatchSnapshot();
  });
});
