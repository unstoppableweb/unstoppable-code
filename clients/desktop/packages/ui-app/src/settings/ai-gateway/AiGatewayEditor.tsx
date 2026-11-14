'use client';

import { useRef, useState, type JSX, type RefObject } from 'react';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  Button,
  ErrorBanner,
  Heading,
  InlineTextInput,
  ModelProviderIcon,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH,
  type ModelGatewayModel,
} from '@canopy/protocol/canopy-server';
import { gatewayHostname } from '@canopy/protocol/model-gateway/discovery';
import { matchAiGatewayPreset } from '@canopy/protocol/model-gateway/presets';
import {
  SettingsConfirmDialog,
  useSettingsAiGatewayConnectionKey,
  useSettingsPrivacy,
} from '../host';
import { useSettingsErrorCopy, type SettingsFailure } from '../errors';
import { joinClassNames } from '../organization/settings/join-class-names';
import { GatewayModelList } from './gateway-model-list';
import { AiGatewaySetup } from './AiGatewaySetup';
import { AiGatewayRefreshDialog } from './AiGatewayRefreshDialog';
import { EditGatewayModelDialog } from './EditGatewayModelDialog';
import {
  CloudChatsKeySection,
  useCloudChatsKeysAvailable,
} from './CloudChatsKeySection';
import {
  aiGatewayLabel,
  CLEARED_GATEWAY_PATCH,
  type AiGatewayEditorAdapter,
  type AiGatewayEditorConfig,
  type AiGatewayEditorPatch,
} from './ai-gateway-adapter';
import {
  AI_GATEWAY_ERROR_SCOPE,
  AI_GATEWAY_KNOWN_ERRORS,
} from './ai-gateway-copy';

export interface AiGatewayEditorProps {
  readonly adapter: AiGatewayEditorAdapter;
  readonly initial: AiGatewayEditorConfig | null;
}

/** A gateway is configured once it has an endpoint and a model. */
export function isAiGatewayConfigured(
  config: AiGatewayEditorConfig | null,
): config is AiGatewayEditorConfig & { baseUrl: string } {
  return config !== null && config.baseUrl !== null && config.models.length > 0;
}

/**
 * One scope's AI gateway: the setup flow until it has an endpoint and a
 * model, then its connection, models and switches. Personal and team pages
 * render this with their own adapter; nothing here asks which host it is in.
 */
export function AiGatewayEditor({
  adapter,
  initial,
}: AiGatewayEditorProps): JSX.Element {
  const [config, setConfig] = useState<AiGatewayEditorConfig | null>(initial);
  // Removing the gateway takes its Remove button away, so focus lands here.
  const setupRef = useRef<HTMLElement | null>(null);
  if (!isAiGatewayConfigured(config)) {
    return (
      <section
        ref={setupRef}
        tabIndex={-1}
        className={SETTINGS_CARD_CLASS}
        data-testid="ai-gateway-empty"
      >
        <div className={joinClassNames(SETTINGS_CARD_GROUP_CLASS, 'px-4')}>
          <AiGatewaySetup
            adapter={adapter}
            current={config}
            enableOnSave={adapter.scope === 'personal'}
            onSaved={setConfig}
          />
        </div>
      </section>
    );
  }
  return (
    <ConfiguredAiGateway
      adapter={adapter}
      config={config}
      onConfigChange={setConfig}
      setupRef={setupRef}
    />
  );
}

interface ConfiguredAiGatewayProps {
  readonly adapter: AiGatewayEditorAdapter;
  readonly config: AiGatewayEditorConfig & { baseUrl: string };
  readonly onConfigChange: (config: AiGatewayEditorConfig) => void;
  /** The setup card shown once the gateway is removed. */
  readonly setupRef: RefObject<HTMLElement | null>;
}

