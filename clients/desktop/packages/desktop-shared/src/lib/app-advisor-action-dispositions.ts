/*
 * CAN-4133: where each App Advisor DispatchAction type runs. `core` runs in
 * Electron main through the action router and never reaches a renderer;
 * `presentation` reaches a window only through an interface lease;
 * `host_presentation` is Electron main's own window code, gated on the main
 * window's lease; `legacy` still runs in the renderer dispatcher, only while
 * the main window's lease is live, and may only shrink
 * (check:advisor-action-dispositions).
 */

export const APP_ADVISOR_ACTION_GRANTS = Object.freeze([
  'core.archive.write',
  'core.browser.write',
  'core.catalog.write',
  'core.chat.write',
  'core.config.write',
  'core.initiatedWork.write',
  'core.integration.write',
  'core.ledger.write',
  'core.memory.write',
  'core.operation.cancel',
  'core.pipeline.write',
  'core.remoteAccess.write',
  'core.script.write',
  'core.sharing.write',
  'core.workspace.write',
  'core.worktree.write',
  'worker.codeGraph.write',
  'worker.filesystem.write',
  'worker.git.write',
  'worker.script.execute',
] as const);
export type AppAdvisorActionGrant = (typeof APP_ADVISOR_ACTION_GRANTS)[number];

export type AppAdvisorCoreExecutor =
  | 'shared-engine'
  | 'script-preferences'
  | 'chat-history'
  | 'transcript-read'
  | 'code-graph'
  | 'browser'
  | 'delegation-read'
  | 'delegation-control'
  | 'pipeline-execution'
  | 'catalog'
  | 'sharing'
  | 'automation-sharing'
  | 'collection-sharing'
  | 'file-tree'
  | 'memory'
  | 'records'
  | 'settings'
  | 'credentials'
  | 'remote-access'
  | 'settings-surface'
  | 'project-bot'
  | 'message-control'
  | 'send'
  | 'task-creation'
  | 'chat-creation'
  | 'advisor-chat'
  | 'worktree-scripts'
  | 'worktree-actions'
  | 'repository-owner'
  | 'automation'
  | 'resource';
export type AppAdvisorHostPresentationExecutor =
  | 'shared-engine'
  | 'script-preferences'
  | 'editor-setup';

export type AppAdvisorActionDisposition =
  | {
      readonly kind: 'core';
      readonly access: 'read';
      readonly executor: AppAdvisorCoreExecutor;
      /** CAN-6008: only while the session binds the main window's lease. */
      readonly requiresInterface?: true;
    }
  | {
      readonly kind: 'core';
      readonly access: 'write';
      readonly executor: AppAdvisorCoreExecutor;
      readonly grants: readonly AppAdvisorActionGrant[];
      readonly revision: 'domain' | 'none';
      /** Runs its core write, then a best-effort ui.app_advisor.present reveal (D12). */
      readonly composite?: true;
      /** worktree-chat.open_tab: with a chatId the action is pure presentation (D12). */
      readonly presentationWhenChatId?: true;
      /**
       * CAN-5999 D3: when the core route's guard fails, main presents the
       * action through the main window's lease, which applies it in the
       * window; with no lease the action is refused with the guard's reason.
       */
      readonly presentationWhenGuarded?: true;
      /**
       * CAN-6008 (CAN-4133 N2): runs in main only while the session binds
       * the main window's lease (`ui.app_advisor.present`); never headless,
       * and a remote route never satisfies it.
       */
      readonly requiresInterface?: true;
    }
  | { readonly kind: 'presentation' }
  | {
      readonly kind: 'host_presentation';
      readonly executor: AppAdvisorHostPresentationExecutor;
    }
  | { readonly kind: 'legacy'; readonly access: 'read' }
  | {
      readonly kind: 'legacy';
      readonly access: 'write';
      readonly grants: readonly AppAdvisorActionGrant[];
    };

export const APP_ADVISOR_ACTION_DISPOSITIONS: Readonly<
  Record<string, AppAdvisorActionDisposition>
