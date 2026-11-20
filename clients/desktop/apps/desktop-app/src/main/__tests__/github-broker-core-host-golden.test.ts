// CAN-4176 golden: Electron main hosts the core GitHub broker with its own
// credential port, its own github-auth token cache and its own main-process
// log. Only the stored PAT's secure-storage read, the storage policy, the PAT
// paths and the Octokit constructor are replaced; github-auth, the credential
// port, main-process logging, the accessor and the core broker are the real
// modules. A change here is a behaviour change: re-record deliberately with
// `pnpm test <this file> -u` and review the snapshot diff.
import type * as BrokerModule from '../lib/github-broker';
import type * as CoreBrokerModule from '@canopy/core-runtime/node/github/broker/broker';
import type * as CredentialPortModule from '../lib/github-broker/credential-port';
import type * as GitHubAuthModule from '../lib/github-auth';
import type * as LoggingModule from '../lib/main-process-logging';

const patReads: string[] = [];
jest.mock('../lib/secure-storage-migration', () => ({
  migrateSecureStorageFile: (): Promise<{
    status: 'current';
    value: string;
  }> => {
    patReads.push('read');
    return Promise.resolve({ status: 'current', value: 'ghp_stored_pat' });
  },
}));
jest.mock('../lib/paths', () => ({
  getGitHubPatFilePath: (): string => '/unused/github-pat.enc',
  getInternalLegacySharedGitHubPatFilePath: (): string =>
    '/unused/shared-github-pat.enc',
  getLegacyGitHubPatFilePath: (): string => '/unused/legacy.enc',
}));
jest.mock('../lib/secure-storage-policy', () => ({
  getSecureStorageFailure: (): null => null,
  getSecretStoragePolicy: (): unknown => ({
    assertCanRead: (): void => undefined,
    assertCanWrite: (): void => undefined,
    getStatus: (): { backend: string } => ({ backend: 'test' }),
    decrypt: (value: unknown): unknown => value,
    encrypt: (value: unknown): unknown => value,
  }),
}));
jest.mock('../lib/github-octokit-loader', () => ({
  loadOctokitConstructor: (): unknown =>
    class FakeOctokit {
      hook = { wrap: (): void => undefined };
    },
}));

type CreateOptions = CoreBrokerModule.CreateGitHubBrokerOptions;

let brokerModule: typeof BrokerModule;
let githubAuth: typeof GitHubAuthModule;
let logging: typeof LoggingModule;
let credentialPort: CredentialPortModule.GitHubBrokerCredentialPort;
let received: CreateOptions[];
let infoLines: string[];

beforeEach(async () => {
  jest.resetModules();
  patReads.length = 0;
  received = [];
  infoLines = [];
  const core = await import('@canopy/core-runtime/node/github/broker/broker');
  const create = core.createGitHubBroker;
  jest
    .spyOn(core, 'createGitHubBroker')
    .mockImplementation((options: CreateOptions) => {
      received.push(options);
      return create(options);
    });
  // Beneath the real logMainProcessInfo: what reaches the main-process log.
  const electronLog = (await import('electron-log/main.js')).default;
  jest.spyOn(electronLog, 'info').mockImplementation((...args: unknown[]) => {
    infoLines.push(String(args[0]));
  });
  githubAuth = await import('../lib/github-auth');
  logging = await import('../lib/main-process-logging');
  credentialPort = (
    await import('../lib/github-broker/credential-port')
  ).getGitHubBrokerCredentialPort();
  brokerModule = await import('../lib/github-broker');
});

afterEach(() => {
  brokerModule.resetGitHubBrokerForTests();
  jest.restoreAllMocks();
});

function read(
  statuses: number[],
  sent: number[],
): () => Promise<BrokerModule.GitHubRawResponse<{ ok: true }>> {
  return () => {
    const status = statuses.shift() ?? 200;
    sent.push(status);
    return status === 200
      ? Promise.resolve({ status, headers: {}, data: { ok: true } })
      : Promise.reject(
          Object.assign(new Error('Bad credentials'), { status, headers: {} }),
        );
  };
}

