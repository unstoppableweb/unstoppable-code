/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'node',
  // A worker keeps the heap of every suite it ran. CI runs each shard as a
  // targeted run, without the shard loop's per-file recycling, so a worker
  // that grows past this between suites is replaced instead of running out
  // of the shard's heap.
  workerIdleMemoryLimit: '1GB',
  roots: [
    '<rootDir>/apps/desktop-app/src',
    '<rootDir>/apps/core-daemon/src',
    '<rootDir>/packages',
  ],
  // Golden tests live in __tests__/ (see scripts/golden-suites.mjs). Local TDD
  // tests live in gitignored __scratch__/ directories and are never committed.
  testPathIgnorePatterns: ["<rootDir>/apps/desktop-app/src/main/lib/__tests__/internal-root-migration-qualification.test.ts","<rootDir>/scripts/run-internal-root-migration-qualification.mjs","<rootDir>/packages/core-platform/src/__tests__/windows-process-native.test.ts","<rootDir>/packages/desktop-shared/src/node/internal-root-migration/__tests__/cold-proof-qualification.test.ts","<rootDir>/apps/desktop-app/src/main/__tests__/windows-phase3-qualification.test.ts","<rootDir>/apps/desktop-app/scripts/windows-phase3-qualify.mjs","<rootDir>/apps/desktop-app/src/main/__tests__/fixtures/windows-phase3/electron.ts","<rootDir>/apps/desktop-app/src/main/lib/__tests__/w5-recovery-daemon.test.ts","<rootDir>/apps/desktop-app/src/main/lib/__tests__/fixtures/w5-recovery-daemon-child.ts","<rootDir>/apps/desktop-app/src/main/lib/__tests__/fixtures/w5-recovery-refusal-child.ts","<rootDir>/packages/core-runtime/src/node/vault/__tests__/copilot-grant-authority.test.ts","<rootDir>/apps/desktop-app/src/main/canopy-runtime/__tests__/fixtures/electron-w5-record-port-daemon.ts","<rootDir>/packages/desktop-shared/src/node/lib/__tests__/admitted-storage-paths-manifest.test.ts","<rootDir>/packages/core-platform/src/__tests__/secret-protection.win32.test.ts","<rootDir>/packages/core-platform/src/__tests__/secret-protection.darwin.test.ts","<rootDir>/packages/core-platform/src/__tests__/secret-protection.linux.test.ts","<rootDir>/packages/protocol/src/__tests__/ui-labels-mobile-mirror.test.ts","<rootDir>/apps/desktop-app/src/main/w5-commit-log/__tests__/commit-log-host-construction.test.ts","<rootDir>/apps/desktop-app/src/main/canopy-runtime/__tests__/daemon-files-route.test.ts","<rootDir>/apps/desktop-app/src/main/canopy-runtime/__tests__/daemon-files-route-connection.test.ts","<rootDir>/apps/desktop-app/src/main/canopy-runtime/__tests__/daemon-files-route-remote.test.ts","<rootDir>/apps/desktop-app/src/main/canopy-runtime/__tests__/electron-daemon-caller-lifetime.test.ts","<rootDir>/apps/desktop-app/src/main/canopy-runtime/__tests__/electron-w5-record-port.test.ts","<rootDir>/apps/desktop-app/src/main/canopy-runtime/__tests__/electron-w5-record-port-stopped.test.ts","<rootDir>/apps/desktop-app/src/main/canopy-runtime/__tests__/daemon-status-host-change.qualification.test.ts","<rootDir>/apps/desktop-app/src/main/__tests__/pipeline-harness/invariants.test.ts","<rootDir>/apps/desktop-app/src/main/__tests__/provider-turn-contract-fixtures.pipeline.test.ts","<rootDir>/apps/desktop-app/src/main/__tests__/provider-turn-launch-profile.pipeline.test.ts","<rootDir>/packages/protocol/src/__tests__/core-workspace-metadata-contracts.test.ts"],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.test.tsx',
    '**/__scratch__/**/*.test.ts',
    '**/__scratch__/**/*.test.tsx',
  ],
  // Tests spawn `git` in temp repositories; drop inherited repository
  // variables (set when run from a Git hook) before any worker forks.
  globalSetup: '<rootDir>/scripts/lib/jest-git-env-isolation.mjs',
  setupFiles: [
    '<rootDir>/scripts/lib/jest-web-encoding-setup.cjs',
    '<rootDir>/apps/desktop-app/src/__tests__/jestDataDirIsolation.ts',
    '<rootDir>/apps/desktop-app/src/__tests__/jestElectronLogSetup.ts',
    '<rootDir>/apps/desktop-app/src/__tests__/jestSecureStorageSetup.ts',
    '<rootDir>/apps/desktop-app/src/__tests__/jestW5FileStoreSetup.ts',
    '<rootDir>/apps/desktop-app/src/__tests__/jestCodeGraphResourcesSetup.ts',
  ],
  moduleNameMapper: {
    '^@canopy/mcp-oauth-core$':
      '<rootDir>/packages/mcp-oauth-core/src/index.ts',
    '^@canopy/memory-consolidation$':
      '<rootDir>/packages/memory-consolidation/src/index.ts',
    '^@canopy/memory-consolidation/(.*)$':
      '<rootDir>/packages/memory-consolidation/src/$1',
    '^@canopy/pipeline-interop$':
      '<rootDir>/packages/pipeline-interop/src/index.ts',
    '^@canopy/pipeline-interop/(.*)$':
      '<rootDir>/packages/pipeline-interop/src/$1',
    '\\.(css|less|sass|scss)$':
      '<rootDir>/apps/desktop-app/src/__tests__/styleMock.ts',
    '^ansi_up$': '<rootDir>/apps/desktop-app/src/__tests__/ansiUpMock.ts',
    '^@anthropic-ai/claude-agent-sdk$':
      '<rootDir>/apps/desktop-app/src/__tests__/claudeAgentSdkMock.ts',
    '^electron$': '<rootDir>/apps/desktop-app/src/__tests__/electronMock.ts',
    '^react-diff-viewer-continued$':
      '<rootDir>/apps/desktop-app/src/__tests__/reactDiffViewerMock.tsx',
    '^mammoth$': '<rootDir>/node_modules/mammoth/mammoth.browser.js',
    '^.+\\?worker&url$':
      '<rootDir>/apps/desktop-app/src/__tests__/viteWorkerUrlMock.ts',
    '^@/(.*)$': '<rootDir>/apps/desktop-app/src/renderer/src/$1',
    '^@canopy/protocol$': '<rootDir>/packages/protocol/src/index.ts',
    '^@canopy/protocol/(.*)$': '<rootDir>/packages/protocol/src/$1',
    '^@canopy/agent-actions$': '<rootDir>/packages/agent-actions/src/index.ts',
    '^@canopy/agent-actions/(.*)$': '<rootDir>/packages/agent-actions/src/$1',
    '^@canopy/remote-session$':
      '<rootDir>/packages/remote-session/src/index.ts',
    '^@canopy/plugin-interop$':
      '<rootDir>/packages/plugin-interop/src/index.ts',
    '^@canopy/plugin-interop/(.*)$': '<rootDir>/packages/plugin-interop/src/$1',
    '^@canopy/agent-transcript$':
      '<rootDir>/packages/agent-transcript/src/index.ts',
    '^@canopy/agent-transcript/(.*)$':
      '<rootDir>/packages/agent-transcript/src/$1',
    '^@canopy/core-runtime$': '<rootDir>/packages/core-runtime/src/index.ts',
    '^@canopy/core-runtime/(.*)$': '<rootDir>/packages/core-runtime/src/$1',
    '^@canopy/core-platform$': '<rootDir>/packages/core-platform/src/index.ts',
    '^@canopy/core-platform/(.*)$': '<rootDir>/packages/core-platform/src/$1',
    '^@canopy/core-transport$':
      '<rootDir>/packages/core-transport/src/index.ts',
    '^@canopy/core-transport/(.*)$': '<rootDir>/packages/core-transport/src/$1',
    '^@canopy/core-client$': '<rootDir>/packages/core-client/src/index.ts',
    '^@canopy/core-client/(.*)$': '<rootDir>/packages/core-client/src/$1',
    '^@canopy/copilot-recipient/(.*)$':
      '<rootDir>/packages/copilot-recipient/src/$1',
    '^@canopy/code-graph$': '<rootDir>/packages/code-graph/src/index.ts',
    '^@canopy/code-graph/(.*)$': '<rootDir>/packages/code-graph/src/$1',
    '^@canopy/execution-engine/(.*)$':
      '<rootDir>/packages/execution-engine/src/$1',
    '^@canopy/desktop-shared$':
      '<rootDir>/packages/desktop-shared/src/index.ts',
    '^@canopy/desktop-shared/(.*)$': '<rootDir>/packages/desktop-shared/src/$1',
    '^@canopy/desktop-instrumentation$':
      '<rootDir>/packages/desktop-instrumentation/src/index.ts',
    '^@canopy/desktop-instrumentation/(.*)$':
      '<rootDir>/packages/desktop-instrumentation/src/$1',
    '^@canopy/ui-shared$': '<rootDir>/packages/ui-shared/src/index.ts',
    '^@canopy/ui-shared/(.*)$': '<rootDir>/packages/ui-shared/src/$1',
    '^@canopy/ui-rich$': '<rootDir>/packages/ui-rich/src/index.ts',
    '^@canopy/ui-rich/(.*)$': '<rootDir>/packages/ui-rich/src/$1',
    '^@canopy/ipc-canopy-client$':
      '<rootDir>/packages/ipc-canopy-client/src/index.ts',
    '^@canopy/ipc-canopy-client/(.*)$':
      '<rootDir>/packages/ipc-canopy-client/src/$1',
    '^@canopy/app-core$': '<rootDir>/packages/app-core/src/index.ts',
    '^@canopy/app-core/(.*)$': '<rootDir>/packages/app-core/src/$1',
    '^@canopy/app-state$': '<rootDir>/packages/app-state/src/index.ts',
    '^@canopy/app-state/(.*)$': '<rootDir>/packages/app-state/src/$1',
    '^@canopy/ui-app$': '<rootDir>/packages/ui-app/src/index.ts',
    '^@canopy/ui-app/(.*)$': '<rootDir>/packages/ui-app/src/$1',
    '^@canopy/brand/current$':
      '<rootDir>/.cache/brand/current/desktop-brand.ts',
    '^@canopy/brand/web$': '<rootDir>/scripts/public-build/web-brand-fixture.ts',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(?:mdast-util-[^/]+|micromark[^/]*|unist-util-[^/]+|decode-named-character-reference|devlop|character-entities|ccount|escape-string-regexp|longest-streak|markdown-table|zwitch|dequal)/)',
  ],
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  transform: require('./scripts/lib/jest-swc-transform.cjs').transform,
  globals: {
    __DEP_CLAUDE_CLI__: '1.0.0',
    __DEP_CLAUDE_SDK__: '^0.1.0',
    __DEP_CODEX_CLI__: '2.0.0',
    __DEP_CODEX_SDK__: '^0.2.0',
    __DEP_GH_CLI__: '3.0.0',
    __DEP_OLLAMA_CLI__: '0.14.0',
    __DEP_RTK_CLI__: '0.37.2',
    __DEP_OCTOKIT__: '^4.0.0',
    // Same projection electron.vite.config.ts injects for the main bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    __CANOPY_CURSOR_CLI__: require('./package.json')['cursor-cli'],
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    __CANOPY_COPILOT_CLI__: require('./package.json')['copilot-cli'],
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    __CANOPY_CLIPROXYAPI__: require('./package.json').cliproxyapi,
    __CANOPY_BRAND_ID__: 'canopy',
    __CANOPY_BRAND_DISPLAY_NAME__: 'Canopy',
    __CANOPY_BRAND_CLI_NAME__: 'canopy',
    __CANOPY_RELEASE_FLAVOR__: 'stable',
    __CANOPY_UD_OAUTH_ENV__: 'staging',
    __CANOPY_INTERNAL_RELEASE_INDICATOR__: '',
    __CANOPY_UPDATE_BASE_URL__: 'https://releases.unstoppable.ai',
    __CANOPY_APP_VERSION__: '0.0.0-test',
    __CANOPY_POSTHOG_ENABLED__: false,
    __CANOPY_POSTHOG_PROJECT_KEY__: '',
    __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
    __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: 0,
    __CANOPY_POSTHOG_STUB_URL__: undefined,
    __CANOPY_E2E__: false,
    __CANOPY_DESKTOP_SIDEBAR_SHADOW__: false,
    __CANOPY_DESKTOP_SHARED_SIDEBAR__: false,
    __CANOPY_OLLAMA_ENABLED__: true,
    __CANOPY_MOCK_LLM_BASE_URL__: undefined,
    __CANOPY_LINEAR_API_BASE_URL__: undefined,
  },
};

module.exports = config;