> = Object.freeze({
  'account_proxy.set_routing': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'account_proxy.status': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'settings',
  }),
  'advisor-chat.create_chat': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'advisor-chat',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'advisor-chat.create_entry': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'advisor-chat',
    grants: Object.freeze(['core.chat.write', 'core.worktree.write'] as const),
    revision: 'none',
  }),
  'advisor-chat.send_message': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'advisor-chat',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'agents.create': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'catalog',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'agents.delete': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'catalog',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'agents.delete_shared': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'agents.get': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'catalog',
  }),
  'agents.import_shared': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'agents.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'catalog',
  }),
  'agents.list_shared': Object.freeze({ kind: 'legacy', access: 'read' }),
  'agents.open_manager': Object.freeze({ kind: 'presentation' }),
  'agents.publish_public_share': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'agents.revoke_public_share': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'agents.update': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'catalog',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'app_advisor.close': Object.freeze({ kind: 'presentation' }),
  'app_advisor.open': Object.freeze({ kind: 'presentation' }),
  'app_advisor.toggle': Object.freeze({ kind: 'presentation' }),
  'app_advisor.update_settings': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'archived.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'records',
  }),
  'archived.open': Object.freeze({ kind: 'presentation' }),
  'archived.open_empty_trash': Object.freeze({ kind: 'presentation' }),
  'archived.open_overview': Object.freeze({ kind: 'presentation' }),
  'archived.read_chat': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'records',
  }),
  'archived.restore': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'records',
    grants: Object.freeze(['core.archive.write'] as const),
    revision: 'none',
  }),
  'archived.set_locked': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'records',
    grants: Object.freeze(['core.archive.write'] as const),
    revision: 'none',
  }),
  'automation.create': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'automation',
    grants: Object.freeze(['core.initiatedWork.write'] as const),
    revision: 'none',
  }),
  'automation.delete': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'automation',
    grants: Object.freeze(['core.initiatedWork.write'] as const),
    revision: 'none',
  }),
  'automation.disable': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'automation',
    grants: Object.freeze(['core.initiatedWork.write'] as const),
    revision: 'none',
  }),
  'automation.get': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'automation',
  }),
  'automation.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'automation',
  }),
  'automation.list_shared': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'automation-sharing',
  }),
  'automation.open_editor': Object.freeze({ kind: 'presentation' }),
  'automation.open_shared_pipeline_review': Object.freeze({
    kind: 'presentation',
  }),
  'automation.read_shared': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'automation-sharing',
  }),
  'automation.run_now': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'automation',
    grants: Object.freeze(['core.initiatedWork.write'] as const),
    revision: 'none',
  }),
  'automation.share': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'automation-sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'automation.unshare': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'automation-sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'automation.update': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'automation',
    grants: Object.freeze(['core.initiatedWork.write'] as const),
    revision: 'none',
  }),
  'bots.create_task': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'task-creation',
    grants: Object.freeze(['core.chat.write', 'core.worktree.write'] as const),
    revision: 'none',
  }),
  'bots.create_task_chat': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'task-creation',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'bots.get_last_agent_response': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'bots.get_last_user_message': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'bots.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'bots.list_task_chats': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'bots.list_tasks': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'bots.read_history': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'bots.send_message': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'send',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'browser.back': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.cancel_transfer': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.click': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.drag': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.drop_files': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.fill': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.focus': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.forward': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.get_console': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.get_dialog': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.get_network': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.handle_dialog': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.hover': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.input_snapshot': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.inspect': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.list_transfers': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.navigate': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.open': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.open_external': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.press': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.profile.clear': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.profile.get': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.profile.job_cancel': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.profile.job_get': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.profile.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.profile.preview_clear': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.profile.switch': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.reload': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.request_files': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.save_download': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.save_pdf': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.screenshot': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'browser',
  }),
  'browser.scroll': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.select_option': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.set_checked': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.start_recording': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.stop': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.stop_recording': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.type': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.upload_files': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'browser.wait_for': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'browser',
    grants: Object.freeze(['core.browser.write'] as const),
    revision: 'none',
  }),
  'canopy_cloud.cancel_oauth_login': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'credentials',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'canopy_cloud.clear_api_key': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'credentials',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'canopy_cloud.disconnect': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'credentials',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'canopy_cloud.load_account': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'credentials',
    requiresInterface: true,
  }),
  'canopy_cloud.save_api_key': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'credentials',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'canopy_cloud.start_oauth_login': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'credentials',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'canopy_cloud.validate_api_key': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'credentials',
    requiresInterface: true,
  }),
  'canopy_portal.close': Object.freeze({ kind: 'presentation' }),
  'canopy_portal.open': Object.freeze({ kind: 'presentation' }),
  'canopy_portal.open_account_settings': Object.freeze({
    kind: 'presentation',
  }),
  'canopy_portal.start': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'remote-access',
    grants: Object.freeze(['core.remoteAccess.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'canopy_portal.stop': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'remote-access',
    grants: Object.freeze(['core.remoteAccess.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'chat.content.read': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'chat.open_import_session_modal': Object.freeze({ kind: 'presentation' }),
  'chat.set_harness': Object.freeze({ kind: 'presentation' }),
  'chat.transcript.blocks.page': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'chat.history.search': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'chat-history',
  }),
  'chat.history.excerpt': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'chat-history',
  }),
  'chat.transcript.page': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  // CAN-5974: permanent presentation reads, not migration debt. The main
  // window serves them from the cloud chats its sidebar already loaded;
  // App Advisor gains no web-core access.
  'cloud_chats.list': Object.freeze({ kind: 'presentation' }),
  'cloud_chats.open': Object.freeze({ kind: 'presentation' }),
  'code-graph.build': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'code-graph',
    grants: Object.freeze(['worker.codeGraph.write'] as const),
    revision: 'none',
  }),
  'code-graph.compare_changes': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'code-graph',
  }),
  'code-graph.detect_changes': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'code-graph',
  }),
  'code-graph.explain': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'code-graph',
  }),
  'code-graph.get_context': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'code-graph',
  }),
  'code-graph.impact': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'code-graph',
  }),
  'code-graph.query': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'code-graph',
  }),
  'code-graph.review': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'code-graph',
  }),
  'code-graph.search': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'code-graph',
  }),
  'code_review.open': Object.freeze({ kind: 'presentation' }),
  'collections.create': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'catalog',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'collections.delete': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'catalog',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'collections.delete_shared': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'collection-sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'collections.import_shared': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'collection-sharing',
    grants: Object.freeze([
      'core.sharing.write',
      'core.catalog.write',
    ] as const),
    revision: 'none',
  }),
  'collections.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'catalog',
  }),
  'collections.list_shared': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'collection-sharing',
  }),
  'collections.open_manager': Object.freeze({ kind: 'presentation' }),
  'collections.share': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'collection-sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'collections.update': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'catalog',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'collections.update_shared': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'collection-sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'cursor.approval_check': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings-surface',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'cursor.connection': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings-surface',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'delegation.read_changes': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'delegation-read',
  }),
  'delegation.roots': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'delegation-read',
  }),
  'delegation.stop': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'delegation-control',
    grants: Object.freeze(['core.operation.cancel'] as const),
    revision: 'none',
  }),
  'delegation.stop_all': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'delegation-control',
    grants: Object.freeze(['core.operation.cancel'] as const),
    revision: 'none',
  }),
  'delegation.transcript': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'delegation-read',
  }),
  'delegation.tree': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'delegation-read',
  }),
  'delegation.worktree_summary': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'delegation-read',
  }),
  'environment.update_workspace_assignment': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'experiments.set_enabled': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'shared-engine',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'none',
  }),
  'file-tree.copy': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'file-tree',
    grants: Object.freeze(['worker.filesystem.write'] as const),
    revision: 'none',
  }),
  'file-tree.create_directory': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'file-tree',
    grants: Object.freeze(['worker.filesystem.write'] as const),
    revision: 'none',
  }),
  'file-tree.create_file': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'file-tree',
    grants: Object.freeze(['worker.filesystem.write'] as const),
    revision: 'none',
  }),
  'file-tree.delete': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'file-tree',
    grants: Object.freeze(['worker.filesystem.write'] as const),
    revision: 'none',
  }),
  'file-tree.move': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'file-tree',
    grants: Object.freeze(['worker.filesystem.write'] as const),
    revision: 'none',
  }),
  'file-tree.set_search': Object.freeze({ kind: 'presentation' }),
  'file.open': Object.freeze({ kind: 'presentation' }),
  'file.preview_search_close': Object.freeze({ kind: 'presentation' }),
  'file.preview_search_open': Object.freeze({ kind: 'presentation' }),
  'file.save_active': Object.freeze({ kind: 'presentation' }),
  'file.send_selection_to_chat': Object.freeze({ kind: 'presentation' }),
  'github.resolve_base_branch_alignment': Object.freeze({
    kind: 'presentation',
  }),
  'github.split_pr': Object.freeze({ kind: 'presentation' }),
  'home.set_execution_harness': Object.freeze({ kind: 'presentation' }),
  'hook.pause': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.worktree.write'] as const),
    revision: 'none',
  }),
  'hook.resume': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.worktree.write'] as const),
    revision: 'none',
  }),
  'installed_items.list_status': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'shared-engine',
  }),
  'installed_items.set_status': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'shared-engine',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'installed_items.uninstall': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'shared-engine',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'ledger.add_entry': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'records',
    grants: Object.freeze(['core.ledger.write'] as const),
    revision: 'none',
  }),
  'ledger.open': Object.freeze({ kind: 'presentation' }),
  'ledger.search': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'records',
  }),
  'mcp.account_connect': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings-surface',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'mcp.account_disconnect': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings-surface',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'mcp.account_edit': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings-surface',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'mcp.account_promote': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings-surface',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'mcp.account_reconnect': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings-surface',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'memory.consolidate_now': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'memory',
    grants: Object.freeze(['core.memory.write'] as const),
    revision: 'none',
  }),
  'memory.import_external': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'memory',
    grants: Object.freeze(['core.memory.write'] as const),
    revision: 'none',
  }),
  'memory.list_snapshots': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'memory',
  }),
  'memory.rebuild': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'memory',
    grants: Object.freeze(['core.memory.write'] as const),
    revision: 'none',
  }),
  'memory.restore_snapshot': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'memory',
    grants: Object.freeze(['core.memory.write'] as const),
    revision: 'none',
  }),
  'navigation.close_settings': Object.freeze({ kind: 'presentation' }),
  'navigation.go_back': Object.freeze({ kind: 'presentation' }),
  'navigation.go_forward': Object.freeze({ kind: 'presentation' }),
  'navigation.go_to_page': Object.freeze({ kind: 'presentation' }),
  'navigation.open_chat_turn': Object.freeze({ kind: 'presentation' }),
  'navigation.open_code_graph': Object.freeze({ kind: 'presentation' }),
  'navigation.open_command_palette': Object.freeze({ kind: 'presentation' }),
  'navigation.open_customize_sidebar': Object.freeze({ kind: 'presentation' }),
  'navigation.open_editor_setup': Object.freeze({
    kind: 'host_presentation',
    executor: 'editor-setup',
  }),
  'navigation.open_file_search': Object.freeze({ kind: 'presentation' }),
  'navigation.open_import_projects': Object.freeze({ kind: 'presentation' }),
  'navigation.open_pr_picker': Object.freeze({ kind: 'presentation' }),
  'navigation.open_settings': Object.freeze({ kind: 'presentation' }),
  'navigation.open_workspace_settings': Object.freeze({ kind: 'presentation' }),
  'ollama.install': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'credentials',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'opencode.connection': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'credentials',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'org_project.create_code': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'org_project.create_cowork': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'org_project.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'org_project.open_move_to_organization': Object.freeze({
    kind: 'presentation',
  }),
  'org_project.setup_cancel': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'org_project.setup_start': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'panel.add_tab': Object.freeze({ kind: 'presentation' }),
  'panel.arrange': Object.freeze({ kind: 'presentation' }),
  'panel.close': Object.freeze({ kind: 'presentation' }),
  'panel.focus': Object.freeze({ kind: 'presentation' }),
  'panel.maximize': Object.freeze({ kind: 'presentation' }),
  'panel.move': Object.freeze({ kind: 'presentation' }),
  'panel.reset_layout': Object.freeze({ kind: 'presentation' }),
  'panel.save_default_layout': Object.freeze({ kind: 'presentation' }),
  'panel.set_layout_mode': Object.freeze({ kind: 'presentation' }),
  'panel.split': Object.freeze({ kind: 'presentation' }),
  'pipeline-assistant-chat.create_tab': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.chat.write'] as const),
  }),
  'pipeline-assistant-chat.get_last_agent_response': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'pipeline-assistant-chat.get_last_user_message': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'pipeline-assistant-chat.list_plugins': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'pipeline-assistant-chat.list_tabs': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'pipeline-assistant-chat.read_history': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'pipeline-assistant-chat.send_message': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.chat.write'] as const),
  }),
  'pipeline-assistant-chat.set_model': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
    presentationWhenGuarded: true,
  }),
  'pipeline-assistant-chat.set_plugin_selections': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'pipeline-assistant-chat.set_thinking_level': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
    presentationWhenGuarded: true,
  }),
  'pipeline-assistant-chat.switch_tab': Object.freeze({ kind: 'presentation' }),
  'pipeline-assistant-chat.update_plugin_selection': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'pipeline.create': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.pipeline.write'] as const),
    revision: 'none',
  }),
  'pipeline.debug_run': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'pipeline-execution',
    grants: Object.freeze(['core.chat.write', 'core.worktree.write'] as const),
    revision: 'none',
  }),
  'pipeline.delete': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.pipeline.write'] as const),
    revision: 'none',
  }),
  'pipeline.delete_shared': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'pipeline.duplicate': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.pipeline.write'] as const),
    revision: 'none',
  }),
  'pipeline.execution_cancel': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.pipeline.write'] as const),
  }),
  'pipeline.execution_cancel_matrix_variant': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.pipeline.write'] as const),
  }),
  'pipeline.execution_chain': Object.freeze({ kind: 'legacy', access: 'read' }),
  'pipeline.execution_get': Object.freeze({ kind: 'legacy', access: 'read' }),
  'pipeline.execution_list': Object.freeze({ kind: 'legacy', access: 'read' }),
  'pipeline.execution_list_for_worktree': Object.freeze({
    kind: 'legacy',
    access: 'read',
  }),
  'pipeline.execution_read_plan': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'pipeline-execution',
  }),
  'pipeline.execution_read_report': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'pipeline-execution',
  }),
  'pipeline.execution_resume': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.pipeline.write'] as const),
  }),
  'pipeline.execution_retry': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.pipeline.write'] as const),
  }),
  'pipeline.execution_retry_matrix_job': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.pipeline.write'] as const),
  }),
  'pipeline.execution_send_plan_to_chat': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'pipeline-execution',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'pipeline.execution_send_report_to_chat': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'pipeline-execution',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'pipeline.execution_start_over': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'pipeline-execution',
    grants: Object.freeze(['core.pipeline.write'] as const),
    revision: 'none',
  }),
  'pipeline.get': Object.freeze({ kind: 'legacy', access: 'read' }),
  'pipeline.list': Object.freeze({ kind: 'legacy', access: 'read' }),
  'pipeline.open_curated_preview': Object.freeze({ kind: 'presentation' }),
  'pipeline.open_editor': Object.freeze({ kind: 'presentation' }),
  'pipeline.open_run': Object.freeze({ kind: 'presentation' }),
  'pipeline.run': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'shared-engine',
    grants: Object.freeze(['core.pipeline.write'] as const),
    revision: 'none',
  }),
  'pipeline.save': Object.freeze({ kind: 'presentation' }),
  'pipeline.set_enabled': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.pipeline.write'] as const),
    revision: 'none',
  }),
  'pipeline.share': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'pipeline.update': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.pipeline.write'] as const),
    revision: 'none',
  }),
  'pipeline.update_shared': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'plan.share': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'plan.unshare': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'plugins.list_marketplaces': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'catalog',
  }),
  'plugins.open_entry_detail': Object.freeze({ kind: 'presentation' }),
  'plugins.open_management': Object.freeze({ kind: 'presentation' }),
  'plugins.open_marketplaces': Object.freeze({ kind: 'presentation' }),
  'plugins.open_mcp_browse': Object.freeze({ kind: 'presentation' }),
  'plugins.refresh_marketplace': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'catalog',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'plugins.remove_marketplace': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'catalog',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'preferences.get_global_plugin_selections': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'catalog',
  }),
  'preferences.set_global_plugin_selections': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'catalog',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'projects.create_task': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'task-creation',
    grants: Object.freeze(['core.chat.write', 'core.worktree.write'] as const),
    revision: 'none',
  }),
  'projects.create_task_chat': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'task-creation',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'projects.get_last_agent_response': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'projects.get_last_user_message': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'projects.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'projects.list_task_chats': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'projects.list_tasks': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'projects.read_history': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'project-bot',
  }),
  'projects.schedule_message': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'message-control',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'projects.send_message': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'send',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'projects.steer_queued_message': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'message-control',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'remote_control.get_state': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'remote-access',
    requiresInterface: true,
  }),
  'remote_control.open_computer': Object.freeze({ kind: 'presentation' }),
  'remote_control.set_allow_incoming': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'remote-access',
    grants: Object.freeze(['core.remoteAccess.write'] as const),
    revision: 'none',
    requiresInterface: true,
  }),
  'runs.open_comments': Object.freeze({ kind: 'presentation' }),
  'runs.share': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'sharing',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'runs.unshare': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'sharing',
    grants: Object.freeze(['core.chat.write', 'core.sharing.write'] as const),
    revision: 'none',
  }),
  'script_actions.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'script-preferences',
  }),
  'script_actions.open_review': Object.freeze({
    kind: 'host_presentation',
    executor: 'script-preferences',
  }),
  'script_actions.rescan': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'script-preferences',
    grants: Object.freeze(['core.script.write'] as const),
    revision: 'none',
  }),
  'script_actions.set_pin': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'script-preferences',
    grants: Object.freeze(['core.script.write'] as const),
    revision: 'none',
  }),
  'script_actions.set_shortcut': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'script-preferences',
    grants: Object.freeze(['core.script.write'] as const),
    revision: 'none',
  }),
  'settings.ai_gateway.connect': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'shared-engine',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
  }),
  'settings.ai_gateway.get': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'shared-engine',
  }),
  'settings.ai_gateway.update': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'shared-engine',
    grants: Object.freeze(['core.integration.write'] as const),
    revision: 'none',
  }),
  'settings.get_claude_max_turns': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'settings',
  }),
  'settings.get_handoff_model': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'settings',
  }),
  'settings.get_local_memory_model': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'settings',
  }),
  'settings.open': Object.freeze({
    kind: 'host_presentation',
    executor: 'shared-engine',
  }),
  'settings.open_memory_folder': Object.freeze({ kind: 'presentation' }),
  'settings.personalCatalog.set': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.config.write'] as const),
  }),
  'settings.review_privacy_opt_in': Object.freeze({ kind: 'presentation' }),
  'settings.set_claude_max_turns': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'settings.set_handoff_model': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'settings.set_launch_at_login': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'none',
  }),
  'settings.set_ledger_agent_recording_enabled': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'settings.set_local_memory_enabled': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'settings.set_local_memory_model': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'settings.set_managed_delegation_max_depth': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'settings.set_managed_delegation_mode': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'settings.set_navigation_mode': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'settings.set_profile_role': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'settings.set_skill_suggestions_enabled': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'settings',
    grants: Object.freeze(['core.config.write'] as const),
    revision: 'domain',
  }),
  'shared-containers.open_invite': Object.freeze({ kind: 'presentation' }),
  'shared-containers.open_received': Object.freeze({ kind: 'presentation' }),
  'shared-containers.retry_received': Object.freeze({ kind: 'presentation' }),
  'shared-containers.revoke_recipient': Object.freeze({ kind: 'presentation' }),
  'sharing.open_dialog': Object.freeze({ kind: 'presentation' }),
  'sidebar.item_groups.create': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.workspace.write'] as const),
    revision: 'none',
  }),
  'sidebar.item_groups.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'sidebar.item_groups.list_items': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'sidebar.item_groups.move_group': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.workspace.write'] as const),
    revision: 'none',
  }),
  'sidebar.item_groups.move_item': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.workspace.write'] as const),
    revision: 'none',
  }),
  'sidebar.item_groups.set_item': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.workspace.write'] as const),
    revision: 'none',
  }),
  'sidebar.item_groups.ungroup': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.workspace.write'] as const),
    revision: 'none',
  }),
  'sidebar.item_groups.update': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.workspace.write'] as const),
    revision: 'none',
  }),
  'skill_suggestions.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'catalog',
  }),
  'skill_suggestions.open': Object.freeze({ kind: 'presentation' }),
  'skills.create_custom': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'skills.delete_custom': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'skills.delete_shared': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'skills.import_shared': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'skills.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'resource',
  }),
  'skills.list_marketplace': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'catalog',
  }),
  'skills.list_shared': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'resource',
  }),
  'skills.open_manager': Object.freeze({ kind: 'presentation' }),
  'skills.open_shared_viewer': Object.freeze({ kind: 'presentation' }),
  'skills.open_viewer': Object.freeze({ kind: 'presentation' }),
  'skills.read': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'resource',
  }),
  'skills.read_file': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'resource',
  }),
  'skills.read_shared': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'resource',
  }),
  'skills.share_custom': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'skills.update_custom': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.catalog.write'] as const),
    revision: 'none',
  }),
  'skills.update_shared': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'resource',
    grants: Object.freeze(['core.sharing.write'] as const),
    revision: 'none',
  }),
  'standalone-chat.create_chat': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'chat-creation',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
    composite: true,
  }),
  'standalone-chat.delete_work_entry': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.chat.write'] as const),
  }),
  'standalone-chat.get_attachment': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'standalone-chat.get_last_agent_response': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'standalone-chat.get_last_user_message': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'standalone-chat.get_note': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'standalone-chat.get_prompt': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'standalone-chat.get_settings': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'standalone-chat.list_attachments': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'standalone-chat.list_chats': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'standalone-chat.list_notes': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'standalone-chat.list_plugins': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'standalone-chat.list_projects': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'standalone-chat.list_prompts': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'standalone-chat.read_history': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'standalone-chat.rename_work_entry': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.chat.write'] as const),
  }),
  'standalone-chat.send_message': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'send',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'standalone-chat.set_model': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
    presentationWhenGuarded: true,
  }),
  'standalone-chat.set_plugin_selections': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'standalone-chat.set_thinking_level': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
    presentationWhenGuarded: true,
  }),
  'standalone-chat.switch_chat': Object.freeze({ kind: 'presentation' }),
  'standalone-chat.switch_project': Object.freeze({ kind: 'presentation' }),
  'standalone-chat.update_plugin_selection': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'standalone-chat.update_settings': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.chat.write'] as const),
  }),
  'terminal.close': Object.freeze({ kind: 'presentation' }),
  'terminal.open': Object.freeze({ kind: 'presentation' }),
  'tracked-plan.get': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'tracked-plan.get_comment_thread': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'tracked-plan.import': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.workspace.write'] as const),
    revision: 'none',
  }),
  'tracked-plan.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'tracked-plan.list_comment_threads': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'tracked-plan.open_explore': Object.freeze({ kind: 'presentation' }),
  'usage.control_resume_queue': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.chat.write'] as const),
  }),
  'usage.open_resume_modal': Object.freeze({ kind: 'presentation' }),
  'usage.open_resume_queue': Object.freeze({ kind: 'presentation' }),
  'watcher.delete': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'records',
    grants: Object.freeze(['core.initiatedWork.write'] as const),
    revision: 'none',
  }),
  'watcher.get': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'records',
  }),
  'watcher.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'records',
  }),
  'workspace.add_org_project': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'workspace.add_repo': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'workspace.apply_source_edits': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'workspace.create_multi_repo': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'workspace.find_repository_owner': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'repository-owner',
  }),
  'workspace.get_settings': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'workspace.get_start_page': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'workspace.list': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'workspace.list_existing_worktree_join_options': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'workspace.list_join_options': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'workspace.list_worktrees': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'workspace.open_add_dialog': Object.freeze({ kind: 'presentation' }),
  'workspace.open_clone_progress': Object.freeze({ kind: 'presentation' }),
  'workspace.promote_temporary': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'workspace.read_readiness': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'workspace.remove_repo': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'workspace.set_start_page': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'workspace.start_readiness_fix': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'workspace.update_local_settings': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.workspace.write'] as const),
  }),
  'workspace_context.switch': Object.freeze({ kind: 'presentation' }),
  'worktree-chat.dismiss_state_notice': Object.freeze({ kind: 'presentation' }),
  'worktree-chat.get_last_agent_response': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'worktree-chat.get_last_user_message': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'worktree-chat.list_background_processes': Object.freeze({
    kind: 'legacy',
    access: 'read',
  }),
  'worktree-chat.list_plugins': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'worktree-chat.list_tabs': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'worktree-chat.open_archives': Object.freeze({ kind: 'presentation' }),
  'worktree-chat.open_tab': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'chat-creation',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
    composite: true,
    presentationWhenChatId: true,
  }),
  'worktree-chat.read_history': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'transcript-read',
  }),
  'worktree-chat.retry_state_refresh': Object.freeze({ kind: 'presentation' }),
  'worktree-chat.run_chat_action': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.chat.write'] as const),
  }),
  'worktree-chat.schedule_message': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'message-control',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'worktree-chat.send_message': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'send',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'worktree-chat.set_fast_mode': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'worktree-chat.set_interface_mode': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.chat.write'] as const),
  }),
  'worktree-chat.set_model': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
    presentationWhenGuarded: true,
  }),
  'worktree-chat.set_plan_mode': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
    presentationWhenGuarded: true,
  }),
  'worktree-chat.set_plugin_selections': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'worktree-chat.set_speed': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'worktree-chat.set_thinking_level': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
    presentationWhenGuarded: true,
  }),
  'worktree-chat.steer_queued_message': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'message-control',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'worktree-chat.stop_background_process': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.chat.write'] as const),
  }),
  'worktree-chat.switch_tab': Object.freeze({ kind: 'presentation' }),
  'worktree-chat.update_plugin_selection': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.chat.write'] as const),
    revision: 'none',
  }),
  'worktree.add_existing_worktree': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.worktree.write'] as const),
  }),
  'worktree.add_workspace': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.worktree.write'] as const),
  }),
  'worktree.archive': Object.freeze({ kind: 'presentation' }),
  'worktree.cancel_git_action': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['worker.git.write'] as const),
  }),
  'worktree.create': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.worktree.write'] as const),
    revision: 'none',
  }),
  'worktree.create_from': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.worktree.write'] as const),
  }),
  'worktree.create_from_link': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.worktree.write'] as const),
  }),
  'worktree.get_settings': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-actions',
  }),
  'worktree.list_git_actions': Object.freeze({
    kind: 'legacy',
    access: 'read',
  }),
  'worktree.list_scripts': Object.freeze({
    kind: 'core',
    access: 'read',
    executor: 'worktree-scripts',
  }),
  'worktree.resolve_branch_from_confirmation': Object.freeze({
    kind: 'presentation',
  }),
  'worktree.run_git_action': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['worker.git.write'] as const),
  }),
  'worktree.run_script': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-scripts',
    grants: Object.freeze(['worker.script.execute'] as const),
    revision: 'none',
  }),
  'worktree.select': Object.freeze({ kind: 'presentation' }),
  'worktree.set_base_branch': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.worktree.write'] as const),
    revision: 'none',
  }),
  'worktree.set_notification_level': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.worktree.write'] as const),
  }),
  'worktree.split_temporary_workspace': Object.freeze({
    kind: 'legacy',
    access: 'write',
    grants: Object.freeze(['core.worktree.write'] as const),
  }),
  'worktree.start_ci_check_fix': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.worktree.write'] as const),
    revision: 'none',
  }),
  'worktree.start_merge_conflict_resolution': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.worktree.write'] as const),
    revision: 'none',
  }),
  'worktree.start_pr_comment_triage': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.worktree.write'] as const),
    revision: 'none',
  }),
  'worktree.update_settings': Object.freeze({
    kind: 'core',
    access: 'write',
    executor: 'worktree-actions',
    grants: Object.freeze(['core.worktree.write'] as const),
    revision: 'none',
  }),
});

