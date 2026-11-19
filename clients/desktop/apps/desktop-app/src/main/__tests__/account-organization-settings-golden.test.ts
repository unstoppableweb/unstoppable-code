// CAN-4168 golden: hosted account and organization settings as desktop main
// orchestrates them today, captured before the core account session takes
// ownership. It drives the real settings service with the real orchestration
// and follow-up resolvers; the bridge session, hosted calls, feed streams,
// Portal page open, Personal promotion and post-write refreshes are recorded
// fakes. A change here is a behaviour change: re-record deliberately with
// `pnpm test <this file> -u` and review the snapshot diff.
import { SettingsOperationError } from '@canopy/protocol/settings';
import type { SettingsEvent } from '@canopy/protocol/settings';
import {
  createAccountOrganizationSettingsService,
  type AccountOrganizationSettingsService,
  type SettingsBridgeSessionState,
  type SettingsEventSender,
  type SettingsSessionPort,
} from '../services/account-organization-settings';
import {
  createSettingsOrchestratedOperations,
  createSettingsWriteFollowUps,
} from '../services/account-organization-settings-orchestration';
import type { PersonalOrganizationUpgradeService } from '../services/personal-organization-upgrade';

const ACCOUNT = 'account-one';
const OTHER = 'account-two';
const PERSONAL = '33333333-3333-4333-8333-333333333333';
const TEAM = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const OPERATION = '66666666-6666-4666-8666-666666666666';

const log: string[] = [];

class FakeSession implements SettingsSessionPort {
  readonly generation: number;
  state: SettingsBridgeSessionState = 'ready';
  private readonly listeners = new Set<
    (state: SettingsBridgeSessionState) => void
  >();
  constructor(
    readonly accountId: string,
    generation: number,
  ) {
    this.generation = generation;
  }
  ensureReady(options?: { userInitiated?: boolean }): Promise<void> {
    log.push(
      `ensureReady ${this.accountId}#${String(this.generation)} user=${String(options?.userInitiated ?? false)}`,
    );
    return Promise.resolve();
  }
  onStateChange(
    listener: (state: SettingsBridgeSessionState) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(): void {
    this.state = 'disposed';
    for (const listener of Array.from(this.listeners)) listener('disposed');
  }
}

class FakeSender implements SettingsEventSender {
  readonly sent: unknown[] = [];
  private destroyed = false;
  private readonly handlers = new Map<string, Set<() => void>>();
  constructor(readonly id: number) {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args });
  }
  once(event: 'destroyed', listener: () => void): unknown {
    return this.add(event, listener);
  }
  on(event: 'did-navigate', listener: () => void): unknown {
    return this.add(event, listener);
  }
  removeListener(
    event: 'destroyed' | 'did-navigate',
    listener: () => void,
  ): unknown {
    this.handlers.get(event)?.delete(listener);
    return this;
  }
  emit(event: 'destroyed' | 'did-navigate'): void {
    if (event === 'destroyed') this.destroyed = true;
    for (const listener of Array.from(this.handlers.get(event) ?? []))
      listener();
  }
  listenerCount(): number {
    let count = 0;
    for (const set of this.handlers.values()) count += set.size;
    return count;
  }
  private add(event: string, listener: () => void): this {
    const set = this.handlers.get(event) ?? new Set();
    set.add(listener);
    this.handlers.set(event, set);
    return this;
  }
}

interface World {
  signedIn: string | null;
  session: FakeSession | null;
  generation: number;
  accountListeners: Set<(accountId: string | null) => void>;
  streams: { scope: unknown; emit: (event: SettingsEvent) => void }[];
  handoffAvailable: boolean;
  onExecute: ((name: string) => void) | null;
  promote: PersonalOrganizationUpgradeService['promote'];
}

let world: World;

function unexpected(): Promise<never> {
  return Promise.reject(new Error('Unexpected upgrade call'));
}

function upgradeService(): PersonalOrganizationUpgradeService {
  return {
    inviteStatus: unexpected,
    status: unexpected,
    convert: unexpected,
    list: unexpected,
    promote: (request) => world.promote(request),
    invite: unexpected,
    resume: unexpected,
  };
}
let service: AccountOrganizationSettingsService;

function bootstrap(accountId: string): unknown {
  return {
    version: 1,
    viewer: { id: accountId, email: `${accountId}@example.test`, name: null },
    account: {
      billingEnabled: true,
      digestsEnabled: true,
      integrationsEnabled: true,
      freeAccess: true,
    },
    organizations: [
      { id: PERSONAL, name: 'Personal', role: 'OWNER', isPersonal: true },
      { id: TEAM, name: 'Team', role: 'MEMBER', isPersonal: false },
    ],
    organization: null,
  };
}

function switchAccount(accountId: string | null): void {
  world.session?.dispose();
  world.signedIn = accountId;
  world.session = null;
  for (const listener of Array.from(world.accountListeners))
    listener(accountId);
}

