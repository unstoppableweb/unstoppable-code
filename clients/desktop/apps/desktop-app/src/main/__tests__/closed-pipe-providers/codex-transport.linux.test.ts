jest.mock('node:child_process', (): typeof childProcess => ({
  ...jest.requireActual<typeof childProcess>('node:child_process'),
  spawn: jest.fn(),
}));

import * as childProcess from 'node:child_process';
import {
  CodexAppServerConnection,
  type CodexAppServerConnectionOwner,
} from '@canopy/execution-engine/node/codex-runtime/connection';
import { bounded, errorDetails, nativePipeChild } from './native-pipe-fixture';

jest.mock('@canopy/execution-engine/pipelines/config-paths', () => ({
  getBundledCodexBinaryPath: (): string => 'fixture-codex',
  getEnhancedEnv: (): NodeJS.ProcessEnv => ({}),
}));

// POSIX parity runs are useful, but only Ubuntu output qualifies Linux.
const nativeTest = process.platform === 'win32' ? test.skip : test;

nativeTest.each(['before', 'during'] as const)(
  'Codex native pipe closes %s a mutating request without replay',
  async (phase) => {
    const old = nativePipeChild('codex', phase);
    const replacement = nativePipeChild('codex', 'replacement');
    const connection = new CodexAppServerConnection('native-pipe', {}, [], {
      environmentPolicy: 'restricted',
    });
    const markProcessFailed = jest.fn();
    const owner: CodexAppServerConnectionOwner = {
      hasActiveTurn: () => false,
      getActiveTurnInterruptTarget: () => null,
      cancelPendingTurnStart: jest.fn(),
      rejectActiveTurn: jest.fn(),
      markProcessSuspended: jest.fn(),
      markProcessFailed,
      handleConnectionNotification: jest.fn(),
      handleRequestUserInput: jest.fn().mockResolvedValue(undefined),
      handleDynamicToolCall: jest.fn().mockResolvedValue(undefined),
      handleApprovalRequest: jest.fn().mockResolvedValue(undefined),
      handleMcpElicitation: jest.fn().mockResolvedValue(undefined),
    };
    const onProcessError = jest.fn();
    connection.registerOwner(owner, { onProcessError });
    const spawn = jest.mocked(childProcess.spawn);
    spawn.mockImplementation(() => {
      throw new Error('Unexpected automatic worker spawn');
    });
    spawn.mockReturnValueOnce(old.child);
    const settle = (
      promise: Promise<unknown>,
      name: string,
    ): Promise<unknown> =>
      promise.catch((error: unknown) => {
        old.record('rejection', { request: name, ...errorDetails(error) });
        return error;
      });
    try {
      await old.waitFor('child:ready');
      await bounded(connection.ensureInitialized());
      expect(old.child.stdin.listenerCount('error')).toBe(1);
      const staleError = old.child.stdin.listeners('error').at(-1);
      const staleExit = old.child.listeners('exit').at(-1);
      const nativeError = old.waitFor('stdin-error');
      const held = settle(
        connection.request('account/read', { refreshToken: false }, { owner }),
        'account/read',
      );
      await old.waitFor('child:pending-held');
      expect(connection.canEvictOwner(owner)).toBe(false);
      old.send(phase === 'before' ? 'close-before' : 'close-during');
      await old.waitFor(
        phase === 'before' ? 'child:input-closed' : 'child:armed',
      );
      const text = 'x'.repeat(8 * 1024 * 1024);
      const mutation = settle(
        connection.request(
          'turn/start',
          {
            threadId: 'fixture-thread',
            input: [{ type: 'text', text, text_elements: [] }],
          },
          { owner },
        ),
        'turn/start',
      );
      const [heldFailure, mutationFailure, pipeObservation] = await bounded(
        Promise.all([held, mutation, nativeError]),
      );
      expect(heldFailure).toBeInstanceOf(Error);
      expect(mutationFailure).toBeInstanceOf(Error);
      expect(typeof pipeObservation.code).toBe('string');
      const pipeError = old.nativeError;
      expect(onProcessError).toHaveBeenCalledTimes(1);
      expect(markProcessFailed).toHaveBeenCalledTimes(1);
      expect(connection.canEvictOwner(owner)).toBe(true);
      expect(connection.livePid()).toBeUndefined();
      expect(spawn).toHaveBeenCalledTimes(1);
      const closure = await old.waitFor('child:input-closed');
      if (phase === 'before') {
        expect(closure.bytesRead).toBe(0);
        expect(
          old.events.findIndex((event) => event.event === 'child:input-closed'),
        ).toBeLessThan(
          old.events.findIndex(
            (event) =>
              event.event === 'write-start' &&
              Number(event.bytes) > text.length,
          ),
        );
      } else {
        expect(Number(closure.bytesRead)).toBeGreaterThan(0);
        expect(Number(closure.bytesRead)).toBeLessThan(text.length);
      }
      await old.waitFor('child:sigterm');
      // The next operation is explicit. Production must wait for real native
      // termination before spawning it, not replay the failed turn/start.
      spawn.mockReturnValueOnce(replacement.child);
      const ready = connection.ensureInitialized();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(spawn).toHaveBeenCalledTimes(1);
      old.record('explicit-replacement-requested');
      old.send('release');
      await bounded(ready);
      await bounded(old.closed);
      replacement.record('replacement-ready-after-native-exit');
      expect(old.events.some((event) => event.event === 'exit')).toBe(true);
      expect(connection.livePid()).toBe(replacement.child.pid);
      expect(connection.isInitialized()).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(2);
      // Supplemental delivery of captured production callbacks with the REAL
      // native error/exit values. This is not another native error or exit.
      replacement.record('supplemental:retired-callback-delivery');
      if (!staleError || !staleExit)
        throw new Error('Missing production lifecycle listeners');
      Reflect.apply(staleError, old.child.stdin, [pipeError]);
      Reflect.apply(staleExit, old.child, [
        old.child.exitCode,
        old.child.signalCode,
      ]);
      expect(onProcessError).toHaveBeenCalledTimes(1);
      expect(markProcessFailed).toHaveBeenCalledTimes(1);
      expect(connection.livePid()).toBe(replacement.child.pid);
      await expect(
        bounded(
          connection.request(
            'account/read',
            { refreshToken: false },
            { owner },
          ),
        ),
      ).resolves.toEqual({ fixture: true });
      replacement.send('fence');
      await replacement.waitFor('child:fence');
      expect(
        replacement.events
          .filter((event) => event.event === 'child:frame')
          .map((event) => event.method),
      ).toEqual(['initialize', 'initialized', 'account/read']);
      expect(connection.canEvictOwner(owner)).toBe(true);
      replacement.send('release');
      replacement.child.stdin.end();
      await bounded(replacement.closed);
      await bounded(connection.terminateForFinalRelease());
      expect(connection.livePid()).toBeUndefined();
    } finally {
      await Promise.all([old.cleanup(), replacement.cleanup()]);
      await bounded(connection.terminateForFinalRelease());
      spawn.mockReset();
      old.evidence();
      replacement.evidence();
    }
  },
  15_000,
);
