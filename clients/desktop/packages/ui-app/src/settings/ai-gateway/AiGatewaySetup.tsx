'use client';

import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import {
  Button,
  buttonClassName,
  ErrorBanner,
  FormField,
  ModelProviderIcon,
  ProviderStatusDot,
  StatusLabel,
  TextInput,
} from '@canopy/ui-shared/components';
import { ArrowUpRightIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH,
  MODEL_GATEWAY_MAX_MODELS,
  type ModelGatewayModel,
} from '@canopy/protocol/canopy-server';
import {
  gatewayHostname,
  suggestNewGatewayModels,
  type AiGatewayConnectionResult,
  type DiscoveredGatewayModel,
} from '@canopy/protocol/model-gateway/discovery';
import {
  matchAiGatewayPreset,
  type AiGatewayPreset,
} from '@canopy/protocol/model-gateway/presets';
import {
  useSettingsAiGatewayConnectionKey,
  useSettingsClient,
  useSettingsPrivacy,
} from '../host';
import { useSettingsErrorCopy, type SettingsFailure } from '../errors';
import { joinClassNames } from '../organization/settings/join-class-names';
import { AddGatewayModelForm } from './gateway-model-list';
import { GatewayModelBrowser } from './GatewayModelBrowser';
import {
  AiGatewayPresetMark,
  AiGatewayPresetPicker,
} from './AiGatewayPresetPicker';
import {
  initialGatewaySelection,
  openWeightGatewayIds,
} from './gateway-model-search';
import {
  ABSENT_GATEWAY_REVISION,
  keepKeyForCloudChats,
  type AiGatewayEditorAdapter,
  type AiGatewayEditorConfig,
} from './ai-gateway-adapter';
import {
  AI_GATEWAY_ERROR_SCOPE,
  AI_GATEWAY_KNOWN_ERRORS,
  connectionFailureCopy,
  maskedKeySuffix,
  presetShortName,
} from './ai-gateway-copy';

export interface AiGatewaySetupProps {
  readonly adapter: AiGatewayEditorAdapter;
  /** The stored gateway being set up again, or `null` for a first setup. */
  readonly current: AiGatewayEditorConfig | null;
  readonly onSaved: (config: AiGatewayEditorConfig) => void;
  /** First run turns the gateway on when it saves. */
  readonly enableOnSave: boolean;
  /**
   * `dialog` stacks the URL and key and fits the model list to first run's
   * narrow dialog.
   */
  readonly layout?: 'page' | 'dialog';
}

/** Shown once the gateway holds as many enabled models as it can. */
export const AI_GATEWAY_SETUP_CAP_HINT = 'Turn one off to add another.';

type SetupStep =
  | { readonly kind: 'choose' }
  | {
      readonly kind: 'connect';
      /** A preset's key step, or `null` for the custom URL form. */
      readonly preset: AiGatewayPreset | null;
    }
  | {
      readonly kind: 'connected';
      readonly baseUrl: string;
      readonly keySuffix: string | null;
      readonly suggestions: readonly ModelGatewayModel[];
      readonly openWeightIds: ReadonlySet<string>;
      /** The step's preset, or the one a custom URL turned out to be. */
      readonly preset: AiGatewayPreset | null;
    };

/**
 * The URL a connect step starts from. Reconnecting a stored gateway keeps
 * its own URL (a regional Requesty host stays in its region); a hosted
 * preset otherwise uses its URL, and the URL forms start empty.
 */
function seededBaseUrl(
  preset: AiGatewayPreset | null,
  current: AiGatewayEditorConfig | null,
): string {
  const stored = current?.baseUrl ?? null;
  const storedPreset = matchAiGatewayPreset(stored);
  if (preset?.baseUrl)
    return stored && storedPreset?.id === preset.id ? stored : preset.baseUrl;
  return stored && storedPreset === null ? stored : '';
}

function initialStep(current: AiGatewayEditorConfig | null): SetupStep {
  if (!current?.baseUrl) return { kind: 'choose' };
  return { kind: 'connect', preset: matchAiGatewayPreset(current.baseUrl) };
}

/**
 * Choose a gateway, connect, then pick models, then Save. Connect is an
 * explicit action, never a probe on each keystroke. On a host that keeps
 * keys a successful Connect stores the key; elsewhere the key goes with that
 * one request. Saving is a separate step, so a failed save keeps the draft
 * for another try.
 */
