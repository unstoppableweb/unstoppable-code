import type { LabsExperimentAvailability } from '../experiments';

/**
 * Client-visible feature flag registry shared by Canopy Desktop and Canopy
 * Web. This module is intentionally environment-neutral — it cannot import
 * Electron, Next.js, Prisma, or any other runtime-bound surface — so both
 * the desktop renderer and the web client can safely depend on it.
 *
 * Server-only flag definitions never live here. The LaunchDarkly evaluation
 * logic that decides each flag's value runs in the desktop main process and
 * in the Next.js server runtime; the result is projected onto this registry
 * shape and shipped to the renderer/client via the transport defined in
 * `packages/desktop-shared/src/types.ts`.
 */

/**
 * Canonical client-visible feature flag registry. Each entry pairs a stable
 * LaunchDarkly key with the two compile-time-known fallback values Canopy
 * needs to distinguish:
 *
 * - `launchDarklyDisabledDefaultValue` applies when LaunchDarkly is not
 *   configured for the current runtime.
 * - `launchDarklyEnabledUnavailableValue` applies when LaunchDarkly is
 *   configured but has not returned a live value yet.
 * - `localOnlyDefaultValue` applies in a local-only desktop build
 *   (docs/local-only-build.md), whatever LaunchDarkly is configured to. A flag
 *   whose feature needs our cloud, relay, gateway, LaunchDarkly or PostHog is
 *   hosted and takes its off value; every other flag copies
 *   `launchDarklyDisabledDefaultValue`. It is listed after the two
 *   LaunchDarkly values because scripts/browser-profiles-build-config.py
 *   matches that adjacent pair in bundled output.
 *
 * Desktop keeps the last live value after LaunchDarkly returns data at least
 * once. Web server evaluation intentionally does not cache live values: a
 * communication error uses the LaunchDarkly-enabled unavailable fallback for
 * that request.
 *
 * To add a new client-visible flag:
 *
 * 1. Confirm the intended values for both LaunchDarkly default modes and
 *    for local-only builds (required: typecheck fails without it).
 * 2. Add a new entry to this object with typed defaults for every mode and
 *    its {@link FeatureFlagOwnership}.
 * 3. Extend {@link ClientFeatureFlagValues} so the value type is pinned per
 *    key (TypeScript will surface every missed update site).
 * 4. Add the matching entries to the default maps below.
 */
interface ClientFeatureFlagDefinition {
  readonly key: string;
  readonly launchDarklyDisabledDefaultValue: boolean | number | string;
  readonly launchDarklyEnabledUnavailableValue: boolean | number | string;
  readonly localOnlyDefaultValue: boolean | number | string;
  readonly ownership: FeatureFlagOwnership;
  readonly description: string;
}

/**
 * Where a flag is evaluated (CAN-4181). `core`: a backend host gates
 * behavior on it (desktop main, the daemon, the web server). `interface`:
 * only UI reads it to decide presentation. `both`: each does. Core serves
 * `core` and `both` flags through `core.featureFlag.*`; an `interface` flag
 * never crosses that contract. A flag nothing reads yet is `interface`
 * until a core host starts gating on it.
 */
export type FeatureFlagOwnership = 'core' | 'interface' | 'both';

