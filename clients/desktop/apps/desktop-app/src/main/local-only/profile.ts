/**
 * Main-process entry to the local-only build profile
 * (docs/local-only-build.md). Chokepoints read `isLocalOnlyBuild()` from
 * here; every other main-process site asks `allowsAutomaticCall()` in
 * `./policy` instead.
 */
export {
  isLocalOnlyBuild,
  LOCAL_ONLY_CHILD_ENV,
} from '@canopy/execution-engine/node/local-only-build';
