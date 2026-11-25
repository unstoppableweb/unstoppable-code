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
 * item grouping, delegation lifetime, shared multi-repo) add nothing.
 * Worktree discard and journal quarantine are on (CAN-7443); recovery reads
 * are on (CAN-7439), and recovery actions are on (CAN-7444).
 * The web golden
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
 *   workspace (`project:delete`, `workspace:delete`). The web UI offers
 *   worktree archive and delete on a directly connected computer, which is
 *   always the account's own (CAN-7438).
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
 * - Onboarding tips and suggestions (CAN-7434): two narrow reads,
 *   `preferences:load-onboarding-tips` (only `{ dismissed }`) and
 *   `preferences:load-suggestions` (only `enabled`, `dismissed` and
 *   `lastCornerShownAt`), and the two writes the desktop's own tips and
 *   suggestions make. `preferences:update-onboarding-tips` accepts exactly
 *   what `parseOnboardingTipsUpdate` accepts: dismiss one known tip, or reset
 *   every dismissal ("Show tips again"). `preferences:update-suggestions`
 *   accepts exactly what `parseSuggestionsUpdate` accepts: turn the master
 *   switch on or off, dismiss one known suggestion, or stamp a corner
 *   suggestion as shown (the host supplies every timestamp). Each write
 *   touches only its own field. The browser session has no read-only mode
 *   that gates writes, so none applies. `preferences:load`, every
 *   preference, stays off this list.
 * - Web archive and retention (CAN-7438), offered whenever the browser is
 *   directly connected to the account's own computer:
 *   - `work-entries:delete`: archives or deletes a cowork Work Entry. The
 *     adapter always sends `lockAfterArchive: true`, a locked archive the
 *     person restores from Archived and deleted. The host checks no
 *     arguments from a browser, as with `worktree:archive`, so a browser
 *     controller can also send an unlocked delete (kept for the project's
 *     retention days) of any Work Entry of a cowork project.
 *   - `workspace:set-archive-retention`: a settings write. The adapter sends
 *     a code project's deletion retention days only; the channel also
 *     accepts the project's auto-archive days and branch deletion setting.
 * - Chat reads on direct Remote Control (CAN-7432), all read only:
 *   `chat:read-visual` (a byte range of one chat visual, checked against its
 *   reference hash and size on the computer); and `chat:read-delegation-page`,
 *   `chat:read-delegation-content` and `chat:read-delegation-blocks`, a
 *   delegate's stream pages, field bodies and bounded block pages, which the
 *   computer serves only for delegation targets of the named chat. Mobile and
 *   hosted agents are refused all four. The watcher list and its push stay
 *   off this list until the browser can project them to display rows.
 * - Pending clones (CAN-7433): `clone-jobs:list` and `clone-jobs:changed`
 *   are in-memory reads of the computer's Add project clones; `remoteUrl` is
 *   blanked for every controller and `destinationPath` for browsers.
 *   `clone-jobs:cancel` stops git and removes the partial checkout of that
 *   one job, including a clone the desktop user started; it is a no-op for an
 *   unknown or finished job. `clone-jobs:dismiss` forgets a finished job, on
 *   the desktop too. `clone-jobs:background` is not listed.
 * - Provider quotas (CAN-7433): `provider-usage:load` reads the curated plan
 *   usage projection (no audit rows, credentials or raw provider responses);
 *   `provider-usage:refresh` asks one provider, or the account proxy when it
 *   serves that provider, for current usage and answers the projection. The
 *   desktop joins a refresh already running for the same provider or proxy
 *   and does not otherwise throttle a browser's refreshes. `observability:*`
 *   stays off this list.
 * - Repository owner nudge (CAN-7433): `org-projects:find-repository-owner`,
 *   accepted from a browser only as exactly `{ remoteUrl }`
 *   (`browserInvocationAllowed`), never `{ path }`. It compares the URL with
 *   the desktop's cached organization catalogs (at most one first catalog
 *   fetch with the desktop's account), never contacts the URL or runs Git,
 *   gives up after 3 seconds, and answers only the organization, project and
 *   `owner/name` for organizations the desktop's account belongs to.
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
 * - Marketplace on direct Remote Control (CAN-7442), offered whenever the
 *   browser is directly connected to the account's own computer:
 *   - `installed-items:list-status` reads the status snapshot of installed
 *     plugins, skills, collections and MCP servers; it takes no argument.
 *     `installed-items:changed` is a notice to read it again. A catalog Add
 *     may carry a refresh token to the invoking browser session.
 *   - `installed-items:set-status` sets an already-installed item to active,
 *     available or disabled. It runs `claude plugin enable/disable`, parks or
 *     restores Codex installs, writes the computer's global plugin
 *     selections (new chats computer-wide see the change), and can turn on an
 *     existing stdio MCP server that later sessions spawn. It cannot create
 *     or edit a server or its command, and asks for no confirmation.
 *   - `installed-items:uninstall` removes a plugin, skill, collection,
 *     device MCP server (with its configurations and sign-ins) or account MCP
 *     connection: it deletes files and credentials. The computer asks for no
 *     approval of its own; the web's confirmation dialog is the only check.
 *     The request schema excludes `mcp-config`, bundled and
 *     marketplace-owned items are refused, and the device-MCP repair
 *     channels stay off this list.
 *   - `plugins:install-plugin` installs a plugin already listed with an
 *     external source in a marketplace this computer has already added. The
 *     host accepts exactly `(marketplaceId, pluginName, '')` from a browser
 *     (`browserInvocationAllowed`): the empty URL means the source the
 *     computer has stored, which must be public https with no userinfo or
 *     private host, cloned with redirects off. A browser cannot name a URL
 *     or add a marketplace (`plugins:addMarketplace` stays off this list).
 *   - `plugins:install-built-in-plugin` installs from the built-in or
 *     curated marketplace for the named providers, accepted from a browser
 *     only as `{ marketplaceId, pluginName, providers }`. It takes no URL;
 *     its marketplace progress pushes stay off this list.
 *   - A browser receives both install results through a field allowlist
 *     (no source, cache or install path, details or harness record) and an
 *     install error only when it is one of the computer's fixed messages.
 *     Installed plugin content can run later, once active in an agent
 *     session, as after a desktop install. `plugins:install-for-harnesses`,
 *     `plugins:retry-harness-install`, `plugins:prepare-codex-compatibility`,
 *     `plugins:set-codex-compat-disabled` and `plugins:read-component` stay
 *     off this list.
 * - New Task base branches (CAN-7437): `home:list-branch-targets` is a
 *   read of one registered workspace's source repository, answering branch
 *   names, ref flags and the default branch with no host paths. The host
 *   checks no browser arguments beyond the handler's `workspaceId`
 *   validation. A read may contact the remote once to resolve its default
 *   branch (`git ls-remote --symref origin HEAD`), skipped while the
 *   computer's recorded default-branch hint is under five minutes old. A
 *   browser session that offered `exactWorktreeBaseBranch` in hello gets the
 *   exact (`local:`/`remote:`) catalogue and may send exact bases on
 *   `worktree:create` and `workspace:create-worktree`. Also on the mobile
 *   list.
 * - Web discard and journal quarantine (CAN-7443), offered whenever the
 *   browser is directly connected to the account's own computer. Every
 *   channel here is user-only; agents, mobile and hosted controllers are
 *   refused.
 *   - `worktree:discard-describe`: reads what a discard of one stranded
 *     worktree would remove (targets, absolute host paths for display under
 *     the CAN-5334 exception, also-deleted data) and a confirmation token;
 *     with `retainedArchives: true`, also a retained archive. A browser may
 *     send `recovery` only on the first argument, as exactly the recovery
 *     request the adapter sends (CAN-7444, `browserInvocationAllowed`); the
 *     recovery-aware description gets the same browser projection as a
 *     plain one.
 *   - `worktree:discard`: permanently removes that worktree's checkout and
 *     quarantine, or with `retainedArchives: true` one retained archive,
 *     with its chats, plans, attachments and cost history. It needs the
 *     token from the description; the computer re-describes inside the
 *     deletion envelope and archive lock and refuses on any difference.
 *   - `workspace:delete-discard-describe`: reads which worktrees (and with
 *     `retainedArchives: true`, which retained archives) block a project's
 *     deletion, each with its discard description. Each discard still goes
 *     through `worktree:discard` with its own token.
 *   - `lifecycle-journal:inspect`: reads the destructive-lifecycle journal's
 *     health for the whole computer. Remote senders get the portable
 *     `<data>/w5/…` label, never a host path.
 *   - `lifecycle-journal:quarantine`: moves one unreadable journal entry,
 *     byte for byte, into the quarantine folder (strict request schema),
 *     which unblocks later archive and delete. Nothing is deleted.
 *   - `project:delete` and `workspace:delete` now also carry
 *     `supersedeInterruptedDeletion` from the web UI (already accepted), and
 *     since CAN-7444 `discardPendingRecovery` on the first argument only, as
 *     a bounded list of exact `{ operationId, confirmation }` entries. The
 *     computer compares it with its own fresh description
 *     (`isDeepStrictEqual`) and refuses any difference.
 * - Archive recovery list (CAN-7439): `worktree:recovery-list`, read only.
 *   It returns ids, timestamps, counts, presence flags and fixed codes for one
 *   workspace's unfinished archives, as the core `core.worktree.recovery.list`
 *   query answers under the bridge's `core.worktree.read` grant. The revision
 *   and operation tokens it returns are accepted only by
 *   `worktree:recovery-resolve` and `worktree:recovery-finish`.
 * - Archive recovery actions (CAN-7444), offered whenever the browser is
 *   directly connected to the account's own computer.
 *   - `worktree:recovery-resolve`: keeps a stranded worktree
 *     (`keep-worktree`), withdraws an archive attempt (`release`), or
 *     permanently deletes retained recovery material, Git snapshots and file
 *     copies (`delete-hold`). Its result carries only ids, counts and enums.
 *   - `worktree:recovery-finish`: finishes an interrupted archive, removing
 *     the worktree's remaining files. A browser receives its `check` only
 *     when it is code-shaped; anything else becomes `finish-refused`.
 *   - Both are bound to the `{ operationId, revision }` the list returned:
 *     the computer refuses when the live diagnosis no longer matches, under
 *     a strict params schema and `assertWritableScope`. The computer asks for
 *     no approval of its own; the shared UI asks before deleting recovery
 *     material. The action runs with only `core.worktree.write`, attributed
 *     to the controller's `remote-device:<id>` principal.
 *   - The bridge principal is the same for every controller kind, so adding
 *     either channel to the mobile or hosted list would grant those
 *     controllers the same destructive actions. Desktop controllers reach
 *     both, as every tunnelled channel.
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
  'chat:read-delegation-blocks',
  'chat:read-delegation-content',
  'chat:read-delegation-page',
  'chat:read-visual',
  'chat:send-message',
  'clone-jobs:cancel',
  'clone-jobs:changed',
  'clone-jobs:dismiss',
  'clone-jobs:list',
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
  'home:list-branch-targets',
  'hook:change-pause',
  'hook:complete',
  'hook:run',
  'hook:started',
  'hook:stop',
  'installed-items:changed',
  'installed-items:list-status',
  'installed-items:set-status',
  'installed-items:uninstall',
  'lifecycle-journal:inspect',
  'lifecycle-journal:quarantine',
  'model-registry:get',
  'org-projects:find-repository-owner',
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
  'plugins:install-built-in-plugin',
  'plugins:install-plugin',
  'preferences:load-onboarding-tips',
  'preferences:load-suggestions',
  'preferences:update-onboarding-tips',
  'preferences:update-suggestions',
  'project:delete',
  'projects:load',
  'projects:save',
  'provider-usage:load',
  'provider-usage:refresh',
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
  'work-entries:delete',
  'work-entries:list',
  'work-entries:list-archived',
  'workspace:add-from-remote',
  'workspace:archive-worktree',
  'workspace:create-worktree',
  'workspace:delete',
  'workspace:delete-discard-describe',
  'workspace:load-claude-md',
  'workspace:merge-scripts',
  'workspace:read-scripts',
  'workspace:reorder',
  'workspace:save-claude-md',
  'workspace:set-archive-retention',
  'workspace:update-metadata',
  'worktree-summary:generating',
  'worktree-summary:refresh',
  'worktree-summary:updated',
  'worktree:activity-entities',
  'worktree:archive',
  'worktree:create',
  'worktree:discard',
  'worktree:discard-describe',
  'worktree:get-path',
  'worktree:list-repo-entries',
  'worktree:recovery-finish',
  'worktree:recovery-list',
  'worktree:recovery-resolve',
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
 * - `chat:command`: only `chat.create_tab`, `chat.send_message`, ordinary
 *   question answers and the CAN-7445 settings commands below, argument
 *   checked on the host (`hostedInvocationAllowed`).
 * - `chat:cancel`: only one exact turn, argument checked on the host.
 * - Tasks tools on a connected computer (CAN-7445), each argument checked on
 *   the host: the plugin catalog, a workspace's branches, a worktree's hooks
 *   (read, pause, resume), one queued message (cancel, edit, interrupt), a
 *   task's label, visibility, tracked base branch and work entry title, and
 *   creating a named sidebar group or moving a task between groups.
 *   `chat:command` also sets a chat's model, the reviewed settings patch keys
 *   and steers a queued message.
 *
 * No terminals, approval answers or destructive actions.
 */