export function AiGatewaySetup({
  adapter,
  current,
  onSaved,
  enableOnSave,
  layout = 'page',
}: AiGatewaySetupProps): JSX.Element {
  const errorCopy = useSettingsErrorCopy(AI_GATEWAY_ERROR_SCOPE);
  const { maskClassName } = useSettingsPrivacy();
  const client = useSettingsClient();
  const KeyRow = useSettingsAiGatewayConnectionKey();
  const keepsKeys = KeyRow !== undefined;
  const statusId = useId();

  const [step, setStep] = useState<SetupStep>(() => initialStep(current));
  const [baseUrl, setBaseUrl] = useState(() =>
    seededBaseUrl(matchAiGatewayPreset(current?.baseUrl), current),
  );
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [name, setName] = useState(current?.displayName ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [manualModels, setManualModels] = useState<ModelGatewayModel[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualGatewayId, setManualGatewayId] = useState('');

  // A response belongs to the input it was sent for; editing the URL or key,
  // changing gateway, or closing, makes any response still in flight stale.
  const attemptRef = useRef(0);
  const connectingRef = useRef(false);
  const savingRef = useRef(false);
  // Set by the first keystroke in Name: a prefill never overwrites it.
  const nameTouchedRef = useRef(false);
  // The key that connected, kept until Save: the server takes a cloud chats
  // key only for a stored gateway.
  const cloudKeyRef = useRef('');
  useEffect(
    () => (): void => {
      attemptRef.current += 1;
    },
    [],
  );

  const editInput = (): void => {
    attemptRef.current += 1;
    connectingRef.current = false;
    setConnecting(false);
    setNotice(null);
    setError(null);
  };

  const openConnect = (preset: AiGatewayPreset | null): void => {
    editInput();
    setBaseUrl(seededBaseUrl(preset, current));
    setStep({ kind: 'connect', preset });
  };

  const backToChoose = (): void => {
    editInput();
    setApiKey('');
    setStep({ kind: 'choose' });
  };

  const connect = async (preset: AiGatewayPreset | null): Promise<void> => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    const attempt = ++attemptRef.current;
    const typedKey = apiKey.trim();
    setConnecting(true);
    setNotice(null);
    setError(null);
    let result: AiGatewayConnectionResult;
    try {
      result = await adapter.connect({
        baseUrl: baseUrl.trim(),
        ...(typedKey ? { apiKey: typedKey } : {}),
      });
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setConnecting(false);
      setError(
        errorCopy.actionFailure(err, {
          action: 'connect to your AI gateway',
          known: AI_GATEWAY_KNOWN_ERRORS,
        }),
      );
      return;
    } finally {
      if (attempt === attemptRef.current) connectingRef.current = false;
    }
    if (attempt !== attemptRef.current) return;
    setConnecting(false);
    if (result.status !== 'connected') {
      setNotice(
        connectionFailureCopy(
          result.status,
          keepsKeys,
          presetShortName(preset),
        ),
      );
      return;
    }
    // The key has done its job: stored on a host that keeps keys, and
    // elsewhere held only until Save keeps it for cloud chats.
    setApiKey('');
    cloudKeyRef.current = keepsKeys ? '' : typedKey;
    const resolved = preset ?? matchAiGatewayPreset(result.baseUrl);
    const existing = current?.models ?? [];
    const suggestions = suggestModels(
      result.models,
      existing,
      adapter.organizationId,
    );
    setSelected(
      new Set(
        initialGatewaySelection({
          stored: existing,
          candidates: suggestions,
          suggestedIds: resolved?.suggestedModelIds ?? [],
          reservedCount: 0,
          limit: MODEL_GATEWAY_MAX_MODELS,
        }),
      ),
    );
    // A stored name that is just its preset's name is a prefill too, so it
    // follows a switch to another gateway.
    const storedNameIsPrefill =
      !current?.displayName ||
      current.displayName === matchAiGatewayPreset(current.baseUrl)?.name;
    if (!nameTouchedRef.current && storedNameIsPrefill)
      setName(resolved?.name ?? '');
    setManualModels([]);
    setManualGatewayId('');
    setManualOpen(existing.length + suggestions.length === 0);
    setStep({
      kind: 'connected',
      baseUrl: result.baseUrl,
      keySuffix: keepsKeys ? maskedKeySuffix(typedKey) : null,
      suggestions,
      openWeightIds: openWeightGatewayIds(result.models),
      preset: resolved,
    });
  };

  // The browser indexes the catalog once per array, so keep the array stable
  // across renders that don't change it, such as typing a Name.
  const storedModels = current?.models;
  const connectedSuggestions =
    step.kind === 'connected' ? step.suggestions : null;
  const models = useMemo(
    () => [
      ...(storedModels ?? []),
      ...(connectedSuggestions ?? []),
      ...manualModels,
    ],
    [storedModels, connectedSuggestions, manualModels],
  );

  if (step.kind === 'choose') {
    return (
      <div className="flex flex-col gap-3" data-testid="ai-gateway-setup">
        <AiGatewayPresetPicker
          layout={layout}
          onChoose={openConnect}
          onCustom={() => openConnect(null)}
        />
      </div>
    );
  }

  if (step.kind === 'connect') {
    const { preset } = step;
    const hosted = preset !== null && preset.baseUrl !== null;
    // Back sits beside Connect, the wizard's usual footer, on both forms.
    const connectFooter = (
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-xs fg-secondary" role="status">
          {notice ? (
            <StatusLabel tone="destructive" data-testid="ai-gateway-notice">
              {notice}
            </StatusLabel>
          ) : null}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="compact"
            data-testid="ai-gateway-setup-back"
            onClick={backToChoose}
          >
            Back
          </Button>
          <Button
            type="button"
            variant="primary"
            size="compact"
            disabled={connecting || baseUrl.trim().length === 0}
            data-testid="ai-gateway-connect"
            onClick={() => void connect(preset)}
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </div>
    );
    const urlField = (
      <FormField label="Gateway URL">
        {(control) => (
          <div className={maskClassName}>
            <TextInput
              {...control}
              density="settings"
              mono
              type="url"
              value={baseUrl}
              disabled={connecting}
              placeholder={
                preset?.urlPlaceholder ?? 'https://gateway.example.com'
              }
              autoComplete="off"
              data-testid="ai-gateway-setup-url"
              onChange={(event) => {
                setBaseUrl(event.target.value);
                editInput();
              }}
            />
          </div>
        )}
      </FormField>
    );
    const keyField = (
      <FormField label="API key">
        {(control) => (
          <div className={maskClassName}>
            <TextInput
              {...control}
              density="settings"
              mono
              type="password"
              value={apiKey}
              disabled={connecting}
              autoComplete="off"
              autoFocus={hosted}
              data-testid="ai-gateway-setup-key"
              onChange={(event) => {
                setApiKey(event.target.value);
                editInput();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void connect(preset);
              }}
            />
          </div>
        )}
      </FormField>
    );

    if (preset === null) {
      return (
        <div className="flex flex-col gap-3" data-testid="ai-gateway-setup">
          <ErrorBanner error={error?.copy} details={error?.details} />
          <div
            className={
              layout === 'dialog' ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-2'
            }
          >
            {urlField}
            {keyField}
          </div>
          {connectFooter}
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-3" data-testid="ai-gateway-setup">
        <ErrorBanner error={error?.copy} details={error?.details} />
        <div
          className="flex items-center gap-3"
          data-testid="ai-gateway-preset-header"
        >
          <AiGatewayPresetMark preset={preset} />
          <span className="min-w-0 flex-1 truncate text-s font-medium fg-primary">
            {preset.name}
          </span>
        </div>
        {hosted ? null : urlField}
        {keyField}
        <div className="flex text-xs">
          {/* A plain external anchor, not `SettingsLink`: desktop first run
              mounts this with a standalone host whose link needs the hosted
              settings provider. Desktop opens new-window https links in the
              browser. */}
          <a
            href={preset.keyUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({
              variant: 'link',
              className: 'text-xs',
            })}
            data-testid="ai-gateway-preset-key-link"
          >
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              {hosted
                ? `Get a key from ${presetShortName(preset) ?? preset.name}`
                : `${preset.name} virtual keys`}
              <ArrowUpRightIcon size="xs" aria-hidden="true" />
            </span>
          </a>
        </div>
        {connectFooter}
      </div>
    );
  }

  const chosen = models.filter((model) => selected.has(model.id));
  const atCapacity = chosen.length >= MODEL_GATEWAY_MAX_MODELS;
  // A safety net only: the browser stops turning models on at the limit.
  const overLimit = chosen.length > MODEL_GATEWAY_MAX_MODELS;
  const host = gatewayHostname(step.baseUrl);
  const { preset } = step;

  const save = async (): Promise<void> => {
    if (savingRef.current || chosen.length === 0 || overLimit) return;
    savingRef.current = true;
    const attempt = attemptRef.current;
    setSaving(true);
    setError(null);
    try {
      const saved = await adapter.save(
        {
          baseUrl: step.baseUrl,
          // A cleared name on a preset falls back to the preset's name; a
          // custom URL falls back to its hostname wherever it shows.
          displayName: name.trim() || preset?.name || null,
          models: chosen,
          ...(enableOnSave ? { enabled: true } : {}),
        },
        current?.revision ?? ABSENT_GATEWAY_REVISION,
      );
      // Before `onSaved`, so Cloud chats reads the key as saved when it mounts.
      if (cloudKeyRef.current && saved.baseUrl)
        await keepKeyForCloudChats(
          client,
          adapter.organizationId,
          cloudKeyRef.current,
          saved.baseUrl,
        );
      if (attempt === attemptRef.current) onSaved(saved);
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setError(
        errorCopy.actionFailure(err, {
          action: 'save your AI gateway',
          known: AI_GATEWAY_KNOWN_ERRORS,
        }),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const openManual = (gatewayId: string): void => {
    setManualGatewayId(gatewayId);
    setManualOpen(true);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="ai-gateway-setup">
      <ErrorBanner error={error?.copy} details={error?.details} />
      <div className="flex items-center justify-between gap-3">
        <p
          id={statusId}
          role="status"
          className="flex min-w-0 items-center gap-2 text-s fg-primary"
          data-testid="ai-gateway-connected"
        >
          <ProviderStatusDot tone="connected" />
          <span className="font-medium">Connected</span>
          {preset ? (
            <ModelProviderIcon
              provider={preset.id}
              size="sm"
              aria-hidden="true"
              className="shrink-0"
            />
          ) : null}
          <span
            className={joinClassNames(
              'min-w-0 truncate fg-secondary',
              maskClassName,
            )}
          >
            {[preset?.name ?? host, step.keySuffix].filter(Boolean).join(' · ')}
          </span>
        </p>
        {/* Connected to the wrong gateway: pick another without a reload. */}
        <Button
          type="button"
          variant="ghost"
          size="compact"
          disabled={saving}
          data-testid="ai-gateway-connected-change"
          onClick={backToChoose}
        >
          Change
        </Button>
      </div>
      <FormField label="Name">
        {(control) => (
          <div className={maskClassName}>
            <TextInput
              {...control}
              density="settings"
              type="text"
              value={name}
              maxLength={MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH}
              disabled={saving}
              placeholder={host}
              data-testid="ai-gateway-setup-name"
              onChange={(event) => {
                nameTouchedRef.current = true;
                setName(event.target.value);
              }}
            />
          </div>
        )}
      </FormField>
      <GatewayModelBrowser
        models={models}
        selected={selected}
        suggestedIds={preset?.suggestedModelIds}
        openWeightIds={step.openWeightIds}
        limit={MODEL_GATEWAY_MAX_MODELS}
        capHint={AI_GATEWAY_SETUP_CAP_HINT}
        disabled={saving}
        layout={layout}
        autoFocus
        onAddManually={openManual}
        onToggle={(id) =>
          setSelected((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
      />
      {models.length === 0 ? (
        <p className="text-xs fg-secondary" data-testid="ai-gateway-no-models">
          Your gateway didn&apos;t list any models. Add one manually.
        </p>
      ) : null}
      {manualOpen ? (
        <div className="flex flex-col">
          <AddGatewayModelForm
            key={manualGatewayId}
            busy={saving}
            existing={models}
            atCapacity={atCapacity}
            initialGatewayId={manualGatewayId}
            organizationId={adapter.organizationId}
            onAdd={(model) => {
              setManualModels((previous) => [...previous, model]);
              setSelected((previous) => new Set(previous).add(model.id));
              setManualGatewayId('');
              setManualOpen(false);
            }}
            onCancel={() => setManualOpen(false)}
          />
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {manualOpen ? (
          <span />
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={saving || atCapacity}
            data-testid="ai-gateway-add-manual"
            onClick={() => openManual('')}
          >
            Add model manually
          </Button>
        )}
        <Button
          type="button"
          variant="primary"
          size="compact"
          disabled={saving || chosen.length === 0 || overLimit}
          data-testid="ai-gateway-save"
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Suggested settings for each discovered model the gateway doesn't have yet,
 * with IDs that stay unique among themselves as well as the stored models.
 */
export function suggestModels(
  discovered: readonly DiscoveredGatewayModel[],
  existing: readonly ModelGatewayModel[],
  ownerId: string,
): ModelGatewayModel[] {
  return suggestNewGatewayModels(discovered, existing, ownerId);
}
