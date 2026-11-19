/**
 * CAN-4475 R0-F2 on the in-app host, storage format 3 (CAN-7176): a chat
 * scope crashed at each steady-state delta journal boundary reopens with
 * every acknowledged command, the in-flight command wholly present or wholly
 * absent, a second reopen byte-identical, and a retry that converges.
 */
import { join } from 'node:path';
import {
  crashCases,
  expectCoverage,
  expectCrashImage,
  referenceStates,
  useR0Root,
  type Observed,
} from './helpers/chat-r0-commit-workload';

// Real syncs dominate case time (CAN-6971).
jest.setTimeout(60_000);

const root = useR0Root();
let expected: Observed[] | undefined;

it('R0-F2 coverage (format 3): the workload reaches every crashed boundary at its step', async () => {
  await expectCoverage(join(root(), 'coverage'), 'format 3');
});

it.each(crashCases('format 3'))(
  'R0-F2 $format $step at $boundary ($image): acknowledged commands survive; in-flight is all or nothing; reopen is stable; retry converges',
  async (crash) => {
    expected ??= await referenceStates(join(root(), 'reference'), 'format 3');
    await expectCrashImage(root(), crash, expected);
  },
);
