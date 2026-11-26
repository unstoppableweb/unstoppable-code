// Managed production TTL and natural idle shutdown are migration
// qualifications, not product-golden waits. The fast managed quit/finish/cancel
// checks and the native lease checks stay in daemon-pipelines.
import { test } from '@playwright/test';
import { runNativeSurvivalBatch } from './nativeSurvivalFixture.mjs';

test.skip(
  !['darwin', 'linux'].includes(process.platform),
  'The retained-process fixture requires a supported POSIX daemon artifact.',
);

for (const mode of ['governed-native', 'ai-credits']) {
  for (const provider of ['claude', 'codex']) {
    test(`${mode} ${provider} survives the production lease interval and releases idle obligations`, async ({}, testInfo) => {
      test.setTimeout(900_000);
      await runNativeSurvivalBatch(
        { mode, provider, adverseConditions: [], qualifyLease: true },
        testInfo,
      );
    });
  }
}