beforeEach(() => {
  log.length = 0;
  world = {
    signedIn: ACCOUNT,
    session: null,
    generation: 0,
    accountListeners: new Set(),
    streams: [],
    handoffAvailable: true,
    onExecute: null,
    promote: (
      request,
    ): ReturnType<PersonalOrganizationUpgradeService['promote']> => {
      log.push(`promote ${request.organizationId} ${request.name}`);
      return Promise.resolve({
        promotion: {
          organizationId: request.organizationId,
          name: request.name,
          personalOrganizationId: PERSONAL,
          operationId: request.operationId,
          alreadyUpgraded: false,
          warnings: [],
        },
        contextSwitched: true,
        warnings: [],
      });
    },
  };
  service = createAccountOrganizationSettingsService<FakeSession>({
    acquireSession: (accountId) => {
      log.push(`acquireSession ${accountId}`);
      if (world.signedIn !== accountId)
        return Promise.reject(
          new SettingsOperationError({ code: 'unauthenticated' }),
        );
      world.generation += 1;
      world.session ??= new FakeSession(accountId, world.generation);
      return Promise.resolve(world.session);
    },
    execute: (session, name, input) => {
      log.push(`execute ${name} ${JSON.stringify(input)}`);
      world.onExecute?.(name);
      if (name === 'settings.bootstrap')
        return Promise.resolve(bootstrap(session.accountId));
      return Promise.resolve(null);
    },
    openFeedStream: (_session, scope, handlers) => {
      log.push(`openFeedStream ${JSON.stringify(scope)}`);
      world.streams.push({
        scope,
        emit: (event): void => handlers.onEvent(event),
      });
      return {
        close: (): void => {
          log.push(`closeFeedStream ${JSON.stringify(scope)}`);
        },
      };
    },
    credentials: (accountId) => {
      if (world.signedIn !== accountId)
        return Promise.reject(new Error('account changed'));
      return Promise.resolve({
        baseUrl: 'https://cloud.example.test',
        apiKey: 'csk_never_logged',
      });
    },
    currentAccountId: () => Promise.resolve(world.signedIn),
    currentSession: () => world.session,
    signedInAccountId: () => world.signedIn,
    subscribeAccountChanges: (listener) => {
      world.accountListeners.add(listener);
      return (): boolean => world.accountListeners.delete(listener);
    },
    openStrictPortalPage: (path, credentials) => {
      log.push(
        `openStrictPortalPage ${path} key=${credentials.apiKey ? 'present' : 'absent'}`,
      );
      return Promise.resolve({ ok: true });
    },
    paymentHandoffAvailable: (accountId) => {
      log.push(`paymentHandoffAvailable ${accountId}`);
      return Promise.resolve(world.handoffAvailable);
    },
    resolveOrchestrated: createSettingsOrchestratedOperations(() =>
      Promise.resolve(upgradeService()),
    ),
    resolveWriteFollowUp: createSettingsWriteFollowUps({
      refresh: () => {
        log.push('followUp refresh');
        return Promise.resolve();
      },
      refreshWithRetry: (name) => {
        log.push(`followUp refreshWithRetry ${name}`);
        return Promise.resolve();
      },
      clearRemovedGatewayKey: (organizationId, accountId) => {
        log.push(
          `followUp clearRemovedGatewayKey ${organizationId} ${accountId}`,
        );
        return Promise.resolve();
      },
      refreshOrganizationCapabilities: (organizationId) => {
        log.push(`followUp refreshOrganizationCapabilities ${organizationId}`);
        return Promise.resolve();
      },
      refreshProjectCapabilities: (projectId) => {
        log.push(`followUp refreshProjectCapabilities ${projectId}`);
        return Promise.resolve();
      },
    }),
    randomId: () => 'request-0001',
  });
});

afterEach(() => {
  service.dispose();
});

describe('reads and writes', () => {
  it('reads through the signed-in bridge session and refuses bad requests before any session', async () => {
    const results = {
      bootstrap: await service.read({
        accountId: ACCOUNT,
        operation: 'settings.bootstrap',
        input: {},
      }),
      unknownOperation: await service.read({
        accountId: ACCOUNT,
        operation: 'not.an.operation',
        input: {},
      }),
      writeThroughRead: await service.read({
        accountId: ACCOUNT,
        operation: 'organization.leave',
        input: { organizationId: TEAM },
      }),
      invalidInput: await service.read({
        accountId: ACCOUNT,
        operation: 'settings.bootstrap',
        input: { organizationId: 7 },
      }),
      otherAccount: await service.read({
        accountId: OTHER,
        operation: 'settings.bootstrap',
        input: {},
      }),
    };
    expect({ results, log }).toMatchSnapshot();
  });

  it('runs the follow-up each write names and none for the others', async () => {
    const results = {
      leave: await service.write({
        accountId: ACCOUNT,
        operation: 'organization.leave',
        input: { organizationId: TEAM },
      }),
      accept: await service.write({
        accountId: ACCOUNT,
        operation: 'organization.invitations.respond',
        input: { inviteId: 'invite-1', action: 'accept' },
      }),
      decline: await service.write({
        accountId: ACCOUNT,
        operation: 'organization.invitations.respond',
        input: { inviteId: 'invite-2', action: 'decline' },
      }),
    };
    expect({ results, log }).toMatchSnapshot();
  });

  it('reports an account change during a read as expired and during a write as uncertain', async () => {
    world.onExecute = (): void => switchAccount(OTHER);
    const read = await service.read({
      accountId: ACCOUNT,
      operation: 'settings.bootstrap',
      input: {},
    });
    switchAccount(ACCOUNT);
    world.onExecute = (): void => switchAccount(OTHER);
    const write = await service.write({
      accountId: ACCOUNT,
      operation: 'organization.leave',
      input: { organizationId: TEAM },
    });
    expect({ read, write, log }).toMatchSnapshot();
  });
});

