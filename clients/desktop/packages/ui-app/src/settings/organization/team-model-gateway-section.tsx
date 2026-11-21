'use client';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  AddGatewayModelForm,
  GatewayModelList,
} from '../ai-gateway/gateway-model-list';
import {
  Stack,
  Button,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
  FormField,
  SettingsRowsRow,
  TextInput,
  ToggleSwitch,
  Heading,
} from '@canopy/ui-shared/components';
import {
  MODEL_GATEWAY_MAX_MODELS,
  type ModelGatewayModel,
} from '@canopy/protocol';
import type {
  OrganizationConfigDetail,
  OrganizationDetail,
} from '@canopy/protocol/settings/organization';
import { canEditOrgEnforcedSettings } from '@canopy/protocol/settings/organization-permissions';
import {
  SettingsConfirmDialog,
  useSettingsClient,
  useSettingsPrivacy,
} from '../host';
import { useSettingsErrorCopy, useSettingsLoadFailure } from '../errors';
import { joinClassNames } from './settings/join-class-names';
import { getOrganizationConfig, updateModelGatewayConfig } from './team-api';
import type { SettingsFailure } from '../errors';
import { Divider, Surface } from '@canopy/ui-shared/components';
import { Badge } from '@canopy/ui-shared/components/Badge';

interface TeamModelGatewaySectionProps {
  detail: OrganizationDetail;
}

/**
 * Owner/admin home for Bring Your Own Gateway: the org points its members'
 * agent traffic at a AI gateway it runs, and declares which models that
 * gateway serves.
 *
 * Three things make this card different from the model-policy card beside it:
 *
 * 1. It is a DATA PATH, not an availability list. Turning it on means prompts,
 *    file contents, and tool output leave for an endpoint the org operates, so
 *    the URL is the primary field and it is stated plainly to members on the
 *    invite screen too.
 * 2. There is no catalog to page through — the admin AUTHORS the rows. A model
 *    this org's gateway does not serve is a broken row for every member, so
 *    each one carries the exact slug the gateway expects.
 * 3. Labels must be unique inside the org catalog. In additive mode the org's
 *    rows sit beside Canopy's own in the same picker, and the collapsed picker
 *    trigger renders only the bare label — two rows reading "Claude Opus" would
 *    be indistinguishable once selected. The server enforces this; the helper
 *    text below says so, because the admin is the one with the context to name
 *    them well.
 */
export function TeamModelGatewaySection({
  detail,
}: TeamModelGatewaySectionProps): JSX.Element | null {
  if (!canEditOrgEnforcedSettings(detail.viewerRole)) {
    return null;
  }
  return <ModelGatewayCard detail={detail} />;
}

const MODEL_GATEWAY_ERROR_SCOPE = 'settings.organization.model-gateway';

/** The gateway fields exactly as the server last confirmed them. */
interface GatewayState {
  enabled: boolean;
  baseUrl: string;
  models: ModelGatewayModel[];
  enforced: boolean;
  promptCachePassthrough: boolean;
}

const EMPTY_GATEWAY: GatewayState = {
  enabled: false,
  baseUrl: '',
  models: [],
  enforced: false,
  promptCachePassthrough: true,
};

function readGateway(config: OrganizationConfigDetail): GatewayState {
  return {
    enabled: config.enforceMemberModelGateway,
    baseUrl: config.modelGatewayBaseUrl ?? '',
    models: [...config.modelGatewayModels],
    enforced: config.modelGatewayEnforced,
    promptCachePassthrough: config.modelGatewayPromptCachePassthrough,
  };
}