function ConfiguredAiGateway({
  adapter,
  config,
  onConfigChange,
  setupRef,
}: ConfiguredAiGatewayProps): JSX.Element {
  const errorCopy = useSettingsErrorCopy(AI_GATEWAY_ERROR_SCOPE);
  const { maskClassName } = useSettingsPrivacy();
  const KeyRow = useSettingsAiGatewayConnectionKey();
  const personal = adapter.scope === 'personal';
  const host = gatewayHostname(config.baseUrl);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [keyRevision, setKeyRevision] = useState(0);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [editing, setEditing] = useState<ModelGatewayModel | null>(null);
  // Known even while the gateway is off, when the section below isn't shown.
  const cloudKeys = useCloudChatsKeysAvailable(adapter.organizationId);
  const [removeOpen, setRemoveOpen] = useState(false);

  // Every patch is built from the server's last answer, and one runs at a
  // time, so a second edit can't send a value the first already replaced.
  const latestRef = useRef(config);
  latestRef.current = config;
  const savingRef = useRef(false);
  const nameInFlightRef = useRef<string | null>(null);

  const apply = async (
    patch: AiGatewayEditorPatch,
    action = 'update your AI gateway',
  ): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await adapter.save(patch, latestRef.current.revision);
      latestRef.current = { ...saved, baseUrl: saved.baseUrl ?? '' };
      onConfigChange(saved);
      return true;
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action,
          known: AI_GATEWAY_KNOWN_ERRORS,
        }),
      );
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Blur and Enter both submit; the second of a pair is the same value and
  // is dropped. A refused name puts the saved one back.
  const submitName = async (value: string): Promise<void> => {
    const next = value.trim();
    const previous = latestRef.current.displayName ?? '';
    if (next === previous || nameInFlightRef.current === next) return;
    nameInFlightRef.current = next;
    await apply({ displayName: next || null });
    nameInFlightRef.current = null;
  };

  const label = aiGatewayLabel(config, adapter.fallbackName);
  const preset = matchAiGatewayPreset(config.baseUrl);
  const lastModel = config.enabled && config.models.length === 1;

  return (
    <div className="flex flex-col gap-10" data-testid="ai-gateway-configured">
      <section className={SETTINGS_CARD_CLASS}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {preset ? (
              <ModelProviderIcon
                provider={preset.id}
                size="md"
                aria-hidden="true"
                className="shrink-0 fg-primary"
                data-testid="ai-gateway-configured-mark"
              />
            ) : null}
            <Heading level={2} variant="section">
              <span className={maskClassName}>{label}</span>
            </Heading>
          </div>
          {personal ? (
            <ToggleSwitch
              label="AI gateway"
              checked={config.enabled}
              disabled={saving}
              dataTestId="ai-gateway-enabled-toggle"
              onChange={(next) => void apply({ enabled: next })}
            />
          ) : null}
        </div>
        {/* The remove dialog shows its own failure. */}
        <ErrorBanner
          errorSource="configured-ai-gateway-remove-open"
          error={removeOpen ? undefined : error?.copy}
          details={error?.details}
        />
        <div className={SETTINGS_CARD_GROUP_CLASS}>
          <div className={SETTINGS_CARD_ROW_CLASS}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className={joinClassNames('max-w-80', maskClassName)}>
                <InlineTextInput
                  aria-label="Name"
                  value={config.displayName ?? ''}
                  maxLength={MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH}
                  placeholder={adapter.fallbackName ?? host}
                  disabled={saving}
                  data-testid="ai-gateway-name-input"
                  onCommit={(value) => void submitName(value)}
                />
              </div>
              {/* A preset's mark and name already say which gateway it
                  is; only a custom URL needs the URL to tell. */}
              {preset ? null : (
                <p
                  className={joinClassNames(
                    'truncate font-mono text-xs fg-secondary',
                    maskClassName,
                  )}
                  data-testid="ai-gateway-url"
                >
                  {config.baseUrl}
                </p>
              )}
            </div>
          </div>
          {KeyRow ? (
            <div
              className={SETTINGS_CARD_ROW_CLASS}
              data-testid="ai-gateway-key-row"
            >
              <span className="text-s font-medium fg-primary">
                {personal ? 'API key' : 'Your API key'}
              </span>
              <KeyRow
                organizationId={adapter.organizationId}
                baseUrl={config.baseUrl}
                revision={keyRevision}
                label={personal ? 'API key' : 'Your API key'}
              />
            </div>
          ) : cloudKeys !== false ? null : (
            // Where cloud chats take a key, this pointer would send members
            // to the desktop app for a key they can save here.
            <div className={SETTINGS_CARD_ROW_CLASS}>
              <p
                className="text-s fg-secondary"
                data-testid="ai-gateway-desktop-key"
              >
                Add your key in the desktop app.
              </p>
            </div>
          )}
          {personal ? null : (
            <div className={SETTINGS_CARD_ROW_CLASS}>
              <span className="text-s font-medium fg-primary">
                Offer to members
              </span>
              <ToggleSwitch
                label="Offer to members"
                checked={config.enabled}
                disabled={saving}
                dataTestId="ai-gateway-offer-toggle"
                onChange={(next) => void apply({ enabled: next })}
              />
            </div>
          )}
        </div>
      </section>

      {config.enabled ? (
        <CloudChatsKeySection
          organizationId={adapter.organizationId}
          baseUrl={config.baseUrl}
          revision={keyRevision}
        />
      ) : null}

      <section className={SETTINGS_CARD_CLASS} data-testid="ai-gateway-models">
        <div className="flex items-center justify-between gap-3">
          <Heading level={2} variant="section">
            {`Models (${config.models.length})`}
          </Heading>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={saving}
            data-testid="ai-gateway-refresh-models"
            onClick={() => setRefreshOpen(true)}
          >
            Refresh models
          </Button>
        </div>
        <p className="text-s fg-secondary" data-testid="ai-gateway-models-use">
          {cloudKeys === true && config.enabled
            ? 'Used by the desktop app, and by cloud chats once a key is saved.'
            : 'Used by the desktop app.'}
        </p>
        <div className={SETTINGS_CARD_GROUP_CLASS}>
          <GatewayModelList
            models={config.models}
            busy={saving}
            canRemove={!lastModel}
            onEdit={setEditing}
            onRemove={(id) =>
              void apply({
                models: latestRef.current.models.filter(
                  (model) => model.id !== id,
                ),
              })
            }
          />
        </div>
      </section>

      {personal ? (
        <section className={SETTINGS_CARD_CLASS}>
          <div className={SETTINGS_CARD_GROUP_CLASS}>
            <div className={SETTINGS_CARD_ROW_CLASS}>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-s font-medium fg-primary">
                  Use only my AI gateway
                </span>
                {/* Where keys stay on this computer, its own key row says so. */}
                {KeyRow ? null : (
                  <p
                    className="text-xs text-pretty fg-secondary"
                    data-testid="ai-gateway-only-desktop-note"
                  >
                    Also applies to the desktop app, which needs its own key.
                  </p>
                )}
              </div>
              <ToggleSwitch
                label="Use only my AI gateway"
                checked={config.onlyThisGateway}
                disabled={saving || !config.enabled}
                dataTestId="ai-gateway-only-toggle"
                onChange={(next) => void apply({ onlyThisGateway: next })}
              />
            </div>
          </div>
        </section>
      ) : null}

      <section className={SETTINGS_CARD_CLASS}>
        <div className={SETTINGS_CARD_GROUP_CLASS}>
          <div className={SETTINGS_CARD_ROW_CLASS}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-s font-medium fg-primary">
                Remove AI gateway
              </span>
              <p className="text-xs text-pretty fg-secondary">
                {personal
                  ? 'Deletes its URL, models and saved API keys.'
                  : 'Deletes its URL, models and saved API keys. Members lose access to it.'}
              </p>
            </div>
            <Button
              type="button"
              variant="destructive"
              size="compact"
              disabled={saving}
              data-testid="ai-gateway-remove"
              onClick={() => {
                setError(null);
                setRemoveOpen(true);
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      </section>

      {removeOpen ? (
        <SettingsConfirmDialog
          destructive
          title="Remove this AI gateway?"
          message={
            personal
              ? 'Its URL, models and saved API keys are deleted. Chats using its models will need another model.'
              : 'Its URL, models and saved API keys are deleted. Chats using its models will need another model. Members lose access to it.'
          }
          confirmLabel="Remove AI gateway"
          busyLabel="Removing…"
          busy={saving}
          dataTestId="ai-gateway-remove-confirm"
          errorMessage={error?.copy}
          errorDetails={error?.details}
          restoreFocusRef={setupRef}
          onCancel={() => {
            // A failed removal's error belongs to the dialog, not the card.
            setError(null);
            setRemoveOpen(false);
          }}
          onConfirm={() =>
            // On success the editor drops back to setup and unmounts this
            // dialog; on failure it stays open with the reason.
            void apply(CLEARED_GATEWAY_PATCH, 'remove your AI gateway')
          }
        />
      ) : null}

      {refreshOpen ? (
        <AiGatewayRefreshDialog
          adapter={adapter}
          config={config}
          onClose={() => setRefreshOpen(false)}
          onAdd={async (models) => {
            const ok = await apply({
              models: [...latestRef.current.models, ...models],
            });
            if (ok) setRefreshOpen(false);
            return ok;
          }}
          onKeySaved={() => setKeyRevision((revision) => revision + 1)}
        />
      ) : null}
      {editing ? (
        <EditGatewayModelDialog
          model={editing}
          busy={saving}
          error={error}
          onClose={() => setEditing(null)}
          onSave={async (edited) => {
            const ok = await apply({
              models: latestRef.current.models.map((model) =>
                model.id === edited.id ? edited : model,
              ),
            });
            if (ok) setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}