export const CLIENT_FEATURE_FLAGS = {
  canopyAiGatewaySettingsEnabled: {
    key: 'canopy-ai-gateway-settings-enabled',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description: 'Personal and organization AI gateway setup.',
  },
  canopyDesktopLabsEarlyAccess: {
    key: 'canopy-desktop-labs-early-access',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'both',
    description: 'Availability of the account Early access experiment.',
  },
  canopyDesktopLabsSidebar: {
    key: 'canopy-desktop-labs-sidebar',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'core',
    description: 'Availability of the Sidebar experiment.',
  },
  canopyDesktopLabsActivityCard: {
    key: 'canopy-desktop-labs-activity-card',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'core',
    description: 'Availability of the Chat activity card experiment.',
  },
  // Historical UI rollout keys remain reserved for older client snapshots.
  // Current clients ignore them; see docs/feature-flags.md for retirement policy.
  canopyDesktopLabsMinimalLayout: {
    key: 'canopy-desktop-labs-minimal-layout',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description: 'Availability of the Minimal workspace layout experiment.',
  },
  canopyDesktopLabsCometSpinners: {
    key: 'canopy-desktop-labs-comet-spinners',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description: 'Availability of the Comet spinners experiment.',
  },
  canopyDesktopLabsChatTabPreviews: {
    key: 'canopy-desktop-labs-chat-tab-previews',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description: 'Availability of the Tab previews experiment.',
  },
  canopyDesktopLabsSubagentsView: {
    key: 'canopy-desktop-labs-subagents-view',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description: 'Availability of the Subagents view experiment.',
  },
  canopyDesktopLabsArchivedChatsCard: {
    key: 'canopy-desktop-labs-archived-chats-card',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description: 'Availability of the Archived chats card experiment.',
  },
  canopyDesktopLabsCompactQueue: {
    key: 'canopy-desktop-labs-compact-queue',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description: 'Availability of the Compact queue experiment.',
  },
  canopyDesktopLabsProxyAccountCards: {
    key: 'canopy-desktop-labs-proxy-account-cards',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description: 'Availability of the Proxy account cards experiment.',
  },
  canopyDesktopLabsPrHoverCards: {
    key: 'canopy-desktop-labs-pr-hover-cards',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description: 'Availability of the Pull request cards experiment.',
  },
  canopyDesktopLabsSmoothStreaming: {
    key: 'canopy-desktop-labs-smooth-streaming',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description: 'Availability of the Smooth streaming experiment.',
  },
  // Retired Labs selector; preserve its wire key and availability values.
  canopyDesktopLabsDaemonFilesReads: {
    key: 'canopy-desktop-labs-daemon-files-reads',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description:
      'Obsolete Files Labs selector. Retained only for wire compatibility.',
  },
  // Retired Labs selector; preserve its wire key and availability values.
  canopyDesktopLabsDaemonTerminals: {
    key: 'canopy-desktop-labs-daemon-terminals',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description:
      'Obsolete terminal Labs selector. Retained only for wire compatibility.',
  },
  // Retired Labs selector; preserve its wire key and availability values.
  canopyDesktopLabsDaemonCodeGraph: {
    key: 'canopy-desktop-labs-daemon-code-graph',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description:
      'Obsolete code graph Labs selector. Retained only for wire compatibility.',
  },
  // Retired Labs selector; preserve its wire key and availability values.
  canopyDesktopLabsDaemonScripts: {
    key: 'canopy-desktop-labs-daemon-scripts',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description:
      'Obsolete daemon scripts Labs selector. Retained only for wire compatibility.',
  },
  // Retired Labs selector; preserve its wire key and availability values.
  canopyDesktopLabsDaemonPipelines: {
    key: 'canopy-desktop-labs-daemon-pipelines',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description:
      'Obsolete daemon workflows Labs selector. Retained only for wire compatibility.',
  },
  canopyDesktopLabsOrchestratorPage: {
    key: 'canopy-desktop-labs-orchestrator-page',
    // Off until opted in: the Orchestrator opens as a page in the main window.
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'core',
    description: 'Availability of the Orchestrator page Labs experiment.',
  },
  canopyDesktopLabsBots: {
    key: 'canopy-desktop-labs-bots',
    // Hidden in both modes until LaunchDarkly serves it.
    launchDarklyDisabledDefaultValue: 'hidden',
    launchDarklyEnabledUnavailableValue: 'hidden',
    localOnlyDefaultValue: 'hidden',
    ownership: 'core',
    description: 'Availability of the Bots Labs experiment.',
  },
  canopyDesktopLabsPromptSuggestions: {
    key: 'canopy-desktop-labs-prompt-suggestions',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'interface',
    description:
      'Obsolete next prompt suggestions Labs selector. Retained only for wire compatibility.',
  },
  canopyDesktopLabsOverviewPage: {
    key: 'canopy-desktop-labs-overview-page',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'core',
    description: 'Availability of the Overview page Labs experiment.',
  },
  canopyDesktopLabsKanbanPage: {
    key: 'canopy-desktop-labs-kanban-page',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'core',
    description: 'Availability of the Kanban page Labs experiment.',
  },
  canopyDesktopLabsStatisticsPage: {
    key: 'canopy-desktop-labs-statistics-page',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'core',
    description: 'Availability of the Statistics page Labs experiment.',
  },
  canopyDesktopLabsAuditTrailPage: {
    key: 'canopy-desktop-labs-audit-trail-page',
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'core',
    description: 'Availability of the Audit Trail page Labs experiment.',
  },
  canopyDesktopLabsCustomizeDiscovery: {
    key: 'canopy-desktop-labs-customize-discovery',
    // Off until opted in: Customize keeps its current tabs (CAN-6809).
    launchDarklyDisabledDefaultValue: 'offered',
    launchDarklyEnabledUnavailableValue: 'offered',
    localOnlyDefaultValue: 'offered',
    ownership: 'both',
    description: 'Availability of the New Customize Labs experiment.',
  },
  canopyPostHogCaptureEnabled: {
    key: 'canopy-desktop-posthog-capture-enabled',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (PostHog): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Allows desktop PostHog capture only within the bundled instrumentation settings.',
  },
  canopyPostHogSessionReplaySampleRate: {
    key: 'canopy-desktop-posthog-session-replay-sample-rate',
    // A percentage ceiling: 100 leaves the build-time rate unchanged.
    launchDarklyDisabledDefaultValue: 100,
    launchDarklyEnabledUnavailableValue: 0,
    // Hosted (PostHog): off in a local-only build.
    localOnlyDefaultValue: 0,
    ownership: 'interface',
    description:
      'Caps desktop PostHog replay sampling at a percentage from 0 to 100; never enables replay by itself.',
  },
  canopyPostHogAutocaptureEnabled: {
    key: 'canopy-desktop-posthog-autocapture-enabled',
    // Matches the capture flag. Release builds always bundle LaunchDarkly, so
    // they fail closed and each environment opts in once its PostHog billing
    // limit covers the added click events.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (PostHog): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'interface',
    description:
      'Allows desktop PostHog click autocapture, rage clicks, dead clicks, and heatmaps while capture is enabled; never enables capture by itself.',
  },
  canopySharedReleaseNotesEnabled: {
    key: 'canopy-shared-release-notes-enabled',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (release notes are read from our cloud): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Controls release-note reads, changelog access, and desktop highlights.',
  },
  canopyLedgerEnabled: {
    key: 'canopy-ledger-enabled',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Gates the Agent Ledger local store and core handlers, agent tools, Feed panel, and Feed page.',
  },
  canopySharedClaudeModelFable5: {
    key: 'canopy-shared-claude-model-fable5',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: false,
    ownership: 'interface',
    description:
      'Controls whether the shared Claude Fable 5 model is visible and usable.',
  },
  canopyDigestsEnabled: {
    key: 'canopy-digests-enabled',
    // No LaunchDarkly configuration at all means local development, tests, and
    // the E2E harness — where the digest settings, list, detail, and share
    // surfaces need to be reachable without standing up LaunchDarkly.
    launchDarklyDisabledDefaultValue: true,
    // Configured but unreachable stays FAIL-CLOSED, and the asymmetry is the
    // point: every deployed environment sets `LAUNCHDARKLY_SDK_KEY`, so an
    // outage or an evaluation error there takes this branch, not the one
    // above. That matters more for this flag than for a purely visual one —
    // it also gates fan-out, which spends model budget and sends email.
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (Work Digests are generated and delivered by our cloud): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Controls periodic Work Digest generation, delivery, and settings surfaces.',
  },
  canopySharedCustomAgents: {
    key: 'canopy-shared-custom-agents',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls whether shared custom agent UI surfaces are visible in desktop and web.',
  },
  canopyCloudSignInRequired: {
    key: 'canopy-cloud-sign-in-required',
    launchDarklyDisabledDefaultValue: false,
    // Flipped false (CAN-934): guest mode lets a new user reach the shell with
    // no account, so the sign-in wall no longer fails closed when LaunchDarkly
    // is configured but has not returned a live value yet. The flag is retained
    // as a per-environment release gate (staging targeted true, prod off).
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (cloud account sign-in): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'interface',
    description:
      'Requires a connected Canopy Cloud account before the desktop app shell is usable; shows a blocking sign-in splash when disconnected.',
  },
  canopyGuestModeEnabled: {
    key: 'canopy-guest-mode-enabled',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (guest sessions are minted by our cloud): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Controls whether desktop first-run shows the guest-mode consent screen (guest session, no account required) instead of the blocking Cloud sign-in gate.',
  },
  canopyDesktopPrSplit: {
    key: 'canopy-desktop-pr-split',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls whether desktop PR Split entry points are visible and usable.',
  },
  canopyDesktopSharedAutomationsWorkflowForm: {
    key: 'canopy-desktop-shared-automations-workflow-form',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      "Controls whether desktop shares chat automations that it would otherwise share in chat form (packaged installs, native chat automations, container automations) as workflows (CAN-6455). Off until recipients run a desktop that binds a workflow's project input.",
  },
  canopyDesktopChatFormat4Promotion: {
    key: 'canopy-desktop-chat-format4-promotion',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: false,
    ownership: 'core',
    description:
      'Controls whether desktop promotes writable chat scopes to storage format 4. Turning it off stops new promotions and never demotes a promoted scope.',
  },
  canopyDesktopCursorHarness: {
    key: 'canopy-desktop-cursor-harness',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls desktop Cursor settings, model selection, and interactive runtime access.',
  },
  canopyDesktopCursorHarnessReleased: {
    key: 'canopy-desktop-cursor-harness-released',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: false,
    ownership: 'interface',
    description:
      'Promotes Cursor out of Labs into Accounts and harness discovery when the Cursor harness gate is also enabled.',
  },
  canopyDesktopAntigravityHarness: {
    key: 'canopy-desktop-antigravity-harness',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls desktop Antigravity setup, model discovery, and runtime access.',
  },
  canopyDesktopAntigravityHarnessReleased: {
    key: 'canopy-desktop-antigravity-harness-released',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: false,
    ownership: 'interface',
    description:
      'Promotes Antigravity setup from Labs to Providers when the Antigravity harness gate is also enabled.',
  },
  canopyDesktopCopilotHarness: {
    key: 'canopy-desktop-copilot-harness',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Controls desktop GitHub Copilot setup, model selection, and runtime access.',
  },
  canopyDesktopCopilotHarnessReleased: {
    key: 'canopy-desktop-copilot-harness-released',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: false,
    ownership: 'interface',
    description:
      'Promotes GitHub Copilot setup out of Labs into Accounts when the Copilot harness gate is also enabled.',
  },
  canopyDesktopOpenCodeHarness: {
    key: 'canopy-desktop-opencode-harness',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls desktop OpenCode setup, model selection, and runtime access.',
  },
  canopyDesktopOpenCodeHarnessReleased: {
    key: 'canopy-desktop-opencode-harness-released',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: false,
    ownership: 'interface',
    description:
      'Promotes OpenCode setup out of Labs into Accounts when the OpenCode harness gate is also enabled.',
  },
  canopyDesktopClaudeTuiWorkers: {
    key: 'canopy-desktop-claude-tui-workers',
    // Fails open when LaunchDarkly is not configured so local/self-hosted
    // desktop builds preserve existing Claude Worker behavior. Once
    // LaunchDarkly is configured, unavailable evaluation falls back to off and
    // worker mode preferences are treated as read-only `canopy` overrides.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls whether desktop Claude Worker terminal-mode settings and execution paths are visible and usable.',
  },
  canopyDesktopClaudeTuiChats: {
    key: 'canopy-desktop-claude-tui-chats',
    // Fails open when LaunchDarkly is not configured so local/self-hosted
    // desktop builds preserve existing Claude Code chat behavior. Once
    // LaunchDarkly is configured, unavailable evaluation falls back to off and
    // chat interface mode preferences are treated as read-only `canopy`
    // overrides.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls whether desktop Claude Code chat terminal-mode settings and composer controls are visible and usable.',
  },
  canopyDesktopClaudeModAdmission: {
    key: 'canopy-desktop-claude-mod-admission',
    // On when LaunchDarkly is not configured, so local development builds
    // gate Mods by admission. Release builds bundle a LaunchDarkly client ID,
    // so users get it only where the flag is enabled there.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'core',
    description:
      'Controls personal Claude Mod admission before desktop Claude launches.',
  },
  canopyDesktopClaudeModSurface: {
    key: 'canopy-desktop-claude-mod-surface',
    // As admission: on when LaunchDarkly is not configured (local development),
    // off when it is configured but unavailable. Needs admission on too.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'core',
    description:
      'Controls whether an admitted Claude Mod draws its toasts, status lines and log lines in desktop Claude chats.',
  },
  canopyDesktopWorkspaceCodeGraph: {
    key: 'canopy-desktop-workspace-code-graph',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls whether desktop code-graph generation (worktree-create and agent-invoked builds) and the nine code-graph injected tools are advertised, executed, and mentioned in agent prompts. Desktop-only; the SEA CLI is a separate surface and is not gated.',
  },
  canopyDesktopChatVisuals: {
    key: 'canopy-desktop-chat-visuals',
    // On when LaunchDarkly is not configured, so local development and tests
    // exercise visuals; release builds always bundle a client ID. Fails closed
    // when LaunchDarkly is configured but unavailable.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'core',
    description:
      'Controls whether desktop chat visuals are offered to agents and whether new visual tool calls can execute.',
  },
  canopyBillingEnabled: {
    key: 'canopy-billing-enabled',
    // On when LaunchDarkly is not configured so local dev exercises billing
    // surfaces without an LD setup. Still fails closed when LaunchDarkly is
    // configured-but-unavailable, so deployed environments preserve today's
    // behavior (AI-Credits gate for data sync)
    // until the flag is explicitly enabled.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (billing): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Gates all Canopy billing surfaces (Stripe payment collection, pricing tiers/trials, native AI credits, billing panels, public pricing page, admin billing API). Off by default; every billing surface checks this one flag server-side.',
  },
  canopyDesktopSuggestedPrompts: {
    key: 'canopy-desktop-suggested-prompts',
    // Kill switch only: the feature degrades safely on its own (generic
    // fallback prompts, inert hidden states), so both fallback modes stay
    // enabled and LaunchDarkly can turn it off remotely if needed.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: true,
    localOnlyDefaultValue: true,
    ownership: 'interface',
    description:
      'Controls whether MCP-aware suggested prompts render on the desktop New Task and blank chat empty states.',
  },
  canopyDesktopStartPage: {
    key: 'canopy-desktop-start-page',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls project start-page persistence, publication, and first-open behavior on desktop.',
  },
  canopyDesktopSharedContainers: {
    key: 'canopy-desktop-shared-containers',
    // On when LaunchDarkly is not configured so local development and the E2E
    // harness can exercise the invite/manage surfaces without an LD setup.
    // Deployed environments fail CLOSED and stay closed until a revision
    // producer exists (CAN-2547/2548): CAN-2544 shipped grants but no content
    // sink, so an invite today grants access to a container with no content.
    // The asymmetry is the release sequencing, not an oversight.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (shared containers are hosted): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Controls whether desktop shared-container invite, manage, and revoke entry points are visible and usable on code worktrees and Cowork Work Entries.',
  },
  canopySharedContainerExternalSharing: {
    key: 'canopy-shared-container-external-sharing',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (shared containers are hosted): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Controls direct shared-container grants and email invitations outside an organization.',
  },
  canopyCloudAgents: {
    key: 'canopy-cloud-agents',
    // Dark-launched in deployed environments: cloud workspaces (agentic-core
    // backed chats) are hidden — UI section absent and /api/cloud/* returns
    // 404 — until explicitly enabled in LaunchDarkly, and evaluator errors fail
    // closed. The LaunchDarkly-disabled default is ON so local development and
    // the E2E harness can exercise the surface without an LD environment;
    // `prepare:dev` seeds the staging agentic-core credentials, and a runtime
    // that never configured Core still degrades cleanly through
    // `isAgenticCoreConfigured()`. Every deployed environment sets
    // LAUNCHDARKLY_SDK_KEY, so this branch is unreachable there.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (cloud agents): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Shows cloud (agentic-core) workspaces in the web Chat tab and enables the /api/cloud endpoints.',
  },
  canopyActivationJourneyEnabled: {
    key: 'canopy-activation-journey-enabled',
    // Both defaults are false: an unconfigured or degraded runtime must never
    // fire lifecycle marketing. A dev build should not spontaneously notify,
    // and a LaunchDarkly outage must not be the reason a user gets a nudge.
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (lifecycle campaigns are hosted): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Controls whether the post-install activation notification journey schedules and delivers campaigns on desktop.',
  },
  canopyOrgProjectsEnabled: {
    key: 'canopy-shared-org-projects-enabled',
    // An unconfigured runtime (local development, no LaunchDarkly) shows
    // organization projects (decision 2026-09-28). A LaunchDarkly outage still
    // hides them rather than expose surfaces to users who are not targeted, and
    // server helpers fail closed on evaluation errors with the unavailable
    // value. Enforced at the server operation boundary (`org-projects-v1` is
    // minted only when this evaluates true for the API user), not only in
    // visible UI.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (organization projects are hosted): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Gates organization projects: the Personal/organization context switcher, org project catalog and setup, and the organization admin Projects surface across desktop and web.',
  },
  canopySharedAutoModelRouting: {
    key: 'canopy-shared-auto-model-routing',
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (Auto routing runs in our cloud): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Controls Jev-powered per-turn Auto model routing, its organization Statistics attribution, and the automatic model routing backtest (Statistics and profile).',
  },
  canopySharedMcpAccountConnections: {
    key: 'canopy-shared-mcp-account-connections',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (web vault and hosted MCP proxy): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Account-scoped MCP connections (web vault + proxy) in the cloud picker and desktop MCP tab',
  },
  canopySharedSpaceNotificationSettings: {
    key: 'canopy-shared-space-notification-settings',
    // Unconfigured means local development, tests and the E2E harness, where
    // the per-space choices should be reachable without LaunchDarkly. A
    // configured-but-unavailable deployment hides the controls and rejects
    // writes; saved choices are still read and enforced either way.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Shows the per-space notification choices and accepts changes to them; never disables reading or enforcing saved choices.',
  },
  canopyCloudDurableTerminals: {
    key: 'canopy-cloud-durable-terminals',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (cloud terminals): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Cloud terminals on durable sandbox terminals through the web core (worker.terminal.*), surviving a page reload',
  },
  canopyDesktopCloudChats: {
    key: 'canopy-desktop-cloud-chats',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (cloud chats): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Temporary: cloud cowork chats in the desktop sidebar and chat view through the web core (CAN-4185); remove at CAN-4186 rollout.',
  },
  canopyDesktopCloudCopyInstalledSkills: {
    key: 'canopy-desktop-cloud-copy-installed-skills',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (cloud copies of installed skills): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      "Temporary: a desktop cloud chat's picker offers skills installed from GitHub, a URL or a local folder for a private cloud copy (CAN-6943); main refuses them while off.",
  },
  /**
   * @deprecated Retained for shipped builds; no current code reads it. Free
   * access is the only mode: the subscription tier system and its money
   * movement were removed. Keep the declaration and the LaunchDarkly flag
   * (serving `true`, client-side availability unchanged) until telemetry shows
   * no live build older than that removal, then delete both.
   */
  canopyFreeAccessEnabled: {
    key: 'canopy-free-access-enabled',
    // CAN-3926. Older desktop and web builds read this flag directly. With
    // LaunchDarkly not configured they present free mode; with LaunchDarkly
    // configured but unavailable they present tier mode. The current server
    // no longer moves subscription money in any flag state, so an OFF
    // evaluation only changes what those older clients render.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (billing (deprecated)): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'interface',
    description:
      'Deprecated: retained for shipped builds. Makes every app feature free for signed-in users in older clients; no current code reads it.',
  },
  canopyDesktopAccountProxy: {
    key: 'canopy-desktop-account-proxy',
    // On in unconfigured local builds; configured but unavailable fails
    // closed, so release builds stay off until LaunchDarkly serves `true`.
    // The per-user opt-in preference (`accountProxyEnabled`) still gates
    // every surface.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls the desktop account proxy (CLIProxyAPI): the Labs opt-in, its settings, and routing agents through it.',
  },
  canopyDesktopMemoryLearnFromChats: {
    key: 'canopy-desktop-memory-learn-from-chats',
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: false,
    ownership: 'both',
    description: 'Learn local memory from eligible completed chat turns.',
  },
  canopyDesktopSkillSuggestions: {
    key: 'canopy-desktop-skill-suggestions',
    // Unconfigured builds keep the feature, matching the Cursor harness
    // rollout. Configured but unavailable fails closed so a slow or failed
    // first fetch cannot bypass the kill switch.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Controls desktop repeat-task skill suggestions: recording repeated requests, the idle scan, the composer banner, and the Settings section. The Settings toggle opts out on top of this flag.',
  },
  canopyDesktopDaemonFilesReads: {
    key: 'canopy-desktop-daemon-files-reads',
    // Obsolete boolean retained for wire compatibility; no longer selects Files routing.
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: false,
    ownership: 'interface',
    description:
      'Obsolete Files selector. Retained only for wire compatibility.',
  },
  canopyWebCoreClient: {
    key: 'canopy-web-core-client',
    // Off everywhere until browser features move onto the web core
    // (CAN-6092 to CAN-6094); the /chat route evaluates it per user.
    launchDarklyDisabledDefaultValue: false,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (web core): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'both',
    description:
      'Web /chat opens and holds a shared-protocol connection to the web core (CAN-6091); no feature uses it yet.',
  },
  canopyDesktopExternalAgentsMenu: {
    key: 'canopy-desktop-external-agents-menu',
    // On without LaunchDarkly, so local builds show the row; off when
    // LaunchDarkly is configured but unavailable. The hosted MCP page has its
    // own server gate.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    // Hosted (opens a hosted page through the Portal): off in a local-only build.
    localOnlyDefaultValue: false,
    ownership: 'interface',
    description:
      'Shows the External agents (MCP) row in the desktop account menu, which opens the hosted page through the authenticated Portal.',
  },
  canopySharedAgentSecretRequests: {
    key: 'canopy-shared-agent-secret-requests',
    // On without LaunchDarkly, so development builds and tests can reach the
    // feature; off when LaunchDarkly is configured but unavailable, and
    // production stays off until the flag serves true there.
    launchDarklyDisabledDefaultValue: true,
    launchDarklyEnabledUnavailableValue: false,
    localOnlyDefaultValue: true,
    ownership: 'both',
    description:
      'Agent secret requests: the RequestSecrets, RunWithSecrets and WriteSecretsFile tools, the secret request form, and the secret_requests capability cloud clients advertise.',
  },
} as const satisfies Record<string, ClientFeatureFlagDefinition>;

