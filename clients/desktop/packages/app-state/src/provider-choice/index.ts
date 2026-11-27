/**
 * `@canopy/app-state/provider-choice`: the shared provider-choice decision
 * behind recovery notices and locked-model picks. Pure TypeScript, no React,
 * no host imports; each host supplies source facts and renders the rows.
 */
export * from './types';
export * from './resolve-provider-choices';
export * from './other-billing-source';
export * from './resolve-billing-readiness';
