// CAN-7196: the one check every caller of a keyed write uses to tell an
// outcome that may have landed from a refusal, read shape by shape from the
// shared table, as each caller's own goldens also read it.
import {
  isRebuildAdmissionRefusal,
  isUnknownKeyedWriteOutcome,
  KEYED_WRITE_OUTCOME_SHAPES,
  NOT_APPLIED_MARKS,
  type CanopyErrorPayload,
} from '..';

const sameKey = (
  extra: Partial<CanopyErrorPayload> = {},
): CanopyErrorPayload => ({
  kind: 'unavailable',
  message: 'Answered.',
  retry: { kind: 'same_idempotency_key' },
  ...extra,
});

describe('keyed write outcomes (CAN-7196)', () => {
  it.each(KEYED_WRITE_OUTCOME_SHAPES.map((each) => [each.name, each] as const))(
    'reads %s as its table says',
    (_name, each) => {
      expect(isUnknownKeyedWriteOutcome(each.payload)).toBe(each.unknown);
    },
  );

  it('names the producer of every shape, and reads each not-applied mark as a refusal', () => {
    for (const each of KEYED_WRITE_OUTCOME_SHAPES)
      expect(each.source.length).toBeGreaterThan(0);
    for (const mark of NOT_APPLIED_MARKS)
      expect(
        isUnknownKeyedWriteOutcome(
          sameKey({ kind: 'resource_exhausted', code: mark.code }),
        ),
      ).toBe(false);
  });

  it("reads only a running rebuild's exact code as its refusal before any post", () => {
    const rebuild = sameKey({
      details: {
        reason: 'cloud_refused',
        cloudCode: 'cloud-worktree-recovery-in-progress',
      },
    });
    expect(isRebuildAdmissionRefusal(rebuild)).toBe(true);
    expect(isUnknownKeyedWriteOutcome(rebuild)).toBe(false);
    for (const cloudCode of [
      'cloud-worktree-recovery-in-progress-later',
      'cloud-worktree-recovery-needed',
    ]) {
      const other = sameKey({ details: { cloudCode } });
      expect(isRebuildAdmissionRefusal(other)).toBe(false);
      expect(isUnknownKeyedWriteOutcome(other)).toBe(true);
    }
  });

  it('reads the operation ledger’s unavailable answer as nothing applied (CAN-6986 L3b G10)', () => {
    expect(NOT_APPLIED_MARKS.map((mark) => mark.code)).toContain(
      'core.operationLedger.unavailable',
    );
    expect(
      isUnknownKeyedWriteOutcome(
        sameKey({ code: 'core.operationLedger.unavailable' }),
      ),
    ).toBe(false);
  });
});