/**
 * Convenience union of every registered flag's TypeScript handle (the
 * property name on {@link CLIENT_FEATURE_FLAGS}). Useful in call sites that
 * want to refer to a flag by its registry key rather than its LaunchDarkly
 * string.
 */
export type ClientFeatureFlagName = keyof typeof CLIENT_FEATURE_FLAGS;

/**
 * Closed union of every LaunchDarkly key surfaced to clients. Type-level
 * source of truth for IPC bridge declarations, web client hooks, and the
 * `requiredFeatureFlag` marker on App Advisor action metadata.
 */
export type ClientFeatureFlagKey =
  (typeof CLIENT_FEATURE_FLAGS)[ClientFeatureFlagName]['key'];

type CoreOwnedFlag = Extract<
  (typeof CLIENT_FEATURE_FLAGS)[ClientFeatureFlagName],
  { ownership: 'core' | 'both' }
>;

/** A flag core evaluates: owned by core or shared with interfaces. */
export type CoreFeatureFlagKey = CoreOwnedFlag['key'];

/** The keys `core.featureFlag.*` serves (CAN-4181). */
export const CORE_FEATURE_FLAG_KEYS: ReadonlySet<CoreFeatureFlagKey> = new Set(
  Object.values(CLIENT_FEATURE_FLAGS)
    .filter((flag): flag is CoreOwnedFlag => flag.ownership !== 'interface')
    .map((flag) => flag.key),
);