export function appAdvisorActionDisposition(
  type: string,
): AppAdvisorActionDisposition | undefined {
  return Object.prototype.hasOwnProperty.call(
    APP_ADVISOR_ACTION_DISPOSITIONS,
    type,
  )
    ? APP_ADVISOR_ACTION_DISPOSITIONS[type]
    : undefined;
}

/** The 81 presentation types (D8); the renderer refuses any other type arriving on ui.app_advisor.present. */
/** Core writes the main window's lease may apply when their guard fails (CAN-5999 D3). */
/**
 * CAN-6008 B1: core writes main hands to a mounted Settings surface through
 * the main window's lease, inside the keyed run for their tool call.
 */
export const APP_ADVISOR_SURFACE_REQUEST_ACTION_TYPES: ReadonlySet<string> =
  new Set(
    Object.entries(APP_ADVISOR_ACTION_DISPOSITIONS)
      .filter(
        ([, disposition]) =>
          disposition.kind === 'core' &&
          disposition.executor === 'settings-surface',
      )
      .map(([type]) => type),
  );

export const APP_ADVISOR_GUARDED_PRESENTATION_ACTION_TYPES: ReadonlySet<string> =
  new Set(
    Object.entries(APP_ADVISOR_ACTION_DISPOSITIONS)
      .filter(
        ([, disposition]) =>
          disposition.kind === 'core' &&
          disposition.access === 'write' &&
          disposition.presentationWhenGuarded === true,
      )
      .map(([type]) => type),
  );

export const APP_ADVISOR_PRESENTATION_ACTION_TYPES: ReadonlySet<string> =
  new Set(
    Object.entries(APP_ADVISOR_ACTION_DISPOSITIONS)
      .filter(([, disposition]) => disposition.kind === 'presentation')
      .map(([type]) => type),
  );
