/**
 * CAN-4475 R0-F2 on the in-app host, delegation registry, receipt and
 * child-stream boundaries (CAN-7176), storage format 4: a delegated run
 * crashed at each registry settle, receipt and child checkpoint boundary
 * reopens with every acknowledged step, the in-flight step wholly present
 * or wholly absent, a second reopen byte-identical, and a retry that
 * converges.
 */
import { join } from 'node:path';
import {
  delegationCrashCases,
  delegationReferenceStates,
  expectDelegationCoverage,
  expectDelegationCrashImage,
  useR0Root,
  type DelegationObserved,
} from './helpers/chat-r0-commit-workload';

// Real syncs dominate case time (CAN-6971).
jest.setTimeout(60_000);

const root = useR0Root();
let expected: DelegationObserved[] | undefined;

it('R0-F2 delegation coverage: the delegated run reaches every crashed boundary at its step', async () => {
  await expectDelegationCoverage(join(root(), 'coverage'));
});

it.each(delegationCrashCases())(
  'R0-F2 delegation $step at $boundary: acknowledged steps survive; in-flight is all or nothing; reopen is stable; retry converges',
  async (crash) => {
    expected ??= await delegationReferenceStates(join(root(), 'reference'));
    await expectDelegationCrashImage(root(), crash, expected);
  },
);