function ModelGatewayCard({
  detail,
}: TeamModelGatewaySectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(MODEL_GATEWAY_ERROR_SCOPE);
  const loadErrorCopy = useSettingsLoadFailure(MODEL_GATEWAY_ERROR_SCOPE);
  const { maskClassName } = useSettingsPrivacy();
  const orgId = detail.id;

  const [gateway, setGateway] = useState<GatewayState | null>(null);
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Bumped by Retry to run every load again.
  const [loadAttempt, setLoadAttempt] = useState(0);

  /**
   * The gateway configuration the SERVER last confirmed. Every PATCH sends the
   * whole gateway state, so building the next body from render-time state would
   * let a second edit started mid-flight send the first one's pre-edit value
   * back and silently revert it.
   */
  const latestRef = useRef<GatewayState>(EMPTY_GATEWAY);

  const canEnableGateway =
    gateway !== null && gateway.baseUrl.length > 0 && gateway.models.length > 0;

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const config = await getOrganizationConfig(client, orgId);
        if (cancelled) return;
        const next = readGateway(config);
        latestRef.current = next;
        setGateway(next);
        setBaseUrlDraft(next.baseUrl);
      } catch (err) {
        if (!cancelled) setLoadError(loadErrorCopy(err));
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [client, orgId, loadErrorCopy, loadAttempt]);

  /**
   * Retry runs every load again. Clearing the errors puts the card back on
   * its placeholder until the reads settle.
   */
  const retryLoad = (): void => {
    setLoadError(null);
    setLoadAttempt((attempt) => attempt + 1);
  };

  const save = async (next: GatewayState): Promise<boolean> => {
    try {
      setSaving(true);
      setError(null);
      const config = await updateModelGatewayConfig(client, orgId, {
        enforceMemberModelGateway: next.enabled,
        modelGatewayBaseUrl: next.baseUrl.length > 0 ? next.baseUrl : null,
        modelGatewayModels: next.models,
        modelGatewayEnforced: next.enforced,
        modelGatewayPromptCachePassthrough: next.promptCachePassthrough,
      });
      const confirmed = readGateway(config);
      latestRef.current = confirmed;
      setGateway(confirmed);
      setBaseUrlDraft(confirmed.baseUrl);
      return true;
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'update your AI gateway',
        }),
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  // The catalog is capped, so the form hides rather than fail the save.
  const onlyRouteLocked =
    gateway !== null && !gateway.enforced && !gateway.enabled;
  const canAddModel =
    gateway !== null && gateway.models.length < MODEL_GATEWAY_MAX_MODELS;

  const trimmedDraft = baseUrlDraft.trim().replace(/\/+$/, '');
  const baseUrlChanged = gateway !== null && trimmedDraft !== gateway.baseUrl;

  const addModel = (model: ModelGatewayModel): void => {
    void (async (): Promise<void> => {
      const ok = await save({
        ...latestRef.current,
        models: [...latestRef.current.models, model],
      });
      if (ok) setAddOpen(false);
    })();
  };

  const removeModel = (id: string): void => {
    void save({
      ...latestRef.current,
      models: latestRef.current.models.filter((model) => model.id !== id),
    });
  };

  return (
    <section
      className={SETTINGS_CARD_CLASS}
      data-testid="team-model-gateway-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Heading level={2} variant="section">
              AI gateway
            </Heading>
            <p className={SETTINGS_CARD_SUBTITLE_CLASS}>
              Specify a custom AI gateway available to your members
            </p>
          </div>
          {gateway?.enabled === true ? (
            <Badge
              tone="success"
              className="shrink-0"
              data-testid="model-gateway-status-pill"
            >
              {gateway.enforced ? 'Only route' : 'Active'}
            </Badge>
          ) : null}
        </div>
      </div>
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <div className="flex flex-col gap-4">
          {error?.copy || loadError?.copy ? (
            <Stack gap="item">
              <ErrorBanner
                errorSource="team-model-gateway-request"
                error={error?.copy}
                details={error?.details}
              />
              <ErrorBanner
                errorSource="model-gateway-card-load"
                error={loadError?.copy}
                details={loadError?.details}
                onRetry={retryLoad}
              />
            </Stack>
          ) : null}
          {gateway === null ? (
            <div data-testid="model-gateway-pending">
              <DelayedLoadingPlaceholder>
                <ModelGatewaySkeleton />
              </DelayedLoadingPlaceholder>
            </div>
          ) : (
            /*
             * Three panels, in the order the admin has to think about them:
             * whether traffic moves at all, where it goes, and what it may
             * ask for. Everything below the first panel is configuration for
             * a route that only the first panel can switch on.
             */
            <div className="flex flex-col gap-3">
              <Surface gap="item" variant="group" padding="default">
                <Stack gap="inline">
                  <SettingsRowsRow
                    label="Route member traffic through your gateway"
                    description="Members add their own gateway key in desktop settings."
                    control={
                      <ToggleSwitch
                        label="Route member traffic through your gateway"
                        checked={gateway.enabled}
                        disabled={
                          saving || (!gateway.enabled && !canEnableGateway)
                        }
                        dataTestId="enforce-member-model-gateway-checkbox"
                        onChange={(next) => {
                          if (!next) {
                            setError(null);
                            setConfirmDisable(true);
                            return;
                          }
                          void save({ ...latestRef.current, enabled: true });
                        }}
                      />
                    }
                  />

                  {!gateway.enabled && !canEnableGateway ? (
                    <p className="text-xs fg-secondary">
                      Add a gateway URL and one model to turn this on.
                    </p>
                  ) : null}
                </Stack>
                <div>
                  <Divider />
                  <div
                    className={`pt-3 ${onlyRouteLocked ? 'opacity-60' : ''}`}
                  >
                    <SettingsRowsRow
                      label="Make this the only route"
                      description="Members can't use their own provider sign-ins or hosted credits."
                      control={
                        <ToggleSwitch
                          label="Make this the only route"
                          checked={gateway.enforced}
                          disabled={saving || onlyRouteLocked}
                          dataTestId="model-gateway-enforced-checkbox"
                          onChange={(next) =>
                            void save({
                              ...latestRef.current,
                              enforced: next,
                            })
                          }
                        />
                      }
                    />
                  </div>
                </div>
              </Surface>

              <>
                <Surface gap="item" variant="outline" padding="default">
                  <FormField
                    id="model-gateway-base-url"
                    label="Gateway URL"
                    description={
                      <>
                        The HTTPS base serving{' '}
                        <code className="font-mono">/v1/messages</code> and{' '}
                        <code className="font-mono">/v1/responses</code>
                      </>
                    }
                  >
                    {(control) => (
                      <div className="flex gap-2">
                        <div
                          className={joinClassNames(
                            'min-w-0 flex-1',
                            maskClassName,
                          )}
                        >
                          <TextInput
                            {...control}
                            density="settings"
                            mono
                            type="url"
                            value={baseUrlDraft}
                            disabled={saving}
                            placeholder="https://gateway.example.com"
                            data-testid="model-gateway-base-url-input"
                            onChange={(event) =>
                              setBaseUrlDraft(event.target.value)
                            }
                          />
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="compact"
                          disabled={saving || !baseUrlChanged}
                          data-testid="model-gateway-base-url-save"
                          onClick={() =>
                            void save({
                              ...latestRef.current,
                              baseUrl: trimmedDraft,
                            })
                          }
                        >
                          Save
                        </Button>
                      </div>
                    )}
                  </FormField>
                  <div>
                    <Divider />
                    <div className="pt-3">
                      <SettingsRowsRow
                        label="Gateway supports prompt caching"
                        description="Most of the savings come from caching. Turn it off only if your gateway rejects cache markers."
                        control={
                          <ToggleSwitch
                            label="Gateway supports prompt caching"
                            checked={gateway.promptCachePassthrough}
                            disabled={saving}
                            dataTestId="model-gateway-prompt-cache-checkbox"
                            onChange={(next) =>
                              void save({
                                ...latestRef.current,
                                promptCachePassthrough: next,
                              })
                            }
                          />
                        }
                      />
                    </div>
                  </div>
                </Surface>

                <Surface
                  variant="outline"
                  data-testid="model-gateway-models-panel"
                >
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <Heading level={3} variant="title">
                      Models
                      {gateway.models.length > 0
                        ? ` (${gateway.models.length})`
                        : ''}
                    </Heading>
                    {canAddModel && !addOpen ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="compact"
                        disabled={saving}
                        data-testid="model-gateway-add-model-toggle"
                        onClick={() => setAddOpen(true)}
                      >
                        Add model
                      </Button>
                    ) : null}
                  </div>

                  {gateway.models.length > 0 ? (
                    <GatewayModelList
                      models={gateway.models}
                      busy={saving}
                      canRemove
                      onRemove={removeModel}
                    />
                  ) : !addOpen ? (
                    <div>
                      <Divider />
                      <p
                        className="px-4 py-5 text-center text-xs fg-secondary"
                        data-testid="model-gateway-models-empty"
                      >
                        Add a model so your members have something to pick.
                      </p>
                    </div>
                  ) : null}

                  {addOpen && canAddModel ? (
                    <AddGatewayModelForm
                      busy={saving}
                      existing={gateway.models}
                      organizationId={orgId}
                      onAdd={addModel}
                      onCancel={() => setAddOpen(false)}
                    />
                  ) : null}

                  {gateway.models.length >= MODEL_GATEWAY_MAX_MODELS ? (
                    <div>
                      <Divider />
                      <p
                        className="px-4 py-3 text-xs fg-secondary"
                        data-testid="model-gateway-model-limit"
                      >
                        You&apos;ve added the maximum of{' '}
                        {MODEL_GATEWAY_MAX_MODELS} models. Remove one to add
                        another.
                      </p>
                    </div>
                  ) : null}
                </Surface>
              </>
            </div>
          )}
        </div>

        {confirmDisable ? (
          <SettingsConfirmDialog
            dataTestId="model-gateway-disable-dialog"
            errorMessage={error?.copy}
            // The banner above records this failure.
            errorRecordingDisabled
            errorDetails={error?.details}
            title="Turn off your AI gateway?"
            confirmLabel="Turn it off"
            busyLabel="Saving…"
            busy={saving}
            onCancel={() => setConfirmDisable(false)}
            onConfirm={() => {
              void (async (): Promise<void> => {
                const ok = await save({
                  ...latestRef.current,
                  enabled: false,
                });
                if (ok) setConfirmDisable(false);
              })();
            }}
            message={
              <div className="flex flex-col gap-2">
                <p>
                  Your members stop routing through your gateway and go back to
                  their usual models. Their chats keep working.
                </p>
                <p>
                  Your endpoint and model list are kept, so you can turn it back
                  on later.
                </p>
              </div>
            }
          />
        ) : null}
      </div>
    </section>
  );
}

const noop = (): void => undefined;

/** The route switches, as the loaded card's first panel shows them. */
const SAMPLE_GATEWAY_ROWS: readonly { label: string; description: string }[] = [
  {
    label: 'Route member traffic through your gateway',
    description: 'Members add their own gateway key.',
  },
  {
    label: 'Make this the only route',
    description: 'Members use only this gateway.',
  },
];

/**
 * The card body while the gateway loads: its first panel with sample rows
 * inside `Skeleton`, so skullet measures them into bars in place.
 */
function ModelGatewaySkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading AI gateway"
      testId="settings-skeleton-form"
      className="w-full"
    >
      <Surface variant="group" padding="default" gap="item">
        {SAMPLE_GATEWAY_ROWS.map((row, index) => (
          <div key={row.label}>
            {index > 0 ? <Divider /> : null}
            <div className={index > 0 ? 'pt-3' : undefined}>
              <SettingsRowsRow
                label={row.label}
                description={row.description}
                control={
                  <ToggleSwitch
                    label={row.label}
                    checked={false}
                    onChange={noop}
                  />
                }
              />
            </div>
          </div>
        ))}
      </Surface>
    </Skeleton>
  );
}
