import { openAccountOrganizationPage } from '@/lib/navigation/settings-destinations';
import { useGitHubStore } from '@/stores/githubStore';

export const DEVICE_AI_GATEWAY_CONFLICT_MESSAGE =
  'Your account and this computer have different AI gateways.';

/**
 * After sign-in found the account's AI gateway differs from the one set up on
 * this computer while signed out. Main sends it once per account and
 * device-config revision; the choice itself waits on the account AI gateway
 * page, so it survives the toast.
 */
export function showDeviceAiGatewayConflictToast(): void {
  useGitHubStore
    .getState()
    .addToast(DEVICE_AI_GATEWAY_CONFLICT_MESSAGE, 'info', undefined, {
      category: 'Account',
      messageContext: 'Choose which one to keep.',
      persistent: true,
      action: {
        label: 'Choose',
        testId: 'device-ai-gateway-conflict-view',
        onClick: (): void => {
          openAccountOrganizationPage({ scope: 'account', page: 'ai-gateway' });
        },
      },
    });
}
