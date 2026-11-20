/**
 * Mobile invokes and push filters in apps/mobile/lib/device_link/** and
 * apps/mobile/lib/ui/features/device_link/computer_connect/** (provider usage,
 * Orchestrator questions and windows, and execution-indicator pushes).
 * Includes conditional workspace/worktree branches and optional runtime reads.
 */
export const MOBILE_CONTROLLER_CHANNELS = [
  'account-proxy:changed',
  'account-proxy:status',
  'activity:changed-files',
  'activity:file-diff',
  'activity:list-live-bg-tasks',
  'activity:live-bg-tasks-changed',
  'activity:stop-bg-process',
  'app-advisor:settings-changed',
  'app-advisor:tool-request',
  'app-advisor:tool-request-cancelled',
  'app-advisor:tool-response',
  'app-advisor:watcher-delete',
  'app-advisor:watchers-changed',
  'app-advisor:watchers-completed-list',
  'app-advisor:watchers-list',
  'app-advisor:window-command',
  'app-advisor:window-renderer-ready',
  'chat-project:list',
  'chat-search:catalog',
  'chat-search:updated',
  'chat:cancel',
  'chat:command',
  'chat:get-state',
  'chat:get-transcript-page',
  'chat:queue-get-snapshot',
  'chat:queue-updated',
  'chat:send-message',
  'chat:set-interest',
  'chat:set-state-scopes',
  'chat:state-changed',
  'clone-jobs:background',
  'clone-jobs:changed',
  'clone-jobs:list',
  'code-graph:build-status-changed',
  'collections:load-index',
  'copilot-connection:status',
  'cursor-connection:status',
  'desktop:session-snapshot',
  'desktop:session-snapshot-invalidate',
  'desktop:session-snapshot-stale',
  // The mobile file viewer resolves roots, then reads reports and linked images.
  'file-tree:roots',
  'file:read-content',
  'github:create-pr',
  'github:merge-pr',
  'github:merge-pr-progress',
  'github:pr-creation-progress',
  'github:pr-status-event',
  'github:request-fast-refresh',
  'home:list-branch-targets',
  'hook:complete',
  'hook:load-worktree-runs',
  'hook:source-info',
  'hook:started',
  'invocable-inventory:changed',
  'invocable-inventory:load',
  'managed-delegation:activity-changed',
  'managed-delegation:activity-list',
  'managed-delegation:stop',
  'managed-delegation:stop-all',
  'managed-delegation:tree',
  'mcp-servers:load-index',
  'model-registry:get',
  'observability:event',
  'observability:load-snapshot',
  'observability:refresh-usage',
  'org-projects:ownership-changed',
  'pipelines:cancel-execution',
  'pipelines:discover-project',
  'pipelines:execute',
  'pipelines:execution-event',
  'pipelines:get',
  'pipelines:get-execution',
  'pipelines:list',
  'pipelines:list-executions',
  'pipelines:queue-event',
  'pipelines:read-report-file',
  'pipelines:read-step-log',
  'pipelines:resume',
  'pipelines:retry-execution',
  'pipelines:step-output-event',
  'plugins:loadCacheOnly',
  'preferences:changed',
  'preferences:load',
  'projects:load',
  'repo:default-clone-dir',
  'script:complete',
  'script:load-worktree-runs',
  'script:source-info',
  'script:started',
  'sidebar-item-groups:changed',
  'skills:load',
  'terminal:exit',
  'terminal:running-changed',
  'terminal:spawned',
  'tracked-plans:list',
  'tracked-plans:updated',
  'work-entries:create',
  'work-entries:list',
  'workspace-items:delete-attachment',
  'workspace-items:import-attachments',
  'workspace:add-from-remote',
  'workspace:archive-worktree',
  'workspace:create-worktree',
  'workspace:worktrees-updated',
  'worktree-summary:load',
  'worktree-summary:updated',
  'worktree:archive',
  'worktree:branch-changed',
  'worktree:create',
  'worktree:get-path',
  'worktree:git-failed',
  'worktree:git-ready',
  'worktree:set-paused-hooks',
  'worktrees:file-changed',
] as const;

