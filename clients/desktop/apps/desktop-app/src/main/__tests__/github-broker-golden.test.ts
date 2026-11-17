// CAN-4176 golden: the GitHub broker as desktop main runs it today, captured
// before it moves into core behind a credential port. It drives the real
// broker, scheduler, quota ledger and conditional cache with fake timers;
// only the token resolver and the Octokit constructor are replaced, and the
// requests are in-test functions returning raw GitHub responses. A change
// here is a behaviour change: re-record deliberately with
// `pnpm test <this file> -u` and review the snapshot diff.
import type * as BrokerModule from '../lib/github-broker';

const tokenReads: string[] = [];
let currentToken = 'ghp_token_one';
jest.mock('../lib/github-auth', () => ({
  resolveGitHubToken: (): Promise<string> => {
    tokenReads.push(currentToken === '' ? 'none' : 'read');
    return Promise.resolve(currentToken);
  },
  invalidateTokenCache: (): void => {
    tokenReads.push('invalidate');
  },
}));
const octokitBuilds: string[] = [];
jest.mock('../lib/github-octokit-loader', () => ({
  loadOctokitConstructor: (): unknown =>
    class FakeOctokit {
      hook = { wrap: (): void => undefined };
      constructor(options: { auth?: unknown }) {
        octokitBuilds.push(
          typeof options.auth === 'string' && options.auth.length > 0
            ? 'with-token'
            : 'without-token',
        );
      }
    },
}));

let broker: BrokerModule.GitHubBroker;
let brokerModule: typeof BrokerModule;
const log: string[] = [];

beforeEach(async () => {
  jest.useFakeTimers({ now: Date.parse('2026-11-16T10:00:00.000Z') });
  jest.resetModules();
  tokenReads.length = 0;
  octokitBuilds.length = 0;
  log.length = 0;
  currentToken = 'ghp_token_one';
  brokerModule = await import('../lib/github-broker');
  broker = brokerModule.getGitHubBroker();
});

afterEach(() => {
  brokerModule.resetGitHubBrokerForTests();
  jest.useRealTimers();
});

const elapsed = (): number =>
  Date.now() - Date.parse('2026-11-16T10:00:00.000Z');

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(
      Math.floor(Date.parse('2026-11-16T11:00:00.000Z') / 1000),
    ),
    'x-ratelimit-resource': 'core',
    ...extra,
  };
}

function ok<T>(data: T, extra: Record<string, string> = {}) {
  return (): Promise<BrokerModule.GitHubRawResponse<T>> =>
    Promise.resolve({ status: 200, headers: headers(extra), data });
}

function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (result) => {
      if (typeof result !== 'object' || result === null) return result;
      const { kind, status, changed } = result as {
        kind?: unknown;
        status?: unknown;
        changed?: unknown;
      };
      return { kind, status, changed };
    },
    (error: unknown) =>
      brokerModule.isGitHubBrokerError(error)
        ? { error: error.code, retriable: error.retriable ?? null }
        : { error: error instanceof Error ? error.name : String(error) },
  );
}

describe('scheduling', () => {
  it('starts at most eight reads per second and spaces mutations a second apart', async () => {
    const starts: string[] = [];
    const read =
      (label: string) =>
      (): Promise<BrokerModule.GitHubRawResponse<{ label: string }>> => {
        starts.push(`${label}@${String(elapsed())}`);
        return ok({ label })();
      };
    const reads = Array.from({ length: 10 }, (_, index) =>
      broker.execute(read(`read-${String(index)}`), {
        priority: 'background',
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: 30_000,
      }),
    );
    const mutations = ['mutation-a', 'mutation-b'].map((label) =>
      broker.execute(read(label), {
        priority: 'interactive',
        operation: 'mutation',
        idempotency: 'unsafe',
        timeoutMs: 30_000,
      }),
    );
    await jest.advanceTimersByTimeAsync(5_000);
    await Promise.all([...reads, ...mutations]);
    expect(starts).toMatchSnapshot();
  });

  it('serves interactive requests first without starving background reads', async () => {
    const starts: string[] = [];
    const request =
      (label: string) =>
      (): Promise<BrokerModule.GitHubRawResponse<{ label: string }>> => {
        starts.push(label);
        return ok({ label })();
      };
    const queued: Promise<unknown>[] = [];
    for (let index = 0; index < 8; index += 1) {
      queued.push(
        broker.execute(request(`fill-${String(index)}`), {
          priority: 'background',
          operation: 'read',
          idempotency: 'safe',
          timeoutMs: 60_000,
        }),
      );
    }
    for (let index = 0; index < 4; index += 1) {
      queued.push(
        broker.execute(request(`background-${String(index)}`), {
          priority: 'background',
          operation: 'read',
          idempotency: 'safe',
          timeoutMs: 60_000,
        }),
      );
    }
    for (let index = 0; index < 8; index += 1) {
      queued.push(
        broker.execute(request(`interactive-${String(index)}`), {
          priority: 'interactive',
          operation: 'read',
          idempotency: 'safe',
          timeoutMs: 60_000,
        }),
      );
    }
    await jest.advanceTimersByTimeAsync(10_000);
    await Promise.all(queued);
    expect(starts).toMatchSnapshot();
  });

  it('shares one in-flight conditional read per resource key, and only those', async () => {
    let calls = 0;
    const request = (): Promise<
      BrokerModule.GitHubRawResponse<{ n: number }>
    > => {
      calls += 1;
      return ok({ n: calls })();
    };
    const plain = {
      priority: 'watcher' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      resourceKey: 'repos/acme/app/pulls',
      timeoutMs: 30_000,
    };
    const conditional = {
      ...plain,
      conditional: true,
      isCachedData: (value: unknown): value is { n: number } =>
        typeof value === 'object' && value !== null && 'n' in value,
    };
    const shared = await Promise.all([
      broker.execute(request, conditional),
      broker.execute(request, conditional),
    ]);
    const sharedCalls = calls;
    const separate = await Promise.all([
      broker.execute(request, plain),
      broker.execute(request, plain),
    ]);
    expect({
      sharedCalls,
      shared: shared.map((result) => result.data),
      plainCalls: calls - sharedCalls,
      separate: separate.map((result) => result.data),
    }).toMatchSnapshot();
  });
});

