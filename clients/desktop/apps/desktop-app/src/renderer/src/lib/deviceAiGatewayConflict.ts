import { openAccountOrganizationPage } from '@/lib/navigation/settings-destinations';
import { useGitHubStore } from '@/stores/githubStore';

export const DEVICE_AI_GATEWAY_CONFLICT_MESSAGE =
  "Your account already has an AI gateway, so we're using that one.";

/**
 * After sign-in kept the account's own AI gateway over the one set up on this
 * computer while signed out. Main sends it once per account and device-config
 * revision; the device copy stays for signed-out use.
 */
export function showDeviceAiGatewayConflictToast(): void {
  useGitHubStore
    .getState()
    .addToast(DEVICE_AI_GATEWAY_CONFLICT_MESSAGE, 'info', undefined, {
      category: 'Account',
      action: {
        label: 'View',
        testId: 'device-ai-gateway-conflict-view',
        onClick: (): void => {
          openAccountOrganizationPage({ scope: 'account', page: 'ai-gateway' });
        },
      },
    });
}
