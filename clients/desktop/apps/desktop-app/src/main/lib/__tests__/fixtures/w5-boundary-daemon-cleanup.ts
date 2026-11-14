import type * as CorePlatform from '@canopy/core-platform';
import type { PlatformOwnedChild } from '@canopy/core-runtime';

const children: PlatformOwnedChild[] = [];

// Worktree-data cleanup drains daemon graph builds even without a local build.
// Keep fixture-spawned daemons owned until teardown instead of detaching them
// for the ordinary app/CLI idle grace.
jest.mock('@canopy/core-platform', () => {
  const actual = jest.requireActual<typeof CorePlatform>(
    '@canopy/core-platform',
  );
  return {
    ...actual,
    createOwnedChildServices: (
      options: Parameters<typeof actual.createOwnedChildServices>[0],
    ): ReturnType<typeof actual.createOwnedChildServices> => {
      const services = actual.createOwnedChildServices(options);
      return {
        ...services,
        spawn: async (request) => {
          const child = await services.spawn(request);
          children.push(child);
          return { ...child, commit: (): void => undefined };
        },
      };
    },
  };
});

import { disposeElectronDaemonConnections } from '../../../canopy-runtime/electron-daemon-access';

afterAll(async () => {
  await disposeElectronDaemonConnections();
  for (const child of children.splice(0)) {
    await child.terminate(AbortSignal.timeout(5_000));
    await child.exited;
  }
});
