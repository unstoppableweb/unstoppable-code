// Source CLI composition using the same verified lane payload as Electron.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrand } from '../../../../../scripts/brand/load-brand.mjs';
import { verifyE2eDaemonHosts } from '../../../../../scripts/lib/e2e-core-daemon-artifact.mjs';
import { productDaemonTargets } from '../../../../../scripts/lib/e2e-daemon-product-bridge.mjs';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
// Ordinary import() under the tsx runner shares one runtime module instance
// with the entry's own imports; a scoped tsx require would load a second copy
// that never sees the lane inputs.
const cliEntry = '../../../../../apps/desktop-cli/src/index.ts';
async function runCliFixture() {
  process.argv[1] = path.join(root, 'apps/desktop-cli/src/index.ts');
  const runtimeRoot = process.env.CANOPY_E2E_LANE_RUNTIME_ROOT;
  if (!runtimeRoot) return import(cliEntry);
  const targets = productDaemonTargets({
    runtimeRoot,
    brand: loadBrand(process.env.CANOPY_BRAND ?? 'canopy'),
    platform: process.platform,
    arch: process.arch,
  });
  const artifact = verifyE2eDaemonHosts({
    root,
    sourceSha: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    platform: process.platform,
    arch: process.arch,
  });
  const hash = (file) =>
    createHash('sha256').update(readFileSync(file)).digest('hex');
  for (const [staged, verified] of [
    [targets.executable, artifact.executable],
    [targets.ownedChildNativePath, artifact.ownedChildNativePath],
    ...artifact.daemonFiles.map((file) => [
      path.join(path.dirname(targets.executable), file.path),
      file.source,
    ]),
  ]) {
    if (hash(staged) !== hash(verified))
      throw new Error('W5 CLI lane payload differs from the verified artifact');
  }
  const { withCliDaemonHostInputs } =
    await import('../../../../../apps/desktop-cli/src/runtime.ts');
  // The entry is evaluated inside the scope, so its command chain inherits it.
  return withCliDaemonHostInputs(targets, () => import(cliEntry));
}
await runCliFixture();
