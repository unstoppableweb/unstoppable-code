import {
  CanopyClientError,
  decodeCanopyClientResponseError,
  toCanopyClientError,
} from '../errors';
import {
  acceptCanopyInitializeResult,
  buildCanopyInitializeParams,
  toCanopyInitializeError,
} from '../handshake';
import { canonicalInitializeResult } from './fixtures/canonical-core';

const accept = { protocolVersions: [1], connectionId: 'conn-1' } as const;

function canonicalResult(
  overrides: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = canonicalInitializeResult();
  return {
    ...base,
    runtime: { ...base.runtime, ...runtime },
    capabilities: {
      operations: ['core.runtime.initialize', 'core.runtime.health.get'],
      events: [],
      streams: ['core.events.subscribe'],
    },
    ...overrides,
  };
}

function failure(run: () => unknown): CanopyClientError {
  try {
    run();
  } catch (error) {
    if (error instanceof CanopyClientError) return error;
  }
  throw new Error('expected a CanopyClientError');
}

describe('initialize handshake', () => {
  it('builds canonical params and rejects an empty version offer', () => {
    expect(
      buildCanopyInitializeParams({
        clientName: 'web',
        clientVersion: '9',
        protocolVersions: [1],
        clientCapabilities: ['streams'],
      }),
    ).toEqual({
      client: {
        name: 'web',
        version: '9',
        protocolVersions: [1],
        capabilities: ['streams'],
      },
    });
    expect(
      failure(() =>
        buildCanopyInitializeParams({
          clientName: 'web',
          clientVersion: '9',
          protocolVersions: [],
          clientCapabilities: [],
        }),
      ).payload.kind,
    ).toBe('invalid_argument');
  });

  it('keeps authority, runtime, host, and epoch identities independent', () => {
    const { identity, runtime } = acceptCanopyInitializeResult(
      canonicalResult({}, { authorityId: null, hostId: 'h', runtimeId: 'r' }),
      accept,
    );
    expect(identity).toEqual({
      connectionId: 'conn-1',
      authorityId: null,
      runtimeId: 'r',
      hostId: 'h',
      daemonEpoch: 'epoch-1',
      profile: 'core+worker',
      buildVersion: '0.0.0-canonical',
      protocolVersion: 1,
    });
    expect(runtime.runtimeId).toBe('r');
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it('gates on a private manifest snapshot that public sets cannot widen', () => {
    const { manifest } = acceptCanopyInitializeResult(
      canonicalResult(),
      accept,
    );
    expect(manifest.has('operations', 'core.runtime.health.get')).toBe(true);
    expect(manifest.has('operations', 'core.chat.send')).toBe(false);
    expect(manifest.has('streams', 'core.events.subscribe')).toBe(true);
    expect(manifest.has('events', 'core.events.subscribe')).toBe(false);
    if (manifest.operations instanceof Set)
      manifest.operations.add('core.chat.send');
    expect(manifest.operations.has('core.chat.send')).toBe(true);
    expect(manifest.has('operations', 'core.chat.send')).toBe(false);
    const probe: { has(kind: string, name: string): boolean } = manifest;
    expect(probe.has('constructor', 'x')).toBe(false);
  });

  it('accepts additive fields, extra advertised versions, and reduced capabilities', () => {
    const { identity, manifest } = acceptCanopyInitializeResult(
      canonicalResult(
        {
          futureField: { a: 1 },
          capabilities: { operations: [], events: [], streams: [] },
        },
        { protocolVersions: [1, 2], futureRuntimeField: 'x' },
      ),
      { protocolVersions: [1, 2], connectionId: 'c' },
    );
    expect(identity.protocolVersion).toBe(1);
    expect(manifest.has('operations', 'core.runtime.initialize')).toBe(false);
  });

  it('rejects results missing buildVersion or capabilities', () => {
    const bindingOnly = {
      selectedProtocolVersion: 1,
      runtime: { runtimeId: 'r' },
    };
    expect(
      failure(() => acceptCanopyInitializeResult(bindingOnly, accept)).payload
        .kind,
    ).toBe('internal');
    const withoutCapabilities = Object.fromEntries(
      Object.entries(canonicalResult()).filter(
        ([key]) => key !== 'capabilities',
      ),
    );
    expect(() =>
      acceptCanopyInitializeResult(withoutCapabilities, accept),
    ).toThrow(CanopyClientError);
    expect(() =>
      acceptCanopyInitializeResult(
        canonicalResult({}, { buildVersion: undefined }),
        accept,
      ),
    ).toThrow(CanopyClientError);
    expect(() => acceptCanopyInitializeResult('nope', accept)).toThrow(
      CanopyClientError,
    );
  });

  it('fails an unoffered or unadvertised version with a restart/update hint', () => {
    for (const result of [
      canonicalResult(
        { selectedProtocolVersion: 2 },
        { protocolVersions: [2] },
      ),
      canonicalResult({}, { protocolVersions: [3] }),
    ]) {
      const { payload } = failure(() =>
        acceptCanopyInitializeResult(result, accept),
      );
      expect(payload.kind).toBe('failed_precondition');
      expect(payload.code).toBe('core.runtime.invalidState');
      expect(payload.retry).toEqual({ kind: 'never' });
      expect(payload.message).toMatch(
        /restart the daemon or update this client/i,
      );
    }
  });

  it('adds the hint to a daemon mismatch and preserves other taxonomy', () => {
    const daemon = new CanopyClientError({
      kind: 'failed_precondition',
      message: 'Protocol version mismatch: no common version.',
      code: 'core.runtime.invalidState',
      retry: { kind: 'never' },
    });
    const hinted = toCanopyInitializeError(daemon, [1]);
    expect(hinted.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.runtime.invalidState',
    });
    expect(hinted.message).toMatch(/client offers 1.*restart the daemon/i);
    expect(toCanopyInitializeError(hinted, [1])).toBe(hinted);
    const auth = new CanopyClientError({
      kind: 'unauthenticated',
      message: 'Bad token.',
      retry: { kind: 'never' },
    });
    expect(toCanopyInitializeError(auth, [1])).toBe(auth);
  });

  it('keeps the offered versions negotiable while bounding their diagnostics', () => {
    const many = Array.from({ length: 2_000 }, (_, index) => index + 1);
    const accepted = acceptCanopyInitializeResult(canonicalResult(), {
      protocolVersions: many,
      connectionId: 'c',
    });
    expect(accepted.identity.protocolVersion).toBe(1);
    const { payload } = failure(() =>
      acceptCanopyInitializeResult(
        canonicalResult({ selectedProtocolVersion: 3_000 }),
        { protocolVersions: many, connectionId: 'c' },
      ),
    );
    expect(payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.runtime.invalidState',
      retry: { kind: 'never' },
    });
    expect(payload.message.length).toBeLessThanOrEqual(4_096);
    expect(payload.message).toMatch(/client offers 1, 2.*more/);
    expect(payload.message).toMatch(
      /restart the daemon or update this client/i,
    );
  });

  it('bounds the daemon-advertised versions when the selection is missing', () => {
    const advertised = Array.from({ length: 2_000 }, (_, index) => index + 10);
    const { payload } = failure(() =>
      acceptCanopyInitializeResult(
        canonicalResult({}, { protocolVersions: advertised }),
        accept,
      ),
    );
    expect(payload.kind).toBe('failed_precondition');
    expect(payload.message.length).toBeLessThanOrEqual(4_096);
    expect(payload.message).toMatch(/advertised 10, 11.*more/);
    expect(payload.message).toMatch(
      /restart the daemon or update this client/i,
    );
  });

  it('keeps the guidance when the daemon message fills the payload limit', () => {
    const full = new CanopyClientError({
      kind: 'failed_precondition',
      message: `Protocol version mismatch: ${'x'.repeat(4_096)}`.slice(
        0,
        4_096,
      ),
      code: 'core.runtime.invalidState',
      retry: { kind: 'never' },
    });
    const huge = Array.from({ length: 2_000 }, (_, index) => index + 1);
    for (const offers of [[1], huge]) {
      const hinted = toCanopyInitializeError(full, offers);
      expect(hinted.payload).toMatchObject({
        kind: 'failed_precondition',
        code: 'core.runtime.invalidState',
      });
      expect(hinted.message.length).toBeLessThanOrEqual(4_096);
      expect(hinted.message).toMatch(/^Protocol version mismatch: x/);
      expect(hinted.message).toMatch(/client offers 1.*restart the daemon/i);
    }
  });
});

