import {
  createBrowserUpgradeRecovery,
  createPersonalOrganizationUpgradeStore,
  type PersonalOrganizationUpgradePort,
} from '../create-personal-organization-upgrade-store';
import type { PersonalOrganizationPromotionOutcome } from '@canopy/protocol/organizations';

test('a Check again reply cannot restore a retired team checklist', async () => {
  const accountKey = 'account';
  const personalOrganizationId = '10000000-0000-4000-8000-000000000001';
  const replacementPersonalId = '10000000-0000-4000-8000-000000000002';
  const operationId = '10000000-0000-4000-8000-000000000003';
  const receipt: PersonalOrganizationPromotionOutcome = {
    promotion: {
      organizationId: personalOrganizationId,
      name: 'First team',
      personalOrganizationId: replacementPersonalId,
      operationId,
      alreadyUpgraded: false,
      warnings: [],
    },
    contextSwitched: false,
    warnings: ['context-switch-failed'],
  };
  let resolveReply: (
    value: PersonalOrganizationPromotionOutcome,
  ) => void = () => {
    throw new Error('Check again was never requested');
  };
  const promote = jest
    .fn<ReturnType<PersonalOrganizationUpgradePort['promote']>, []>()
    .mockResolvedValueOnce(receipt)
    .mockImplementationOnce(
      () => new Promise((resolve) => (resolveReply = resolve)),
    );
  const stored = new Map<string, string>();
  const recovery = createBrowserUpgradeRecovery(accountKey, {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  const store = createPersonalOrganizationUpgradeStore({
    accountKey,
    personalOrganizationId,
    recovery,
    createId: () => operationId,
    port: {
      canPromote: true,
      canInvite: false,
      canBringProjects: false,
      promote,
      invite: jest.fn(),
      listProjects: jest.fn(),
      convert: jest.fn(),
      status: jest.fn(),
    },
  });
  store.getState().setName('First team');
  await store.getState().submit();
  const checkAgain = store.getState().refreshPromotion();
  expect(promote).toHaveBeenCalledTimes(2);
  store.getState().confirmContext(personalOrganizationId);
  expect(recovery.read()?.promotion?.contextSwitched).toBe(true);

  store.getState().acknowledge();
  expect(stored.size).toBe(0);
  const retired = store.getState();

  resolveReply(receipt);
  await checkAgain;
  expect(stored.size).toBe(0);
  expect(store.getState()).toBe(retired);
});
