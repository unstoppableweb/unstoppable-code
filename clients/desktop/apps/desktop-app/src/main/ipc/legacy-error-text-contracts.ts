/** Explicit privacy exceptions: existing functional parsers require this text.
 * Keep channel and name/pattern together; display-only readers get catalog copy.
 * See docs/app-errors.md and .playwright/can-5115/ for consumer evidence. */
const namedContracts: readonly { channel: RegExp; name: RegExp }[] = [
  // feedback-report-client.ts restores submission outcomes for dialog recovery.
  {
    channel: /^feedback:(?:report-submit|submit)$/,
    name: /^(?:FeedbackOutcomeUnknownError|FeedbackSubmissionConflictError):/,
  },
  // renderer/client/ipc-canopy-client.ts: stale-save recovery.
  {
    channel: /^file:save-content$/,
    name: /^(?:FileSaveConflictError|FileSaveValidationError|FileSaveOperationalError):/,
  },
  // protocol/file-image-save.ts: restores these image-save failures by name.
  {
    channel: /^file:save-content$/,
    name: /^(?:FileNameConflictError|FileSaveUnsupportedError):/,
  },
  // AddRepoModal.tsx: W5 refuses before committing a remote workspace.
  { channel: /^workspace:/, name: /^W5CommitRefusedError:/ },
  // home/homeLinkTarget.ts: GitHub sign-in recovery, not arbitrary git errors.
  {
    channel: /^(?:home|github|workspace|worktree):/,
    name: /^GitHubAuthFailureError:/,
  },
  // hooks/useCopilotModels.ts: policy/sign-in has different retry behavior.
  {
    channel: /^copilot-connection:models$/,
    name: /^(?:CopilotPolicyError|CopilotSignInExpiredError):/,
  },
  // Chat dispatch detects unavailable Ollama and resource admission refusals.
  {
    channel: /^chat:(?:send-message|resume|continue)/,
    name: /^(?:OllamaServerUnavailableError|ResourceGuardError):/,
  },
  // Browser read target recovery uses the named refusal through IPC.
  {
    channel: /^browser:/,
    name: /^BrowserReadTargetError\[(?:target_not_found|target_stale|target_ambiguous|frame_unavailable|invalid_locator)\]:/,
  },
];

