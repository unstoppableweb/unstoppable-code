import { randomBytes } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { deflateRawSync } from 'node:zlib';
import { MAX_FRAGMENT_BYTES } from '@canopy/protocol/remote-control';
import {
  FRAGMENT_FLAG_COMPRESSED,
  FRAGMENT_FLAG_FINAL,
  MessageAssembler,
  MessageCodecError,
  SECURE_CHANNEL_MAX_COUNTER,
  SecureChannel,
  SecureChannelError,
  V8SerializationError,
  decodeEnvelope,
  deserializeV8,
  encodeEnvelope,
  encodeMessage,
  envelopeHeader,
  inflateRawBounded,
  serializeMessage,
  serializeV8,
} from '@canopy/remote-session';
import {
  decodeMessage as desktopDecodeMessage,
  deflateSmallMessage,
  encodeMessage as desktopEncodeMessage,
  fragmentPayload,
  inflateSmallMessage,
  MessageAssembler as DesktopMessageAssembler,
  serializeMessage as desktopSerializeMessage,
  SYNC_CODEC_BYTES,
  wantsCompression,
} from '../transport/message-codec';
import { SecureChannel as DesktopSecureChannel } from '../crypto/secure-channel';
import {
  encodeEnvelope as desktopEncodeEnvelope,
  envelopeHeader as desktopEnvelopeHeader,
} from '../transport/envelope';
import { ipcResultCorpus, rpcEnvelopes } from './helpers/ipc-result-corpus';

/**
 * Wire interop for the portable codec stack against the desktop's Node
 * implementations (the oracle), plus fixed vectors captured from Node 24
 * (format version 15) and Electron 45.2.2 (format version 16).
 */

/**
 * Normalizes decoded values for comparison: Buffers become their bytes (the
 * portable side has no Buffer), and objects Node's `v8.deserialize` built in
 * its own realm become this realm's, so `toEqual` compares contents.
 */
function plain(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  const tag = Object.prototype.toString.call(value);
  if (
    ArrayBuffer.isView(value) ||
    tag === '[object ArrayBuffer]' ||
    tag === '[object Error]'
  ) {
    return value;
  }
  if (tag === '[object Date]')
    return new Date(Date.prototype.getTime.call(value));
  if (tag === '[object Map]') {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    for (const [key, entry] of Map.prototype.entries.call(value)) {
      copy.set(plain(key, seen), plain(entry, seen));
    }
    return copy;
  }
  if (tag === '[object Set]') {
    const copy = new Set<unknown>();
    seen.set(value, copy);
    for (const entry of Set.prototype.values.call(value))
      copy.add(plain(entry, seen));
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    copy.length = value.length;
    for (const key of Object.keys(value))
      Reflect.set(copy, key, plain(Reflect.get(value, key), seen));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const key of Object.keys(value))
    copy[key] = plain(Reflect.get(value, key), seen);
  return copy;
}

/** The `code` of the error `run` throws, or null when it does not throw. */
function thrownCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : null;
  }
  return null;
}

async function portableDecode(
  fragments: Uint8Array[],
  maxMessageBytes?: number,
): Promise<unknown> {
  const assembler = new MessageAssembler(
    maxMessageBytes === undefined ? {} : { maxMessageBytes },
  );
  let result: { complete: true; value: unknown } | null = null;
  for (const fragment of fragments) {
    expect(result).toBeNull();
    result = await assembler.push(fragment);
  }
  if (result === null) throw new Error('No message decoded.');
  return result.value;
}

async function desktopDecode(
  fragments: Uint8Array[],
  maxMessageBytes?: number,
): Promise<unknown> {
  const assembler = new DesktopMessageAssembler(
    maxMessageBytes === undefined ? {} : { maxMessageBytes },
  );
  let result: { complete: true; value: unknown } | null = null;
  for (const fragment of fragments)
    result = await assembler.push(Buffer.from(fragment));
  if (result === null) throw new Error('No message decoded.');
  return result.value;
}

