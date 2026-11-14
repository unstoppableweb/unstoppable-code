// Private cold-recovery startup status, not ordinary daemon exit semantics.
// Keep these below signal exits (128+) and distinct from usage (64) / custody (70).
const REFUSAL_EXITS = [
  { code: 80, reason: 'platform-unsupported' },
  { code: 81, reason: 'invalid-request' },
  { code: 82, reason: 'runtime-unavailable' },
  { code: 83, reason: 'identity-unprovable' },
  { code: 84, reason: 'claim-held' },
  { code: 85, reason: 'claim-ambiguous' },
  { code: 86, reason: 'endpoint-unavailable' },
  { code: 87, reason: 'claim-lost' },
  { code: 88, reason: 'release-uncertain' },
  { code: 89, reason: 'writer-exit-unconfirmed' },
] as const;

type RecoveryStartupRefusal = (typeof REFUSAL_EXITS)[number]['reason'];

export function w5RecoveryRefusalExitCode(reason: string): number | undefined {
  return REFUSAL_EXITS.find((entry) => entry.reason === reason)?.code;
}

export function w5RecoveryRefusalFromExitCode(
  code: number | null,
): RecoveryStartupRefusal | undefined {
  return REFUSAL_EXITS.find((entry) => entry.code === code)?.reason;
}