describe('Personal organization promotion', () => {
  it('routes the promotion write to the upgrade orchestration instead of a hosted call', async () => {
    const promoted = await service.write({
      accountId: ACCOUNT,
      operation: 'organization.promote',
      input: {
        organizationId: PERSONAL,
        name: 'Team name',
        operationId: OPERATION,
      },
    });
    world.promote = (): never => {
      throw new Error('account-changed');
    };
    const changed = await service.write({
      accountId: ACCOUNT,
      operation: 'organization.promote',
      input: {
        organizationId: PERSONAL,
        name: 'Team name',
        operationId: OPERATION,
      },
    });
    expect({ promoted, changed, log }).toMatchSnapshot();
  });
});

describe('subscriptions', () => {
  it('delivers feed events to the owning window and closes on account change, session disposal and window loss', async () => {
    const first = new FakeSender(1);
    const second = new FakeSender(2);
    const scope = { kind: 'organization-feed' as const, organizationId: TEAM };
    const subscribed = await service.subscribe(first, {
      accountId: ACCOUNT,
      subscriptionId: 'feed-1',
      scope,
    });
    await service.subscribe(second, {
      accountId: ACCOUNT,
      subscriptionId: 'credits',
      scope: { kind: 'credit-pool' },
    });
    const event: SettingsEvent = {
      type: 'state',
      organizationId: TEAM,
      state: 'open',
    };
    world.streams[0]?.emit(event);
    const afterEvent = service.subscriptionCount();

    await service.subscribe(first, {
      accountId: ACCOUNT,
      subscriptionId: 'feed-1',
      scope,
    });
    const afterResubscribe = service.subscriptionCount();

    second.emit('destroyed');
    const afterWindowLoss = service.subscriptionCount();

    world.session?.dispose();
    const afterDisposal = service.subscriptionCount();
    world.session = null;

    const reopened = await service.subscribe(first, {
      accountId: ACCOUNT,
      subscriptionId: 'feed-2',
      scope,
    });
    const afterReopen = service.subscriptionCount();
    switchAccount(OTHER);
    const afterAccountChange = service.subscriptionCount();

    expect({
      subscribed,
      reopened,
      counts: {
        afterEvent,
        afterResubscribe,
        afterWindowLoss,
        afterDisposal,
        afterReopen,
        afterAccountChange,
      },
      firstWindow: first.sent,
      secondWindow: second.sent,
      listenersLeft: [first.listenerCount(), second.listenerCount()],
      log,
    }).toMatchSnapshot();
  });
});

describe('payment handoff', () => {
  it('opens an authenticated billing page only for a current member', async () => {
    const results = {
      availability: await service.paymentHandoffAvailability(ACCOUNT),
      personalTopUp: await service.paymentHandoff({
        accountId: ACCOUNT,
        owner: { kind: 'personal' },
        intent: { kind: 'top-up', reason: 'credits' },
      }),
      unlockModels: await service.paymentHandoff({
        accountId: ACCOUNT,
        owner: { kind: 'organization', organizationId: TEAM },
        intent: { kind: 'top-up', reason: 'unlock_models' },
      }),
      notAMember: await service.paymentHandoff({
        accountId: ACCOUNT,
        owner: { kind: 'organization', organizationId: STRANGER },
        intent: { kind: 'top-up', reason: 'credits' },
      }),
      otherAccount: await service.paymentHandoff({
        accountId: OTHER,
        owner: { kind: 'personal' },
        intent: { kind: 'top-up', reason: 'credits' },
      }),
    };
    world.handoffAvailable = false;
    const unavailable = await service.paymentHandoff({
      accountId: ACCOUNT,
      owner: { kind: 'personal' },
      intent: { kind: 'top-up', reason: 'credits' },
    });
    expect(JSON.stringify(log)).not.toContain('csk_never_logged');
    expect({ results, unavailable, log }).toMatchSnapshot();
  });
});
