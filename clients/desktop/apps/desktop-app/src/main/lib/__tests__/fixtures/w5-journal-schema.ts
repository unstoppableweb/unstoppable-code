// The journal contract and production log sanitizers that the W5 E2E failure capture
// (tests/electron/parity/w5-fixtures.mjs) loads through tsx.
export {
  journalSchema,
  LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN,
} from '@canopy/protocol/remote-control/shell/lifecycle-journal';
export {
  sanitizedDestructiveCode,
  sanitizedDestructivePhase,
} from '../../destructive-failure-context';
