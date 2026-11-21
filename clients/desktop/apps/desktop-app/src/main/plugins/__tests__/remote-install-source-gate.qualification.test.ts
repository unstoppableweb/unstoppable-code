import type { LookupAddress } from 'node:dns';
import { buildCloneRepoArgs } from '../../lib/git';
import {
  controllerCredentialFreeGitUrl,
  controllerCredentialParts,
} from '../../remote-control/host/controller-remote-urls';
import {
  installPluginForPrincipal,
  REMOTE_PLUGIN_SOURCE_REFUSAL,
  storedPluginSourceUrl,
  type PluginSourceInstall,
  type StoredPluginSource,
} from '../remote-install-source-gate';

const lookupMock = jest.fn<Promise<LookupAddress[]>, [string]>();
const logWarnMock = jest.fn<void, [string, unknown?]>();

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (message: string, context?: unknown): void =>
    logWarnMock(message, context),
}));

jest.mock('node:dns/promises', () => ({
  lookup: (host: string): Promise<LookupAddress[]> => lookupMock(host),
}));

const PUBLIC_ADDRESS = '140.82.112.3';
const PRIVATE_ADDRESS = '10.0.0.5';

function resolveHosts(addresses: Record<string, string>): void {
  lookupMock.mockImplementation((host: string) => {
    const address = addresses[host];
    return address === undefined
      ? Promise.reject(new Error(`ENOTFOUND ${host}`))
      : Promise.resolve([{ address, family: 4 }]);
  });
}

function installSpy(): jest.MockedFunction<PluginSourceInstall> {
  return jest.fn<
    ReturnType<PluginSourceInstall>,
    Parameters<PluginSourceInstall>
  >(() => Promise.resolve({ success: false, error: 'not cloned in tests' }));
}

/** The host's own record of the plugin's source, as its cache holds it. */
function storedAs(
  sourceUrl: string | undefined,
): jest.MockedFunction<StoredPluginSource> {
  return jest.fn<
    ReturnType<StoredPluginSource>,
    Parameters<StoredPluginSource>
  >(() => Promise.resolve(sourceUrl));
}

