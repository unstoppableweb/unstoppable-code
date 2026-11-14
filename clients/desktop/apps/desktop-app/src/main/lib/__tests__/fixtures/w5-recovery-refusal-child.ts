import { readFileSync } from 'node:fs';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import { runDaemonW5Recovery } from '../../../../../../core-daemon/src/w5-recovery';
import { failureOutcome } from '../../../../../../core-daemon/src/process-control';

async function main(): Promise<void> {
  const [dataRoot, nonce] = process.argv.slice(2);
  if (!dataRoot || !nonce) throw new Error('Missing recovery fixture inputs');
  const handoff: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (
    typeof handoff !== 'object' ||
    handoff === null ||
    !('auth' in handoff) ||
    typeof handoff.auth !== 'object' ||
    handoff.auth === null ||
    !('secret' in handoff.auth) ||
    typeof handoff.auth.secret !== 'string' ||
    !('dataRootHash' in handoff.auth) ||
    typeof handoff.auth.dataRootHash !== 'string'
  )
    throw new Error('Missing recovery fixture handoff');
  const os = hostPlatformOperatingSystem();
  await runDaemonW5Recovery({
    dataRoot,
    nonce,
    auth: {
      secret: handoff.auth.secret,
      dataRootHash: handoff.auth.dataRootHash,
    },
    os,
    platformFor: (validateStartupClaim) =>
      hostPlatformServices(
        createPlatformEndpointServices(os, { validateStartupClaim }),
      ),
    buildVersion: 'test',
  });
}
void main().catch((error: unknown) => {
  const outcome = failureOutcome(error);
  process.stderr.write(`${outcome.message}\n`);
  process.exitCode = outcome.code;
});
