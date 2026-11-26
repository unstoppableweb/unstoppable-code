// Isolated fault qualification complements daemon-survival-leases.spec.mjs's single
// production-length lease proof per composition. Never combine account faults:
// one revocation pauses every paid route and could mask another fault's result.
import { test } from '@playwright/test';
import { runNativeSurvivalBatch } from './nativeSurvivalFixture.mjs';

test.skip(
  !['darwin', 'linux'].includes(process.platform),
  'The retained-process fixture requires a supported POSIX daemon artifact.',
);

for (const mode of ['governed-native', 'ai-credits']) {
  for (const provider of ['claude', 'codex']) {
    for (const condition of [
      'unknown-policy',
      'organization-loss',
      'exhausted',
      'revoked',
      'disconnected',
    ]) {
      test(`${mode} ${provider} isolates ${condition} after quit without billing fallback`, async ({}, testInfo) => {
        test.setTimeout(360_000);
        await runNativeSurvivalBatch(
          {
            mode,
            provider,
            adverseConditions: [condition],
            qualifyLease: false,
          },
          testInfo,
        );
      });
    }
  }
}
