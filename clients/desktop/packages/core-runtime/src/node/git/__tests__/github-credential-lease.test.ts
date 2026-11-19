import {
  createGitHubCredentialLeasePort,
  type GitHubCredentialAdmission,
  type GitHubCredentialLease,
  type GitHubCredentialLeaseRequest,
  type GitHubCredentialResolution,
  type GitHubCredentialUse,
} from '../github-credential-lease';

const request: GitHubCredentialLeaseRequest = {
  purpose: 'git-push',
  audience: { operation: 'worker.git.push', key: 'dispatch-one' },
  expiresAt: 1100,
};
let now: number;
let material: Uint8Array;
let admission: GitHubCredentialAdmission;
let admit: jest.Mock<Promise<GitHubCredentialAdmission>, []>;
let leases: ReturnType<typeof createGitHubCredentialLeasePort>;
let retained: GitHubCredentialLease[];
let lifetime: AbortController;
beforeEach(() => {
  now = 100;
  material = Buffer.from('test-only-credential');
  admission = { kind: 'admitted' };
  admit = jest.fn(() => Promise.resolve(admission));
  lifetime = new AbortController();
  leases = createGitHubCredentialLeasePort({
    now: () => now,
    signal: lifetime.signal,
    source: {
      resolve: () =>
        Promise.resolve({
          kind: 'available',
          material,
          admit: async <T>(use: () => T): Promise<GitHubCredentialUse<T>> => {
            const result = await admit();
            return result.kind === 'admitted'
              ? { kind: 'admitted', value: use() }
              : result;
          },
        }),
    },
  });
  retained = [];
});
afterEach(() => {
  for (const lease of retained) lease.revoke();
  jest.useRealTimers();
});
async function mint(input = request): Promise<GitHubCredentialLease> {
  const result = await leases.mint(input);
  if (result.kind !== 'minted')
    throw new Error(`Mint refused: ${result.reason}`);
  retained.push(result.lease);
  return result.lease;
}