/**
 * Browser controllers (CAN-5985): `deriveRemoteIpcChannels` over every
 * operation the web composite (`apps/web/src/lib/canopy-client/
 * workspaces-canopy-client.ts`) routes to its direct child, under the web
 * capabilities (`WEB_DIRECT_REMOTE_OPERATIONS` and
 * `directRemoteCapabilities` in `direct-remote-child.ts`), including every
 * conditional branch. Operations the web keeps on web-side clients (billing,
 * external agents, account and organization operations, install-update
 * emails) and every capability the web leaves off (terminals, file writes,
 * item grouping, delegation lifetime, tips, suggestions, journals,
 * discard, provider quotas, shared multi-repo) add nothing. The web golden
 * keeps this list equal to that derivation and drives the composite with a
 * transport that refuses anything else.
 *
 * Reviewed by effect, like the mobile list:
 * - Reads: session snapshot and its stale push, chat events and transcript
 *   pages, one chat scope's state (`chat:get-state`, for a tab close), the
 *   model registry (a picked model's provider), file roots, index,
 *   directories, reads and link resolution, one-file diffs, tracked plans,
 *   workspace instructions and scripts, worktree path and repo entries,
 *   projects.
 * - Chat: queue cancel, edit, force and edit lock; `chat:cancel` (stop a
 *   chat's turn, or exactly one turn); `work-entries:create` (a new
 *   standalone chat's Work Entry); and `chat:command`, which the adapter uses
 *   to create and close tabs, send messages, change composer settings, mark
 *   read or unread, answer and dismiss questions (including approval
 *   questions, which an interactive browser user answers as on mobile and
 *   Portal), steer and deliver input. It is a generic chat dispatch: the host
 *   authorizes by channel, so a browser can send any chat command the desktop
 *   accepts there, as Portal's relay of the same commands can today. Every
 *   chat channel here is also on the mobile list.
 * - Workspaces and worktrees: clone from a remote, update, reorder, create,
 *   label, hide, archive, save instructions and scripts, and delete a
 *   workspace (`project:delete`, `workspace:delete`; the web UI also gates
 *   deletion behind its destructive-actions flag, as on Portal).
 * - Execution: scripts, hooks and pipelines run and stop; Git push, pull and
 *   commit-and-push; PR status refresh.
 * - Phase 7 direct gaps:
 *   - Orchestrator: `work-entries:list` and `chat:get-state` (its rows),
 *     `chat:send-message` (a send that records this browser as the chat's
 *     driver, as mobile sends), and on the App Advisor surface the question
 *     push and withdrawal, `app-advisor:tool-response` (answer, dismiss, or
 *     refuse a view the browser cannot show) and
 *     `app-advisor:window-renderer-ready` (redeliver waiting questions).
 *   - Reads: composer menus (`editor:list-slash-commands`,
 *     `editor:list-invocables`), the plugin picker (`plugin-catalog:list`),
 *     a pipeline's detail, runs, one run and a step's log.
 *     `editor:resolve-invocable` prepares a row (as the desktop composer
 *     does) and writes no chat state; enabling it is a `chat:command` patch.
 *   - Actions: delete a tracked plan, regenerate a worktree summary (LLM
 *     work, as Portal's refresh), delete a watcher, resume, retry or rerun a
 *     pipeline run and import a curated pipeline the computer verifies by
 *     hash.
 * - Phase 7 panels:
 *   - Reads: a worktree's plan, script, hook, pipeline and summary rows
 *     (`worktree:activity-entities`, the entities Portal's worktree snapshot
 *     carries, built by the same readers) and one script run's log tail
 *     (`script:read-run-log`); the Orchestrator settings view
 *     (`app-advisor:settings-view`: model, thinking level, plugin selections,
 *     project access, instructions, archive settings and the catalogs the
 *     settings form offers).
 *   - Pushes the desktop's own panels refresh on: pipeline execution events,
 *     tracked plan changes, hook and script starts and completions (their
 *     completion carries the run's output, as the desktop renderer and mobile
 *     receive it), and worktree summary updates. No output streams.
 *   - Actions: pause or resume one hook or every hook (`hook:change-pause`,
 *     applied by the computer to the latest worktree row, replacing the
 *     client read-modify-write over `worktree:set-paused-hooks`, which a
 *     browser no longer reaches); save Orchestrator settings
 *     (`app-advisor:settings-patch`, the patch Portal's settings save
 *     applies, including the Orchestrator's project access, which the
 *     browser user could already change through Portal).
 * - Script review (CAN-6038): the snapshot and the post-add receipt (reads),
 *   `script-actions:rescan` (a detection scan; it runs nothing),
 *   `script-actions:review` (approve, dismiss or reset entries, human-only),
 *   the shortcut, pin and shell-alias-consent writes the desktop's own review
 *   dialog makes, and the `script-actions:changed` push the snapshot
 *   refreshes on. `script-actions:found` is not listed: notices poll the
 *   receipt as Portal does. No terminal channel is added.
 * - Claude Mods (CAN-7436):
 *   - `claude-mods:get` reads the computer's Mod admission state.
 *   - `claude-mods:update` allows or disallows a plugin's Mod and sets the
 *     turn-off-every-Mod switch. The host authorizes by channel, so a paired
 *     browser can send any update the desktop's handler accepts, not only
 *     what the web UI offers, as Portal's `portal.claude_mods.update` could.
 *   - `claude-mods:surface-push` carries a chat's Mod toasts, status lines,
 *     log lines, band and pane trees; the host withholds composer requests
 *     and withdrawals from every controller.
 *   - `claude-mods:surface-command` sends presses, edits, picks, pane and
 *     scroll commands and `resend`; the host refuses `composer-answer`, and
 *     a command whose kind it cannot read.
 * - Portal retirement (CAN-5986): `work-entries:list-archived`, a cowork
 *   project's archived and deleted Work Entries and its legacy archived
 *   chats, the overview Portal's archived list served. Read only; it
 *   restores, deletes or reopens nothing.
 * - Personal project conversion (CAN-7440): `personal-organization-upgrade:
 *   list` reads the computer's convertible Personal projects. `:status` reads
 *   one saved run's progress; acknowledging a finished run also removes that
 *   run's record from the computer's conversion journal. `:convert` creates
 *   and shares an organization project from each selected Personal project
 *   as the computer's signed-in account, only into an organization that
 *   account belongs to (the desktop service checks the destination against
 *   fresh server state), and switches the computer's app to that
 *   organization. It deletes nothing. `:promote`, `:invite` and
 *   `:invite-status` stay off: the browser's own session creates the team
 *   and sends invites.
 * - Terminals: none. Remote Control on the web is terminal-free.
 */
