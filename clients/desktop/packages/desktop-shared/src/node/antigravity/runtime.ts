import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  connectAcp,
  type AcpClient,
  type AcpClientOptions,
} from '@canopy/desktop-shared/node/acp';
import type { ProviderProcessOwner } from '@canopy/desktop-shared/node/provider-process/spawn';
import {
  getEnhancedEnv,
  resolveInstalledBinaryPath,
} from '@canopy/desktop-shared/pipelines/config-paths';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import type { ProviderProcessSpawner } from '../provider-process/spawn';

import { ANTIGRAVITY_RUNTIME_VERSION } from './runtime-metadata';
export { ANTIGRAVITY_RUNTIME_VERSION } from './runtime-metadata';

export function antigravityProfileDirectory(): string {
  return join(getCanopyDataDir(), 'antigravity');
}

export function antigravityEnvironment(
  environment: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env = {
    ...getEnhancedEnv({
      environment: false,
      includeCanopySecrets: false,
    }),
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) =>
          ![
            'HOME',
            'USERPROFILE',
            'HOMEDRIVE',
            'HOMEPATH',
            'HOMESHARE',
            'ANTIGRAVITY_EXECUTABLE',
          ].includes(key.toUpperCase()),
      ),
    ),
  };
  for (const key of [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_GENAI_USE_VERTEXAI',
    // Neither the launching host nor workflow inputs may inject startup code
    // into the native process or its force_ask approval hook.
    'NODE_OPTIONS',
    'NODE_PATH',
    'BASH_ENV',
    'ENV',
    'SHELLOPTS',
    'BASHOPTS',
    'GCONV_PATH',
    'GLIBC_TUNABLES',
  ])
    delete env[key];
  for (const key of Object.keys(env)) {
    if (/^(LD_|DYLD_|BASH_FUNC_)/.test(key)) delete env[key];
  }
  // Native child launches must not inherit Electron application mode.
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

export async function resolveAntigravityExecutable(): Promise<string> {
  if (hostPlatformOperatingSystem() !== 'darwin')
    throw new Error(
      'Google subscription chats are currently available on macOS.',
    );
  const env = antigravityEnvironment();
  const override = env.ANTIGRAVITY_EXECUTABLE?.trim();
  const executable = await resolveInstalledBinaryPath(
    ['agy', 'antigravity'],
    env,
    override,
  );
  if (executable) return executable;
  if (override)
    throw new Error(
      'The selected Antigravity executable is unavailable. Choose an installed Antigravity CLI.',
    );
  throw new Error('Install Antigravity CLI 1.5.1, then refresh Google models.');
}

async function replacePrivateFile(
  file: string,
  contents: string,
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

/** Google retains custody of credentials and native conversations in its own runtime. */
export async function prepareAntigravityProfile(
  profile = antigravityProfileDirectory(),
): Promise<string> {
  const config = join(profile, 'config');
  await mkdir(config, { recursive: true, mode: 0o700 });
  const script = join(profile, 'approval-hook.sh');
  await replacePrivateFile(
    script,
    `#!/bin/sh\n/bin/cat >/dev/null\n/usr/bin/printf '%s\\n' '{"decision":"force_ask"}'\n`,
  );
  const quote = (value: string): string => {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  };
  await replacePrivateFile(
    join(config, 'hooks.json'),
    JSON.stringify({
      'canopy-approval': {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [
              {
                type: 'command',
                command: `/bin/sh ${quote(script)}`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    }),
  );
  // Native configuration must not import unselected MCP servers into the chat.
  await replacePrivateFile(
    join(config, 'mcp_config.json'),
    JSON.stringify({ mcpServers: {} }),
  );
  return profile;
}

export function antigravityArguments(profile: string): string[] {
  return [
    'acp',
    '--gemini-dir',
    profile,
    '--disable-telemetry',
    '--include-default-customizations=false',
    '--process-per-session',
  ];
}

export interface AntigravityRuntime {
  client: AcpClient;
  close(): Promise<void>;
}

export async function openAntigravityRuntime(input: {
  cwd: string;
  profile?: string;
  spawnProcess: ProviderProcessSpawner;
  assertEnabled: () => void | Promise<void>;
  signal?: AbortSignal;
  environment?: Record<string, string>;
  owner: ProviderProcessOwner;
  onUpdate: AcpClientOptions['onUpdate'];
  onPermission?: AcpClientOptions['onPermission'];
  requestTimeoutMs?: number;
}): Promise<AntigravityRuntime> {
  input.signal?.throwIfAborted();
  await input.assertEnabled();
  const executable = await resolveAntigravityExecutable();
  const profile = await prepareAntigravityProfile(input.profile);
  input.signal?.throwIfAborted();
  await input.assertEnabled();
  const child = input.spawnProcess({
    command: executable,
    args: antigravityArguments(profile),
    cwd: input.cwd,
    env: antigravityEnvironment(input.environment),
    owner: input.owner,
  });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopping ??= child.stop());
  const abort = (): void => {
    void stop().catch(() => undefined);
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  child.once('error', () => {
    child.stdout.destroy();
    child.stdin?.destroy();
  });
  child.stderr.resume();
  if (!child.stdin) {
    input.signal?.removeEventListener('abort', abort);
    await stop();
    throw new Error('Google could not start.');
  }
  try {
    const client = await connectAcp({
      transport: {
        input: Readable.toWeb(child.stdout),
        output: Writable.toWeb(child.stdin),
        close: () => {
          void stop().catch(() => undefined);
        },
      },
      clientInfo: { name: 'canopy', version: '1.0.0' },
      resourceGeneration: 1,
      onUpdate: input.onUpdate,
      onPermission: input.onPermission,
      timeouts: {
        promptMs: null,
        permissionMs: 300_000,
        requestMs: input.requestTimeoutMs ?? 30_000,
      },
    });
    if (
      client.getInitialization().agentInfo?.version !==
      ANTIGRAVITY_RUNTIME_VERSION
    ) {
      client.close();
      throw new Error(
        'This version of Antigravity has not been verified. Use Antigravity CLI 1.5.1.',
      );
    }
    return {
      client,
      close: async (): Promise<void> => {
        input.signal?.removeEventListener('abort', abort);
        client.close();
        await stop();
      },
    };
  } catch (error) {
    input.signal?.removeEventListener('abort', abort);
    await stop();
    throw error;
  }
}