/**
 * Asserts `actual` is a byte view holding exactly `expected`'s bytes, naming
 * `label` and the first differing byte on failure. Deep `toEqual` compares
 * typed arrays one element at a time, which is too slow for the
 * fragment-boundary sizes below on loaded CI shards.
 */
function expectSameBytes(
  label: string,
  actual: unknown,
  expected: Uint8Array,
): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  if (!(actual instanceof Uint8Array)) return;
  expect({ label, byteLength: actual.byteLength }).toEqual({
    label,
    byteLength: expected.byteLength,
  });
  if (Buffer.compare(actual, expected) === 0) return;
  const firstDifference = actual.findIndex(
    (byte, index) => byte !== expected[index],
  );
  expect({ label, firstDifference }).toEqual({ label, firstDifference: -1 });
}

/** A Uint8Array payload whose serialized message is exactly `size` bytes. */
function messageOfSerializedSize(size: number): Uint8Array {
  for (let length = size - 9; length <= size; length += 1) {
    if (serialize(new Uint8Array(length)).byteLength === size) {
      return new Uint8Array(randomBytes(length));
    }
  }
  throw new Error(`No payload serializes to ${size} bytes.`);
}

const NODE_VECTORS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['ff0f410349022201615f240003', () => [1, 'a', undefined]],
  [
    'ff0f61034900490249044906400203',
    (): unknown[] => {
      const holey: unknown[] = [1];
      holey[2] = 3;
      return holey;
    },
  ],
  [
    'ff0f6f2201784902220473656c665e007b02',
    () => {
      const value: Record<string, unknown> = { x: 1 };
      value.self = value;
      return value;
    },
  ],
  ['ff0f3b49022201613a02', () => new Map([[1, 'a']])],
  ['ff0f272201612c01', () => new Set(['a'])],
  ['ff0f4400008056febc7842', () => new Date(1_700_000_000_000)],
  ['ff0f4203010203', () => new Uint8Array([1, 2, 3]).buffer],
  ['ff0f5c010107', () => new Uint8Array([7])],
  ['ff0f41022201610063022d4e240002', () => ['a', '中']],
  ['ff0f63043dd800de', () => '\u{1F600}'],
  ['ff0f63023dd8', () => '\ud83d'],
  [
    'ff0f41025a1001000000000000005a2100000000000000000100000000000000240002',
    () => [1n, -(2n ** 64n)],
  ],
  ['ff0f522202616203', () => /ab/gi],
];