describe('CAN-5788 one-shot Git recipient lease', () => {
  it.each([
    request,
    {
      ...request,
      purpose: 'git-fetch',
      audience: { operation: 'worker.git.fetch', key: 'fetch' },
    },
    {
      ...request,
      purpose: 'git-fetch',
      audience: { operation: 'worker.git.pull', key: 'pull' },
    },
  ] satisfies GitHubCredentialLeaseRequest[])(
    'admits at mint and spawn, then zeroes for $purpose / $audience.operation',
    async (input) => {
      const lease = await mint(input);
      expect(admit).toHaveBeenCalledTimes(1);
      const child = {};
      const spawn = jest.fn((bytes) => {
        expect(bytes).toBe(material);
        expect(Buffer.from(bytes).toString()).toBe('test-only-credential');
        return child;
      });
      expect(await lease.deliver(input, spawn)).toEqual({
        kind: 'delivered',
        value: child,
      });
      expect(admit).toHaveBeenCalledTimes(2);
      expect(material.every((byte) => byte === 0)).toBe(true);
      expect(await lease.deliver(input, spawn)).toEqual({
        kind: 'refused',
        reason: 'consumed',
      });
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'absent',
    'stale',
    'locked',
    'denied',
    'unavailable',
    'key_missing',
    'unconfirmed',
  ] as const)(
    'refuses and zeroes %s admission at both boundaries',
    async (reason) => {
      admission = { kind: 'refused', reason };
      expect(await leases.mint(request)).toEqual(admission);
      expect(material.every((byte) => byte === 0)).toBe(true);
      admission = { kind: 'admitted' };
      material = Buffer.from('test-only-credential');
      const lease = await mint();
      admission = { kind: 'refused', reason };
      const spawn = jest.fn();
      expect(await lease.deliver(request, spawn)).toEqual(admission);
      expect(spawn).not.toHaveBeenCalled();
      expect(material.every((byte) => byte === 0)).toBe(true);
    },
  );

  it.each([NaN, Infinity, -1, 100, 300101])(
    'refuses invalid or elapsed expiry %s before resolution',
    async (expiresAt) => {
      expect(await leases.mint({ ...request, expiresAt })).toEqual({
        kind: 'refused',
        reason: 'expired',
      });
      expect(admit).not.toHaveBeenCalled();
    },
  );

  it('checks expiry after mint admission, before delivery, and after delivery admission', async () => {
    admit.mockImplementationOnce(() => {
      now = 1100;
      return Promise.resolve(admission);
    });
    expect(await leases.mint(request)).toEqual({
      kind: 'refused',
      reason: 'expired',
    });
    expect(material.every((byte) => byte === 0)).toBe(true);
    now = 100;
    material = Buffer.from('test-only-credential');
    const expired = await mint();
    now = 1100;
    const spawn = jest.fn();
    expect(await expired.deliver(request, spawn)).toEqual({
      kind: 'refused',
      reason: 'expired',
    });
    now = 100;
    material = Buffer.from('test-only-credential');
    const pending = await mint();
    admit.mockImplementationOnce(() => {
      now = 1100;
      return Promise.resolve(admission);
    });
    expect(await pending.deliver(request, spawn)).toEqual({
      kind: 'refused',
      reason: 'expired',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(material.every((byte) => byte === 0)).toBe(true);
  });

  it('zeroes abandoned leases at expiry without a delivery', async () => {
    jest.useFakeTimers();
    const lease = await mint();
    jest.advanceTimersByTime(1000);
    expect(material.every((byte) => byte === 0)).toBe(true);
    expect(await lease.deliver(request, jest.fn())).toEqual({
      kind: 'refused',
      reason: 'expired',
    });
  });

  it('zeroes at spawn return, without waiting for admission to settle', async () => {
    let boundaries = 0;
    let zeroedAtReturn = false;
    const port = createGitHubCredentialLeasePort({
      now: () => now,
      source: {
        resolve: () =>
          Promise.resolve({
            kind: 'available',
            material,
            admit: <T>(use: () => T): Promise<GitHubCredentialUse<T>> => {
              const value = use();
              if (++boundaries === 2)
                zeroedAtReturn = material.every((byte) => byte === 0);
              return Promise.resolve({ kind: 'admitted', value });
            },
          }),
      },
    });
    const result = await port.mint(request);
    if (result.kind !== 'minted') throw new Error('Expected lease');
    retained.push(result.lease);
    expect(await result.lease.deliver(request, () => 'child')).toEqual({
      kind: 'delivered',
      value: 'child',
    });
    expect(zeroedAtReturn).toBe(true);
  });

  it.each(['abort', 'expiry'] as const)(
    'zeroes immediately on %s while mint admission is pending',
    async (stop) => {
      jest.useFakeTimers();
      const controller = new AbortController();
      let release: (value: GitHubCredentialAdmission) => void = () => undefined;
      let entering: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        entering = resolve;
      });
      admit.mockImplementationOnce(() => {
        entering();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const port = createGitHubCredentialLeasePort({
        now: () => now,
        signal: controller.signal,
        source: {
          resolve: () =>
            Promise.resolve({
              kind: 'available',
              material,
              admit: async <T>(
                use: () => T,
              ): Promise<GitHubCredentialUse<T>> => {
                const result = await admit();
                return result.kind === 'admitted'
                  ? { kind: 'admitted', value: use() }
                  : result;
              },
            }),
        },
      });
      const pending = port.mint(request);
      await entered;
      if (stop === 'abort') controller.abort();
      else jest.advanceTimersByTime(1000);
      expect(material.every((byte) => byte === 0)).toBe(true);
      release({ kind: 'admitted' });
      expect(await pending).toEqual({
        kind: 'refused',
        reason: stop === 'abort' ? 'revoked' : 'expired',
      });
      if (stop === 'abort')
        expect(await port.mint(request)).toEqual({
          kind: 'refused',
          reason: 'revoked',
        });
    },
  );

  it('binds purpose and complete dispatch audience, consuming mismatched deliveries', async () => {
    expect(await leases.mint({ ...request, purpose: 'git-fetch' })).toEqual({
      kind: 'refused',
      reason: 'purpose',
    });
    expect(
      await leases.mint({
        ...request,
        audience: { ...request.audience, key: '' },
      }),
    ).toEqual({ kind: 'refused', reason: 'audience' });
    for (const wrong of [
      {
        ...request,
        purpose: 'git-fetch',
      } satisfies GitHubCredentialLeaseRequest,
      { ...request, audience: { ...request.audience, key: 'other' } },
      {
        ...request,
        audience: { operation: 'worker.git.fetch', key: request.audience.key },
      } satisfies GitHubCredentialLeaseRequest,
    ]) {
      material = Buffer.from('test-only-credential');
      const lease = await mint();
      const spawn = jest.fn();
      expect(await lease.deliver(wrong, spawn)).toMatchObject({
        kind: 'refused',
      });
      expect(material.every((byte) => byte === 0)).toBe(true);
      expect(await lease.deliver(request, spawn)).toEqual({
        kind: 'refused',
        reason: 'consumed',
      });
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  it('snapshots mint identity and does not let callers rebind a lease', async () => {
    const input = { ...request, audience: { ...request.audience } };
    const pending = mint(input);
    input.audience.key = 'changed';
    const lease = await pending;
    expect(lease.audience.key).toBe('dispatch-one');
    expect(Object.isFrozen(lease.audience)).toBe(true);
    expect(await lease.deliver(request, () => 'child')).toEqual({
      kind: 'delivered',
      value: 'child',
    });
  });

  it.each(['lease', 'owner'] as const)(
    'consumes before asynchronous admission and honors %s revocation during it',
    async (owner) => {
      const lease = await mint();
      let release: (result: GitHubCredentialAdmission) => void = () =>
        undefined;
      admit.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const spawn = jest.fn();
      const pending = lease.deliver(request, spawn);
      expect(await lease.deliver(request, spawn)).toEqual({
        kind: 'refused',
        reason: 'consumed',
      });
      if (owner === 'lease') lease.revoke();
      else lifetime.abort();
      release({ kind: 'admitted' });
      expect(await pending).toEqual({ kind: 'refused', reason: 'revoked' });
      expect(spawn).not.toHaveBeenCalled();
      expect(material.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('zeroes on a rejected admission or throwing spawn', async () => {
    let lease = await mint();
    admit.mockRejectedValueOnce(new Error('admission offline'));
    expect(await lease.deliver(request, jest.fn())).toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
    expect(material.every((byte) => byte === 0)).toBe(true);
    material = Buffer.from('test-only-credential');
    lease = await mint();
    expect(
      await lease.deliver(request, () => {
        throw new Error('spawn failed');
      }),
    ).toEqual({ kind: 'refused', reason: 'unavailable' });
    expect(material.every((byte) => byte === 0)).toBe(true);
  });

  it('forwards typed resolution failures and fails closed on a throwing source', async () => {
    for (const resolution of [
      { kind: 'absent', reason: 'stale' },
      { kind: 'blocked', reason: 'locked' },
    ] satisfies GitHubCredentialResolution[]) {
      const port = createGitHubCredentialLeasePort({
        now: () => now,
        source: { resolve: () => Promise.resolve(resolution) },
      });
      expect(await port.mint(request)).toEqual({
        kind: 'refused',
        reason: resolution.reason,
      });
    }
    const port = createGitHubCredentialLeasePort({
      now: () => now,
      source: { resolve: () => Promise.reject(new Error('offline')) },
    });
    expect(await port.mint(request)).toEqual({
      kind: 'refused',
      reason: 'source_failed',
    });
  });
});