const options: BrokerModule.GitHubBrokerRequestOptions<{ ok: true }> = {
  priority: 'interactive',
  operation: 'read',
  idempotency: 'safe',
  timeoutMs: 10_000,
  caller: 'equivalence',
};

describe('the core broker hosted in Electron main', () => {
  it('receives the real credential port as leases only, and the real github-auth and logging functions', () => {
    brokerModule.getGitHubBroker();
    brokerModule.getGitHubBroker();
    expect(received).toHaveLength(1);
    const [given] = received;
    expect({
      credentials: Object.keys(given.credentials).sort(),
      authorizeReachesCore: 'authorize' in given.credentials,
      sameDefaultLease:
        given.credentials.defaultLease === credentialPort.defaultLease,
      sameDefaultScope:
        given.credentials.scopeId(credentialPort.defaultLease) ===
        credentialPort.scopeId(credentialPort.defaultLease),
      isDefault: given.credentials.isDefault(credentialPort.defaultLease),
      realInvalidateTokenCache:
        given.invalidateTokenCache === githubAuth.invalidateTokenCache,
      realLogMainProcessInfo:
        given.logMainProcessInfo === logging.logMainProcessInfo,
    }).toMatchInlineSnapshot(`
      {
        "authorizeReachesCore": false,
        "credentials": [
          "defaultLease",
          "isDefault",
          "scopeId",
          "verify",
        ],
        "isDefault": true,
        "realInvalidateTokenCache": true,
        "realLogMainProcessInfo": true,
        "sameDefaultLease": true,
        "sameDefaultScope": true,
      }
    `);
  });

  it('empties the same github-auth token cache when GitHub rejects the default credential', async () => {
    const broker = brokerModule.getGitHubBroker();
    const sent: number[] = [];

    await broker.execute(read([200], sent), options);
    const afterFirstRead = [...patReads];
    await broker.execute(read([200], sent), options);
    const afterCachedRead = [...patReads];
    const result = await broker.execute(read([401, 200], sent), options);

    expect({
      afterFirstRead,
      afterCachedRead,
      afterRefresh: patReads,
      sent,
      status: result.status,
    }).toMatchInlineSnapshot(`
      {
        "afterCachedRead": [
          "read",
        ],
        "afterFirstRead": [
          "read",
        ],
        "afterRefresh": [
          "read",
          "read",
        ],
        "sent": [
          200,
          200,
          401,
          200,
        ],
        "status": 200,
      }
    `);
  });

  it('refuses a lease the credential port did not mint before anything is read or sent', async () => {
    const broker = brokerModule.getGitHubBroker();
    const sent: number[] = [];
    const foreign = Object.freeze(
      {},
    ) as unknown as CredentialPortModule.GitHubBrokerCredentialLease;

    const outcome = await broker
      .execute(read([200], sent), { ...options, credential: foreign })
      .then(
        () => 'resolved',
        (error: unknown) =>
          brokerModule.isGitHubBrokerError(error)
            ? { code: error.code, message: error.message }
            : String(error),
      );

    expect({ outcome, sent, patReads }).toMatchInlineSnapshot(`
      {
        "outcome": {
          "code": "not_authenticated",
          "message": "The GitHub credential lease was not issued by the credential port.",
        },
        "patReads": [],
        "sent": [],
      }
    `);
  });

  it('logs the spend summary through the real main-process log', async () => {
    const broker = brokerModule.getGitHubBroker();
    await broker.execute(read([200], []), options);
    broker.shutdown();

    expect(infoLines.filter((line) => line.includes('equivalence')))
      .toMatchInlineSnapshot(`
      [
        "[github-broker] GitHub requests in the last 1 min: core 1 (equivalence/interactive 1; 0 not modified).",
      ]
    `);
  });
});
