import {
  PROVIDER_CREDENTIAL_EFFECT_IDS,
  PROVIDER_SIGN_IN_CREDENTIAL_EFFECTS,
  SIGN_IN_OPERATING_SYSTEMS,
  WORKER_AGENT_SIGN_IN_PROVIDERS,
  WorkerAgentSignInRunParamsSchema,
  WorkerAgentSignInRunResultSchema,
  providerCredentialEffects,
} from '../agent-sign-in';

it('every provider declares its credential effects on every supported OS', () => {
  for (const provider of WORKER_AGENT_SIGN_IN_PROVIDERS) {
    for (const os of SIGN_IN_OPERATING_SYSTEMS) {
      expect(providerCredentialEffects(provider, os).length).toBeGreaterThan(0);
    }
  }
  for (const effect of PROVIDER_SIGN_IN_CREDENTIAL_EFFECTS) {
    expect(effect.effectId.startsWith(`${effect.provider}.${effect.os}.`)).toBe(
      true,
    );
  }
});

it('effect ids are unique and stable', () => {
  const ids = PROVIDER_SIGN_IN_CREDENTIAL_EFFECTS.map(
    (effect) => effect.effectId,
  );
  expect(ids).toEqual([...PROVIDER_CREDENTIAL_EFFECT_IDS]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toMatchInlineSnapshot(`
    [
      "claude.darwin.keychain",
      "claude.linux.credentials-file",
      "claude.win32.credentials-file",
      "codex.darwin.auth-store",
      "codex.linux.auth-store",
      "codex.win32.auth-store",
      "github.darwin.gh-store",
      "github.linux.gh-store",
      "github.win32.gh-store",
      "antigravity.darwin.native-store",
      "antigravity.linux.native-store",
      "antigravity.win32.native-store",
      "opencode.darwin.auth-file",
      "opencode.linux.auth-file",
      "opencode.win32.auth-file",
      "opencode.darwin.database",
      "opencode.linux.database",
      "opencode.win32.database",
    ]
  `);
});

it('locations are templates, not user paths', () => {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const user = process.env.USER ?? process.env.USERNAME;
  if (home === undefined || user === undefined)
    throw new Error('The test host has no home directory or user name.');
  for (const effect of PROVIDER_SIGN_IN_CREDENTIAL_EFFECTS) {
    expect(effect.location).not.toContain(home);
    expect(effect.location).not.toContain(user);
  }
});

it('params refuse a method that does not match the provider', () => {
  const parse = (provider: string, method: string): boolean =>
    WorkerAgentSignInRunParamsSchema.safeParse({
      signInRunId: 'run',
      provider,
      method,
    }).success;
  expect(parse('codex', 'terminal')).toBe(false);
  expect(parse('claude', 'chatgpt')).toBe(false);
  expect(parse('codex', 'chatgptDeviceCode')).toBe(true);
  expect(parse('github', 'terminal')).toBe(true);
});

it('results refuse unknown fields and free-text failures', () => {
  const result = {
    signInRunId: 'run',
    provider: 'claude',
    credentialEffects: ['claude.darwin.keychain'],
    exitCode: 0,
    signal: null,
    status: 'succeeded',
  };
  expect(WorkerAgentSignInRunResultSchema.safeParse(result).success).toBe(true);
  expect(
    WorkerAgentSignInRunResultSchema.safeParse({ ...result, output: 'x' })
      .success,
  ).toBe(false);
  const failed = {
    ...result,
    exitCode: 1,
    status: 'failed',
    error: {
      code: 'worker.agent.signInFailed',
      message: 'The provider sign-in did not finish.',
    },
  };
  expect(WorkerAgentSignInRunResultSchema.safeParse(failed).success).toBe(true);
  expect(
    WorkerAgentSignInRunResultSchema.safeParse({
      ...failed,
      error: { ...failed.error, message: 'gh: token ghp_x rejected' },
    }).success,
  ).toBe(false);
});