describe('V8 serialization fixed vectors', () => {
  it('writes Node-identical bytes and reads them back', () => {
    for (const [hex, build] of NODE_VECTORS) {
      const value = build();
      expect(Buffer.from(serializeV8(value)).toString('hex')).toBe(hex);
      expect(deserializeV8(Buffer.from(hex, 'hex'))).toEqual(value);
      expect(deserialize(Buffer.from(hex, 'hex'))).toEqual(value);
    }
  });

  it('reads Node host-object views, Buffers, errors and Electron 45 version-16 output', () => {
    // Node Buffer host object (index 10) over a sliced view: only its bytes.
    const buffer = deserializeV8(Buffer.from('ff0f5c0a020203', 'hex'));
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(Array.from(buffer instanceof Uint8Array ? buffer : [])).toEqual([
      2, 3,
    ]);
    const views = deserializeV8(
      Buffer.from('ff0f6f2201785c0a0202032201795c0404010002007b02', 'hex'),
    );
    expect(views).toEqual({
      x: new Uint8Array([2, 3]),
      y: new Uint16Array([1, 2]),
    });
    const typeError = deserializeV8(
      Buffer.from('ff0f72546d2204626f6f6d732201532e', 'hex'),
    );
    expect(typeError).toBeInstanceOf(TypeError);
    expect(typeError).toMatchObject({ message: 'boom', stack: 'S' });
    const withCause = deserializeV8(
      Buffer.from('ff0f726d22016d7322015363490a2e', 'hex'),
    );
    expect(withCause).toBeInstanceOf(Error);
    expect(
      withCause instanceof Error ? Reflect.get(withCause, 'cause') : null,
    ).toBe(5);
    // Electron 45.2.2 (`v8.serialize`, format 16): shared view and native views.
    const shared = deserializeV8(
      Buffer.from('ff1041025c0101095e01240002', 'hex'),
    );
    expect(Array.isArray(shared) && shared[0] === shared[1]).toBe(true);
    expect(
      deserializeV8(Buffer.from('ff10410349022201615f240003', 'hex')),
    ).toEqual([1, 'a', undefined]);
    const native = deserializeV8(
      Buffer.from(
        'ff1041024208010203040506070856420002005e015642020200240002',
        'hex',
      ),
    );
    expect(native).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    if (Array.isArray(native)) {
      const first: unknown = native[0];
      const second: unknown = native[1];
      expect(first instanceof Uint8Array && second instanceof Uint8Array).toBe(
        true,
      );
      if (first instanceof Uint8Array && second instanceof Uint8Array) {
        expect(first.buffer).toBe(second.buffer);
        expect([first.byteOffset, second.byteOffset]).toEqual([0, 2]);
      }
    }
  });

  it('preserves view offsets, lengths and types in both directions', () => {
    const backing = new Uint8Array(randomBytes(64));
    const values = [
      backing.subarray(5, 21),
      new Int16Array(backing.buffer, 8, 4),
      new Float64Array([Math.PI, -0, Number.NaN]),
      new DataView(backing.buffer, 3, 9),
      new BigUint64Array([2n ** 63n]),
      Buffer.from(backing).subarray(10, 30),
    ];
    for (const value of values) {
      const fromNode = deserializeV8(serialize(value));
      const fromPortable: unknown = deserialize(
        Buffer.from(serializeV8(value)),
      );
      for (const decoded of [fromNode, fromPortable]) {
        if (!ArrayBuffer.isView(decoded)) throw new Error('Expected a view.');
        expect(decoded.byteLength).toBe(value.byteLength);
        expect(
          Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength),
        ).toEqual(
          Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        );
        const expectedType = Buffer.isBuffer(value)
          ? 'Uint8Array'
          : value.constructor.name;
        const actualType = Buffer.isBuffer(decoded)
          ? 'Uint8Array'
          : decoded.constructor.name;
        expect(actualType).toBe(expectedType);
      }
    }
  });

  it('rejects malformed and unsupported input with typed errors', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['', 'malformed'],
      ['0f5f', 'unsupported_version'],
      ['ff11', 'unsupported_version'],
      ['ff0c5f', 'unsupported_version'],
      ['ff0f22', 'malformed'], // truncated length
      ['ff0f2205616263', 'malformed'], // string longer than input
      ['ff0f5e07', 'malformed'], // reference to no object
      ['ff0f41ffffffff0f', 'malformed'], // dense length beyond input
      ['ff0f6301', 'malformed'], // odd two-byte length
      ['ff0f5f5f', 'malformed'], // trailing value
      ['ff0f6f7b01', 'malformed'], // property count mismatch
      ['ff0f6f6f7b007b01', 'malformed'], // object key
      ['ff0f2d', 'malformed'], // the hole outside an array
      ['ff0f7501', 'unsupported_tag'], // SharedArrayBuffer transfer
      ['ff0f5c0e0100', 'unsupported_tag'], // unknown host view type
      ['ff0f5c030101', 'malformed'], // Int16 view with an odd byte length
      ['ff0f49ffffffffff7f', 'malformed'], // overlong varint
    ];
    for (const [hex, code] of cases) {
      let caught: unknown = null;
      try {
        deserializeV8(Buffer.from(hex, 'hex'));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(V8SerializationError);
      expect(
        caught instanceof V8SerializationError ? `${hex}:${caught.code}` : hex,
      ).toBe(`${hex}:${code}`);
    }
    const deep = `ff0f${'4101'.repeat(2_000)}5f${'240001'.repeat(2_000)}`;
    expect(thrownCode(() => deserializeV8(Buffer.from(deep, 'hex')))).toBe(
      'too_deep',
    );
    // A `__proto__` key is an own property, never a prototype.
    const polluted = deserializeV8(
      Buffer.from('ff0f6f22095f5f70726f746f5f5f49027b01', 'hex'),
    );
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    expect(
      typeof polluted === 'object' && polluted !== null
        ? Object.keys(polluted)
        : [],
    ).toEqual(['__proto__']);
  });

  it('refuses values Node refuses, without coercing them', () => {
    const tagged = { [Symbol.toStringTag]: 'Custom', a: 1 };
    for (const value of [
      (): number => 1,
      Symbol('x'),
      Promise.resolve(),
      new WeakMap(),
      [new WeakSet()],
      tagged,
    ]) {
      expect(() => serializeMessage(value)).toThrow(MessageCodecError);
      try {
        serializeMessage(value);
      } catch (error) {
        expect(error instanceof MessageCodecError ? error.code : null).toBe(
          'unsupported_value',
        );
      }
    }
    let nested: unknown[] = [];
    const root = nested;
    for (let depth = 0; depth < 1_100; depth += 1) {
      const next: unknown[] = [];
      nested.push(next);
      nested = next;
    }
    expect(thrownCode(() => serializeV8(root))).toBe('too_deep');
  });
});

