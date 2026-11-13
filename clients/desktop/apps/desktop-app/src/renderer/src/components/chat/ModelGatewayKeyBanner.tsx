import { type JSX, useEffect, useMemo, useState } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  findGatewayForOrganization,
  selectGatewayForOwner,
  useOrgModelGateways,
  usePersonalModelGateway,
} from '@/hooks/useOrgModelGateway';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import {
  MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT,
  subscribeToConnectionChange,
} from '@/lib/integrationConnectionEvents';

type KeyState =
  | { status: 'loading' }
  | { status: 'ok' }
  | { status: 'missing' }
  | { status: 'rejected'; reason: string | null }
  /** Saved against a URL the admin has since changed — the key is for a different endpoint. */
  | { status: 'stale-endpoint' };

/**
 * The composer's answer to "why can't I send this?" when the reason is the
 * organization's model gateway.
 *
 * It shares the slot with the AI Credits exhausted and org-lapsed banners on
 * purpose: this is the place a user already looks when a turn cannot be sent
 * for a billing or access reason, and one more bespoke surface would just be
 * one more place to check.
 *
 * Renders only when there is something to DO. An additive gateway with no key
 * stays quiet while another model is selected, but becomes actionable when the
 * current model uses that gateway. Rejected keys and retired endpoints always
 * remain visible because the user already configured them and must repair them.
 *
 * The gateway is the selected model's org when that model is a gateway row,
 * else the gateway of the org that owns the active work. Never an unrelated
 * org: Personal work only sees a banner for a gateway row it selected. With
 * the owner unknown every org applies, so an enforcing gateway is preferred.
 */
export function ModelGatewayKeyBanner({
  selectedGatewayOrganizationId,
}: {
  selectedGatewayOrganizationId?: string;
}): JSX.Element | null {
  const gateways = useOrgModelGateways();
  const personal = usePersonalModelGateway();
  const activeOwner = useModelCatalogStore((state) => state.activeOwner);
  const gateway = useMemo(() => {
    if (selectedGatewayOrganizationId === personal?.organizationId)
      return personal;
    if (activeOwner?.kind === 'personal') return personal;
    if (!gateways) return null;
    if (selectedGatewayOrganizationId) {
      return findGatewayForOrganization(
        gateways,
        selectedGatewayOrganizationId,
      );
    }
    if (activeOwner) return selectGatewayForOwner(gateways, activeOwner);
    // Owner unknown (org projects off, or the context not hydrated): every
    // org applies under the legacy union, so keep the account-wide read.
    return (
      gateways.find((candidate) => candidate.enforced) ?? gateways[0] ?? null
    );
  }, [gateways, personal, activeOwner, selectedGatewayOrganizationId]);
  const openSettings = useNavigationStore((state) => state.openSettings);
  const [keyState, setKeyState] = useState<KeyState>({ status: 'loading' });

  const organizationId = gateway?.organizationId;
  const baseUrl = gateway?.baseUrl;

  useEffect(() => {
    if (!organizationId) {
      setKeyState({ status: 'loading' });
      return;
    }
    let cancelled = false;
    const readCredential = async (): Promise<void> => {
      try {
        const record =
          await window.api.loadModelGatewayCredential(organizationId);
        if (cancelled) return;
        if (!record.apiKey.trim()) {
          setKeyState({ status: 'missing' });
          return;
        }
        if (
          baseUrl &&
          record.baseUrlAtSave &&
          record.baseUrlAtSave !== baseUrl
        ) {
          setKeyState({ status: 'stale-endpoint' });
          return;
        }
        setKeyState(
          record.lastError
            ? { status: 'rejected', reason: record.lastError }
            : { status: 'ok' },
        );
      } catch {
        // A failed read is not evidence of a missing key; stay quiet rather
        // than accuse the user of something we cannot see.
        if (!cancelled) setKeyState({ status: 'ok' });
      }
    };
    void readCredential();
    const unsubscribe = subscribeToConnectionChange(
      MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT,
      () => void readCredential(),
    );
    const unsubscribeRuntime =
      window.api.onModelGatewayCredentialChanged?.((changedOrganizationId) => {
        if (changedOrganizationId === organizationId) void readCredential();
      }) ?? ((): void => undefined);
    return (): void => {
      cancelled = true;
      unsubscribe();
      unsubscribeRuntime();
    };
  }, [organizationId, baseUrl]);

  if (!gateway) return null;
  if (keyState.status === 'loading' || keyState.status === 'ok') return null;
  if (
    keyState.status === 'missing' &&
    !gateway.enforced &&
    selectedGatewayOrganizationId !== gateway.organizationId
  ) {
    return null;
  }

  // Short title for the state, then the org-specific explanation and remedy
  // on the same line.
  const title =
    keyState.status === 'missing'
      ? 'Gateway key needed'
      : keyState.status === 'stale-endpoint'
        ? 'Gateway endpoint changed'
        : 'Gateway key rejected';
  const personalGateway = gateway.organizationId === personal?.organizationId;
  const message = personalGateway
    ? keyState.status === 'missing'
      ? 'Add your AI gateway key in Providers to send this.'
      : keyState.status === 'stale-endpoint'
        ? 'Add a key for your new AI gateway endpoint in Providers.'
        : "Your AI gateway didn't accept this key. Save a current key in Providers."
    : keyState.status === 'missing'
      ? `${gateway.organizationName} routes your agents through its own AI gateway, so add your gateway key to send this.`
      : keyState.status === 'stale-endpoint'
        ? `${gateway.organizationName} moved its AI gateway, so add a key for the new one to send this.`
        : `${gateway.organizationName} didn't accept your gateway key, so paste a current one or ask your admin for a new key.`;

  return (
    <Notice
      intent="attention"
      title={title}
      data-testid="chat-input-model-gateway-key-banner"
      data-gateway-key-state={keyState.status}
      actions={
        <NoticeButton
          variant="primary"
          data-testid="chat-input-model-gateway-key-banner-action"
          onClick={(): void => openSettings('account')}
        >
          Add your gateway key
        </NoticeButton>
      }
    >
      {message}
    </Notice>
  );
}
