/**
 * Organization transcripts on desktop (docs/organization-transcripts.md).
 *
 * The seven organization.transcripts.* settings entries on the
 * account-organization-settings:read and account-organization-settings:write
 * channels reach core.organizationTranscripts.* on the web core as the
 * signed-in account, with the idempotency key passed as the keyed `_meta`,
 * and a web core refusal becomes the settings error the web route answers.
 *
 * The account-organization-settings:download-transcript channel
 * (IPC_CHANNELS.accountOrganizationSettingsDownloadTranscript, preload
 * api.accountOrganizationSettings.downloadTranscriptFile) accepts only the two
 * transcript download routes, never an origin, asks where to save before any
 * request (a cancelled dialog makes none, so records no access event),
 * fetches from the signed-in account's own origin with its own key, and
 * removes its temporary file when the stream comes up short. It is blocked
 * for Remote Control.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanopyClientError } from '@canopy/core-client';
import { ORG_TRANSCRIPT_ERROR_CODES } from '@canopy/protocol/canopy-core';
import { SettingsOperationError } from '@canopy/protocol/settings';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { OrganizationTranscriptSettingsCalls } from '../../organization-capabilities/web-core-calls';
import { organizationTranscriptsOrchestration } from '../organization-transcripts-settings';
import { downloadOrganizationTranscript } from '../organization-transcript-download';

const ORG = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const EXPORT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = 'account-1';
const SESSION_PATH = `/api/v1/settings/organization/${ORG}/transcripts/sessions/${SESSION}/download?format=md`;
const EXPORT_PATH = `/api/v1/settings/organization/${ORG}/transcripts/exports/${EXPORT}/download`;

function fakeCalls(
  calls: unknown[],
  refuse?: CanopyClientError,
): OrganizationTranscriptSettingsCalls {
  const answer = <T>(name: string, value: unknown, result: T): Promise<T> => {
    calls.push([name, value]);
    return refuse ? Promise.reject(refuse) : Promise.resolve(result);
  };
  const exportRow = {
    id: EXPORT,
    status: 'preparing' as const,
    requestedAt: '2026-11-24T00:00:00.000Z',
    requestedBy: null,
    from: '2026-10-25T00:00:00.000Z',
    to: '2026-11-24T00:00:00.000Z',
    includePlans: false,
    includeSummaries: false,
    sessionCount: null,
    sizeBytes: null,
    readyAt: null,
    expiresAt: null,
    failureReason: null,
  };
  const fake: OrganizationTranscriptSettingsCalls = {
    sessions: (p) =>
      answer('sessions.list', p, { sessions: [], nextCursor: null }),
    session: (p) =>
      answer('session.get', p, {
        session: {
          id: SESSION,
          member: { id: null, name: null, formerMember: true },
          project: { id: ORG, name: 'Web' },
          branchName: 'main',
          firstActivityAt: '2026-11-24T00:00:00.000Z',
          lastActivityAt: '2026-11-24T00:00:00.000Z',
          turnCount: 0,
          model: null,
          totalCostUsd: null,
          status: 'done' as const,
        },
        turns: [],
        nextTurnsCursor: null,
      }),
    exports: (p) =>
      answer('exports.list', p, {
        exports: [],
        nextCursor: null,
        activeExport: null,
        storageAvailable: true,
      }),
    estimate: (p) =>
      answer('exports.estimate', p, {
        sessionCount: 0,
        approximateBytes: 0,
        tooLarge: false,
        sessionLimit: 5000,
      }),
    accessEvents: (p) =>
      answer('accessEvents.list', p, { events: [], nextCursor: null }),
    createExport: (p, key) =>
      answer('exports.create', { ...p, key }, exportRow),
    deleteExport: (p, key) =>
      answer('exports.delete', { ...p, key }, exportRow),
  };
  return fake;
}

const RANGE = {
  organizationId: ORG,
  from: '2026-10-25T00:00:00.000Z',
  to: '2026-11-24T00:00:00.000Z',
};

describe('settings entries', () => {
  it('reach core.organizationTranscripts.* with keys passed through', async () => {
    const calls: unknown[] = [];
    const getCalls = (): Promise<OrganizationTranscriptSettingsCalls> =>
      Promise.resolve(fakeCalls(calls));
    const run = (
      name: Parameters<typeof organizationTranscriptsOrchestration>[0],
      input: unknown,
    ): Promise<unknown> => {
      const operation = organizationTranscriptsOrchestration(
        name,
        input,
        getCalls,
      );
      if (operation === null) throw new Error(`${name} not orchestrated`);
      return operation();
    };
    await run('organization.transcripts.sessions', RANGE);
    await run('organization.transcripts.session', {
      organizationId: ORG,
      sessionId: SESSION,
    });
    await run('organization.transcripts.exports', { organizationId: ORG });
    await run('organization.transcripts.exports.estimate', {
      ...RANGE,
      includePlans: true,
      includeSummaries: false,
    });
    await run('organization.transcripts.accessEvents', { organizationId: ORG });
    await run('organization.transcripts.exports.create', {
      ...RANGE,
      includePlans: false,
      includeSummaries: true,
      idempotencyKey: 'key-1',
    });
    await run('organization.transcripts.exports.delete', {
      organizationId: ORG,
      exportId: EXPORT,
      idempotencyKey: 'key-2',
    });
    expect(calls.map((call) => (call as [string])[0])).toEqual([
      'sessions.list',
      'session.get',
      'exports.list',
      'exports.estimate',
      'accessEvents.list',
      'exports.create',
      'exports.delete',
    ]);
    expect(calls[5]).toEqual([
      'exports.create',
      { ...RANGE, includePlans: false, includeSummaries: true, key: 'key-1' },
    ]);
    expect(calls[6]).toEqual([
      'exports.delete',
      { organizationId: ORG, exportId: EXPORT, key: 'key-2' },
    ]);
    expect(
      organizationTranscriptsOrchestration(
        'organization.settings.projectDefaults',
        { organizationId: ORG },
        getCalls,
      ),
    ).toBeNull();
  });

  it('maps web core refusals to the settings errors the web routes answer', async () => {
    const refusal = (kind: string, code?: string): CanopyClientError =>
      new CanopyClientError({
        kind,
        message: 'refused',
        ...(code === undefined ? {} : { code }),
        retry: { kind: 'never' },
      } as never);
    const settle = async (error: CanopyClientError): Promise<unknown> => {
      const operation = organizationTranscriptsOrchestration(
        'organization.transcripts.exports.create',
        {
          ...RANGE,
          includePlans: false,
          includeSummaries: false,
          idempotencyKey: 'k',
        },
        () => Promise.resolve(fakeCalls([], error)),
      );
      return operation?.().catch((caught: unknown) => caught);
    };
    expect(
      await settle(
        refusal('failed_precondition', ORG_TRANSCRIPT_ERROR_CODES.tooLarge),
      ),
    ).toMatchObject({
      status: 422,
      serverCode: ORG_TRANSCRIPT_ERROR_CODES.tooLarge,
    });
    expect(
      await settle(
        refusal('conflict', ORG_TRANSCRIPT_ERROR_CODES.activeExportExists),
      ),
    ).toMatchObject({ status: 409 });
    expect(
      await settle(
        refusal('resource_exhausted', ORG_TRANSCRIPT_ERROR_CODES.rateLimited),
      ),
    ).toMatchObject({ status: 429 });
    expect(await settle(refusal('permission_denied'))).toMatchObject({
      code: 'forbidden',
    });
    expect(await settle(refusal('not_found'))).toMatchObject({
      code: 'not_found',
    });
    expect(await settle(refusal('capability_unavailable'))).toMatchObject({
      code: 'unsupported_server',
    });
    const unknown = await settle(refusal('internal'));
    expect(unknown).toBeInstanceOf(SettingsOperationError);
    expect(unknown).toMatchObject({ code: 'uncertain' });
  });
});

describe('download channel', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'org-transcripts-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  type Deps = Parameters<typeof downloadOrganizationTranscript>[1];
  function deps(
    overrides: Partial<Omit<Deps, 'choosePath'>> = {},
    { cancelDialog = false }: { cancelDialog?: boolean } = {},
  ): {
    fetch: jest.Mock;
    choosePath: jest.Mock;
    deps: Deps;
  } {
    const choosePath = jest.fn(
      (name: string): Promise<string | null> =>
        Promise.resolve(cancelDialog ? null : join(directory, name)),
    );
    const fetch = jest.fn(
      (): Promise<Response> =>
        Promise.resolve(
          new Response('# transcript\n', {
            status: 200,
            headers: { 'content-length': '13' },
          }),
        ),
    );
    return {
      fetch,
      choosePath,
      deps: {
        signedInAccountId: (): Promise<string> => Promise.resolve(ACCOUNT),
        readCredentials: (): Promise<{ baseUrl: string; apiKey: string }> =>
          Promise.resolve({
            baseUrl: 'https://canopy.example/app',
            apiKey: 'csk_key',
          }),
        fetch,
        ...overrides,
        choosePath,
      },
    };
  }

  it('is a local-only channel', () => {
    expect(IPC_CHANNELS.accountOrganizationSettingsDownloadTranscript).toBe(
      'account-organization-settings:download-transcript',
    );
    expect(
      IPC_REMOTE_DISPOSITIONS.accountOrganizationSettingsDownloadTranscript,
    ).toBe('blocked');
  });

  it('accepts only the two download routes, never an origin', async () => {
    for (const path of [
      'https://evil.example/api/v1/x',
      `/api/v1/settings/organization/${ORG}/transcripts/sessions/${SESSION}`,
      `/api/v1/settings/organization/${ORG}/transcripts/sessions/${SESSION}/download?format=html`,
      `/api/v1/settings/organization/${ORG}/transcripts/exports/../download`,
      `/api/v1/settings/organization/${ORG}%2F/transcripts/exports/${EXPORT}/download`,
    ]) {
      const { deps: d, fetch, choosePath } = deps();
      await expect(
        downloadOrganizationTranscript(
          { accountId: ACCOUNT, path, suggestedName: 'a.md' },
          d,
        ),
      ).resolves.toEqual({ ok: false, reason: 'invalid' });
      expect(fetch).not.toHaveBeenCalled();
      expect(choosePath).not.toHaveBeenCalled();
    }
    const { deps: d } = deps();
    await expect(
      downloadOrganizationTranscript(
        {
          accountId: ACCOUNT,
          path: EXPORT_PATH,
          suggestedName: 'x.zip',
          origin: 'https://evil.example',
        },
        d,
      ),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('asks where to save before any request, and a cancel makes none', async () => {
    const { deps: d, fetch, choosePath } = deps({}, { cancelDialog: true });
    await expect(
      downloadOrganizationTranscript(
        {
          accountId: ACCOUNT,
          path: SESSION_PATH,
          suggestedName: '../../etc/passwd',
        },
        d,
      ),
    ).resolves.toEqual({ ok: true, saved: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(choosePath).toHaveBeenCalledWith('passwd');
  });

  it("saves from the account's own origin with its own key", async () => {
    const { deps: d, fetch } = deps();
    await expect(
      downloadOrganizationTranscript(
        { accountId: ACCOUNT, path: SESSION_PATH, suggestedName: 'main.md' },
        d,
      ),
    ).resolves.toEqual({ ok: true, saved: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`https://canopy.example${SESSION_PATH}`);
    expect(init).toMatchObject({
      redirect: 'error',
      headers: { authorization: 'Bearer csk_key' },
    });
    expect(await readFile(join(directory, 'main.md'), 'utf8')).toBe(
      '# transcript\n',
    );
    expect(await readdir(directory)).toEqual(['main.md']);
  });

  it('removes its temporary file when the stream comes up short', async () => {
    const { deps: d } = deps({
      fetch: jest.fn(
        (): Promise<Response> =>
          Promise.resolve(
            new Response('short', {
              status: 200,
              headers: { 'content-length': '999' },
            }),
          ),
      ),
    });
    await expect(
      downloadOrganizationTranscript(
        { accountId: ACCOUNT, path: EXPORT_PATH, suggestedName: 'export.zip' },
        d,
      ),
    ).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses another account and maps an expired export', async () => {
    const other = deps({
      signedInAccountId: (): Promise<string> => Promise.resolve('someone-else'),
    });
    await expect(
      downloadOrganizationTranscript(
        { accountId: ACCOUNT, path: EXPORT_PATH, suggestedName: 'x.zip' },
        other.deps,
      ),
    ).resolves.toEqual({ ok: false, reason: 'unauthenticated' });
    const gone = deps({
      fetch: jest.fn(
        (): Promise<Response> =>
          Promise.resolve(new Response(null, { status: 410 })),
      ),
    });
    await expect(
      downloadOrganizationTranscript(
        { accountId: ACCOUNT, path: EXPORT_PATH, suggestedName: 'x.zip' },
        gone.deps,
      ),
    ).resolves.toEqual({ ok: false, reason: 'gone' });
  });
});
