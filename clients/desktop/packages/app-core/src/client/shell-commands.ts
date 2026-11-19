import type {
  RemoteControlCommandPayloadMap,
  RemoteControlCommandType,
  SubmitBrowserRemoteControlCommandResponse,
} from '@canopy/protocol/remote-control/shell';

/**
 * Shell commands (CAN-5985): the chat, Orchestrator, editor and activity
 * actions the shared web shell used to send only as Portal commands. Each is
 * a `CanopyClient` operation, so the same shell drives a paired computer over
 * Portal (`HttpCanopyClient` relays the named Portal command unchanged) and
 * directly (`@canopy/ipc-canopy-client` maps it onto the computer's IPC
 * channels, or refuses it with a typed unsupported error).
 *
 * Arguments are the Portal command payload plus the navigation target the
 * shell addressed. The target is what Portal authorizes some commands against
 * (a new standalone chat must target its own chat id, for example), so the
 * Portal client forwards it as sent; direct clients route by the payload.
 *
 * Results are command receipts in the Portal reply shape, which shell code
 * already reads (`ok`, `error`, `chatId`, `result`). Direct clients fill the
 * same fields from the computer's reply.
 */

/** The navigation target a shell command addresses, forwarded as sent. */
export type ShellCommandTarget = Readonly<Record<string, string | undefined>>;

/** One shell command's arguments: its payload and navigation target. */
export interface ShellCommandArgs<Payload> {
  readonly payload: Payload;
  readonly target?: ShellCommandTarget;
}

/**
 * A shell command's receipt. `ok: false` or `error` reports a definite
 * refusal; a rejected promise means the outcome is unknown or the command
 * never left this client.
 */
export type ShellCommandReceipt = SubmitBrowserRemoteControlCommandResponse;

/** Mutating shell commands and the Portal command each one carries. */
export const SHELL_COMMAND_REMOTE_CONTROL_TYPES = {
  'chat.send': 'portal.chat.send',
  'chat.cancel': 'portal.chat.cancel',
  'chat.cancelTurn': 'portal.chat.cancel_turn',
  'chat.createTab': 'portal.chat.create_tab',
  'chat.closeTab': 'portal.chat.close_tab',
  'chat.setModel': 'portal.chat.set_model',
  'chat.setThinkingLevel': 'portal.chat.set_thinking_level',
  'chat.setPlanMode': 'portal.chat.set_plan_mode',
  'chat.setFastMode': 'portal.chat.set_fast_mode',
  'chat.setPluginSelections': 'portal.chat.set_plugin_selections',
  'chat.answerQuestion': 'portal.chat.answer_question',
  'chat.dismissQuestion': 'portal.chat.dismiss_question',
  'chat.markRead': 'portal.chat.mark_read',
  'chat.setUnread': 'portal.chat.set_unread',
  'standaloneChat.send': 'portal.standalone_chat.send',
  'standaloneChat.create': 'portal.standalone_chat.create',
  'standaloneChat.cancel': 'portal.standalone_chat.cancel',
  'standaloneChat.setModel': 'portal.standalone_chat.set_model',
  'standaloneChat.setPluginSelections':
    'portal.standalone_chat.set_plugin_selections',
  'appAdvisor.send': 'portal.app_advisor.send',
  'appAdvisor.cancel': 'portal.app_advisor.cancel',
  'appAdvisor.setModel': 'portal.app_advisor.set_model',
  'appAdvisor.createTab': 'portal.app_advisor.create_tab',
  'appAdvisor.answerQuestion': 'portal.app_advisor.answer_question',
  'appAdvisor.dismissQuestion': 'portal.app_advisor.dismiss_question',
  'editor.resolveInvocable': 'portal.editor.resolve_invocable',
  'pipeline.resume': 'portal.pipeline.resume',
  'pipeline.retry': 'portal.pipeline.retry',
  'pipeline.rerun': 'portal.pipeline.rerun',
  'pipeline.requestLog': 'portal.pipeline.log_request',
  'pipeline.installCurated': 'portal.pipeline.install_curated',
  'script.requestLog': 'portal.script.log_request',
  'hook.pause': 'portal.hook.pause',
  'hook.resume': 'portal.hook.resume',
  'plan.delete': 'portal.plan.delete',
  'summary.refresh': 'portal.summary.refresh',
  'watcher.delete': 'portal.watcher.delete',
} as const satisfies Readonly<Record<string, RemoteControlCommandType>>;

/** Read-only shell commands and the Portal command each one carries. */
export const SHELL_QUERY_REMOTE_CONTROL_TYPES = {
  'editor.fileMentions': 'portal.editor.list_file_mentions',
  'editor.slashCommands': 'portal.editor.list_slash_commands',
  'editor.invocables': 'portal.editor.list_invocables',
  /** The composer's plugin picker catalog (collections, skills, plugins, MCP servers). */
  'editor.pluginCatalog': 'portal.chat.list_plugin_catalog',
  'pipeline.get': 'portal.pipeline.get',
  'pipeline.executions': 'portal.pipeline.execution_list',
  'pipeline.execution': 'portal.pipeline.execution.get',
  /** A cowork project's archived and deleted Work Entries (CAN-5986). */
  'workEntries.archived': 'portal.workspace.archived_work_entries.list',
} as const satisfies Readonly<Record<string, RemoteControlCommandType>>;

export type ShellCommandName = keyof typeof SHELL_COMMAND_REMOTE_CONTROL_TYPES;
export type ShellQueryName = keyof typeof SHELL_QUERY_REMOTE_CONTROL_TYPES;

/** The Portal payload of one shell operation. */
export type ShellCommandPayload<
  Type extends keyof RemoteControlCommandPayloadMap,
> = RemoteControlCommandPayloadMap[Type];

export type ShellCommandMap = {
  [K in ShellCommandName]: {
    args: ShellCommandArgs<
      ShellCommandPayload<(typeof SHELL_COMMAND_REMOTE_CONTROL_TYPES)[K]>
    >;
    result: ShellCommandReceipt;
  };
};

export type ShellQueryMap = {
  [K in ShellQueryName]: {
    args: ShellCommandArgs<
      ShellCommandPayload<(typeof SHELL_QUERY_REMOTE_CONTROL_TYPES)[K]>
    >;
    result: ShellCommandReceipt;
  };
};
