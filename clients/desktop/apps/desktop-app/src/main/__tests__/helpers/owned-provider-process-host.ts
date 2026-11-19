import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { createExecutionProcessServices } from '@canopy/core-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { createOwnedProcessHostPort } from '@canopy/desktop-shared/node/execution-host/owned-process-host';
import type {
  ExecutionHostPort,
  ExecutionHostProcess,
} from '@canopy/desktop-shared/node/execution-host/port';
import { PROVIDER_PROCESS_HOST_ENTRY } from '@canopy/execution-engine/node/agent-host/process/provider-process-host/protocol';
import {
  createProviderProcessHostClient,
  type ProviderProcessHostClient,
} from '@canopy/execution-engine/node/agent-host/process/provider-process-host/runner';

// The production provider process host, bundled as the desktop bundles it and
// launched over the owned-process port (the daemon's) under plain Node. No
// Jest globals: the node:test Cursor scenarios reuse it.

const ROOT = path.resolve(__dirname, '../../../../../..');

export interface OwnedProviderProcessHost {
  readonly client: ProviderProcessHostClient;
  hostPid(): number | undefined;
  killHost(): void;
  dispose(): Promise<void>;
}

function testOperatingSystem(): PlatformOperatingSystem {
  const platform: string = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32')
    return platform;
  throw new Error(`unsupported test host ${platform}`);
}

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
}

export function startOwnedProviderProcessHost(): OwnedProviderProcessHost {
  const dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'provider-host-')),
  );
  buildSync({
    entryPoints: [
      path.join(
        ROOT,
        'apps/desktop-app/src/main/agent-runs/provider-process-host/entry.ts',
      ),
    ],
    outfile: path.join(dir, PROVIDER_PROCESS_HOST_ENTRY),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: path.join(ROOT, 'tsconfig.base.json'),
    external: ['electron', 'node:*'],
    define: { __CANOPY_E2E__: 'false' },
    logLevel: 'silent',
  });
  const services = createExecutionProcessServices({
    os: testOperatingSystem(),
  });
  const owned = createOwnedProcessHostPort({
    services,
    nodeExecutable: process.execPath,
    entryDirectory: dir,
    cwd: dir,
    environment: () => process.env,
  });
  const hosts: ExecutionHostProcess[] = [];
  const strays = new Set<number>();
  const port: ExecutionHostPort = {
    launch(request) {
      const host = owned.launch(request);
      hosts.push(host);
      host.once('spawn', () => {
        if (host.pid !== undefined) strays.add(host.pid);
      });
      return host;
    },
    probe: (request) => owned.probe(request),
  };
  const client = createProviderProcessHostClient(() => port);
  return {
    client,
    hostPid: () => client.currentHostForTests()?.pid,
    killHost: (): void => {
      client.currentHostForTests()?.kill();
    },
    dispose: async (): Promise<void> => {
      await client.shutdown();
      await services.shutdown();
      for (const pid of strays) if (present(pid)) process.kill(pid, 'SIGKILL');
      strays.clear();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
