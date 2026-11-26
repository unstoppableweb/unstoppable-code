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
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import {
  prepareFeedbackDiagnostics,
  readFeedbackDiagnosticsEntry,
  saveFeedbackDiagnostics,
  releaseFeedbackDiagnostics,
  revokeFeedbackDiagnostics,
} from '../feedback/feedback-snapshots';
import { createFeedbackErrorAccountFence } from '../feedback/feedback-error-account-fence';

let accountGeneration = 0;
let subscribed = false;
const errorAccounts = createFeedbackErrorAccountFence();
// A guest can't file error reports: like a signed-out viewer, it is asked to
// sign in, and that account may then report what the guest saw.
function reportingCredential(
  entry: CanopyCloudAccountEntry | null,
): string | null {
  return entry && !isGuestAccount(entry) ? entry.apiKey : null;
}

interface AccountRead {
  readonly entry: CanopyCloudAccountEntry | null;
  /** `undefined` when the read failed: no account can vouch for an error. */
  readonly reporting: string | null | undefined;
}

// An unreadable account owns snapshots as a signed-out viewer, as before.
async function readAccount(): Promise<AccountRead> {
  const result = await readCanopyCloudAccountWithStatus().catch(
    (error: unknown) => {
      errorAccounts.observeUnreadable();
      throw error;
    },
  );
  if (result.status !== 'ok') {
    errorAccounts.observeUnreadable();
    return { entry: null, reporting: undefined };
  }
  const reporting = reportingCredential(result.entry);
  errorAccounts.observeRead(reporting);
  return { entry: result.entry, reporting };
}

function ownerOf(
  event: IpcMainInvokeEvent,
  account: AccountRead,
  errorReport: boolean,
): string {
  if (errorReport && !account.reporting) {
    throw new Error('Sign in to report this error.');
  }
  return createHash('sha256')
    .update(
      JSON.stringify([
        event.sender.id,
        accountGeneration,
        account.entry?.apiKey ?? null,
      ]),
    )
    .digest('hex');
}

async function ownerFor(event: IpcMainInvokeEvent): Promise<string> {
  return ownerOf(event, await readAccount(), false);
}

/**
 * Admission and the owner come from one read, so an account change while it
 * is pending cannot attach the earlier account's error. A later change moves
 * the owner, which each handler re-checks before acting on it.
 */
async function admit<T extends { error?: unknown; telemetry?: unknown }>(
  received: T,
): Promise<{ request: T; account: AccountRead }> {
  const account = await readAccount();
  return { request: errorAccounts.admit(received, account.reporting), account };
}

export function registerFeedbackHandlers(): void {
  if (!subscribed) {
    subscribed = true;
    subscribeCanopyCloudAccountChanges((entry) => {
      errorAccounts.observe(reportingCredential(entry));
      accountGeneration += 1;
      void revokeFeedbackDiagnostics();
    });
    void readAccount().catch(() => undefined);
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
  >(IPC_CHANNELS.feedbackDiagnosticsPrepare, async (event, received) => {
    // The archive scope must match the submit, which drops the same error.
    const { request, account } = await admit(received);
    const owner = ownerOf(event, account, false);
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
    async (event, received) => {
      const { request, account } = await admit(received);
      const owner = ownerOf(event, account, request.error !== undefined);
      return submitFeedback(request, {
        owner,
        exact: true,
        // No sign-in gate here: a switch, even to a guest, reaches the client
        // as an account change, which holds the send.
        validateOwner: async () => {
          if (owner !== (await ownerFor(event)))
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
    async (event, received) => {
      if (received.error === undefined) return submitFeedback(received);
      const { request, account } = await admit(received);
      if (!request.error) return submitFeedback(request);
      const owner = ownerOf(event, account, true);
      return submitFeedback(request, {
        owner,
        validateOwner: async () => {
          if (owner !== (await ownerFor(event)))
            throw new Error('Account changed. Reopen the report.');
        },
      });
    },
  );
}
