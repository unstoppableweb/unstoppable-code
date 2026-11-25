import { createHash } from 'node:crypto';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  FeedbackDiagnosticsSnapshot,
  FeedbackDiagnosticsEntryContent,
} from '@canopy/protocol/feedback-report';
import {
  IPC_CHANNELS,
  type FeedbackDiagnosticsPrepareRequest,
  type FeedbackPrepareRequest,
  type FeedbackPrepareResponse,
  type FeedbackSubmitRequest,
  type FeedbackSubmitResponse,
} from '@canopy/desktop-shared/types';
import { prepareFeedbackBundle } from '../feedback/feedback-bundle';
import { submitFeedback } from '../feedback/feedback-submit';
import { registerIpcHandler } from './register';
import {
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import {
  prepareFeedbackDiagnostics,
  readFeedbackDiagnosticsEntry,
  saveFeedbackDiagnostics,
  releaseFeedbackDiagnostics,
  revokeFeedbackDiagnostics,
} from '../feedback/feedback-snapshots';

let accountGeneration = 0;
let subscribed = false;
async function ownerFor(
  event: IpcMainInvokeEvent,
  errorReport = false,
): Promise<string> {
  const account = await loadCanopyCloudAccount();
  if (errorReport && (!account || isGuestAccount(account))) {
    throw new Error('Sign in to report this error.');
  }
  return createHash('sha256')
    .update(
      JSON.stringify([
        event.sender.id,
        accountGeneration,
        account?.apiKey ?? null,
      ]),
    )
    .digest('hex');
}

export function registerFeedbackHandlers(): void {
  if (!subscribed) {
    subscribed = true;
    subscribeCanopyCloudAccountChanges(() => {
      accountGeneration += 1;
      void revokeFeedbackDiagnostics();
    });
  }
  // `errorSource` is additive: this host accepts `source` on report errors.
  // The protocol version stays 1 because older clients ignore the flag.
  registerIpcHandler<[], { snapshots: true; version: 1; errorSource: true }>(
    IPC_CHANNELS.feedbackDiagnosticsCapabilities,
    () => ({
      snapshots: true,
      version: 1,
      errorSource: true,
    }),
  );
  registerIpcHandler<
    [FeedbackDiagnosticsPrepareRequest],
    FeedbackDiagnosticsSnapshot
  >(IPC_CHANNELS.feedbackDiagnosticsPrepare, async (event, request) => {
    const owner = await ownerFor(event);
    const snapshot = await prepareFeedbackDiagnostics(owner, request);
    if (owner !== (await ownerFor(event))) {
      await releaseFeedbackDiagnostics(owner, snapshot.id);
      throw new Error('Account changed. Prepare diagnostics again.');
    }
    return snapshot;
  });
  registerIpcHandler<[string, string], FeedbackDiagnosticsEntryContent>(
    IPC_CHANNELS.feedbackDiagnosticsRead,
    async (event, id, entry) => {
      const owner = await ownerFor(event);
      const result = await readFeedbackDiagnosticsEntry(owner, id, entry);
      if (owner !== (await ownerFor(event)))
        throw new Error('Account changed. Reopen the report.');
      return result;
    },
  );
  registerIpcHandler<[string], void>(
    IPC_CHANNELS.feedbackDiagnosticsSave,
    async (event, id) => saveFeedbackDiagnostics(await ownerFor(event), id),
  );
  registerIpcHandler<[string], void>(
    IPC_CHANNELS.feedbackDiagnosticsRelease,
    async (event, id) => releaseFeedbackDiagnostics(await ownerFor(event), id),
  );
  registerIpcHandler<[FeedbackSubmitRequest], FeedbackSubmitResponse>(
    IPC_CHANNELS.feedbackReportSubmit,
    async (event, request) => {
      const owner = await ownerFor(event, request.error !== undefined);
      return submitFeedback(request, {
        owner,
        exact: true,
        validateOwner: async () => {
          if (owner !== (await ownerFor(event, request.error !== undefined)))
            throw new Error('Account changed. Reopen the report.');
        },
      });
    },
  );
  registerIpcHandler<[FeedbackPrepareRequest], FeedbackPrepareResponse>(
    IPC_CHANNELS.feedbackPrepare,
    async (_event, request) => prepareFeedbackBundle(request),
  );
  registerIpcHandler<[FeedbackSubmitRequest], FeedbackSubmitResponse>(
    IPC_CHANNELS.feedbackSubmit,
    async (event, request) => {
      if (!request.error) return submitFeedback(request);
      const owner = await ownerFor(event, true);
      return submitFeedback(request, {
        owner,
        validateOwner: async () => {
          if (owner !== (await ownerFor(event, true)))
            throw new Error('Account changed. Reopen the report.');
        },
      });
    },
  );
}
