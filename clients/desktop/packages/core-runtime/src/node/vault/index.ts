// Host-only migration composition; never a remote-control or interface port.
export * from './migration-admission';
export * from './migration-evidence';
export * from './migration-platform';
export * from './migration-ports';
export * from './migration-protocol';
export * from './migration-sessions';
export * from './migration-module';
export * from './daemon-vault';
export * from './paths';
export * from './vault-module';
export * from './github-credential-authority';
export * from './github-credential-fence-store';
export * from './legacy-pat-generation';
export * from './credential-module';

export * from './migration-windows-verifier';
export * from './migration-linux-verifier';
export * from './copilot-grant-contracts';
export * from './copilot-grant-authority';
export * from './copilot-legacy-source';

export * from './copilot-import';
export * from './copilot-handoff-bridge';
export * from './copilot-handoff-core';

export {
  createCopilotMigrationUse,
  type CopilotUseCompletion,
} from './copilot-use';
