/**
 * Main-process entry to the local-only and self-host build profiles
 * (docs/local-only-build.md). Chokepoints read `isLocalOnlyBuild()`,
 * `isSelfHostBuild()` or `isEgressGuardedBuild()` from here; every other
 * main-process site asks `allowsAutomaticCall()` in `./policy` instead.
 */
export {
  isEgressGuardedBuild,
  isLocalOnlyBuild,
  isSelfHostBuild,
  LOCAL_ONLY_CHILD_ENV,
} from '@canopy/execution-engine/node/local-only-build';
