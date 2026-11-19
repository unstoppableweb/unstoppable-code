import {
  chatSurfaceUsesGlobalPluginDefaults,
  legacyAccountMcpConnectionId,
  withoutAccountsPickedOver,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { access } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import {
  automationAccountProblemText,
  automationAccountProblems,
  choseOtherSignIn,
  workflowStepAccountProblems,
  type AutomationAccountProblem,
} from '@canopy/desktop-shared/lib/automation-accounts';
import type { McpServerRef } from '@canopy/protocol/mcp-servers';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/execution-engine/types/plugins';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { showOsNotification } from '../ipc/os-notifications';
import { getMcpServerFilePath } from '../lib/paths';
import { isSpaceNotificationDeliverable } from '../lib/space-notification-gate';
import {
  accountMcpConnectionsEnabled,
  loadAccountMcpRefConnections,
} from '../mcp/account-catalog';
import {
  readCachedCuratedMcpDesktopOnlyKeys,
  readCachedCuratedMcpServers,
} from '../mcp/curated-catalog';
import { listDetectedMcpServersForSelections } from '../plugins/mcp-inventory';

/** The run stopped before sending anything because of an account (CAN-6233). */
export class AutomationAccountUnavailableError extends Error {
  constructor(
    readonly problems: readonly AutomationAccountProblem[],
    subject: 'automation' | 'workflow' = 'automation',
  ) {
    super(
      [
        'This run stopped before sending anything.',
        ...problems.map((problem) =>
          automationAccountProblemText(problem, subject),
        ),
      ].join(' '),
    );
    this.name = 'AutomationAccountUnavailableError';
  }
}

/** Shown when the connection list could not be read; the next run retries. */
export const AUTOMATION_ACCOUNTS_UNREADABLE_MESSAGE =
  "This run stopped before sending anything: the accounts it sends as couldn't be checked. It tries again at its next run.";

let ownerWindow: () => BrowserWindow | null = () => null;

/** The window the owner's notice is raised from; set once by the service. */
export function setAutomationAccountNoticeWindow(
  getWindow: () => BrowserWindow | null,
): void {
  ownerWindow = getWindow;
}

export interface AutomationAccountRun {
  /** The automation's name, for the owner's notice. */
  readonly automationName: string;
  /** The run's space, when it has one, for the notification policy. */
  readonly scope?: { readonly projectId: string; readonly worktreeId: string };
  /**
   * The chat the run sends into (`chatId`), or the task it opens a chat in.
   * The check then layers what that chat's session inherits, the person's
   * global defaults included, so it sees every account the run loads.
   */
  readonly target?: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly chatId?: string;
  };
}

/** Stands in for the chat a run opens, which has no id or saved state yet. */
const NEW_CHAT_ID = 'automation-new-chat';

/**
 * The selections the run's session loads: `local` with the layers its chat
 * inherits, by the session's own function, where the session applies them.
 * Layering maps legacy `account:<id>` refs onto their connector and drops a
 * deleted one, so the stored legacy refs are kept beside it for the check to
 * name.
 */
async function withSessionLayers(
  local: ChatTabPluginSelections,
  target: NonNullable<AutomationAccountRun['target']>,
): Promise<ChatTabPluginSelections> {
  if (!chatSurfaceUsesGlobalPluginDefaults(target.projectId)) return local;
  const { resolveEffectiveChatPluginContext } =
    await import('../plugins/global-plugin-overlay');
  const { selections } = await resolveEffectiveChatPluginContext(
    local,
    {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId ?? NEW_CHAT_ID,
    },
    target.chatId !== undefined ? true : { inheritsProjectDefaults: true },
  );
  const legacy = (local.mcpServerRefs ?? []).filter(
    (ref) => legacyAccountMcpConnectionId(ref.serverId) !== undefined,
  );
  return legacy.length === 0
    ? selections
    : {
        ...selections,
        mcpServerRefs: [...(selections.mcpServerRefs ?? []), ...legacy],
      };
}

/** The curated keys of the servers the selection's curated plugins bring. */
async function pluginCuratedKeys(
  selections: ChatTabPluginSelections,
): Promise<string[]> {
  const curatedPlugins = selections.pluginRefs.some(
    (ref) => ref.marketplaceId === CURATED_PLUGIN_MARKETPLACE_ID,
  );
  if (!curatedPlugins && selections.collectionIds.length === 0) return [];
  const { servers } = await listDetectedMcpServersForSelections(selections);
  // Every curated server a plugin brings, unless the person chose another
  // sign-in for it (on the server or for this run): an unbound row, such as
  // several accounts with no default, still needs an account. A device
  // server binds only when the person holds no account, which the check
  // skips anyway.
  return servers.flatMap((server) =>
    server.source === 'plugin' &&
    server.curatedKey !== undefined &&
    !choseOtherSignIn(server)
      ? [server.curatedKey]
      : [],
  );
}

function selectsAccountConnector(selections: ChatTabPluginSelections): boolean {
  return (
    (selections.mcpServerRefs?.length ?? 0) > 0 ||
    selections.pluginRefs.some(
      (ref) => ref.marketplaceId === CURATED_PLUGIN_MARKETPLACE_ID,
    ) ||
    selections.collectionIds.length > 0
  );
}

/** Which refs name a server on this device, read once off the main thread. */
async function deviceServerCheck(
  refs: readonly McpServerRef[],
): Promise<(serverId: string) => boolean> {
  const deviceServerIds = new Set(
    (
      await Promise.all(
        Array.from(new Set(refs.map((ref) => ref.serverId)), (id) =>
          access(getMcpServerFilePath(id)).then(
            (): string | null => id,
            (): string | null => null,
          ),
        ),
      )
    ).filter((id): id is string => id !== null),
  );
  return (serverId) => deviceServerIds.has(serverId);
}

