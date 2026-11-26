import { createHmac } from 'node:crypto';
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
  ONE_WINDOW_CAPABILITIES,
  ONE_WINDOW_CAPABILITY_CHANNELS,
  ONE_WINDOW_CONTROLLER_CHANNELS,
  oneWindowChannelAllowed,
  oneWindowChannelsFor,
  oneWindowInvocationAllowed,
  oneWindowSendAllowed,
  ONE_WINDOW_REQUEST_FIELDS,
  oneWindowControllerProfile,
} from '../channels';
import { buildPairingLink, parsePairingFragment } from '../pairing-link';
import {
  HostedDelegationSchema,
  decodeCanonicalBase64url,
  hostedDelegationSigningBytes,
  PAIR_PROOF_LABEL,
} from '../security';
import {
  DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION,
  DESKTOP_ONE_WINDOW_MODE,
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

it('preserves the optional typed-steer feature in a host hello (CAN-7350)', () => {
  const features = {
    controllerProfiles: true,
    pairingProof: true,
    hostedDelegation: false,
  };
  const hello = { name: 'Host', platform: 'linux', appVersion: '1' };
  expect(HelloResultSchema.parse({ ...hello, features }).features).toEqual(
    features,
  );
  const withSteer = { ...features, chatSendSteerIntent: true };
  expect(
    HelloResultSchema.parse({ ...hello, features: withSteer }).features,
  ).toEqual(withSteer);
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

it('holds one-window desktop controllers to their own floor and a reviewed list (CAN-7758)', () => {
  // 26 is the protocol one-window mode ships on; no host below it has the
  // profile. The floor never passes this build's protocol.
  expect(DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION).toBeGreaterThanOrEqual(26);
  expect(DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION).toBeLessThanOrEqual(
    REMOTE_PROTOCOL_VERSION,
  );
  const controller = oneWindowControllerProfile();
  expect(HelloParamsSchema.parse({ version, controller }).controller).toEqual({
    kind: 'desktop',
    minVersion: DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION,
    mode: DESKTOP_ONE_WINDOW_MODE,
  });
  // The host announces its capabilities; older controllers ignore the key.
  const hello = { name: 'Host', platform: 'linux', appVersion: '1' };
  const features = {
    controllerProfiles: true,
    pairingProof: true,
    hostedDelegation: true,
    oneWindow: { capabilities: [...ONE_WINDOW_CAPABILITIES] },
  };
  expect(HelloResultSchema.parse({ ...hello, features }).features).toEqual(
    features,
  );
  // One sorted list without repeats, the union of the capabilities, so it
  // fingerprints the same however the groups are written.
  expect(ONE_WINDOW_CONTROLLER_CHANNELS).toEqual(
    [...new Set(ONE_WINDOW_CONTROLLER_CHANNELS)].sort(),
  );
  expect(oneWindowChannelsFor(ONE_WINDOW_CAPABILITIES)).toEqual(
    new Set(ONE_WINDOW_CONTROLLER_CHANNELS),
  );
  // A capability this build does not know grants nothing.
  expect(oneWindowChannelsFor(['terminals', 'toString'])).toEqual(new Set());
  expect(oneWindowChannelsFor(['approvals'])).toEqual(
    new Set(ONE_WINDOW_CAPABILITY_CHANNELS.approvals),
  );
  for (const channel of ONE_WINDOW_CONTROLLER_CHANNELS) {
    expect(oneWindowChannelAllowed(channel)).toBe(true);
  }
  expect(oneWindowChannelAllowed('terminal:spawn')).toBe(false);
  expect(oneWindowChannelAllowed('')).toBe(false);
});

it('holds every one-window call that changes something to a field allowlist (CAN-7854)', () => {
  const readOnly = new Set<string>([
    ...ONE_WINDOW_CAPABILITY_CHANNELS.sidebar,
    ...ONE_WINDOW_CAPABILITY_CHANNELS.chats,
    ...ONE_WINDOW_CAPABILITY_CHANNELS.composer,
    ...ONE_WINDOW_CAPABILITY_CHANNELS.approvals,
  ]);
  for (const channel of ONE_WINDOW_CONTROLLER_CHANNELS) {
    if (readOnly.has(channel)) continue;
    expect(
      channel === 'chat:command' || ONE_WINDOW_REQUEST_FIELDS.has(channel),
    ).toBe(true);
  }
  // Every allowlist names a channel on the list, so none is dead.
  for (const channel of ONE_WINDOW_REQUEST_FIELDS.keys()) {
    expect(oneWindowChannelAllowed(channel)).toBe(true);
  }
  // A call with no allowlist is refused even with no fields at all.
  expect(oneWindowInvocationAllowed('chat:queue-edit', [{}])).toBe(false);
  // Sends ride chat:command, which takes the session from the saved chat;
  // the older send takes it from its caller.
  expect(oneWindowChannelAllowed('chat:send-message')).toBe(false);
  // Approval answers wait until the host ties one to a chat's approval.
  expect(oneWindowChannelAllowed('approval:respond')).toBe(false);
  expect(oneWindowChannelAllowed('approval:dismiss')).toBe(false);
  // Values are checked, not only names: plugin selections keep the hosted
  // shape, so no MCP credential routing, and a send's text is a string.
  const envelope = (command: Record<string, unknown>): unknown[] => [
    {
      schemaVersion: 1,
      commandId: 'c',
      projectId: 'p',
      worktreeId: 'w',
      command,
    },
  ];
  const selections = { collectionIds: [], skillRefs: [], pluginRefs: [] };
  // No settings patch: turning on Auto would let a later send move the
  // chat to another provider, and a patch replaces plugin selections whole.
  expect(
    oneWindowInvocationAllowed(
      'chat:command',
      envelope({
        type: 'chat.patch_tab_settings',
        tabId: 't',
        patch: { modelSelectionMode: 'auto' },
      }),
    ),
  ).toBe(false);
  expect(
    oneWindowInvocationAllowed(
      'chat:command',
      envelope({
        type: 'chat.patch_tab_settings',
        tabId: 't',
        patch: { pluginSelections: selections },
      }),
    ),
  ).toBe(false);
  // Calls that change something are invokes; only reads may be sent.
  const send = envelope({
    type: 'chat.send_message',
    chatId: 'c',
    userMessageId: 'm',
    text: 'Hello',
  });
  expect(oneWindowInvocationAllowed('chat:command', send)).toBe(true);
  expect(oneWindowSendAllowed('chat:command', send)).toBe(false);
  expect(oneWindowSendAllowed('chat:set-interest', [])).toBe(true);
  expect(oneWindowChannelAllowed('chat:model-change')).toBe(false);
  // Stop names the exact turn; a plain Stop ends whatever turn runs.
  const scope = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
  expect(oneWindowInvocationAllowed('chat:cancel', [scope])).toBe(false);
  expect(
    oneWindowInvocationAllowed('chat:cancel', [
      { ...scope, expectedUserMessageId: 'm' },
    ]),
  ).toBe(true);
  expect(
    oneWindowInvocationAllowed(
      'chat:command',
      envelope({
        type: 'chat.patch_tab_settings',
        tabId: 't',
        patch: {
          pluginSelections: { ...selections, mcpHttpAuthPreferences: {} },
        },
      }),
    ),
  ).toBe(false);
  expect(
    oneWindowInvocationAllowed(
      'chat:command',
      envelope({
        type: 'chat.send_message',
        chatId: 'c',
        userMessageId: 'm',
        text: { nested: true },
      }),
    ),
  ).toBe(false);
  expect(
    oneWindowInvocationAllowed('chat:model-change', [
      { projectId: 'p', worktreeId: 'w', chatId: 'c', model: 'm', notice: {} },
    ]),
  ).toBe(false);
});

it('allows only channels that the host explicitly tunnels', () => {
  for (const channel of [
    ...MOBILE_CONTROLLER_CHANNELS,
    ...BROWSER_CONTROLLER_CHANNELS,
    ...HOSTED_CONTROLLER_CHANNELS,
    ...ONE_WINDOW_CONTROLLER_CHANNELS,
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
