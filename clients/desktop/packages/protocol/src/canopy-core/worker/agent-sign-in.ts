import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
} from '../errors';
import { WORKER_AGENT_GRANTS } from './agent-helpers';

/*
 * `worker.agent.signIn.run` (CAN-5070): one provider sign-in attempt on a
 * worker, as the child dispatch of a `core.signIn.run` operation. The run
 * spans the window in which the provider's own binary may write its
 * credentials. Params carry ids only; the launch is staged by the owning
 * core's host. Results name the declared credential effects, never a value.
 */
export const WORKER_AGENT_SIGN_IN_PROVIDERS = [
  'claude',
  'codex',
  'github',
  'opencode',
  'antigravity',
] as const;
export type WorkerAgentSignInProvider =
  (typeof WORKER_AGENT_SIGN_IN_PROVIDERS)[number];

export const WORKER_AGENT_SIGN_IN_METHODS = [
  'terminal',
  'chatgpt',
  'chatgptDeviceCode',
] as const;
export type WorkerAgentSignInMethod =
  (typeof WORKER_AGENT_SIGN_IN_METHODS)[number];

export const SIGN_IN_OPERATING_SYSTEMS = ['darwin', 'linux', 'win32'] as const;
export type SignInOperatingSystem = (typeof SIGN_IN_OPERATING_SYSTEMS)[number];

export const PROVIDER_CREDENTIAL_EFFECT_IDS = [
  'claude.darwin.keychain',
  'claude.linux.credentials-file',
  'claude.win32.credentials-file',
  'codex.darwin.auth-store',
  'codex.linux.auth-store',
  'codex.win32.auth-store',
  'github.darwin.gh-store',
  'github.linux.gh-store',
  'github.win32.gh-store',
  'antigravity.darwin.native-store',
  'antigravity.linux.native-store',
  'antigravity.win32.native-store',
  'opencode.darwin.auth-file',
  'opencode.linux.auth-file',
  'opencode.win32.auth-file',
  'opencode.darwin.database',
  'opencode.linux.database',
  'opencode.win32.database',
] as const;
export type ProviderCredentialEffectId =
  (typeof PROVIDER_CREDENTIAL_EFFECT_IDS)[number];

export interface ProviderCredentialEffect {
  readonly effectId: ProviderCredentialEffectId;
  readonly provider: WorkerAgentSignInProvider;
  readonly os: SignInOperatingSystem;
  readonly store: 'os-keychain' | 'file' | 'file-or-os-keyring' | 'database';
  /** A location template; never a resolved user path. */
  readonly location: string;
  readonly writer: 'provider-binary' | 'codex-app-server';
  readonly evidence: 'source' | 'provider-documentation';
}