describe('plugins:install-plugin source gate by principal (CAN-5764)', () => {
  beforeEach((): void => {
    lookupMock.mockReset();
    resolveHosts({
      'github.com': PUBLIC_ADDRESS,
      'git.internal.example.com': PRIVATE_ADDRESS,
    });
  });

  it.each([
    ['file:///etc/passwd'],
    ['ssh://git@github.com/acme/plugin.git'],
    ['git@github.com:acme/plugin.git'],
    ['https://10.0.0.5/acme/plugin.git'],
    ['https://169.254.169.254/latest/meta-data'],
    ['https://git.internal.example.com/acme/plugin.git'],
    ['https://user:token@github.com/acme/plugin.git'],
  ])(
    'refuses a remote control install from %s and never clones',
    async (sourceUrl) => {
      const install = installSpy();
      const result = await installPluginForPrincipal(
        { remote: true, marketplaceId: 'acme', pluginName: 'p', sourceUrl },
        install,
        storedAs(sourceUrl),
      );
      expect(result.success).toBe(false);
      expect(result.success ? '' : result.error).toContain(
        REMOTE_PLUGIN_SOURCE_REFUSAL,
      );
      expect(install).not.toHaveBeenCalled();
    },
  );

  it('clones a remote control install from a public https source with redirects refused, so a redirect to an internal host is never followed', async () => {
    const install = installSpy();
    const sourceUrl = 'https://github.com/acme/plugin.git';
    await installPluginForPrincipal(
      { remote: true, marketplaceId: 'acme', pluginName: 'p', sourceUrl },
      install,
      storedAs(sourceUrl),
    );
    expect(install).toHaveBeenCalledWith('acme', 'p', sourceUrl, {
      disableRedirects: true,
    });
    const args = buildCloneRepoArgs(sourceUrl, '/cache/p', false);
    expect(args.slice(0, 3)).toEqual([
      '-c',
      'http.followRedirects=false',
      'clone',
    ]);
  });

  it('keeps a local install of an ssh or private source working as before', async () => {
    for (const sourceUrl of [
      'git@github.com:acme/plugin.git',
      'https://git.internal.example.com/acme/plugin.git',
    ]) {
      const install = installSpy();
      const stored = storedAs(undefined);
      await installPluginForPrincipal(
        { remote: false, marketplaceId: 'acme', pluginName: 'p', sourceUrl },
        install,
        stored,
      );
      expect(install).toHaveBeenCalledWith('acme', 'p', sourceUrl);
      expect(stored).not.toHaveBeenCalled();
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

// CAN-7082: a controller sees plugin sources redacted, so the
// URL it sends back only picks the host's own record. The host clones what it
// stored, and a source it has no record of is refused.
describe('plugins:install-plugin source from a controller (CAN-7082)', () => {
  const SECRET = 'tok-0123456789';
  const STORED = `https://github.com/acme/plugin.git?token=${SECRET}`;
  const REDACTED = 'https://github.com/acme/plugin.git';

  beforeEach((): void => {
    lookupMock.mockReset();
    resolveHosts({ 'github.com': PUBLIC_ADDRESS });
  });

  it.each([
    ['the redacted URL a controller sees', REDACTED],
    ['the stored URL itself', STORED],
  ])(
    'clones the stored source when the controller sends %s',
    async (_label, sourceUrl) => {
      const install = installSpy();
      const stored = storedAs(STORED);
      await installPluginForPrincipal(
        { remote: true, marketplaceId: 'acme', pluginName: 'p', sourceUrl },
        install,
        stored,
      );
      expect(stored).toHaveBeenCalledWith('acme', 'p');
      expect(install).toHaveBeenCalledWith('acme', 'p', STORED, {
        disableRedirects: true,
      });
    },
  );

  it.each([
    ['another repository', 'https://github.com/acme/other.git'],
    ['another host', 'https://example.invalid/acme/plugin.git'],
    ['a new credential', `https://github.com/acme/plugin.git?token=new`],
    ['an empty source', ''],
  ])(
    'refuses %s that does not match the stored source, and never clones',
    async (_label, sourceUrl) => {
      const install = installSpy();
      const result = await installPluginForPrincipal(
        { remote: true, marketplaceId: 'acme', pluginName: 'p', sourceUrl },
        install,
        storedAs(STORED),
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(install).not.toHaveBeenCalled();
    },
  );

  it('refuses a plugin this computer has no source for, and never clones', async () => {
    const install = installSpy();
    const result = await installPluginForPrincipal(
      {
        remote: true,
        marketplaceId: 'acme',
        pluginName: 'p',
        sourceUrl: REDACTED,
      },
      install,
      storedAs(undefined),
    );
    expect(result.success).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it('keeps the stored credential out of a failed clone it reports', async () => {
    const install = jest.fn<
      ReturnType<PluginSourceInstall>,
      Parameters<PluginSourceInstall>
    >(() =>
      Promise.resolve({
        success: false,
        error: `Cloning into '/cache/p'...\nfatal: unable to access '${STORED}/': The requested URL returned error: 403`,
      }),
    );
    const result = await installPluginForPrincipal(
      {
        remote: true,
        marketplaceId: 'acme',
        pluginName: 'p',
        sourceUrl: REDACTED,
      },
      install,
      storedAs(STORED),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // The raw text never reaches the controller; a 403 reads as its
    // allowlisted reason.
    expect(result.success ? '' : result.error).toBe(
      "Couldn't install this plugin from https://github.com/acme/plugin.git: authentication failed. Its details are in this computer's log.",
    );
  });

  // A query value can hold an apostrophe, which ends no URL.
  it('keeps the stored credential out of a failed clone even after an apostrophe in its query', async () => {
    const stored = `https://github.com/acme/plugin.git?ref=team's-branch&token=${SECRET}`;
    const install = jest.fn<
      ReturnType<PluginSourceInstall>,
      Parameters<PluginSourceInstall>
    >(() =>
      Promise.resolve({
        success: false,
        error: `fatal: unable to access '${stored}/': The requested URL returned error: 403`,
      }),
    );
    const result = await installPluginForPrincipal(
      {
        remote: true,
        marketplaceId: 'acme',
        pluginName: 'p',
        sourceUrl: "https://github.com/acme/plugin.git?ref=team's-branch",
      },
      install,
      storedAs(stored),
    );
    expect(install).toHaveBeenCalledWith('acme', 'p', stored, {
      disableRedirects: true,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  // A clone error can quote one part of the stored source
  // without the rest, so each secret part is redacted on its own, as written
  // and percent-decoded.
  it('keeps each secret part of the stored source out of a failed clone, alone or decoded', async () => {
    const stored = `https://github.com/acme/plugin.git?ref=main&token=${SECRET}&sig=a%2Fb%2Bc`;
    const install = jest.fn<
      ReturnType<PluginSourceInstall>,
      Parameters<PluginSourceInstall>
    >(() =>
      Promise.resolve({
        success: false,
        error: `remote: token ${SECRET} rejected\nremote: signature a/b+c expired (a%2Fb%2Bc)\nfatal: Authentication failed`,
      }),
    );
    const result = await installPluginForPrincipal(
      {
        remote: true,
        marketplaceId: 'acme',
        pluginName: 'p',
        sourceUrl: 'https://github.com/acme/plugin.git?ref=main',
      },
      install,
      storedAs(stored),
    );
    const text = JSON.stringify(result);
    for (const part of [SECRET, 'a/b+c', 'a%2Fb%2Bc'])
      expect(text).not.toContain(part);
    expect(text).toContain('authentication failed');
  });

  it("reads a plugin's stored source in its object or string form", () => {
    expect(storedPluginSourceUrl({ externalSource: { url: STORED } })).toBe(
      STORED,
    );
    expect(storedPluginSourceUrl({ externalSource: STORED })).toBe(STORED);
    for (const externalSource of [null, undefined, '', {}, { url: '' }, 7])
      expect(storedPluginSourceUrl({ externalSource })).toBeUndefined();
  });
});

// A remote controller never sees raw clone-error text for a
// stored source that holds a credential part. It gets a fixed message: the
// source as a controller sees it and one allowlisted reason. Its details,
// scrubbed, go to this computer's log.
describe('a failed controller install from a credentialed source (CAN-7082)', () => {
  const failingWith =
    (error: string): PluginSourceInstall =>
    () =>
      Promise.resolve({ success: false, error });
  const remoteInstall = (
    stored: string,
    sent: string,
    install: PluginSourceInstall,
  ): ReturnType<typeof installPluginForPrincipal> =>
    installPluginForPrincipal(
      { remote: true, marketplaceId: 'acme', pluginName: 'p', sourceUrl: sent },
      install,
      storedAs(stored),
    );
  beforeEach((): void => {
    lookupMock.mockReset();
    logWarnMock.mockReset();
    resolveHosts({ 'github.com': PUBLIC_ADDRESS });
  });

  it("returns only the fixed message for a '+' token, with a scrubbed error logged here", async () => {
    const stored = 'https://github.com/acme/plugin.git?token=tok+secret';
    const raw =
      "remote: token tok secret rejected\nfatal: Authentication failed for 'https://github.com/acme/plugin.git/'";
    const result = await remoteInstall(
      stored,
      'https://github.com/acme/plugin.git',
      failingWith(raw),
    );
    expect(result).toEqual({
      success: false,
      error:
        "Couldn't install this plugin from https://github.com/acme/plugin.git: authentication failed. Its details are in this computer's log.",
    });
    expect(JSON.stringify(result)).not.toContain('tok secret');
    // main.log can leave the machine in a bug report, so the
    // logged line is scrubbed too. It keeps the error's shape and its reason,
    // and no 4-character piece of a secret part.
    const logged = JSON.stringify(logWarnMock.mock.calls).toLowerCase();
    expect(logged).toContain('rejected');
    expect(logged).toContain('authentication failed');
    for (const part of ['tok+secret', 'tok secret', 'tok%2bsecret'])
      for (let at = 0; at + 4 <= part.length; at += 1)
        expect(logged).not.toContain(part.slice(at, at + 4));
  });

  it.each([
    ["fatal: Authentication failed for 'X'", 'authentication failed'],
    ['remote: Repository not found.', "the source wasn't found"],
    [
      "fatal: unable to access 'X': Could not resolve host: github.com",
      "the source couldn't be reached",
    ],
    ['error: the clone ran out of disk space', 'the install failed'],
  ])('sorts %j into one allowlisted reason', async (raw, reason) => {
    const result = await remoteInstall(
      `https://github.com/acme/plugin.git?token=${'Q1X2Z3J4'}`,
      'https://github.com/acme/plugin.git',
      failingWith(raw),
    );
    expect(result.success ? '' : result.error).toBe(
      `Couldn't install this plugin from https://github.com/acme/plugin.git: ${reason}. Its details are in this computer's log.`,
    );
  });

  // A password that ends in `]` is a credential part, and a source
  // holding one is refused before any clone, with nothing of it shown.
  it.each([
    'https://user:secret]/tail@example.invalid/x',
    'https://user:secret]?tail@example.invalid/x',
    'https://user:secret]#tail@example.invalid/x',
    'ssh://user:secret]/tail@example.invalid/x',
    '//user:secret]/tail@example.invalid/x',
  ])('refuses %s before any clone, showing none of it', async (stored) => {
    expect(controllerCredentialParts(stored)).not.toEqual([]);
    const install = installSpy();
    const result = await remoteInstall(
      stored,
      controllerCredentialFreeGitUrl(stored),
      install,
    );
    expect(install).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/secret|tail/);
  });

  // An `@` after a cut-short password. The source is refused before
  // any clone, and neither the result nor the log holds a piece of it.
  it.each([
    'https://user:sekA/sekB@sekC?ref=sekD@example.invalid/x',
    'https://user:sekA?sekB@sekC?ref=sekD@example.invalid/x',
    'https://user:sekA#sekB@sekC#sekD@example.invalid/x',
    'https://user:sekA\\sekB@sekC?ref=sekD@example.invalid/x',
    'ssh://user:sekA/sekB@sekC?ref=sekD@example.invalid/x',
    '//user:sekA/sekB@sekC?ref=sekD@example.invalid/x',
    'https://user:sekA:123/sekB@example.invalid/x',
    'https://user:1234/sekB@example.invalid/x',
    'https://sekA:1234/sekB@example.invalid/x',
  ])('refuses %s before any clone, logging none of it', async (stored) => {
    const install = jest.fn<
      ReturnType<PluginSourceInstall>,
      Parameters<PluginSourceInstall>
    >(() =>
      Promise.resolve({
        success: false,
        error: `fatal: unable to access '${stored}': Could not resolve host`,
      }),
    );
    const result = await remoteInstall(
      stored,
      controllerCredentialFreeGitUrl(stored),
      install,
    );
    expect(install).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(JSON.stringify([result, logWarnMock.mock.calls])).not.toMatch(
      /sek[A-D]|:123|1234/,
    );
  });

  // Backstop: an `@` anywhere in the stored source takes the
  // fixed message, since a lenient reader takes userinfo up to the last one.
  it.each([
    'https://github.com/acme/@scope/plugin.git',
    'https://github.com/acme]/tail@example.invalid/plugin.git',
  ])(
    'returns only the fixed message for %s, which holds an @',
    async (stored) => {
      expect(controllerCredentialParts(stored)).toEqual([]);
      const result = await remoteInstall(
        stored,
        stored,
        failingWith('remote: token Q1X2Z3J4 rejected'),
      );
      expect(result).toEqual({
        success: false,
        error: `Couldn't install this plugin from ${stored}: the install failed. Its details are in this computer's log.`,
      });
    },
  );

  it('keeps the scrubbed detail for a source with no credential part', async () => {
    const raw = 'remote: Repository not found.';
    const result = await remoteInstall(
      'https://github.com/acme/plugin.git',
      'https://github.com/acme/plugin.git',
      failingWith(raw),
    );
    expect(result).toEqual({ success: false, error: raw });
  });

  it('shows a local caller the full error, as before', async () => {
    const raw = 'remote: token tok secret rejected';
    const result = await installPluginForPrincipal(
      {
        remote: false,
        marketplaceId: 'acme',
        pluginName: 'p',
        sourceUrl: 'https://github.com/acme/plugin.git?token=tok+secret',
      },
      failingWith(raw),
      storedAs(undefined),
    );
    expect(result).toEqual({ success: false, error: raw });
  });

  // Any transformation of the raw text: no 4-character window of a secret
  // part reaches the controller, in any letter case.
  it('never lets a 4-character piece of a secret part reach the controller', async () => {
    let state = 7082;
    const random = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const ALPHABET = '0123456789QXZJ';
    const secret = (): string =>
      Array.from(
        { length: 12 },
        () => ALPHABET[Math.floor(random() * ALPHABET.length)] ?? 'Q',
      ).join('');
    const leaks: string[] = [];
    for (let round = 0; round < 40; round += 1) {
      const token = secret();
      const fragment = secret();
      const stored = `https://github.com/acme/plugin.git?ref=main&token=${token}+${token.slice(0, 6)}&sig=${encodeURIComponent(token)}#${fragment}`;
      const transforms = [
        stored,
        stored.toUpperCase(),
        stored.toLowerCase(),
        JSON.stringify(stored),
        encodeURIComponent(stored),
        stored.replaceAll('+', ' '),
        [...stored].reverse().join(''),
        Buffer.from(stored).toString('base64'),
        `${token} ${fragment} ${token.toLowerCase()}`,
      ];
      for (const transform of transforms) {
        const result = await remoteInstall(
          stored,
          'https://github.com/acme/plugin.git?ref=main',
          failingWith(`fatal: ${transform}`),
        );
        const error = (
          result.success ? '' : (result.error ?? '')
        ).toLowerCase();
        for (const part of [token, fragment])
          for (let at = 0; at + 4 <= part.length; at += 1) {
            const piece = part.slice(at, at + 4).toLowerCase();
            if (error.includes(piece)) leaks.push(`${piece} in ${error}`);
          }
      }
    }
    expect(leaks.slice(0, 5)).toEqual([]);
  });
});