export function isCoreFeatureFlagKey(key: string): key is CoreFeatureFlagKey {
  return Object.values(CLIENT_FEATURE_FLAGS).some(
    (flag) => flag.key === key && flag.ownership !== 'interface',
  );
}

/**
 * Map of every registered client-visible flag key to its evaluated value
 * type. Extending the registry MUST extend this type so consumers cannot
 * accidentally read an undeclared key.
 */
export type ClientFeatureFlagValues = {
  [CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSidebar
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsActivityCard
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsMinimalLayout
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCometSpinners
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsChatTabPreviews
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSubagentsView
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsArchivedChatsCard
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsProxyAccountCards
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsPrHoverCards
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonFilesReads
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonTerminals
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonCodeGraph
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonScripts
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonPipelines
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsOrchestratorPage
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsBots.key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsPromptSuggestions
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsOverviewPage
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsAuditTrailPage
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCustomizeDiscovery
    .key]: LabsExperimentAvailability;
  [CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyPostHogSessionReplaySampleRate.key]: number;
  [CLIENT_FEATURE_FLAGS.canopyPostHogAutocaptureEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDigestsEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopSharedAutomationsWorkflowForm
    .key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopChatFormat4Promotion.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarnessReleased.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarnessReleased.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModSurface.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyBillingEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopSuggestedPrompts.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopStartPage.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyCloudAgents.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopySharedSpaceNotificationSettings.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyCloudDurableTerminals.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopCloudCopyInstalledSkills.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyFreeAccessEnabled.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopMemoryLearnFromChats.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyDesktopDaemonFilesReads.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopyWebCoreClient.key]: boolean;
  [CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests.key]: boolean;
};