export const HOSTED_CONTROLLER_CHANNELS: readonly string[] = [
  'activity:changed-files',
  'activity:file-diff',
  'app-advisor:slack-turn-status',
  'chat:cancel',
  'chat:command',
  'chat:event',
  'chat:get-transcript-page',
  'chat:queue-cancel',
  'chat:queue-edit',
  'chat:queue-force',
  'desktop:session-snapshot',
  'desktop:session-snapshot-invalidate',
  'desktop:session-snapshot-stale',
  'file-tree:directory',
  'file-tree:roots',
  'file:read-content',
  'github:get-pr-state',
  'home:list-branch-targets',
  'hook:change-pause',
  'plugin-catalog:list',
  'provider-usage:limits-get',
  'pipelines:get-worktree-execution',
  'pipelines:list-for-worktree',
  'pipelines:list-worktree-executions',
  'projects:load',
  'remote-control:install-id',
  'sidebar-item-groups:create',
  'sidebar-item-groups:move-item',
  'tracked-plans:get',
  'tracked-plans:list',
  'work-entries:create',
  'work-entries:update',
  'workspace:create-worktree',
  'worktree:activity-entities',
  'worktree:create',
  'worktree:set-hidden',
  'worktree:set-label',
  'worktree:set-tracked-base-branch',
];
export * from './browser-arguments';
export * from './hosted-channels';
export * from './ipc-channels';
export * from './operation-channels';