describe('message codec interop with the desktop', () => {
  it('round-trips the allowlisted IPC corpus in both directions', async () => {
    let id = 1;
    for (const entry of ipcResultCorpus()) {
      for (const envelope of rpcEnvelopes(entry, id)) {
        id += 1;
        const expected = plain(deserialize(serialize(envelope)));
        const portableFragments = await encodeMessage(envelope);
        expect(plain(await desktopDecode(portableFragments))).toEqual(expected);
        const desktopFragments = await desktopEncodeMessage(envelope);
        expect(plain(await portableDecode(desktopFragments))).toEqual(expected);
        expect(plain(await portableDecode(portableFragments))).toEqual(
          expected,
        );
      }
    }
  });

  it('splits at the same boundaries with byte-identical uncompressed fragments', async () => {
    for (const size of [
      100,
      8 * 1024 - 1,
      MAX_FRAGMENT_BYTES - 1,
      MAX_FRAGMENT_BYTES,
      MAX_FRAGMENT_BYTES + 1,
      2 * MAX_FRAGMENT_BYTES,
      2 * MAX_FRAGMENT_BYTES + 1,
    ]) {
      const value = messageOfSerializedSize(size);
      const portable = await encodeMessage(value);
      const desktop = await desktopEncodeMessage(value);
      expect(portable).toHaveLength(desktop.length);
      portable.forEach((fragment, index) => {
        expectSameBytes(
          `size ${size} fragment ${index}`,
          fragment,
          desktop[index] ?? new Uint8Array(0),
        );
      });
      expect(portable).toHaveLength(
        Math.max(1, Math.ceil(size / MAX_FRAGMENT_BYTES)),
      );
      portable.forEach((fragment, index) => {
        const final = index === portable.length - 1;
        expect(fragment[0]).toBe(final ? FRAGMENT_FLAG_FINAL : 0);
        if (!final) expect(fragment.byteLength).toBe(MAX_FRAGMENT_BYTES + 1);
      });
      expectSameBytes(
        `size ${size} portable decode`,
        await portableDecode(desktop),
        value,
      );
      expectSameBytes(
        `size ${size} desktop decode`,
        await desktopDecode(portable),
        value,
      );
    }
  });

  it('compresses from 8 KiB only when smaller, readable by the desktop', async () => {
    const below = 'a'.repeat(8 * 1024 - 16);
    const belowFragments = await encodeMessage(below);
    expect(serializeMessage(below).byteLength).toBeLessThan(8 * 1024);
    expect(belowFragments[0]?.[0]).toBe(FRAGMENT_FLAG_FINAL);
    const large = { log: 'line of log output\n'.repeat(50_000) };
    const fragments = await encodeMessage(large);
    for (const fragment of fragments) {
      expect((fragment[0] ?? 0) & FRAGMENT_FLAG_COMPRESSED).toBe(
        FRAGMENT_FLAG_COMPRESSED,
      );
    }
    expect(
      fragments.reduce((sum, fragment) => sum + fragment.byteLength, 0),
    ).toBeLessThan(serializeMessage(large).byteLength);
    expect(await desktopDecode(fragments)).toEqual(large);
    expect(await portableDecode(await desktopEncodeMessage(large))).toEqual(
      large,
    );
    const incompressible = new Uint8Array(randomBytes(20_000));
    const raw = await encodeMessage(incompressible);
    expect((raw[0]?.[0] ?? 0) & FRAGMENT_FLAG_COMPRESSED).toBe(0);
  });

  it('writes the same bytes as a desktop on the previous release, and reads them', async () => {
    // The previous release deflated synchronously (level 1) before it split
    // the message (CAN-7764 and CAN-7931 moved deflate and inflate of
    // messages over 32 KiB to the thread pool). Both codec paths, in both
    // directions, must stay byte-compatible with it.
    const previousRelease = (value: unknown): Buffer[] => {
      const serialized = serialize(value);
      const deflated =
        serialized.byteLength >= 8 * 1024
          ? deflateRawSync(serialized, { level: 1 })
          : null;
      const compressed =
        deflated !== null && deflated.byteLength < serialized.byteLength;
      const payload = compressed ? deflated : serialized;
      const fragments: Buffer[] = [];
      let offset = 0;
      do {
        const end = Math.min(offset + MAX_FRAGMENT_BYTES, payload.byteLength);
        const flags =
          (end === payload.byteLength ? FRAGMENT_FLAG_FINAL : 0) |
          (compressed ? FRAGMENT_FLAG_COMPRESSED : 0);
        fragments.push(
          Buffer.concat([Buffer.from([flags]), payload.subarray(offset, end)]),
        );
        offset = end;
      } while (offset < payload.byteLength);
      return fragments;
    };
    // What SecureSession does on main for a message up to SYNC_CODEC_BYTES:
    // deflate and fragment on send, join and inflate on receive.
    const sessionSend = (value: unknown): Buffer[] => {
      const serialized = desktopSerializeMessage(value);
      expect(serialized.byteLength).toBeLessThanOrEqual(SYNC_CODEC_BYTES);
      const deflated = wantsCompression(serialized)
        ? deflateSmallMessage(serialized)
        : null;
      return deflated === null
        ? fragmentPayload(serialized, false)
        : fragmentPayload(deflated, true);
    };
    const sessionReceive = (fragments: Buffer[]): unknown => {
      const assembler = new DesktopMessageAssembler();
      let assembled: ReturnType<typeof assembler.pushFragment> = null;
      for (const fragment of fragments)
        assembled = assembler.pushFragment(fragment);
      if (assembled === null) throw new Error('No message assembled.');
      if (!assembled.compressed) return desktopDecodeMessage(assembled.payload);
      const inflated = inflateSmallMessage(
        assembled.payload,
        assembler.maxMessageBytes,
      );
      if (inflated === null) throw new Error('Not inflated on main.');
      return desktopDecodeMessage(inflated);
    };
    const expectSameFragments = (
      current: Buffer[],
      previous: Buffer[],
    ): void => {
      expect(current).toHaveLength(previous.length);
      current.forEach((fragment, index) => {
        expectSameBytes(
          `fragment ${index}`,
          fragment,
          previous[index] ?? new Uint8Array(0),
        );
      });
    };
    const small = [
      { small: true },
      { log: 'line of log output\n'.repeat(500) },
      { log: 'line of log output\n'.repeat(1_700) },
      new Uint8Array(randomBytes(30_000)),
    ];
    for (const value of small) {
      const previous = previousRelease(value);
      expectSameFragments(sessionSend(value), previous);
      expect(plain(sessionReceive(previous))).toEqual(plain(value));
    }
    for (const value of [
      ...small,
      { log: 'line of log output\n'.repeat(200_000) },
      new Uint8Array(randomBytes(3 * MAX_FRAGMENT_BYTES)),
    ]) {
      const previous = previousRelease(value);
      expectSameFragments(await desktopEncodeMessage(value), previous);
      expect(plain(await desktopDecode(previous))).toEqual(plain(value));
    }
  });

  it('enforces the message limit while accumulating and inflating', async () => {
    const limit = 1024 * 1024;
    // A compression bomb: 64 MiB of zeros in about 64 KiB of raw deflate.
    const bomb = deflateRawSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
    const fragments: Uint8Array[] = [];
    for (
      let offset = 0;
      offset < bomb.byteLength;
      offset += MAX_FRAGMENT_BYTES
    ) {
      const end = Math.min(offset + MAX_FRAGMENT_BYTES, bomb.byteLength);
      const flags =
        FRAGMENT_FLAG_COMPRESSED |
        (end === bomb.byteLength ? FRAGMENT_FLAG_FINAL : 0);
      fragments.push(
        Buffer.concat([Buffer.from([flags]), bomb.subarray(offset, end)]),
      );
    }
    await expect(portableDecode(fragments, limit)).rejects.toMatchObject({
      code: 'too_large',
    });
    await expect(desktopDecode(fragments, limit)).rejects.toThrow('too large');
    await expect(
      inflateRawBounded(new Uint8Array(bomb), limit),
    ).rejects.toMatchObject({
      code: 'too_large',
    });
    // Plain fragments past the limit fail before the final fragment arrives.
    const assembler = new MessageAssembler({
      maxMessageBytes: 2 * MAX_FRAGMENT_BYTES,
    });
    const full = new Uint8Array(MAX_FRAGMENT_BYTES + 1);
    expect(await assembler.push(full)).toBeNull();
    expect(await assembler.push(full)).toBeNull();
    await expect(assembler.push(full)).rejects.toMatchObject({
      code: 'too_large',
    });
    // Senders check the same serialized size before compressing.
    expect(
      thrownCode(() =>
        serializeMessage('x'.repeat(2_000), { maxMessageBytes: 1_000 }),
      ),
    ).toBe('too_large');
    await expect(
      desktopEncodeMessage('x'.repeat(2_000), { maxMessageBytes: 1_000 }),
    ).rejects.toThrow('too large');
  });

  it('rejects malformed fragments and messages with typed errors', async () => {
    const valid = await encodeMessage({ ok: true });
    const cases: ReadonlyArray<readonly [Uint8Array[], string]> = [
      [[new Uint8Array(0)], 'malformed_fragment'],
      [[Uint8Array.of(0x05, 1)], 'malformed_fragment'], // unknown flag bit
      [[Uint8Array.of(0x00, 1, 2, 3)], 'malformed_fragment'], // short non-final
      [
        [
          new Uint8Array(MAX_FRAGMENT_BYTES + 1),
          Uint8Array.of(FRAGMENT_FLAG_FINAL | FRAGMENT_FLAG_COMPRESSED, 1),
        ],
        'malformed_fragment',
      ], // compression flag changes mid-message
      [
        [Uint8Array.of(FRAGMENT_FLAG_FINAL, 0xff, 0x0f, 0x22, 0x09)],
        'malformed_message',
      ],
      [
        [
          Uint8Array.of(
            FRAGMENT_FLAG_FINAL | FRAGMENT_FLAG_COMPRESSED,
            0xff,
            0xff,
          ),
        ],
        'decompression_failed',
      ],
      [[(valid[0] ?? new Uint8Array(0)).subarray(0, 4)], 'malformed_message'], // truncated
    ];
    for (const [fragments, code] of cases) {
      await expect(portableDecode(fragments)).rejects.toMatchObject({ code });
    }
  });
});