/**
 * Default mode used when creating an in-code fallback snapshot.
 *
 * - `launchdarkly_disabled` means LaunchDarkly is not configured, so the app
 *   should preserve its non-LaunchDarkly behavior.
 * - `launchdarkly_enabled_unavailable` means LaunchDarkly is configured but
 *   the evaluator cannot supply data yet. This should usually be the more
 *   conservative value. Desktop uses this until the first successful
 *   evaluation and then keeps the last live value across transient
 *   LaunchDarkly failures. Web server evaluation uses this on each
 *   communication failure.
 */
export type FeatureFlagDefaultMode =
  | 'launchdarkly_disabled'
  | 'launchdarkly_enabled_unavailable';

/**
 * Default values used when LaunchDarkly is not configured for the current
 * runtime. The keys here MUST match the runtime evaluator's projection so
 * consumers always see a full set of flag values.
 *
 * The object is `readonly` at the type level but consumers MUST NOT mutate
 * it directly. Use {@link getClientFeatureFlagDefaults} or
 * {@link getDefaultFeatureFlagSnapshot} to obtain a fresh object whose
 * `values` can be safely mutated by the caller.
 */
export const CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS: ClientFeatureFlagValues =
  {
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSidebar.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSidebar
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsActivityCard.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsActivityCard
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsMinimalLayout.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsMinimalLayout
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCometSpinners.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCometSpinners
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsChatTabPreviews.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsChatTabPreviews
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSubagentsView.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSubagentsView
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsArchivedChatsCard.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsArchivedChatsCard
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsProxyAccountCards.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsProxyAccountCards
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsPrHoverCards.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsPrHoverCards
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonFilesReads.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonFilesReads
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonTerminals.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonTerminals
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonCodeGraph.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonCodeGraph
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonScripts.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonScripts
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonPipelines.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonPipelines
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsOrchestratorPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsOrchestratorPage
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsBots.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsBots
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsPromptSuggestions.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsPromptSuggestions
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsOverviewPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsOverviewPage
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsAuditTrailPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsAuditTrailPage
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCustomizeDiscovery.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCustomizeDiscovery
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyPostHogSessionReplaySampleRate.key]:
      CLIENT_FEATURE_FLAGS.canopyPostHogSessionReplaySampleRate
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyPostHogAutocaptureEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyPostHogAutocaptureEnabled
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]:
      CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDigestsEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyDigestsEnabled
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]:
      CLIENT_FEATURE_FLAGS.canopySharedCustomAgents
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]:
      CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSharedAutomationsWorkflowForm.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedAutomationsWorkflowForm
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopChatFormat4Promotion.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopChatFormat4Promotion
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarnessReleased
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarnessReleased
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModSurface.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModSurface
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyBillingEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyBillingEnabled
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSuggestedPrompts.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSuggestedPrompts
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopStartPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopStartPage
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key]:
      CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyCloudAgents.key]:
      CLIENT_FEATURE_FLAGS.canopyCloudAgents.launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting.key]:
      CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key]:
      CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedSpaceNotificationSettings.key]:
      CLIENT_FEATURE_FLAGS.canopySharedSpaceNotificationSettings
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyCloudDurableTerminals.key]:
      CLIENT_FEATURE_FLAGS.canopyCloudDurableTerminals
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCloudCopyInstalledSkills.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCloudCopyInstalledSkills
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyFreeAccessEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyFreeAccessEnabled
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopMemoryLearnFromChats.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopMemoryLearnFromChats
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopDaemonFilesReads.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopDaemonFilesReads
        .launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyWebCoreClient.key]:
      CLIENT_FEATURE_FLAGS.canopyWebCoreClient.launchDarklyDisabledDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests.key]:
      CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests
        .launchDarklyDisabledDefaultValue,
  };

