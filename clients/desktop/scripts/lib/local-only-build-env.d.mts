export const LOCAL_ONLY_BUILD_ENV: 'CANOPY_LOCAL_ONLY';

export const SELF_HOST_BUILD_ENV: 'CANOPY_SELF_HOST';

export function readLocalOnlyBuildEnv(
  env?: Record<string, string | undefined>,
): boolean;

export function readSelfHostBuildEnv(
  env?: Record<string, string | undefined>,
): boolean;

export function assertSelfHostCloudBaseUrl(value: string | undefined): string;

export function readCloudBaseUrlForBundle(
  env?: Record<string, string | undefined>,
): string;

export function readLaunchDarklyClientSideIdForBundle(
  env?: Record<string, string | undefined>,
): string;