export const PROVIDER_SIGN_IN_CREDENTIAL_EFFECTS: readonly ProviderCredentialEffect[] =
  Object.freeze([
    {
      effectId: 'claude.darwin.keychain',
      provider: 'claude',
      os: 'darwin',
      store: 'os-keychain',
      location:
        'login Keychain generic password, service "Claude Code-credentials", account = OS user',
      writer: 'provider-binary',
      evidence: 'source',
    },
    {
      effectId: 'claude.linux.credentials-file',
      provider: 'claude',
      os: 'linux',
      store: 'file',
      location:
        '$CLAUDE_CONFIG_DIR/.credentials.json, default ~/.claude/.credentials.json',
      writer: 'provider-binary',
      evidence: 'source',
    },
    {
      effectId: 'claude.win32.credentials-file',
      provider: 'claude',
      os: 'win32',
      store: 'file',
      location:
        '%CLAUDE_CONFIG_DIR%\\.credentials.json, default %USERPROFILE%\\.claude\\.credentials.json',
      writer: 'provider-binary',
      evidence: 'source',
    },
    {
      effectId: 'codex.darwin.auth-store',
      provider: 'codex',
      os: 'darwin',
      store: 'file-or-os-keyring',
      location:
        '$CODEX_HOME/auth.json (default ~/.codex), or the OS keyring when cli_auth_credentials_store selects it',
      writer: 'codex-app-server',
      evidence: 'source',
    },
    {
      effectId: 'codex.linux.auth-store',
      provider: 'codex',
      os: 'linux',
      store: 'file-or-os-keyring',
      location:
        '$CODEX_HOME/auth.json (default ~/.codex), or the OS keyring when cli_auth_credentials_store selects it',
      writer: 'codex-app-server',
      evidence: 'source',
    },
    {
      effectId: 'codex.win32.auth-store',
      provider: 'codex',
      os: 'win32',
      store: 'file-or-os-keyring',
      location:
        '%CODEX_HOME%\\auth.json (default %USERPROFILE%\\.codex), or the OS keyring when cli_auth_credentials_store selects it',
      writer: 'codex-app-server',
      evidence: 'source',
    },
    {
      effectId: 'github.darwin.gh-store',
      provider: 'github',
      os: 'darwin',
      store: 'file-or-os-keyring',
      location:
        'gh: login Keychain when available, else $GH_CONFIG_DIR/hosts.yml (default ~/.config/gh)',
      writer: 'provider-binary',
      evidence: 'provider-documentation',
    },
    {
      effectId: 'github.linux.gh-store',
      provider: 'github',
      os: 'linux',
      store: 'file-or-os-keyring',
      location:
        'gh: Secret Service keyring when available, else $GH_CONFIG_DIR/hosts.yml (default ~/.config/gh)',
      writer: 'provider-binary',
      evidence: 'provider-documentation',
    },
    {
      effectId: 'github.win32.gh-store',
      provider: 'github',
      os: 'win32',
      store: 'file-or-os-keyring',
      location:
        'gh: Windows Credential Manager when available, else %GH_CONFIG_DIR%\\hosts.yml (default %AppData%\\GitHub CLI)',
      writer: 'provider-binary',
      evidence: 'provider-documentation',
    },
    {
      effectId: 'antigravity.darwin.native-store',
      provider: 'antigravity',
      os: 'darwin',
      store: 'file-or-os-keyring',
      location:
        'Antigravity native credential store; runtime profile under the app data root/antigravity',
      writer: 'provider-binary',
      evidence: 'provider-documentation',
    },
    {
      effectId: 'antigravity.linux.native-store',
      provider: 'antigravity',
      os: 'linux',
      store: 'file-or-os-keyring',
      location:
        'Antigravity native credential store; runtime profile under the app data root/antigravity',
      writer: 'provider-binary',
      evidence: 'provider-documentation',
    },
    {
      effectId: 'antigravity.win32.native-store',
      provider: 'antigravity',
      os: 'win32',
      store: 'file-or-os-keyring',
      location:
        'Antigravity native credential store; runtime profile under the app data root/antigravity',
      writer: 'provider-binary',
      evidence: 'provider-documentation',
    },
    {
      effectId: 'opencode.darwin.auth-file',
      provider: 'opencode',
      os: 'darwin',
      store: 'file',
      location:
        '$XDG_DATA_HOME/opencode/auth.json, default ~/.local/share/opencode/auth.json',
      writer: 'provider-binary',
      evidence: 'source',
    },
    {
      effectId: 'opencode.linux.auth-file',
      provider: 'opencode',
      os: 'linux',
      store: 'file',
      location:
        '$XDG_DATA_HOME/opencode/auth.json, default ~/.local/share/opencode/auth.json',
      writer: 'provider-binary',
      evidence: 'source',
    },
    {
      effectId: 'opencode.win32.auth-file',
      provider: 'opencode',
      os: 'win32',
      store: 'file',
      location:
        '%XDG_DATA_HOME%\\opencode\\auth.json, default %USERPROFILE%\\.local\\share\\opencode\\auth.json',
      writer: 'provider-binary',
      evidence: 'source',
    },
    {
      effectId: 'opencode.darwin.database',
      provider: 'opencode',
      os: 'darwin',
      store: 'database',
      location:
        '$XDG_DATA_HOME/opencode/opencode.db, default ~/.local/share/opencode/opencode.db',
      writer: 'provider-binary',
      evidence: 'source',
    },
    {
      effectId: 'opencode.linux.database',
      provider: 'opencode',
      os: 'linux',
      store: 'database',
      location:
        '$XDG_DATA_HOME/opencode/opencode.db, default ~/.local/share/opencode/opencode.db',
      writer: 'provider-binary',
      evidence: 'source',
    },
    {
      effectId: 'opencode.win32.database',
      provider: 'opencode',
      os: 'win32',
      store: 'database',
      location:
        '%XDG_DATA_HOME%\\opencode\\opencode.db, default %USERPROFILE%\\.local\\share\\opencode\\opencode.db',
      writer: 'provider-binary',
      evidence: 'source',
    },
  ]);