/**
 * Fallback values used while LaunchDarkly is configured but unavailable.
 * Desktop uses these until it has a live value cached; web server evaluation
 * uses them on each LaunchDarkly communication failure.
 *
 * The object is `readonly` at the type level but consumers MUST NOT mutate
 * it directly. Use {@link getClientFeatureFlagDefaults} or
 * {@link getDefaultFeatureFlagSnapshot} to obtain a fresh object whose
 * `values` can be safely mutated by the caller.
 */
export const CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS: ClientFeatureFlagValues =
  {
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSidebar.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSidebar
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsActivityCard.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsActivityCard
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsMinimalLayout.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsMinimalLayout
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCometSpinners.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCometSpinners
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsChatTabPreviews.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsChatTabPreviews
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSubagentsView.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSubagentsView
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsArchivedChatsCard.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsArchivedChatsCard
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsProxyAccountCards.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsProxyAccountCards
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsPrHoverCards.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsPrHoverCards
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonFilesReads.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonFilesReads
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonTerminals.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonTerminals
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonCodeGraph.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonCodeGraph
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonScripts.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonScripts
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonPipelines.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonPipelines
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsOrchestratorPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsOrchestratorPage
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsBots.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsBots
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsPromptSuggestions.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsPromptSuggestions
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsOverviewPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsOverviewPage
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsAuditTrailPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsAuditTrailPage
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCustomizeDiscovery.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCustomizeDiscovery
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyPostHogSessionReplaySampleRate.key]:
      CLIENT_FEATURE_FLAGS.canopyPostHogSessionReplaySampleRate
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyPostHogAutocaptureEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyPostHogAutocaptureEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]:
      CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDigestsEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyDigestsEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]:
      CLIENT_FEATURE_FLAGS.canopySharedCustomAgents
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]:
      CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSharedAutomationsWorkflowForm.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedAutomationsWorkflowForm
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopChatFormat4Promotion.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopChatFormat4Promotion
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarnessReleased
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarnessReleased
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModSurface.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModSurface
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyBillingEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyBillingEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSuggestedPrompts.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSuggestedPrompts
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopStartPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopStartPage
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key]:
      CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyCloudAgents.key]:
      CLIENT_FEATURE_FLAGS.canopyCloudAgents
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting.key]:
      CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key]:
      CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopySharedSpaceNotificationSettings.key]:
      CLIENT_FEATURE_FLAGS.canopySharedSpaceNotificationSettings
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyCloudDurableTerminals.key]:
      CLIENT_FEATURE_FLAGS.canopyCloudDurableTerminals
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCloudCopyInstalledSkills.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCloudCopyInstalledSkills
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyFreeAccessEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyFreeAccessEnabled
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopMemoryLearnFromChats.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopMemoryLearnFromChats
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopDaemonFilesReads.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopDaemonFilesReads
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopyWebCoreClient.key]:
      CLIENT_FEATURE_FLAGS.canopyWebCoreClient
        .launchDarklyEnabledUnavailableValue,
    [CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests.key]:
      CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests
        .launchDarklyEnabledUnavailableValue,
  };

