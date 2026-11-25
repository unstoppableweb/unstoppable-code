// Golden (CAN-7640): opening AI gateway settings re-reads the account, so a
// gateway changed on the web reaches this desktop's catalog and routing. The
// page's own read (account-organization-settings:read, settings.pageData)
// never waits on that refresh.
jest.mock('../../ipc/settings', () => ({
  reprobeAndApplyCanopyCloudEnforcedSettings: jest.fn(() =>
    Promise.resolve(true),
  ),
}));
jest.mock('../../canopy-cloud/settings-session', () => ({
  acquireSettingsBridgeSession: jest.fn((accountId: string) =>
    Promise.resolve({
      accountId,
      generation: 1,
      state: 'ready',
      ensureReady: () => Promise.resolve(),
      onStateChange: () => (): void => undefined,
      dispose: () => undefined,
    }),
  ),
  peekSettingsBridgeSession: jest.fn(() => null),
  settingsBridgeCredentials: jest.fn(),
}));
jest.mock('../../canopy-cloud/settings-client', () => ({
  executeSettingsOperation: jest.fn(() => Promise.resolve({})),
  openSettingsFeedStream: jest.fn(),
}));
jest.mock('../../canopy-cloud/authenticated-cloud-page', () => ({
  isPaymentHandoffAvailable: jest.fn(),
  openStrictAuthenticatedCloudPage: jest.fn(),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: jest.fn(() =>
    Promise.resolve({ account: { id: 'account-one' } }),
  ),
  peekCanopyCloudAccountId: jest.fn(() => 'account-one'),
  subscribeCanopyCloudAccountChanges: jest.fn(() => (): void => undefined),
}));

import {
  disposeAccountOrganizationSettingsService,
  getAccountOrganizationSettingsService,
} from '../account-organization-settings-host';

const ORG = '44444444-4444-4444-8444-444444444444';
const { reprobeAndApplyCanopyCloudEnforcedSettings: reprobe } =
  jest.requireMock<{
    reprobeAndApplyCanopyCloudEnforcedSettings: jest.Mock<Promise<boolean>>;
  }>('../../ipc/settings');
const { executeSettingsOperation: execute } = jest.requireMock<{
  executeSettingsOperation: jest.Mock<Promise<unknown>>;
}>('../../canopy-cloud/settings-client');

async function readPage(route: unknown): Promise<void> {
  await getAccountOrganizationSettingsService().read({
    accountId: 'account-one',
    operation: 'settings.pageData',
    input: { route },
  });
  await new Promise((resolve) => setImmediate(resolve));
}

describe('AI gateway settings page refresh', () => {
  beforeEach(() => {
    reprobe.mockClear();
    execute.mockClear();
  });
  afterEach(() => disposeAccountOrganizationSettingsService());

  it('re-reads the account when the Personal AI gateway page opens', async () => {
    await readPage({ scope: 'account', page: 'ai-gateway' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reprobe).toHaveBeenCalledTimes(1);
  });

  it('re-reads the account when an organization AI gateway subtab opens', async () => {
    await readPage({
      scope: 'organization',
      organizationId: ORG,
      page: 'settings',
      subtab: 'ai-gateway',
    });
    expect(reprobe).toHaveBeenCalledTimes(1);
  });

  it('leaves other pages alone', async () => {
    await readPage({ scope: 'account', page: 'profile' });
    await readPage({
      scope: 'organization',
      organizationId: ORG,
      page: 'settings',
      subtab: 'general',
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(reprobe).not.toHaveBeenCalled();
  });

  it('does not hold the page read on the refresh', async () => {
    reprobe.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
    await readPage({ scope: 'account', page: 'ai-gateway' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
