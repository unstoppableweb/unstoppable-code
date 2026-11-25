import {
  CoreClientToolsRegisterParamsSchema,
  CoreClientToolsUnregisterParamsSchema,
  interfaceToolDescriptor,
} from '@canopy/protocol/canopy-core';
import { InterfaceToolRegistry } from '@canopy/core-runtime/node/client/interface-tools';
import { CanopyOperationError } from '@canopy/core-runtime/runtime/errors';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  registerInterfaceTools,
  unregisterAllInterfaceTools,
} from '../interface-tools-client';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  reportClientAppError: jest.fn(),
}));

function stubRelay(invoke: jest.Mock): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { canopyCore: { invoke } },
  });
}

interface RelayRequest {
  method: string;
  params: {
    tools?: { name: string }[];
    toolNames?: string[];
    all?: boolean;
    _meta?: { idempotencyKey?: string };
  };
}

/**
 * Answers like the real InterfaceToolRegistry: a registration replaces the
 * lease's set and returns exactly the requested names, sorted; an unregister
 * returns the names it actually removed.
 */
function leaseBackend(): jest.Mock<Promise<unknown>, [RelayRequest]> {
  let revision = 0;
  const served = new Set<string>();
  return jest.fn((request: RelayRequest): Promise<unknown> => {
    if (request.method === 'core.client.tools.register') {
      served.clear();
      for (const tool of request.params.tools ?? []) served.add(tool.name);
      revision += 1;
      return Promise.resolve({
        ok: true,
        value: {
          registrationRevision: revision,
          effectiveToolNames: [...served].sort(),
        },
      });
    }
    const removed = [...served]
      .filter(
        (name) =>
          request.params.all === true ||
          (request.params.toolNames ?? []).includes(name),
      )
      .sort();
    for (const name of removed) served.delete(name);
    if (removed.length > 0) revision += 1;
    return Promise.resolve({
      ok: true,
      value: { registrationRevision: revision, removedToolNames: removed },
    });
  });
}

