import {
  CONFIG_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { isAskUserDismissal } from '../lib/ask-user-outcomes';
import { toAdvisorJson } from './advisor-json';
import type { PersonConfirmation } from './advisor-records-actions';
import type { RequestUserAnswers } from './advisor-records-actions-host';
import type { AdvisorSettingsActionHost } from './advisor-settings-actions';

/**
 * `core.config.get` and `core.config.update` as the advisor chat, each call
 * with only its operation's grant (CAN-6004); launch at sign-in and the
 * account proxy's status through main's own services; and the person's
 * confirmation.
 */
export function mainAdvisorSettingsActionHost(options: {
  chatId: string;
  /** This tool call's key, shared by its retries. */
  callKey: string;
  requestUserAnswers: RequestUserAnswers;
}): AdvisorSettingsActionHost {
  const caller = (
    grant: CanopyCallerDescriptor['grants'][number],
  ): CanopyCallerDescriptor => ({
    principalId: 'local-desktop-user',
    clientInstanceId: `agent-action:${options.chatId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants: [grant],
  });
  return {
    read: (namespace) =>
      getActiveDesktopRuntime().query(
        'core.config.get',
        { namespace },
        { caller: caller(CONFIG_GRANTS.read) },
      ),
    update: (update) => {
      const idempotencyKey = `app-advisor-action:${options.callKey}:config:${update.namespace}`;
      return getActiveDesktopRuntime().instruction(
        'core.config.update',
        { ...update, _meta: { idempotencyKey } },
        {
          caller: caller(CONFIG_GRANTS.write),
          metadata: { idempotencyKey },
        },
      );
    },
    setLaunchAtLogin: async (enabled) =>
      (await import('../ipc/launch-at-login')).handleSetLaunchAtLoginEnabled(
        enabled,
      ),
    accountProxyStatus: async (refresh) =>
      toAdvisorJson(
        await (
          await import('../account-proxy/service')
        ).getAccountProxyStatus({ refresh, refreshUsage: false }),
      ),
    confirm: async (question, labels): Promise<PersonConfirmation> => {
      let answers: Awaited<ReturnType<RequestUserAnswers>>;
      try {
        answers = await options.requestUserAnswers([
          {
            question,
            options: [labels.confirm, labels.decline],
            multiSelect: false,
            allowOther: false,
          },
        ]);
      } catch (error) {
        // A dismissal declines; any failure to ask someone fails closed.
        return isAskUserDismissal(error) ? 'declined' : 'no_person';
      }
      const answer = answers[0];
      // Only a person's answer confirms; an agent's or one of unknown origin
      // never does.
      if (answer?.answeredBy !== 'person') return 'no_person';
      return answer.selectedOptions.includes(labels.confirm)
        ? 'confirmed'
        : 'declined';
    },
  };
}