const plainContracts: readonly { channel: RegExp; text: RegExp }[] = [
  // feedback-report-client.ts invalidates snapshots instead of retrying them.
  {
    channel:
      /^feedback:(?:report-submit|submit|diagnostics-(?:prepare|read|save))$/,
    text: /^Error: (?:Diagnostics expired or are unavailable\. Prepare a new preview\.|Report context changed\. Prepare a new diagnostics preview\.|Account changed\. (?:Prepare diagnostics again|Reopen the report)\.)$/,
  },
  // pipelineRunsStore.ts distinguishes benign conflicts and cancel recovery.
  {
    channel: /^pipelines:(?:retry-matrix-job|cancel-matrix-variant)$/,
    text: /^Error: \[matrix\/[a-z-]+\] /,
  },
  // sharedSkillImport.ts reads this code before offering review refresh.
  // skillWriteError appends guidance; don't broaden the bare refusal grammar.
  {
    channel: /^skills:write-raw$/,
    text: /^Error: Skill unavailable \((?:replacement-unsupported|invalid-replacement|review-required|missing-copy|local-conflict|source-conflict|recovery-required)\)\. /,
  },
  // ui-shared/PluginAccountConnection.tsx selects configuration repair instead
  // of reconnecting for this fixed oauth-client.ts trust refusal.
  {
    channel: /^mcp-servers:start-oauth-login$/,
    text: /^Error: OAuth delegated endpoints are not trusted for this protected resource\.$/,
  },
  // ui-app/sharing/share-refusal-copy.ts: every share surface maps these fixed
  // refusals, whose only variable is a kebab-case reason, to their own copy.
  {
    channel: /^/,
    text: /^(?:Error|ResourceContextUnavailableError): (?:resource|workflow|pipeline|skill|agent|automation|collection|plugin) unavailable \([a-z-]+\)\.?$/i,
  },
  // activity/stop-background-process.ts: a task that is gone settles its card.
  {
    channel: /^activity:stop-bg-process$/,
    text: /status:\s*[a-z_]+|no active session|not running|unknown task|no such task/i,
  },
  // ui-app/capability/McpToolSelection.tsx: reauthorization, not a failed load.
  {
    channel: /^mcp-servers:list-account-upstream-tools$/,
    text: /^Error: mcp_reauth_required$/,
  },
  // ui-app/script-actions/review/review-model.ts: reload a changed definition.
  {
    channel: /^script-actions:/,
    text: /^ScriptActionsError: .*(?:stale|definition changed)/i,
  },
  // ui-app/local-memory/MemoryPanel.tsx: size and stale-edit recovery copy.
  {
    channel: /^local-memory:(?:update|delete)-(?:item|file)$/,
    text: /^(?:LocalMemory[A-Za-z]*Error: .*(?:too large to sync|conflict|changed|revision)|Error: Memory changed since you opened it\.)/i,
  },
  // protocol/remote-control/shell/repository-clone.ts: fixed saved-decision recovery copy.
  {
    channel: /^workspace:add-from-remote$/,
    text: /^Error: (?:This (?:change|request) was saved but did not finish and needs recovery\.|An earlier attempt of this request was interrupted and needs recovery\.)$/,
  },
  // ui-app/code/terminal/terminal-shell-unavailable.ts: unavailable shell recovery.
  {
    channel: /^terminal:(?:spawn|restore)$/,
    text: /^(?:(?:Error|[A-Za-z]+Error): )?Terminal shell unavailable: /,
  },
  // useInstalledSkillActions.tsx and RepoRulesReview.tsx: specific recovery actions.
  { channel: /^skills:update$/, text: /no longer found in source/i },
  { channel: /^repo-rules:apply$/, text: /scan again/i },
  // sharedResourceErrors.ts: HTTP recovery and unsupported CRUD capabilities.
  {
    channel: /^(?:skills|collections|agents|automations|pipelines):shared[-:]/,
    text: /(?:\b[45]\d\d\b|econnrefused|enotfound|etimedout|network|fetch failed|timeout|does not support.*-crud-v1)/i,
  },
  // homeLinkTarget.ts: sign-in/retry/access actions through the home-link adapters.
  {
    channel: /^github:list-user-repos$/,
    text: /rate limit|429|too many requests|auth|token|credential|connect|401|sign in|404|not found|access denied|forbidden/i,
  },
  {
    channel: /^settings:search-linear-issues$/,
    // Catalog offline copy contains "connection", which the recovery parser
    // mistakes for a request to connect Linear. Keep this fixed refusal exact.
    text: /connect|auth|credential|token|^Error: Couldn’t reach Linear\. Try again\.$/i,
  },
  // chat/slices/messaging.ts: sender reachability and stale Codex resumption.
  {
    channel: /^chat:send-message$/,
    text: /^Error: The agent that sent this message can no longer reach this chat\.$/,
  },
  {
    channel: /^chat:(?:send-message|resume)/,
    text: /\bno rollout found for thread id\b/i,
  },
  // lib/voice/voice-error.ts: platform-specific recovery choices from Swift/OS refusals.
  {
    channel: /^voice:(?:start|request-system-access)$/,
    text: /siri and dictation|dictation (?:are not available|is disabled|are disabled)|on-device speech recognition unavailable|locale|language|speech authorization denied|speechrecognizer|speech recognition.*denied|microphone.*(?:denied|refused|not allowed|blocked)|permission denied|not allowed|unsupported|not supported|macos 26 or later/i,
  },
];

export function preservesLegacyErrorText(
  channel: string,
  legacy: string,
): boolean {
  return (
    namedContracts.some(
      (entry): boolean =>
        entry.channel.test(channel) && entry.name.test(legacy),
    ) ||
    plainContracts.some(
      (entry): boolean =>
        entry.channel.test(channel) && entry.text.test(legacy),
    )
  );
}