function noticeOwner(run: AutomationAccountRun, message: string): void {
  if (
    run.scope !== undefined &&
    !isSpaceNotificationDeliverable(run.scope, 'attention')
  )
    return;
  showOsNotification(
    {
      id: `automation-accounts:${run.automationName}`,
      title: `${run.automationName} didn't run`,
      body: message,
    },
    ownerWindow,
  );
}

/**
 * Stops a run nobody watches before it sends anything when an account of a
 * connector it uses can't be acted as (CAN-6233): several accounts and none
 * chosen ("Send as"), the chosen account gone, or it isn't connected. The
 * run fails with the named reason, which never falls back to another
 * account, and the owner gets a notice. A connection list that can't be read
 * fails the run too, since the accounts can't be checked; the next run tries
 * again. Does nothing when account connections are off.
 */
export async function assertAutomationAccountsReady(
  rawSelections: ChatTabPluginSelections | undefined,
  run: AutomationAccountRun,
): Promise<void> {
  if (!accountMcpConnectionsEnabled()) return;
  // With a target, the chat's inherited layers can bring accounts even when
  // the automation selects nothing itself.
  if (!rawSelections && !run.target) return;
  // Legacy `account:<id>` refs stay as stored: normalizing would drop one
  // whose connection is gone, and the check names that instead.
  const stored = normalizePluginSelections(rawSelections);
  const selections = run.target
    ? await withSessionLayers(stored, run.target)
    : stored;
  if (!selectsAccountConnector(selections)) return;
  const desktopOnlyKeys = await readCachedCuratedMcpDesktopOnlyKeys();
  // What the run loads, by the session's own filter: collections expanded,
  // and turned-off collections, plugins and MCP configurations left out, so
  // only an account the run would act as can stop it.
  const { resolveEffectivePluginSelectionRefs } =
    await import('../plugins/plugin-resolver');
  const effective = await resolveEffectivePluginSelectionRefs(
    selections,
    [],
    undefined,
    undefined,
    'unattended',
  );
  const directRefs = effective.mcpServerRefs;
  const isDeviceServer = await deviceServerCheck(directRefs);
  const connections = await loadAccountMcpRefConnections();
  if (connections === null) {
    // Only a ref that names an account needs the list; device servers and
    // the servers plugins bring run as they do in a chat.
    if (
      !directRefs.some(
        (ref) =>
          !isDeviceServer(ref.serverId) && !desktopOnlyKeys.has(ref.serverId),
      )
    )
      return;
    noticeOwner(run, AUTOMATION_ACCOUNTS_UNREADABLE_MESSAGE);
    throw new Error(AUTOMATION_ACCOUNTS_UNREADABLE_MESSAGE);
  }
  const problems = automationAccountProblems({
    connections,
    directRefs,
    pluginCuratedKeys: await pluginCuratedKeys({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: effective.pluginRefs,
      // The run's per-server sign-in choices, so a plugin set to use its
      // provider's sign-in is not read as using an account.
      ...(selections.mcpHttpAuthPreferences
        ? { mcpHttpAuthPreferences: selections.mcpHttpAuthPreferences }
        : {}),
    }),
    isDeviceServer,
    desktopOnlyKeys,
    curatedConnectors: new Map(
      ((await readCachedCuratedMcpServers())?.servers ?? []).map(
        (server): [string, string] => [server.key, server.name],
      ),
    ),
  });
  if (problems.length === 0) return;
  const error = new AutomationAccountUnavailableError(problems);
  noticeOwner(run, error.message);
  throw error;
}

/**
 * Stops a send step a person started before it sends anything when an account
 * the step names can't be acted as (CAN-7186): the added account it names is
 * gone, or an account it names isn't connected. Only the step's own
 * selections are checked, its installed collections' refs included; a
 * connector it names no account of acts as the
 * person's default, as their own chat does. The person sees the step fail, so
 * no notice is raised. A connection list that can't be read lets the run
 * through, since an attended turn binds as it would anyway.
 */
export async function assertWorkflowStepAccountsReady(
  stepSelections: ChatTabPluginSelections | undefined,
): Promise<void> {
  if (!accountMcpConnectionsEnabled() || !stepSelections) return;
  // The step's installed collections bring account refs too: expanded by
  // the session's own filter (turned-off ones bring none), as the scheduled
  // check expands them, beside the step's own refs as written.
  const collectionRefs =
    stepSelections.collectionIds.length === 0
      ? []
      : (
          await (
            await import('../plugins/plugin-resolver')
          ).resolveEffectivePluginSelectionRefs(
            {
              collectionIds: stepSelections.collectionIds,
              skillRefs: [],
              pluginRefs: [],
            },
            [],
            undefined,
            undefined,
            'unattended',
          )
        ).mcpServerRefs;
  // The step's own account pick of a connector stands in for a collection's
  // other account of it, as the session layers them.
  const directRefs = [
    ...(stepSelections.mcpServerRefs ?? []),
    ...(withoutAccountsPickedOver(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: collectionRefs,
      },
      stepSelections,
    )?.mcpServerRefs ?? []),
  ];
  if (directRefs.length === 0) return;
  const connections = await loadAccountMcpRefConnections();
  if (connections === null) return;
  const problems = workflowStepAccountProblems({
    connections,
    directRefs,
    isDeviceServer: await deviceServerCheck(directRefs),
    desktopOnlyKeys: await readCachedCuratedMcpDesktopOnlyKeys(),
  });
  if (problems.length > 0)
    throw new AutomationAccountUnavailableError(problems, 'workflow');
}