describe('conditional reads and rate limits', () => {
  it('reuses a cached body on 304 and reports it unchanged', async () => {
    const seenConditionalHeaders: string[] = [];
    const options = {
      priority: 'watcher' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      resourceKey: 'repos/acme/app/pulls/1',
      conditional: true,
      isCachedData: (value: unknown): value is { title: string } =>
        typeof value === 'object' && value !== null && 'title' in value,
      timeoutMs: 30_000,
    };
    const first = await broker.execute((_octokit, conditional) => {
      seenConditionalHeaders.push(Object.keys(conditional).sort().join(','));
      return ok({ title: 'Feature' }, { etag: '"v1"' })();
    }, options);
    const second = await broker.execute((_octokit, conditional) => {
      seenConditionalHeaders.push(
        `${Object.keys(conditional).sort().join(',')}=${Object.values(conditional).join(',')}`,
      );
      return Promise.resolve({
        status: 304,
        headers: headers({ etag: '"v1"' }),
        data: null,
      });
    }, options);
    expect({
      seenConditionalHeaders,
      first: { kind: first.kind, status: first.status, data: first.data },
      second: {
        kind: second.kind,
        status: second.status,
        data: second.data,
        changed: second.kind === 'read' ? second.changed : null,
      },
    }).toMatchSnapshot();
  });

  it('pauses a bucket at its primary limit and reports the quota', async () => {
    const states: unknown[] = [];
    broker.subscribeRateLimits((state) => {
      states.push(JSON.parse(JSON.stringify(state)));
    });
    const exhausted = outcome(
      broker.execute(
        () =>
          Promise.reject(
            Object.assign(new Error('API rate limit exceeded'), {
              status: 403,
              response: {
                status: 403,
                headers: headers({ 'x-ratelimit-remaining': '0' }),
              },
            }),
          ),
        {
          priority: 'background',
          operation: 'read',
          idempotency: 'safe',
          timeoutMs: 30_000,
        },
      ),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    const refused = outcome(
      broker.execute(ok({}), {
        priority: 'background',
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: 30_000,
      }),
    );
    await jest.advanceTimersByTimeAsync(1_000);
    expect({
      exhausted: await exhausted,
      refused: await refused,
      diagnostics: broker.getQuotaDiagnostics(),
      states,
    }).toMatchSnapshot();
  });
});

describe('retries', () => {
  async function attempts(
    failure: () => Error,
    operation: 'read' | 'mutation',
    idempotency: 'safe' | 'unsafe',
  ): Promise<unknown> {
    let count = 0;
    const result = outcome(
      broker.execute(
        () => {
          count += 1;
          return Promise.reject(failure());
        },
        { priority: 'interactive', operation, idempotency, timeoutMs: 30_000 },
      ),
    );
    await jest.advanceTimersByTimeAsync(60_000);
    return { attempts: count, result: await result };
  }
  const httpError = (status: number): Error =>
    Object.assign(new Error(`HTTP ${String(status)}`), {
      status,
      response: { status, headers: headers() },
    });

  it('retries safe operations on server and network failures only', async () => {
    expect({
      safeReadServerError: await attempts(() => httpError(502), 'read', 'safe'),
      safeReadNetworkError: await attempts(
        () => new TypeError('fetch failed'),
        'read',
        'safe',
      ),
      safeReadNotFound: await attempts(() => httpError(404), 'read', 'safe'),
      safeMutationServerError: await attempts(
        () => httpError(502),
        'mutation',
        'safe',
      ),
      unsafeMutationServerError: await attempts(
        () => httpError(502),
        'mutation',
        'unsafe',
      ),
    }).toMatchSnapshot();
  });
});

describe('per-credential separation', () => {
  it('keeps conditional cache entries and quota apart per caller-selected credential', async () => {
    const seen: string[] = [];
    const options = (
      token?: string,
    ): BrokerModule.GitHubBrokerRequestOptions<{ title: string }> => ({
      priority: 'watcher' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      resourceKey: 'repos/acme/app/pulls/7',
      conditional: true,
      isCachedData: (value: unknown): value is { title: string } =>
        typeof value === 'object' && value !== null && 'title' in value,
      timeoutMs: 30_000,
      ...(token ? { authenticationToken: token } : {}),
    });
    const read =
      (label: string, remaining: string) =>
      (
        _octokit: unknown,
        conditional: Record<string, string>,
      ): Promise<BrokerModule.GitHubRawResponse<{ title: string }>> => {
        seen.push(
          `${label} ${Object.keys(conditional).join(',') || 'no-conditional'}`,
        );
        return ok(
          { title: label },
          { etag: `"${label}"`, 'x-ratelimit-remaining': remaining },
        )();
      };
    await broker.execute(read('default-1', '4000'), options());
    await broker.execute(read('caller-a-1', '3000'), options('ghp_caller_a'));
    await broker.execute(read('caller-b-1', '2000'), options('ghp_caller_b'));
    await broker.execute(read('default-2', '3999'), options());
    await broker.execute(read('caller-a-2', '2999'), options('ghp_caller_a'));
    expect({
      seen,
      quota: {
        default: broker.currentQuota('core')?.remaining ?? null,
        callerA: broker.currentQuota('core', 'ghp_caller_a')?.remaining ?? null,
        callerB: broker.currentQuota('core', 'ghp_caller_b')?.remaining ?? null,
        unknownCaller:
          broker.currentQuota('core', 'ghp_unknown')?.remaining ?? null,
      },
      tokenReads,
      octokitBuilds,
    }).toMatchSnapshot();
  });
});

describe('credentials and lifecycle', () => {
  it('builds one client per credential generation and refuses without a token', async () => {
    const options = {
      priority: 'interactive' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      timeoutMs: 30_000,
    };
    await broker.execute(ok({ n: 1 }), options);
    await broker.execute(ok({ n: 2 }), options);
    const generationBefore = broker.getCredentialGeneration();
    broker.resetCredentials();
    currentToken = '';
    const refused = await outcome(broker.execute(ok({ n: 3 }), options));
    currentToken = 'ghp_token_two';
    await broker.execute(ok({ n: 4 }), options);
    await broker.execute(ok({ n: 5 }), {
      ...options,
      authenticationToken: 'ghp_caller_selected',
    });
    expect({
      tokenReads,
      octokitBuilds,
      generationAdvanced: broker.getCredentialGeneration() > generationBefore,
      refused,
    }).toMatchSnapshot();
  });

  it('reissues in-flight work on credential reset and shuts down once', async () => {
    const within = async (
      promise: Promise<unknown>,
      ms: number,
    ): Promise<unknown> => {
      const settled = Promise.race([
        promise,
        new Promise((resolve) => {
          setTimeout(() => resolve('still pending'), ms);
        }),
      ]);
      await jest.advanceTimersByTimeAsync(ms);
      return settled;
    };
    let attempts = 0;
    let release: () => void = () => undefined;
    const slow = (): Promise<BrokerModule.GitHubRawResponse<object>> => {
      attempts += 1;
      const attempt = attempts;
      if (attempt > 1) {
        return Promise.resolve({
          status: 200,
          headers: headers(),
          data: { attempt },
        });
      }
      return new Promise((resolve) => {
        release = (): void =>
          resolve({ status: 200, headers: headers(), data: { attempt } });
      });
    };
    const inFlight = outcome(
      broker.execute(slow, {
        priority: 'watcher',
        operation: 'read',
        idempotency: 'safe',
        resourceKey: 'shared',
        timeoutMs: 30_000,
      }),
    );
    await jest.advanceTimersByTimeAsync(1_000);
    const attemptsBeforeReset = attempts;
    broker.resetCredentials();
    release();
    const afterReset = await within(inFlight, 2_000);
    const attemptsAfterReset = attempts;

    const queuedAtShutdown = outcome(
      broker.execute(ok({}), {
        priority: 'background',
        operation: 'mutation',
        idempotency: 'unsafe',
        timeoutMs: 30_000,
      }),
    );
    broker.shutdown();
    broker.shutdown();
    const afterShutdown = outcome(
      broker.execute(ok({}), {
        priority: 'interactive',
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: 30_000,
      }),
    );
    expect({
      attemptsBeforeReset,
      attemptsAfterReset,
      afterReset,
      queuedAtShutdown: await within(queuedAtShutdown, 5_000),
      afterShutdown: await within(afterShutdown, 60_000),
      tokenReads,
    }).toMatchSnapshot();
  });
});
