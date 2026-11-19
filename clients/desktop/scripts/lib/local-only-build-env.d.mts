export const LOCAL_ONLY_BUILD_ENV: 'CANOPY_LOCAL_ONLY';

export function readLocalOnlyBuildEnv(
  env?: Record<string, string | undefined>,
): boolean;

export function readCloudBaseUrlForBundle(
  env?: Record<string, string | undefined>,
): string;

export function readLaunchDarklyClientSideIdForBundle(
  env?: Record<string, string | undefined>,
): string;