/**
 * Values used in a local-only desktop build (docs/local-only-build.md),
 * whatever LaunchDarkly is configured to. Only hosted flags differ from
 * {@link CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS}. Web never reads
 * this map.
 *
 * The object is `readonly` at the type level but consumers MUST NOT mutate
 * it directly. Use {@link getLocalOnlyClientFeatureFlagDefaults}.
 */
export const CLIENT_FEATURE_FLAG_LOCAL_ONLY_DEFAULTS: ClientFeatureFlagValues =
  {
    [CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSidebar.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSidebar.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsActivityCard.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsActivityCard.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsMinimalLayout.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsMinimalLayout.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCometSpinners.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCometSpinners.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsChatTabPreviews.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsChatTabPreviews
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSubagentsView.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSubagentsView.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsArchivedChatsCard.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsArchivedChatsCard
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsProxyAccountCards.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsProxyAccountCards
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsPrHoverCards.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsPrHoverCards.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonFilesReads.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonFilesReads
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonTerminals.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonTerminals
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonCodeGraph.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonCodeGraph
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonScripts.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonScripts.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonPipelines.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonPipelines
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsOrchestratorPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsOrchestratorPage
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsBots.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsBots.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsPromptSuggestions.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsPromptSuggestions
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsOverviewPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsOverviewPage.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsAuditTrailPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsAuditTrailPage
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopLabsCustomizeDiscovery.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCustomizeDiscovery
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyPostHogSessionReplaySampleRate.key]:
      CLIENT_FEATURE_FLAGS.canopyPostHogSessionReplaySampleRate
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyPostHogAutocaptureEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyPostHogAutocaptureEnabled
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]:
      CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDigestsEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyDigestsEnabled.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]:
      CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]:
      CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSharedAutomationsWorkflowForm.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedAutomationsWorkflowForm
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopChatFormat4Promotion.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopChatFormat4Promotion
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarnessReleased
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarnessReleased
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModSurface.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModSurface.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyBillingEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyBillingEnabled.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSuggestedPrompts.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSuggestedPrompts.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopStartPage.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopStartPage.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key]:
      CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyCloudAgents.key]:
      CLIENT_FEATURE_FLAGS.canopyCloudAgents.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting.key]:
      CLIENT_FEATURE_FLAGS.canopySharedAutoModelRouting.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key]:
      CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedSpaceNotificationSettings.key]:
      CLIENT_FEATURE_FLAGS.canopySharedSpaceNotificationSettings
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyCloudDurableTerminals.key]:
      CLIENT_FEATURE_FLAGS.canopyCloudDurableTerminals.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopCloudCopyInstalledSkills.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopCloudCopyInstalledSkills
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyFreeAccessEnabled.key]:
      CLIENT_FEATURE_FLAGS.canopyFreeAccessEnabled.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopMemoryLearnFromChats.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopMemoryLearnFromChats
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopDaemonFilesReads.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopDaemonFilesReads.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyWebCoreClient.key]:
      CLIENT_FEATURE_FLAGS.canopyWebCoreClient.localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu.key]:
      CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu
        .localOnlyDefaultValue,
    [CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests.key]:
      CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests
        .localOnlyDefaultValue,
  };

