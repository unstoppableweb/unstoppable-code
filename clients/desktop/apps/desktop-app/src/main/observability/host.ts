// The desktop composition of observability's host ports (CAN-4136). The
// service takes everything Electron- or main-specific through this host, so
// it imports no instrumentation entry or main-local adapter itself. Provider
// account usage (Claude, Codex, Cursor, Copilot, OpenCode and Antigravity reads, feature
// flags and the account proxy) stays desktop-fed until CAN-4180.
import type { ObservabilityHostServices } from '@canopy/core-runtime/observability';
import {
  captureDesktopInstrumentationError,
  failDesktopOperation,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import type * as AccountProxyUsagePorts from '../account-proxy/service';
import {
  getAccountProxySessionUsage,
  onAccountProxyResponse,
} from '../account-proxy/attribution';
import { readClaudeOauthCredentialsResult } from '../auth/claude-oauth-credentials';
import {
  checkClaudeAuthStatusObserved,
  peekProviderAccountIdentity,
  peekProviderBillingAccountKind,
  warmProviderAccountIdentity,
} from '../auth/provider-auth-state';
import { getCodexRuntimeService } from '../codex/runtime-service';
import { readCopilotUsageSummary } from '../copilot/account-usage';
import { isCopilotHarnessEnabled } from '../copilot/feature-flag';
import { onCopilotUsageChanged } from '../copilot/usage-events';
import { readCursorAccountUsage } from '../cursor/account-usage';
import {
  onAntigravityAccountChanged,
  peekAntigravityAccount,
} from '../antigravity/account';
import { isAntigravityHarnessEnabled } from '../antigravity/feature-flag';
import { isCursorHarnessEnabled } from '../cursor/feature-flag';
import { getFeatureFlagService } from '../feature-flags';
import {
  fetchMockControlPlaneRecord,
  getMockLlmOrigin,
} from '../lib/e2e-mock-control-plane';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  onOpenCodeAccountsChanged,
  peekOpenCodeAccounts,
} from '../opencode/account-information';
import {
  getOpenAiPricingForCostingSync,
  prewarmOpenAiPricingCache,
} from '../openai-pricing/pricing-client';

type CodexAdmin = ReturnType<
  ReturnType<typeof getCodexRuntimeService>['admin']
>;

export interface DesktopObservabilityHost extends ObservabilityHostServices {
  readPreferences: typeof readPreferencesFile;
  claude: {
    checkAuthStatus: typeof checkClaudeAuthStatusObserved;
    readOauthCredentials: typeof readClaudeOauthCredentialsResult;
  };
  codexAdmin(): CodexAdmin;
  cursor: {
    isEnabled: typeof isCursorHarnessEnabled;
    readUsage: typeof readCursorAccountUsage;
  };
  copilot: {
    isEnabled: typeof isCopilotHarnessEnabled;
    readUsage: typeof readCopilotUsageSummary;
    onUsageChanged: typeof onCopilotUsageChanged;
  };
  openCode: {
    peekAccounts: typeof peekOpenCodeAccounts;
    onAccountsChanged: typeof onOpenCodeAccountsChanged;
  };
  /** Cached discovery metadata only; reading never launches the runtime. */
  antigravity?: {
    isEnabled: typeof isAntigravityHarnessEnabled;
    peekAccount: typeof peekAntigravityAccount;
    onAccountChanged: typeof onAntigravityAccountChanged;
  };
  onFeatureFlagsChanged(listener: () => void): () => void;
  accountProxy: {
    onResponse: typeof onAccountProxyResponse;
    sessionUsage: typeof getAccountProxySessionUsage;
    loadUsagePorts(): Promise<typeof AccountProxyUsagePorts>;
  };
  e2e: {
    mockLlmOrigin: typeof getMockLlmOrigin;
    fetchControlPlaneRecord: typeof fetchMockControlPlaneRecord;
  };
}

/**
 * Every member reads its adapter when called, so module mocks and a data
 * root that changes between calls behave as before the host existed.
 */
export function createDesktopObservabilityHost(): DesktopObservabilityHost {
  return {
    instrumentation: {
      startOperation: (name, options) => startDesktopOperation(name, options),
      succeedOperation: (name, options) =>
        succeedDesktopOperation(name, options),
      failOperation: (name, reason, options) =>
        failDesktopOperation(name, reason, options),
      captureError: (error, options) =>
        captureDesktopInstrumentationError(error, options),
    },
    accounts: {
      peekIdentity: (provider) => peekProviderAccountIdentity(provider),
      peekBillingAccountKind: (provider) =>
        peekProviderBillingAccountKind(provider),
      warmIdentity: (provider, reason) =>
        warmProviderAccountIdentity(provider, reason),
    },
    pricing: {
      current: () => getOpenAiPricingForCostingSync(),
      prewarm: () => prewarmOpenAiPricingCache(),
    },
    readAuditRetentionDays: async () =>
      (await readPreferencesFile()).auditRetentionDays,
    readPreferences: () => readPreferencesFile(),
    claude: {
      checkAuthStatus: (...args) => checkClaudeAuthStatusObserved(...args),
      readOauthCredentials: (...args) =>
        readClaudeOauthCredentialsResult(...args),
    },
    codexAdmin: () => getCodexRuntimeService().admin(),
    cursor: {
      isEnabled: () => isCursorHarnessEnabled(),
      readUsage: (...args) => readCursorAccountUsage(...args),
    },
    copilot: {
      isEnabled: () => isCopilotHarnessEnabled(),
      readUsage: (...args) => readCopilotUsageSummary(...args),
      onUsageChanged: (...args) => onCopilotUsageChanged(...args),
    },
    openCode: {
      peekAccounts: () => peekOpenCodeAccounts(),
      onAccountsChanged: (...args) => onOpenCodeAccountsChanged(...args),
    },
    antigravity: {
      isEnabled: () => isAntigravityHarnessEnabled(),
      peekAccount: () => peekAntigravityAccount(),
      onAccountChanged: (...args) => onAntigravityAccountChanged(...args),
    },
    onFeatureFlagsChanged: (listener) =>
      getFeatureFlagService().onSnapshotChanged(listener),
    accountProxy: {
      onResponse: (...args) => onAccountProxyResponse(...args),
      sessionUsage: (...args) => getAccountProxySessionUsage(...args),
      loadUsagePorts: () => import('../account-proxy/service'),
    },
    e2e: {
      mockLlmOrigin: () => getMockLlmOrigin(),
      fetchControlPlaneRecord: (...args) =>
        fetchMockControlPlaneRecord(...args),
    },
  };
}
