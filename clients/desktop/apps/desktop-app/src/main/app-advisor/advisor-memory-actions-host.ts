import {
  MEMORY_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { isAskUserDismissal } from '../lib/ask-user-outcomes';
import type {
  AdvisorMemoryActionHost,
  PersonConfirmation,
} from './advisor-memory-actions';

/** This chat's AskUserQuestion, with each answer's provenance. */
export type RequestUserAnswers = (
  questions: Array<{
    question: string;
    options: string[];
    multiSelect?: boolean;
    allowOther?: boolean;
  }>,
) => Promise<
  Array<{ selectedOptions: string[]; answeredBy?: 'person' | 'agent' }>
>;

/**
 * The core.memory maintenance operations as the advisor chat, each call with
 * only its operation's grant (CAN-6005), and the person's confirmation.
 */
export function mainAdvisorMemoryActionHost(options: {
  chatId: string;
  /** This tool call's key, shared by its retries. */
  callKey: string;
  requestUserAnswers: RequestUserAnswers;
}): AdvisorMemoryActionHost {
  const caller = (
    grant: CanopyCallerDescriptor['grants'][number],
  ): CanopyCallerDescriptor => ({
    principalId: 'local-desktop-user',
    clientInstanceId: `agent-action:${options.chatId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants: [grant],
  });
  const keyed = (
    step: string,
  ): {
    meta: { idempotencyKey: string };
    options: {
      caller: CanopyCallerDescriptor;
      metadata: { idempotencyKey: string };
    };
  } => {
    const idempotencyKey = `app-advisor-action:${options.callKey}:${step}`;
    return {
      meta: { idempotencyKey },
      options: {
        caller: caller(MEMORY_GRANTS.write),
        metadata: { idempotencyKey },
      },
    };
  };
  return {
    consolidate: (target) => {
      const key = keyed(`consolidate:${target.scope}`);
      return getActiveDesktopRuntime().instruction(
        'core.memory.consolidation.run',
        { target, _meta: key.meta },
        key.options,
      );
    },
    listSnapshots: (target) =>
      getActiveDesktopRuntime().query(
        'core.memory.snapshot.list',
        { target },
        { caller: caller(MEMORY_GRANTS.read) },
      ),
    rebuild: (target, expectedRevision) => {
      const key = keyed('rebuild');
      return getActiveDesktopRuntime().instruction(
        'core.memory.consolidation.rebuild',
        { target, expectedRevision, _meta: key.meta },
        key.options,
      );
    },
    restoreSnapshot: (target, snapshotId, expectedRevision) => {
      const key = keyed('restore');
      return getActiveDesktopRuntime().instruction(
        'core.memory.snapshot.restore',
        { target, snapshotId, expectedRevision, _meta: key.meta },
        key.options,
      );
    },
    importSources: (workspaceId) =>
      getActiveDesktopRuntime().query(
        'core.memory.import.sources.list',
        workspaceId === undefined ? {} : { workspaceId },
        { caller: caller(MEMORY_GRANTS.read) },
      ),
    importExternal: (workspaceId, expectedSourcesDigest) => {
      const key = keyed('import');
      return getActiveDesktopRuntime().instruction(
        'core.memory.import.external',
        {
          ...(workspaceId === undefined ? {} : { workspaceId }),
          expectedSourcesDigest,
          _meta: key.meta,
        },
        key.options,
      );
    },
    projectName: async (workspaceId) => {
      const { readAllSidebarItems } = await import('../lib/sidebar-items');
      const item = (await readAllSidebarItems()).items.find(
        (entry) => entry.id === workspaceId,
      );
      return item?.name ?? null;
    },
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