describe('secure channel interop with the desktop', () => {
  const header = Buffer.from(
    desktopEnvelopeHeader('data', Buffer.alloc(16, 7)),
  );

  it('seals and opens identical frames in both directions', async () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const desktop = new DesktopSecureChannel(keyA, keyB);
    const portable = await SecureChannel.create(keyB, keyA);
    expect(
      Buffer.from(envelopeHeader('data', new Uint8Array(16).fill(7))),
    ).toEqual(header);
    for (let index = 0; index < 5; index += 1) {
      const plaintext = randomBytes(index * 1_000 + 1);
      const fromDesktop = desktop.seal(plaintext, header);
      expect(Buffer.from(await portable.open(fromDesktop, header))).toEqual(
        plaintext,
      );
      const fromPortable = await portable.seal(plaintext, header);
      expect(desktop.open(fromPortable, header)).toEqual(plaintext);
    }
    // Deterministic AES-GCM with counter nonces: identical frames for identical state.
    const twinDesktop = new DesktopSecureChannel(keyA, keyB);
    const twinPortable = await SecureChannel.create(keyA, keyB);
    const message = randomBytes(300);
    expect(Buffer.from(await twinPortable.seal(message, header))).toEqual(
      twinDesktop.seal(message, header),
    );
  });

  it('refuses tampering, replays, gaps, foreign sessions and counter exhaustion', async () => {
    const send = randomBytes(32);
    const receive = randomBytes(32);
    const desktop = new DesktopSecureChannel(send, receive);
    const expectRefusal = async (
      channel: SecureChannel,
      frame: Uint8Array,
      aad: Uint8Array,
      code: string,
    ): Promise<void> => {
      let caught: unknown = null;
      try {
        await channel.open(frame, aad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecureChannelError);
      expect(caught instanceof SecureChannelError ? caught.code : null).toBe(
        code,
      );
    };
    const tamperedReceiver = await SecureChannel.create(receive, send);
    const frame0 = desktop.seal(Buffer.from('zero'), header);
    const tampered = Buffer.from(frame0);
    tampered[10] = (tampered[10] ?? 0) ^ 1;
    await expectRefusal(tamperedReceiver, tampered, header, 'authentication');
    const otherSession = Buffer.from(
      desktopEnvelopeHeader('data', Buffer.alloc(16, 8)),
    );
    await expectRefusal(
      tamperedReceiver,
      frame0,
      otherSession,
      'authentication',
    );
    // After failed attempts the next expected counter is unchanged.
    expect(
      Buffer.from(await tamperedReceiver.open(frame0, header)).toString(),
    ).toBe('zero');
    await expectRefusal(tamperedReceiver, frame0, header, 'replayed');
    desktop.seal(Buffer.from('one'), header); // dropped in transit
    const frame2 = desktop.seal(Buffer.from('two'), header);
    await expectRefusal(tamperedReceiver, frame2, header, 'replayed');
    await expectRefusal(
      tamperedReceiver,
      Buffer.alloc(10),
      header,
      'malformed',
    );
    // The desktop refuses portable tampering the same way.
    const portableSender = await SecureChannel.create(send, receive);
    const desktopReceiver = new DesktopSecureChannel(receive, send);
    const sealed = Buffer.from(
      await portableSender.seal(Buffer.from('x'), header),
    );
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0x80;
    expect(() => desktopReceiver.open(sealed, header)).toThrow(
      'failed authentication',
    );
    // Counters never wrap: the last u64 counter is usable once, then refused.
    const exhausted = await SecureChannel.create(send, receive, {
      send: SECURE_CHANNEL_MAX_COUNTER,
      receive: BigInt(0),
    });
    const last = await exhausted.seal(Buffer.from('last'), header);
    expect(Buffer.from(last.subarray(0, 8)).toString('hex')).toBe(
      'ffffffffffffffff',
    );
    await expect(
      exhausted.seal(Buffer.from('wrap'), header),
    ).rejects.toMatchObject({
      code: 'exhausted',
    });
  });

  it('frames envelopes identically', () => {
    const sessionId = new Uint8Array(randomBytes(16));
    for (const type of [
      'hello1',
      'hello2',
      'hello3',
      'hello4',
      'data',
      'abort',
    ] as const) {
      const body = randomBytes(40);
      const portable = encodeEnvelope(type, sessionId, body);
      expect(Buffer.from(portable)).toEqual(
        desktopEncodeEnvelope(type, Buffer.from(sessionId), body),
      );
      expect(decodeEnvelope(portable)).toEqual({
        type,
        sessionId,
        body: new Uint8Array(body),
      });
    }
    expect(
      decodeEnvelope(Uint8Array.of(0x99, ...new Uint8Array(16))),
    ).toBeNull();
    expect(decodeEnvelope(new Uint8Array(5))).toBeNull();
  });
});
