'use client';
/**
 * `@canopy/ui-app/harness-setup`: the agent harness provider rows (gap 1 of
 * CAN-6718), shared by desktop Settings › Providers and web Remote Control.
 * State comes through `CanopyClient.harnessSetup`; presentation and
 * host-local follow-ups through `HarnessSetupHostProvider`.
 */
export * from './host';
export * from './CursorConnectionRow';
export * from './CopilotConnectionRow';
export * from './OpenCodeConnectionRow';
export * from './AntigravityConnectionRow';
export * from './ProviderSignInRow';