/** A fresh copy of {@link CLIENT_FEATURE_FLAG_LOCAL_ONLY_DEFAULTS}. */
export function getLocalOnlyClientFeatureFlagDefaults(): ClientFeatureFlagValues {
  return { ...CLIENT_FEATURE_FLAG_LOCAL_ONLY_DEFAULTS };
}

/**
 * Backward-compatible alias for defaults used when LaunchDarkly is not
 * configured. Prefer the explicit default maps in new code so call sites make
 * the LaunchDarkly mode clear.
 */
export const CLIENT_FEATURE_FLAG_DEFAULTS =
  CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS;

/** Flag keys whose values are Labs experiment availabilities. */
export const LABS_EXPERIMENT_FLAG_KEYS: ReadonlySet<string> = new Set([
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsSidebar.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsActivityCard.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsMinimalLayout.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsCometSpinners.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsChatTabPreviews.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsSubagentsView.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsArchivedChatsCard.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsProxyAccountCards.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsPrHoverCards.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonFilesReads.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonTerminals.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonCodeGraph.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonScripts.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonPipelines.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsOrchestratorPage.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsBots.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsPromptSuggestions.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsOverviewPage.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsAuditTrailPage.key,
  CLIENT_FEATURE_FLAGS.canopyDesktopLabsCustomizeDiscovery.key,
]);

export function isLabsExperimentFlagKey(key: string): boolean {
  return LABS_EXPERIMENT_FLAG_KEYS.has(key);
}

export function getClientFeatureFlagDefaults(
  mode: FeatureFlagDefaultMode,
): ClientFeatureFlagValues {
  return mode === 'launchdarkly_disabled'
    ? { ...CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS }
    : { ...CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS };
}

export function getClientFeatureFlagDefaultValue(
  key: ClientFeatureFlagKey,
  mode: FeatureFlagDefaultMode,
): ClientFeatureFlagValues[ClientFeatureFlagKey] {
  return getClientFeatureFlagDefaults(mode)[key];
}

/**
 * Returns true only when a snapshot carries an explicitly enabled flag value
 * from a configured LaunchDarkly lifecycle. This is useful for dark-launched
 * surfaces that must stay hidden when LaunchDarkly is absent, even if the
 * flag's LaunchDarkly-disabled default preserves older behavior elsewhere.
 */
export function isClientFeatureFlagConfirmedEnabled(
  snapshot: Pick<FeatureFlagSnapshot, 'status' | 'values'>,
  key: ClientFeatureFlagKey,
): boolean {
  return snapshot.status !== 'not_configured' && snapshot.values[key] === true;
}

function inferDefaultModeFromStatus(
  status: FeatureFlagSnapshotStatus,
): FeatureFlagDefaultMode {
  return status === 'not_configured'
    ? 'launchdarkly_disabled'
    : 'launchdarkly_enabled_unavailable';
}

/**
 * Lifecycle status of a feature flag snapshot.
 *
 * - `not_configured` — LaunchDarkly is not configured for the current
 *   runtime; LaunchDarkly-disabled defaults are in effect.
 * - `initializing` — the evaluator is starting and has not produced a
 *   verdict yet; LaunchDarkly-enabled unavailable fallbacks are in effect
 *   unless the evaluator deliberately preserves prior live values.
 * - `ready` — the evaluator has returned at least one verdict and the
 *   snapshot reflects live LaunchDarkly state.
 * - `error` — the evaluator hit an error. Values are the evaluator's chosen
 *   fallback values: desktop may preserve prior live values, while web server
 *   evaluation uses LaunchDarkly-enabled unavailable fallbacks.
 */
export type FeatureFlagSnapshotStatus =
  | 'not_configured'
  | 'initializing'
  | 'ready'
  | 'error';

/**
 * Wire envelope used by both desktop main → renderer and web server →
 * client to deliver feature flag verdicts.
 *
 * `updatedAt` is an ISO-8601 string so the snapshot is JSON-serializable
 * across IPC and HTTP boundaries without timezone ambiguity. `initialized`
 * stays `false` until the underlying evaluator has produced at least one
 * verdict, even when `values` already holds defaults — consumers that need
 * to distinguish "default while initializing" from "default after error"
 * MUST inspect `status` instead of `initialized`.
 */
export interface FeatureFlagSnapshot {
  values: ClientFeatureFlagValues;
  status: FeatureFlagSnapshotStatus;
  initialized: boolean;
  updatedAt: string;
  error: string | null;
}

/**
 * Build a fresh snapshot whose `values` is a brand-new object cloned from the
 * appropriate default map for the supplied status. Callers can safely mutate
 * the returned snapshot without affecting a registry default or any other
 * outstanding snapshot.
 *
 * @param status Defaults to `'not_configured'` — the right answer for
 *   callers that simply need a baseline before the evaluator initializes.
 * @param error Defaults to `null`; supply a string when minting a snapshot
 *   that represents an evaluator failure.
 * @param mode Defaults from `status`: `not_configured` uses
 *   `launchdarkly_disabled`, while every other status uses
 *   `launchdarkly_enabled_unavailable`.
 */
export function getDefaultFeatureFlagSnapshot(
  status: FeatureFlagSnapshotStatus = 'not_configured',
  error: string | null = null,
  mode: FeatureFlagDefaultMode = inferDefaultModeFromStatus(status),
): FeatureFlagSnapshot {
  return {
    values: getClientFeatureFlagDefaults(mode),
    status,
    initialized: false,
    updatedAt: new Date(0).toISOString(),
    error,
  };
}
