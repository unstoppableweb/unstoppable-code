import { CanopyClientError } from '@canopy/core-client';
import {
  CANOPY_OUTCOME_UNKNOWN_MESSAGE,
  CanopyOutcomeUnknownError,
  isCanopyOutcomeUnknown,
} from '@canopy/core-client/outcome';

const OUTCOME_UNKNOWN_PAYLOAD = {
  kind: 'unavailable',
  message: 'The outcome is unknown.',
  retry: { kind: 'never' },
};

describe('CanopyOutcomeUnknownError', () => {
  it('carries the wire shape callers branch on: unavailable with retry never', () => {
    const error = new CanopyOutcomeUnknownError();

    expect(error).toBeInstanceOf(CanopyClientError);
    expect(error.name).toBe('CanopyOutcomeUnknownError');
    expect(error.outcome).toBe('outcome_unknown');
    expect(error.message).toBe(CANOPY_OUTCOME_UNKNOWN_MESSAGE);
    expect(error.payload).toEqual(OUTCOME_UNKNOWN_PAYLOAD);
    expect(JSON.parse(JSON.stringify(error))).toEqual(OUTCOME_UNKNOWN_PAYLOAD);
  });
});

describe('isCanopyOutcomeUnknown', () => {
  it.each([
    ['the typed error', new CanopyOutcomeUnknownError()],
    [
      'a client error of kind unavailable with retry never',
      new CanopyClientError({
        kind: 'unavailable',
        message: 'The core is not reachable.',
        retry: { kind: 'never' },
      }),
    ],
    ['the flattened wire payload', OUTCOME_UNKNOWN_PAYLOAD],
    [
      'a wire payload with optional details',
      { ...OUTCOME_UNKNOWN_PAYLOAD, details: { reason: 'closed' } },
    ],
  ])('is true for %s', (_label, value) => {
    expect(isCanopyOutcomeUnknown(value)).toBe(true);
  });

  it.each([
    [
      'unavailable with retry same_request',
      { ...OUTCOME_UNKNOWN_PAYLOAD, retry: { kind: 'same_request' } },
    ],
    [
      'unavailable with retry same_idempotency_key',
      new CanopyClientError({
        kind: 'unavailable',
        message: 'The response was abandoned.',
        retry: { kind: 'same_idempotency_key' },
      }),
    ],
    [
      'cancelled with retry never',
      { ...OUTCOME_UNKNOWN_PAYLOAD, kind: 'cancelled' },
    ],
    [
      'internal with retry never',
      { ...OUTCOME_UNKNOWN_PAYLOAD, kind: 'internal' },
    ],
    [
      'deadline_exceeded with retry never',
      { ...OUTCOME_UNKNOWN_PAYLOAD, kind: 'deadline_exceeded' },
    ],
    ['unavailable with no retry', { kind: 'unavailable', message: 'Lost.' }],
    [
      'unavailable with no message',
      { kind: 'unavailable', retry: { kind: 'never' } },
    ],
    [
      'a retry with an extra field',
      { ...OUTCOME_UNKNOWN_PAYLOAD, retry: { kind: 'never', after: 1 } },
    ],
    ['a retry with no kind', { ...OUTCOME_UNKNOWN_PAYLOAD, retry: {} }],
    ['a string retry', { ...OUTCOME_UNKNOWN_PAYLOAD, retry: 'never' }],
    ['a null retry', { ...OUTCOME_UNKNOWN_PAYLOAD, retry: null }],
    [
      'a payload with an extra field',
      { ...OUTCOME_UNKNOWN_PAYLOAD, outcome: 'outcome_unknown' },
    ],
    [
      'an error-like object wrapping the payload',
      { payload: OUTCOME_UNKNOWN_PAYLOAD },
    ],
    ['a plain Error', new Error('The outcome is unknown.')],
    ['null', null],
    ['a string', 'unavailable'],
  ])('is false for %s', (_label, value) => {
    expect(isCanopyOutcomeUnknown(value)).toBe(false);
  });
});