/** The declared effects of one provider's sign-in on one OS, in table order. */
export function providerCredentialEffects(
  provider: WorkerAgentSignInProvider,
  os: SignInOperatingSystem,
): ProviderCredentialEffectId[] {
  return PROVIDER_SIGN_IN_CREDENTIAL_EFFECTS.filter(
    (effect) => effect.provider === provider && effect.os === os,
  ).map((effect) => effect.effectId);
}

export const WORKER_AGENT_SIGN_IN_ERROR_CODES = [
  'worker.agent.signInLaunchUnavailable',
  'worker.agent.idempotencyKeyReused',
] as const;
export const WORKER_AGENT_SIGN_IN_FAILED_CODE = 'worker.agent.signInFailed';
export const WORKER_AGENT_SIGN_IN_FAILED_MESSAGE =
  'The provider sign-in did not finish.';

const id = z.string().min(1).max(512);

export const WorkerAgentSignInRunParamsSchema = z
  .strictObject({
    signInRunId: id,
    provider: z.enum(WORKER_AGENT_SIGN_IN_PROVIDERS),
    method: z.enum(WORKER_AGENT_SIGN_IN_METHODS),
  })
  .refine(
    (params) =>
      params.provider === 'codex'
        ? params.method !== 'terminal'
        : params.method === 'terminal',
    { message: 'The sign-in method does not match the provider.' },
  );
export type WorkerAgentSignInRunParams = z.output<
  typeof WorkerAgentSignInRunParamsSchema
>;

const effects = z
  .array(z.enum(PROVIDER_CREDENTIAL_EFFECT_IDS))
  .max(PROVIDER_CREDENTIAL_EFFECT_IDS.length);
const base = {
  signInRunId: id,
  provider: z.enum(WORKER_AGENT_SIGN_IN_PROVIDERS),
  credentialEffects: effects,
  exitCode: z.number().int().nullable(),
  signal: z.string().max(64).nullable(),
};
export const WorkerAgentSignInRunResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...base, status: z.literal('succeeded') }),
  z.strictObject({
    ...base,
    status: z.literal('failed'),
    error: z.strictObject({
      code: z.literal(WORKER_AGENT_SIGN_IN_FAILED_CODE),
      message: z.literal(WORKER_AGENT_SIGN_IN_FAILED_MESSAGE),
    }),
  }),
  z.strictObject({ ...base, status: z.literal('cancelled') }),
]);
export type WorkerAgentSignInRunResult = z.output<
  typeof WorkerAgentSignInRunResultSchema
>;

export const WorkerAgentSignInRunErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_AGENT_SIGN_IN_ERROR_CODES).optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.agent.signIn.run': defineCanopyInstruction({
      plane: 'worker',
      domain: 'agent',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: [WORKER_AGENT_GRANTS.auth],
      params: WorkerAgentSignInRunParamsSchema,
      result: WorkerAgentSignInRunResultSchema,
      error: WorkerAgentSignInRunErrorSchema,
    }),
  });
