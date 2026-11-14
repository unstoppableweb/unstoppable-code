import { createHmac } from 'node:crypto';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
  restoreOptionalRemoteControlFlag,
} from '../../feature-flags';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import {
  DeviceRelayTokenClaimsSchema,
  DeviceRelayServerMessageSchema,
  deviceKindOrDefault,
} from '../../device-relay';
import {
  BROWSER_CONTROLLER_CHANNELS,
  HOSTED_CONTROLLER_CHANNELS,
  MOBILE_CONTROLLER_CHANNELS,
} from '../channels';
import { buildPairingLink, parsePairingFragment } from '../pairing-link';
import {
  HostedDelegationSchema,
  decodeCanonicalBase64url,
  hostedDelegationSigningBytes,
  PAIR_PROOF_LABEL,
} from '../security';
import {
  HelloParamsSchema,
  HelloResultSchema,
  PairRequestParamsSchema,
  REMOTE_PROTOCOL_VERSION,
  WEB_CONTROLLER_MIN_PROTOCOL_VERSION,
} from '../session';

const key = Buffer.alloc(32).toString('base64url');
const deviceId = Buffer.alloc(16).toString('base64url');
const version = { protocolVersion: REMOTE_PROTOCOL_VERSION, appVersion: '1' };

it('preserves legacy session and relay messages without granting new features', () => {
  expect(HelloParamsSchema.parse({ version })).toEqual({ version });
  expect(
    HelloResultSchema.parse({
      name: 'Host',
      platform: 'linux',
      appVersion: '1',
    }).features,
  ).toBeUndefined();
  const ready = DeviceRelayServerMessageSchema.parse({
    type: 'ready',
    deviceId,
    peers: [],
  });
  expect(ready.type === 'ready' && ready.features).toBeUndefined();
  expect(deviceKindOrDefault({})).toBe('desktop');
  expect(
    HelloParamsSchema.safeParse({
      version,
      controller: { kind: 'browser', minVersion: 0 },
    }).success,
  ).toBe(false);
  expect(
    DeviceRelayTokenClaimsSchema.safeParse({
      v: 1,
      userId: 'u',
      deviceId,
      expiresAt: 1,
      kind: 'admin',
    }).success,
  ).toBe(false);
});

it('holds web controllers to their own host floor, not the current protocol', () => {
  // Protocol 19 (CAN-6187) is the first host that honors `targetId` on
  // `pipelines:execute`, a browser channel; an older one would run a cloud
  // run locally. The floor never passes this build's protocol, and a hello
  // naming it is well formed.
  expect(WEB_CONTROLLER_MIN_PROTOCOL_VERSION).toBeGreaterThanOrEqual(19);
  expect(WEB_CONTROLLER_MIN_PROTOCOL_VERSION).toBeLessThanOrEqual(
    REMOTE_PROTOCOL_VERSION,
  );
  for (const kind of ['browser', 'hosted'] as const) {
    expect(
      HelloParamsSchema.parse({
        version,
        controller: { kind, minVersion: WEB_CONTROLLER_MIN_PROTOCOL_VERSION },
      }).controller,
    ).toEqual({ kind, minVersion: WEB_CONTROLLER_MIN_PROTOCOL_VERSION });
  }
});

it('allows only channels that the host explicitly tunnels', () => {
  for (const channel of [
    ...MOBILE_CONTROLLER_CHANNELS,
    ...BROWSER_CONTROLLER_CHANNELS,
    ...HOSTED_CONTROLLER_CHANNELS,
  ]) {
    expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
  }
});

it('accepts canonical keys, MACs and delegation signatures only', () => {
  const delegation = {
    rootPublicKey: key,
    sessionPublicKey: key,
    expiresAt: 1,
    signature: Buffer.alloc(64).toString('base64url'),
  };
  expect(HostedDelegationSchema.parse(delegation)).toEqual(delegation);
  for (const field of ['rootPublicKey', 'sessionPublicKey', 'signature']) {
    for (const invalid of [
      '=',
      key + '=',
      key.slice(1),
      key.slice(0, -1) + 'B',
    ]) {
      expect(
        HostedDelegationSchema.safeParse({ ...delegation, [field]: invalid })
          .success,
      ).toBe(false);
    }
  }
  for (const expiresAt of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    expect(
      HostedDelegationSchema.safeParse({ ...delegation, expiresAt }).success,
    ).toBe(false);
  }
  expect(
    PairRequestParamsSchema.safeParse({
      name: 'Phone',
      platform: 'linux',
      proof: key,
    }).success,
  ).toBe(true);
  expect(
    PairRequestParamsSchema.safeParse({
      name: 'Phone',
      platform: 'linux',
      proof: key.slice(0, -1) + 'B',
    }).success,
  ).toBe(false);
});

it('pins canonical delegation signing bytes and pairing MAC domain separation', () => {
  // label || 00000020 || 32 zero key bytes || 0000018bcfe56800 (1700000000000).
  expect(
    Buffer.from(hostedDelegationSigningBytes(key, 1700000000000)).toString(
      'hex',
    ),
  ).toBe(
    '63616e6f70792d686f737465642d64656c65676174696f6e2d7631' +
      '00000020' +
      '00'.repeat(32) +
      '0000018bcfe56800',
  );
  const proof = createHmac('sha256', Buffer.alloc(32))
    .update(PAIR_PROOF_LABEL)
    .update(Buffer.alloc(32))
    .digest('base64url');
  expect(decodeCanonicalBase64url(proof, 32)?.byteLength).toBe(32);
});

it('keeps pairing secrets in a canonical fragment and rejects ambiguous inputs', () => {
  expect(buildPairingLink('https://example.com', deviceId, key)).toBe(
    `https://example.com/portal/pair#device=${deviceId}&secret=${key}`,
  );
  expect(parsePairingFragment(`#device=${deviceId}&secret=${key}`)).toEqual({
    deviceId,
    secret: key,
  });
  for (const hash of [
    '',
    '#code=123456',
    `#device=${deviceId}`,
    `#secret=${key}`,
    `#device=${deviceId}&secret=${key}&secret=${key}`,
    `#device=${deviceId}&secret=${key}=`,
    `#device=${deviceId}&secret=${key}&code=1`,
    `#device=${deviceId}&secret=${key.slice(0, -1)}B`,
  ]) {
    expect(parsePairingFragment(hash)).toBeNull();
  }
  expect(() =>
    buildPairingLink('https://user@example.com', deviceId, key),
  ).toThrow();
  expect(() => buildPairingLink('http://example.com', deviceId, key)).toThrow();
});

it('accepts old protocol-17 flag snapshots without enabling the hosted rollout', () => {
  const flags: Record<string, unknown> = {
    ...getDefaultFeatureFlagSnapshot().values,
  };
  const key = CLIENT_FEATURE_FLAGS.canopyWebDirectRemoteControl.key;
  delete flags[key];
  restoreOptionalRemoteControlFlag(flags);
  expect(flags[key]).toBe(false);
  flags[key] = true;
  restoreOptionalRemoteControlFlag(flags);
  expect(flags[key]).toBe(true);
});