describe('interface tools client (CAN-4131)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.mocked(reportClientAppError).mockClear();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('registers catalog descriptors with the given key', async () => {
    const invoke = leaseBackend();
    stubRelay(invoke);
    await expect(
      registerInterfaceTools(
        ['ui.get_current_ui_state', 'ui.show_files'],
        'key-1',
      ),
    ).resolves.toEqual({
      status: 'acknowledged',
      registrationRevision: 1,
      effectiveToolNames: ['ui.get_current_ui_state', 'ui.show_files'],
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({
      kind: 'request',
      method: 'core.client.tools.register',
      params: {
        tools: [
          interfaceToolDescriptor('ui.get_current_ui_state'),
          interfaceToolDescriptor('ui.show_files'),
        ],
        _meta: { idempotencyKey: 'key-1' },
      },
    });
    invoke.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: 'invalid_argument',
        message: 'x',
        retry: { kind: 'never' },
      },
    });
    await expect(
      registerInterfaceTools(['ui.show_files'], 'key-2'),
    ).resolves.toEqual({ status: 'refused', kind: 'invalid_argument' });
    // Only the typed kind is reported, never the tools or the key.
    expect(reportClientAppError).toHaveBeenCalledTimes(1);
    expect(reportClientAppError).toHaveBeenCalledWith(
      new Error('Interface tool registration refused: invalid_argument'),
    );
  });

  it('unregisters all and reports failures without throwing', async () => {
    const invoke = jest.fn().mockResolvedValueOnce({
      ok: false,
      error: { kind: 'not_found', message: 'x', retry: { kind: 'never' } },
    });
    stubRelay(invoke);
    await expect(unregisterAllInterfaceTools()).resolves.toEqual({
      status: 'refused',
      kind: 'not_found',
    });
    expect(invoke).toHaveBeenCalledWith({
      kind: 'request',
      method: 'core.client.tools.unregister',
      params: { all: true },
    });
    invoke.mockRejectedValueOnce(new Error('relay closed'));
    await expect(unregisterAllInterfaceTools()).resolves.toEqual({
      status: 'unknown',
    });
    // A reply the page cannot read may still have applied.
    await expect(
      registerInterfaceTools(['ui.show_files'], 'key-3'),
    ).resolves.toEqual({ status: 'unknown' });
    // A refused removal is not reported; the thrown transport error is.
    expect(reportClientAppError).toHaveBeenCalledTimes(1);
  });

  it('records only acknowledged registrations and repeats an unknown one with the same key', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const refused = {
      ok: false,
      error: {
        kind: 'permission_denied',
        message: 'x',
        retry: { kind: 'never' },
      },
    };
    const acknowledged = {
      ok: true,
      value: { registrationRevision: 1, effectiveToolNames: ['ui.show_files'] },
    };
    // Reject malformed registrations just as the host does; missing retry
    // keys must not compare equal and receive an acknowledgement.
    const keys: string[] = [];
    let calls = 0;
    const invoke = jest.fn((request: { params: unknown }): Promise<unknown> => {
      const params = CoreClientToolsRegisterParamsSchema.parse(request.params);
      keys.push(params._meta.idempotencyKey);
      calls += 1;
      if (calls === 1) return Promise.resolve(refused);
      if (calls === 2) return Promise.reject(new Error('relay closed'));
      if (calls === 3)
        return Promise.resolve({
          ok: false,
          error: {
            kind: 'resource_exhausted',
            message: 'Too many concurrent relay calls.',
            retry: { kind: 'after_refresh', resource: 'relay' },
          },
        });
      return Promise.resolve(acknowledged);
    });
    stubRelay(invoke);
    let uuid = 0;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID: (): string => `uuid-${++uuid}` },
    });
    try {
      await jest.isolateModulesAsync(async () => {
        const { contributeInterfaceTools } =
          await import('../interface-tools-client');
        contributeInterfaceTools(['ui.show_files']);
        await jest.advanceTimersByTimeAsync(0);
        // A refusal is not recorded, and is not repeated on its own.
        await jest.advanceTimersByTimeAsync(60_000);
        expect(invoke).toHaveBeenCalledTimes(1);
        // The same set recovers on the next contribution.
        contributeInterfaceTools(['ui.show_files']);
        await jest.advanceTimersByTimeAsync(60_000);
        // The lost call repeats with its own key, even if admission refuses the retry.
        expect(invoke).toHaveBeenCalledTimes(3);
        expect(keys[2]).toBe(keys[1]);
        expect(keys[1]).not.toBe(keys[0]);
        contributeInterfaceTools(['ui.show_files']);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(invoke).toHaveBeenCalledTimes(4);
        expect(keys[3]).toBe(keys[1]);
        // Once acknowledged, the same desired set needs no more registration.
        contributeInterfaceTools(['ui.show_files']);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(invoke).toHaveBeenCalledTimes(4);
      });
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('two contributors share one lease registration', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const invoke = leaseBackend();
    stubRelay(invoke);
    let uuid = 0;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID: (): string => `uuid-${++uuid}` },
    });
    // Longer than every retry delay, so a call that would be retried shows.
    const settle = (): Promise<void> => jest.advanceTimersByTimeAsync(60_000);
    try {
      await jest.isolateModulesAsync(async () => {
        const { contributeInterfaceTools } =
          await import('../interface-tools-client');
        const withdrawAdvisor = contributeInterfaceTools([
          'ui.show_files',
          'ui.get_current_ui_state',
        ]);
        const withdrawEditor = contributeInterfaceTools([
          'ui.pipeline_editor.list',
        ]);
        await settle();
        const registrations = invoke.mock.calls
          .map(([request]) => request)
          .filter((request) => request.method === 'core.client.tools.register');
        // Same-turn root bridges register their complete union in one request.
        expect(registrations).toHaveLength(1);
        expect(
          registrations[0]?.params.tools?.map((tool) => tool.name),
        ).toEqual([
          'ui.get_current_ui_state',
          'ui.pipeline_editor.list',
          'ui.show_files',
        ]);
        // A different tool set is a new registration, so it never reuses a key.
        const keys = registrations.map(
          (request) => request.params._meta?.idempotencyKey,
        );
        expect(keys.every((key) => typeof key === 'string')).toBe(true);
        expect(new Set(keys).size).toBe(keys.length);
        invoke.mockClear();
        withdrawEditor();
        await settle();
        // An acknowledged selective removal is sent once and never retried.
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith({
          kind: 'request',
          method: 'core.client.tools.unregister',
          params: { toolNames: ['ui.pipeline_editor.list'] },
        });
        invoke.mockClear();
        withdrawAdvisor();
        withdrawAdvisor();
        await settle();
        // Likewise the removal of everything, sent once however often withdrawn.
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith({
          kind: 'request',
          method: 'core.client.tools.unregister',
          params: { all: true },
        });
      });
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('recovers surviving and remounted contributions through uncertain lease transitions', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const registry = new InterfaceToolRegistry();
    const leaseId = 'page';
    let holdRemoval = false;
    let loseRegistration = false;
    let refuseRemoval = false;
    const registrationKeys: string[] = [];
    const registrationRevisions: number[] = [];
    let finishRemoval: (value: unknown) => void = () => {
      throw new Error('No removal is pending');
    };
    const removalReply = new Promise<unknown>((resolve) => {
      finishRemoval = resolve;
    });
    const invoke = jest.fn((request: RelayRequest): Promise<unknown> => {
      try {
        if (request.method === 'core.client.tools.register') {
          // The desktop host opens a lease on registration, not on removal.
          if (!registry.hasLease(leaseId))
            registry.openLease(
              { leaseId, surface: 'main', interfaceKind: 'desktop' },
              { deliver: () => true, cancel: () => undefined },
            );
          const params = CoreClientToolsRegisterParamsSchema.parse(
            request.params,
          );
          registrationKeys.push(params._meta.idempotencyKey);
          const value = registry.register(leaseId, params);
          registrationRevisions.push(value.registrationRevision);
          if (loseRegistration)
            return Promise.reject(new Error('Applied registration reply lost'));
          return Promise.resolve({ ok: true, value });
        }
        if (refuseRemoval)
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'resource_exhausted',
              message: 'Too many concurrent relay calls.',
              retry: { kind: 'after_refresh', resource: 'relay' },
            },
          });
        const value = registry.unregister(
          leaseId,
          CoreClientToolsUnregisterParamsSchema.parse(request.params),
        );
        return holdRemoval
          ? removalReply
          : Promise.resolve({ ok: true, value });
      } catch (error) {
        if (error instanceof CanopyOperationError)
          return Promise.resolve({ ok: false, error: error.payload });
        throw error;
      }
    });
    invoke.mockRejectedValueOnce(
      new Error('request lost before lease creation'),
    );
    stubRelay(invoke);
    const originalCrypto = Object.getOwnPropertyDescriptor(
      globalThis,
      'crypto',
    );
    let uuid = 0;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID: (): string => `uuid-${++uuid}` },
    });
    try {
      await jest.isolateModulesAsync(async () => {
        const { contributeInterfaceTools } =
          await import('../interface-tools-client');
        const withdrawAdvisor = contributeInterfaceTools(['ui.show_files']);
        await jest.advanceTimersByTimeAsync(0);
        expect(registry.hasLease(leaseId)).toBe(false);
        const withdrawEditor = contributeInterfaceTools([
          'ui.pipeline_editor.list',
        ]);
        withdrawAdvisor();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(registry.available().toolNames).toEqual([
          'ui.pipeline_editor.list',
        ]);
        holdRemoval = true;
        withdrawEditor();
        await jest.advanceTimersByTimeAsync(0);
        expect(registry.available().toolNames).toEqual([]);
        const withdrawRemountedEditor = contributeInterfaceTools([
          'ui.pipeline_editor.list',
        ]);
        finishRemoval({
          ok: false,
          error: {
            kind: 'deadline_exceeded',
            message: 'The relay deadline passed.',
            retry: { kind: 'same_request' },
          },
        });
        await jest.advanceTimersByTimeAsync(60_000);
        expect(registry.available().toolNames).toEqual([
          'ui.pipeline_editor.list',
        ]);
        holdRemoval = false;
        withdrawRemountedEditor();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(registry.available().toolNames).toEqual([]);
        // A refused withdrawal cannot resolve an earlier applied-but-unanswered
        // registration. Remount recovers its receipt without spending a new key.
        loseRegistration = true;
        const withdrawUncertain = contributeInterfaceTools(['ui.show_files']);
        await jest.advanceTimersByTimeAsync(60_000);
        const uncertainKey = registrationKeys.at(-1);
        const uncertainRevision = registrationRevisions.at(-1);
        refuseRemoval = true;
        withdrawUncertain();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(registry.available().toolNames).toEqual(['ui.show_files']);
        loseRegistration = false;
        const withdrawRecovered = contributeInterfaceTools(['ui.show_files']);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(registrationKeys.at(-1)).toBe(uncertainKey);
        expect(registrationRevisions.at(-1)).toBe(uncertainRevision);
        expect(registry.available().toolNames).toEqual(['ui.show_files']);
        refuseRemoval = false;
        withdrawRecovered();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(registry.available().toolNames).toEqual([]);
      });
    } finally {
      registry.close();
      jest.clearAllTimers();
      jest.useRealTimers();
      if (originalCrypto)
        Object.defineProperty(globalThis, 'crypto', originalCrypto);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  });
});