describe('client errors', () => {
  it('decodes wire errors and fails malformed ones closed', () => {
    const payload = {
      kind: 'permission_denied',
      message: 'No.',
      retry: { kind: 'never' },
    } as const;
    const wire = { code: -32002, message: 'No.', data: payload };
    expect(decodeCanopyClientResponseError(wire).toJSON()).toEqual(payload);
    const mismatched = { ...wire, code: -32003 };
    expect(decodeCanopyClientResponseError(mismatched).payload.kind).toBe(
      'internal',
    );
    expect(decodeCanopyClientResponseError('boom').payload.kind).toBe(
      'internal',
    );
  });

  it('normalizes thrown values without admitting invalid payloads', () => {
    const typed = Object.assign(new Error('x'), {
      payload: { kind: 'not_found', message: 'gone', retry: { kind: 'never' } },
    });
    expect(toCanopyClientError(typed).payload.kind).toBe('not_found');
    const forged = Object.assign(new Error('forged'), {
      payload: { kind: 'bogus', message: 'x' },
    });
    expect(toCanopyClientError(forged).payload.kind).toBe('internal');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toCanopyClientError(abort).payload.kind).toBe('cancelled');
    expect(toCanopyClientError(undefined).message).toBe(
      'Canopy client failure.',
    );
    const longAbort = new Error('a'.repeat(5_000));
    longAbort.name = 'AbortError';
    const cancelled = toCanopyClientError(longAbort);
    expect(cancelled.payload.kind).toBe('cancelled');
    expect(cancelled.message).toHaveLength(4_096);
  });
});
