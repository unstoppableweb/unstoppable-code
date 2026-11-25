'use client';

import { useState, type JSX } from 'react';
import type { PersonalAiGatewayConfig } from '@canopy/protocol/model-gateway';
import type { SettingsPageProps } from '../pages/page-props';
import { useSettingsClient } from '../host';
import { AiGatewayEditor } from './AiGatewayEditor';
import { DeviceAiGatewayChoiceNotice } from './DeviceAiGatewayChoiceNotice';
import {
  personalGatewayEditorConfig,
  usePersonalAiGatewayAdapter,
} from './ai-gateway-adapter';

/**
 * `/account/ai-gateway`: the Personal AI gateway. The page data names the
 * Personal organization it was read for; every save sends it back, so a
 * promotion since then is refused instead of saving into the new Personal.
 */
export function AccountAiGatewayPage({
  page,
}: SettingsPageProps<'account.ai-gateway'>): JSX.Element {
  const client = useSettingsClient();
  const adapter = usePersonalAiGatewayAdapter(client, page.data.organizationId);
  // This computer's gateway replaced the account's: the editor restarts on it.
  const [replaced, setReplaced] = useState<{
    gateway: PersonalAiGatewayConfig | null;
    useInCloudChats: boolean;
  } | null>(null);
  const reloadGateway = (): void => {
    void client.read('account.settings.ai-gateway.read', {}).then(
      ({ gateway, useInCloudChats }) =>
        setReplaced({ gateway, useInCloudChats }),
      () => setReplaced(null),
    );
  };
  return (
    <>
      <DeviceAiGatewayChoiceNotice onAccountGatewayReplaced={reloadGateway} />
      <AiGatewayEditor
        key={`${page.data.organizationId}/${replaced?.gateway?.revision ?? ''}`}
        adapter={adapter}
        initial={
          replaced
            ? personalGatewayEditorConfig(
                replaced.gateway,
                replaced.useInCloudChats,
              )
            : personalGatewayEditorConfig(
                page.data.gateway,
                page.data.useInCloudChats,
              )
        }
      />
    </>
  );
}
