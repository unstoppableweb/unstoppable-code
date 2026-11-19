jest.mock('child_process', (): typeof childProcess => ({
  ...jest.requireActual<typeof childProcess>('child_process'),
  spawn: jest.fn(),
}));

import { randomUUID } from 'node:crypto';
import * as childProcess from 'child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { McpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import { getMcpServerFilePath } from '../../lib/paths';
import { bounded, nativePipeChild } from './native-pipe-fixture';

jest.mock('../../canopy-cloud/mcp-connections', () => ({}));
jest.mock('../../mcp/account-catalog', () => ({
  accountMcpConnectionsEnabled: (): boolean => false,
  normalizeAccountMcpSelections: (selections: unknown): Promise<unknown> =>
    Promise.resolve(selections),
}));
jest.mock('../../mcp/account-routing', () => ({
  readMcpAccountIndexEntry: (): Promise<undefined> =>
    Promise.resolve(undefined),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: jest.fn(),
}));
jest.mock('../../mcp/server-ref-rewrite', () => ({}));
jest.mock('../../mcp/server-secret-view', () => ({}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn().mockResolvedValue({
    mcpHttpAuthDefaultHandler: 'canopy',
    mcpProxyPort: 4321,
  }),
}));
jest.mock('../../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    setWindowAccessor: jest.fn(),
    setBroadcastHandlers: jest.fn(),
    refreshPreferredPortStatus: jest.fn(),
    ensureStarted: (): never => {
      throw new Error('No-auth Connect must not start the proxy');
    },
  })),
}));
jest.mock('../../lib/auth-failure-resume', () => ({}));
jest.mock('../../mcp/oauth-client', () => ({
  setMcpOAuthSettledListener: jest.fn(),
  startMcpOAuthFlow: (): never => {
    throw new Error('No-auth Connect must not open a browser');
  },
}));
jest.mock('../../mcp/oauth-token-store', () => ({
  setMcpOAuthTokensChangedListener: jest.fn(),
  getMcpOAuthAuthStatusForDefinition: jest.fn().mockResolvedValue({
    status: 'not_connected',
    hasStoredToken: false,
  }),
}));
jest.mock('../../lib/main-process-logging', () => ({}));
jest.mock('../../lib/window-send', () => ({}));
jest.mock('../../plugins/plugin-service', () => ({}));
jest.mock('../../plugins/plugin-resolver', () => ({}));
jest.mock('../../lib/open-external', () => ({}));
jest.mock('../../mcp/provider-connectors', () => ({}));
jest.mock('../../services/desktop-inventory-sync-signals', () => ({}));
jest.mock('../../mcp/curated-catalog', () => ({}));
jest.mock('../../mcp/curated-plugin-binding', () => ({}));
jest.mock('../../mcp/remote-image-cache', () => ({}));
jest.mock('../../mcp/tool-discovery', () => ({}));
jest.mock('../../mcp/connection-status', () => ({
  getMcpServerHealthGeneration: (): number => 0,
  recordMcpServerHealth: (): boolean => false,
}));
jest.mock('../../agents/session-manager', () => ({
  refreshCodexSessionsAfterMcpOAuth: (): never => {
    throw new Error('No-auth Connect must not refresh agent sessions');
  },
}));
jest.mock('../../mcp/server-ref-rewrite-outcome', () => ({}));
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

import { testMcpServerConnection } from '../../ipc/mcp-servers';

// Portable POSIX parity; only Ubuntu observations qualify Linux.
const nativeTest = process.platform === 'win32' ? test.skip : test;

nativeTest.each(['before', 'during'] as const)(
  'MCP native pipe closes %s initialize and the health probe fails',
  async (phase) => {
    const fixture = nativePipeChild('mcp', phase);
    const serverId = randomUUID().replaceAll('-', '').slice(0, 12);
    const filename = getMcpServerFilePath(serverId);
    const timestamp = '2026-01-01T00:00:00.000Z';
    const file: McpServerFile = {
      version: 1,
      server: {
        definition: {
          id: serverId,
          name: 'Native pipe fixture',
          description: '',
          type: 'command',
          command: 'node',
          args: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        configs: [],
      },
    };
    const spawn = jest.mocked(childProcess.spawn);
    spawn.mockImplementation(() => {
      throw new Error('Unexpected MCP command replay');
    });
    spawn.mockReturnValueOnce(fixture.child);
    try {
      await fixture.waitFor(
        phase === 'before' ? 'child:input-closed' : 'child:ready',
      );
      await mkdir(dirname(filename), { recursive: true });
      await writeFile(filename, JSON.stringify(file));
      // Persisted configuration and the production test-connection use case,
      // encoder, Writable and failure containment all run unchanged.
      const result = await bounded(testMcpServerConnection(serverId));
      fixture.record('result', {
        success: result.success,
        message: result.message,
        error: result.error ?? null,
      });
      expect(result.success).toBe(false);
      expect(result.message).not.toBe('Connection timed out');
      expect(spawn).toHaveBeenCalledTimes(1);
      const writes = fixture.events.filter(
        (event) => event.event === 'write-start',
      );
      expect(writes).toHaveLength(1);
      // The observer must not hide a missing production error owner: record
      // the count at the native write boundary, before any callback fires.
      expect(writes[0]?.errorListeners).toBe(1);
      const closure = await fixture.waitFor('child:input-closed');
      expect(closure.bytesRead).toBe(phase === 'before' ? 0 : 1);
      if (phase === 'before') {
        expect(
          fixture.events.findIndex(
            (event) => event.event === 'child:input-closed',
          ),
        ).toBeLessThan(
          fixture.events.findIndex((event) => event.event === 'write-start'),
        );
      } else {
        expect(
          fixture.events.findIndex((event) => event.event === 'write-start'),
        ).toBeLessThan(
          fixture.events.findIndex(
            (event) => event.event === 'child:input-closed',
          ),
        );
        expect(
          fixture.events.findIndex(
            (event) => event.event === 'child:input-closed',
          ),
        ).toBeLessThan(
          fixture.events.findIndex(
            (event) => event.event === 'split-remainder-start',
          ),
        );
      }
      expect(result.message).toBe('MCP server input pipe failed');
      const pipeFailure = await fixture.waitFor('stdin-error');
      expect(typeof pipeFailure.code).toBe('string');
      await fixture.waitFor('child:sigterm');
      fixture.send('release');
      await bounded(fixture.closed);
      expect(
        fixture.events.some((event) => event.event === 'write-callback'),
      ).toBe(true);
      expect(fixture.child.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
      spawn.mockReset();
      fixture.evidence();
      await rm(filename, { force: true });
    }
  },
  15_000,
);
