import {
  LABS_EXPERIMENTS_VERSION_HEADER,
  STEER_BY_DEFAULT_EXPERIMENT,
} from '@canopy/protocol/experiments';
import type { LabsAvailabilityState } from '../feature-flags/labs-availability';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  CanopyCloudClientError,
  isTransientCanopyCloudFailure,
  requestCanopyCloudJson,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import { getFeatureFlagService } from '../feature-flags/service';
import {
  peekCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  subscribeCanopyCloudAccountConfirmations,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  LabsExperimentsService,
  labsExperimentRegistry,
  labsExperimentStorageDependencies,
  type LabsAccountSession,
} from './labs-experiments-service';

interface CloudLabsSession extends LabsAccountSession {
  credentialContext?: CanopyCloudCredentialContext;
}
function accountSession(
  account: CanopyCloudAccountEntry | null,
): CloudLabsSession {
  if (!account || isGuestAccount(account))
    return { scope: 'local', signedIn: false, ready: true };
  const baseUrl = getCanopyCloudBaseUrl();
  return {
    scope: JSON.stringify([baseUrl, account.account?.id ?? 'unresolved']),
    signedIn: true,
    ready: !!account.account?.id,
    credentialContext: {
      baseUrl,
      apiKey: account.apiKey,
      account: account.account,
    },
  };
}
function accountFlagIdentity(
  account: CanopyCloudAccountEntry | null,
  session: CloudLabsSession,
): string {
  return JSON.stringify([
    session.scope,
    account?.apiKey,
    account?.account?.id,
    account?.account?.email,
    (account?.organizations ?? []).map(({ id }) => id).sort(),
    (account?.teams ?? []).map(({ id }) => id).sort(),
  ]);
}
function credential(session: LabsAccountSession): CanopyCloudCredentialContext {
  if (
    'credentialContext' in session &&
    session.credentialContext &&
    typeof session.credentialContext === 'object' &&
    'baseUrl' in session.credentialContext &&
    typeof session.credentialContext.baseUrl === 'string' &&
    'apiKey' in session.credentialContext &&
    typeof session.credentialContext.apiKey === 'string'
  )
    return {
      baseUrl: session.credentialContext.baseUrl,
      apiKey: session.credentialContext.apiKey,
    };
  throw new Error('Missing experiment account credentials.');
}
let service: LabsExperimentsService | null = null;
let disposers: (() => void)[] = [];
export function getLabsExperimentsService(): LabsExperimentsService {
  if (service) return service;
  const flags = getFeatureFlagService();
  const account = peekCanopyCloudAccount();
  let session = accountSession(account);
  let flagIdentity = accountFlagIdentity(account, session);
  const instance = new LabsExperimentsService(
    {
      ...labsExperimentStorageDependencies(),
      availability: (): LabsAvailabilityState =>
        flags.getLabsAvailabilityState(),
      fetchChoices: (session): Promise<unknown> =>
        requestCanopyCloudJson('/api/v1/experiments/choices', {
          headers: { [LABS_EXPERIMENTS_VERSION_HEADER]: '2' },
          credentialContext: credential(session),
        }),
      putChoice: (session, request): Promise<unknown> =>
        requestCanopyCloudJson(
          `/api/v1/experiments/choices/${encodeURIComponent(request.experimentId)}`,
          {
            method: 'PUT',
            headers: { [LABS_EXPERIMENTS_VERSION_HEADER]: '2' },
            body: JSON.stringify({ enabled: request.enabled }),
            credentialContext: credential(session),
          },
        ),
      // Validated refusals of the request itself; auth failures stay pending.
      isPermanentRejection: (error): boolean =>
        error instanceof CanopyCloudClientError &&
        !isTransientCanopyCloudFailure(error) &&
        (error.status === 400 || error.status === 409 || error.status === 413),
      diagnostic: (error): void =>
        logMainProcessWarn(
          '[labs-experiments] Experiment cache or synchronization failed.',
          error,
        ),
    },
    session,
    labsExperimentRegistry(),
  );
  service = instance;
  disposers = [
    flags.onSnapshotChanged(() => instance.availabilityChanged()),
    subscribeCanopyCloudAccountChanges((account) => {
      const next = accountSession(account);
      const nextFlagIdentity = accountFlagIdentity(account, next);
      if (nextFlagIdentity !== flagIdentity) {
        // Clear old targeting before publishing another account's cached choices.
        flags.invalidateContext();
        flagIdentity = nextFlagIdentity;
      }
      if (
        next.scope !== session.scope ||
        next.signedIn !== session.signedIn ||
        next.ready !== session.ready ||
        next.credentialContext?.apiKey !== session.credentialContext?.apiKey
      ) {
        session = next;
        void instance.activate(next);
      }
      void flags.refreshContext();
    }),
    // GitHub, Claude, and Codex targeting is probed live; a confirmed but
    // unchanged account is its periodic refresh. A confirmation also means
    // the server answered, so push any Labs choices saved while offline.
    subscribeCanopyCloudAccountConfirmations(() => {
      void flags.refreshContext();
      void instance.retryPendingSync();
    }),
  ];
  instance.availabilityChanged();
  return instance;
}
export function readSteerByDefaultEnabledInMain(): boolean | 'unavailable' {
  try {
    return getLabsExperimentsService().isExperimentEnabled(
      STEER_BY_DEFAULT_EXPERIMENT.id,
    );
  } catch (error) {
    logMainProcessWarn('[steer-by-default] Could not read Labs setting', error);
    return 'unavailable';
  }
}

export async function initializeLabsExperimentsService(): Promise<void> {
  await getLabsExperimentsService().refreshChoices();
}
export async function disposeLabsExperimentsService(): Promise<void> {
  for (const dispose of disposers) dispose();
  disposers = [];
  // A background sync pass may still settle after this; its writes are atomic
  // and at worst leave a spare pending id, which re-sends the same value.
  await service?.flush();
  service = null;
}
