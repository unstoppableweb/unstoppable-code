import { assertAntigravityHarnessEnabled } from './feature-flag';
import { spawnProviderProcess } from '../agent-runs/provider-process-host';
import { openAntigravityRuntime as openPortableRuntime } from '@canopy/desktop-shared/node/antigravity/runtime';
export {
  ANTIGRAVITY_RUNTIME_VERSION,
  antigravityProfileDirectory,
  antigravityEnvironment,
  antigravityArguments,
  prepareAntigravityProfile,
  resolveAntigravityExecutable,
  type AntigravityRuntime,
} from '@canopy/desktop-shared/node/antigravity/runtime';

export function openAntigravityRuntime(
  input: Omit<
    Parameters<typeof openPortableRuntime>[0],
    'spawnProcess' | 'assertEnabled'
  >,
): ReturnType<typeof openPortableRuntime> {
  return openPortableRuntime({
    ...input,
    spawnProcess: spawnProviderProcess,
    assertEnabled: assertAntigravityHarnessEnabled,
  });
}