export const BROWSER_CONTROLLER_CHANNELS: readonly string[] = [
  'activity:file-diff',
  'app-advisor:settings-patch',
  'app-advisor:settings-view',
  'app-advisor:tool-request',
  'app-advisor:tool-request-cancelled',
  'app-advisor:tool-response',
  'app-advisor:watcher-delete',
  'app-advisor:window-renderer-ready',
  'chat:cancel',
  'chat:command',
  'chat:event',
  'chat:get-state',
  'chat:get-transcript-page',
  'chat:queue-cancel',
  'chat:queue-edit',
  'chat:queue-force',
  'chat:queue-set-edit-lock',
  'chat:send-message',
  'claude-mods:get',
  'claude-mods:surface-command',
  'claude-mods:surface-push',
  'claude-mods:update',
  'desktop:session-snapshot',
  'desktop:session-snapshot-invalidate',
  'desktop:session-snapshot-stale',
  'editor:list-invocables',
  'editor:list-slash-commands',
  'editor:resolve-invocable',
  'file-index:get',
  'file-reference:resolve',
  'file-tree:directory',
  'file-tree:roots',
  'file:read-content',
  'github:commit-and-push',
  'github:pull',
  'github:push-only',
  'github:request-refresh',
  'hook:change-pause',
  'hook:complete',
  'hook:run',
  'hook:started',
  'hook:stop',
  'model-registry:get',
  'personal-organization-upgrade:convert',
  'personal-organization-upgrade:list',
  'personal-organization-upgrade:status',
  'pipelines:cancel-execution',
  'pipelines:curated-import',
  'pipelines:discover-project',
  'pipelines:execute',
  'pipelines:execution-event',
  'pipelines:get',
  'pipelines:get-for-worktree',
  'pipelines:get-worktree-execution',
  'pipelines:list-worktree-executions',
  'pipelines:read-step-log',
  'pipelines:rerun-execution',
  'pipelines:resume',
  'pipelines:retry-execution',
  'plugin-catalog:list',
  'project:delete',
  'projects:load',
  'projects:save',
  'repo:default-clone-dir',
  'script-actions:changed',
  'script-actions:enable-shell-alias-scan',
  'script-actions:list',
  'script-actions:receipt',
  'script-actions:rescan',
  'script-actions:review',
  'script-actions:set-pinned',
  'script-actions:set-shortcut',
  'script:complete',
  'script:read-run-log',
  'script:run',
  'script:started',
  'script:stop',
  'tracked-plans:delete',
  'tracked-plans:get',
  'tracked-plans:update',
  'tracked-plans:updated',
  'work-entries:create',
  'work-entries:list',
  'work-entries:list-archived',
  'workspace:add-from-remote',
  'workspace:archive-worktree',
  'workspace:create-worktree',
  'workspace:delete',
  'workspace:load-claude-md',
  'workspace:merge-scripts',
  'workspace:read-scripts',
  'workspace:reorder',
  'workspace:save-claude-md',
  'workspace:update-metadata',
  'worktree-summary:generating',
  'worktree-summary:refresh',
  'worktree-summary:updated',
  'worktree:activity-entities',
  'worktree:archive',
  'worktree:create',
  'worktree:get-path',
  'worktree:list-repo-entries',
  'worktree:reorder',
  'worktree:set-hidden',
  'worktree:set-label',
];
/**
 * Hosted agents (CAN-5985): exactly the channels the hosted MCP Remote
 * Control tools reach (`HOSTED_TOOL_OPERATIONS` under
 * `HOSTED_TOOL_CAPABILITIES`), the hosted chat dispatch, the channels the
 * tools call directly (`HOSTED_DIRECT_CHANNELS`) and the post-pairing identity
 * read. Reviewed by effect in `./hosted-channels`:
 *
 * - Reads: the session snapshot, chat transcript pages, file roots, folders
 *   and contents, tracked plans, changed files and one file's diff, pull
 *   request status, pipelines and pipeline runs.
 * - Pushes: chat events and the snapshot-stale signal `task_wait` waits on.
 * - `projects:load`, `worktree:create`, `workspace:create-worktree`,
 *   `work-entries:create` and `desktop:session-snapshot-invalidate`: a task
 *   in a new worktree or work entry, the same additive create `task_create`
 *   already confirms with the person.
 * - `chat:command`: only `chat.create_tab`, `chat.send_message` and ordinary
 *   question answers, argument checked on the host (`hostedInvocationAllowed`).
 * - `chat:cancel`: only one exact turn, argument checked on the host.
 *
 * No terminals, approval answers or destructive actions.
 */
export const HOSTED_CONTROLLER_CHANNELS: readonly string[] = [
  'activity:changed-files',
  'activity:file-diff',
  'chat:cancel',
  'chat:command',
  'chat:event',
  'chat:get-transcript-page',
  'desktop:session-snapshot',
  'desktop:session-snapshot-invalidate',
  'desktop:session-snapshot-stale',
  'file-tree:directory',
  'file-tree:roots',
  'file:read-content',
  'github:get-pr-state',
  'provider-usage:limits-get',
  'pipelines:get-worktree-execution',
  'pipelines:list-for-worktree',
  'pipelines:list-worktree-executions',
  'projects:load',
  'remote-control:install-id',
  'tracked-plans:get',
  'tracked-plans:list',
  'work-entries:create',
  'workspace:create-worktree',
  'worktree:create',
];
export * from './hosted-channels';
export * from './ipc-channels';
export * from './operation-channels';
