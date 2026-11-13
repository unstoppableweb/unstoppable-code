'use client';

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  Button,
  DialogModal,
  FormField,
  StatusLabel,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  MODEL_GATEWAY_MAX_MODELS,
  type ModelGatewayModel,
} from '@canopy/protocol/canopy-server';
import {
  useSettingsAiGatewayConnectionKey,
  useSettingsClient,
  useSettingsPrivacy,
} from '../host';
import { gatewayHostname } from '@canopy/protocol/model-gateway/discovery';
import { matchAiGatewayPreset } from '@canopy/protocol/model-gateway/presets';
import { useSettingsErrorCopy } from '../errors';
import { AddGatewayModelForm } from './gateway-model-list';
import { AI_GATEWAY_SETUP_CAP_HINT, suggestModels } from './AiGatewaySetup';
import { GatewayModelBrowser } from './GatewayModelBrowser';
import {
  initialGatewaySelection,
  openWeightGatewayIds,
} from './gateway-model-search';
import {
  keepKeyForCloudChats,
  type AiGatewayEditorAdapter,
  type AiGatewayEditorConfig,
} from './ai-gateway-adapter';
import {
  AI_GATEWAY_ERROR_SCOPE,
  AI_GATEWAY_KNOWN_ERRORS,
  connectionFailureCopy,
  presetShortName,
} from './ai-gateway-copy';

// The dialog can't turn stored models off, so once they alone fill the
// gateway it points to settings; picks made here can just be turned off.
const REFRESH_CAP_HINT = `This gateway already has ${MODEL_GATEWAY_MAX_MODELS} models. Remove one in settings to add another.`;
const NO_MODELS: readonly ModelGatewayModel[] = [];

export interface AiGatewayRefreshDialogProps {
  readonly adapter: AiGatewayEditorAdapter;
  readonly config: AiGatewayEditorConfig & { baseUrl: string };
  readonly onClose: () => void;
  /** Adds the chosen models; resolves `false` when the save failed. */
  readonly onAdd: (models: readonly ModelGatewayModel[]) => Promise<boolean>;
  readonly onKeySaved: () => void;
}

type RefreshState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly copy: string }
  | {
      readonly kind: 'listed';
      readonly suggestions: readonly ModelGatewayModel[];
      readonly openWeightIds: ReadonlySet<string>;
    };

/**
 * Lists only the models the gateway serves that aren't configured yet.
 * Existing models keep their IDs and edits, and a model the gateway stopped
 * listing is never removed here. Where the host keeps keys the stored key is
 * used; elsewhere the key is asked for again and goes with this request only.
 */
export function AiGatewayRefreshDialog({
  adapter,
  config,
  onClose,
  onAdd,
  onKeySaved,
}: AiGatewayRefreshDialogProps): JSX.Element {
  const errorCopy = useSettingsErrorCopy(AI_GATEWAY_ERROR_SCOPE);
  const { maskClassName } = useSettingsPrivacy();
  const client = useSettingsClient();
  const keepsKeys = useSettingsAiGatewayConnectionKey() !== undefined;
  const [apiKey, setApiKey] = useState('');
  const [state, setState] = useState<RefreshState>({ kind: 'idle' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [manual, setManual] = useState<ModelGatewayModel[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualGatewayId, setManualGatewayId] = useState('');
  const [saving, setSaving] = useState(false);
  const preset = useMemo(
    () => matchAiGatewayPreset(config.baseUrl),
    [config.baseUrl],
  );
  const attemptRef = useRef(0);
  const discoveringRef = useRef(false);
  const savingRef = useRef(false);

  const discover = async (key: string): Promise<void> => {
    if (discoveringRef.current) return;
    discoveringRef.current = true;
    const attempt = ++attemptRef.current;
    setState({ kind: 'loading' });
    try {
      const result = await adapter.connect({
        baseUrl: config.baseUrl,
        ...(key ? { apiKey: key } : {}),
      });
      if (attempt !== attemptRef.current) return;
      if (result.status !== 'connected') {
        setState({
          kind: 'failed',
          copy: connectionFailureCopy(
            result.status,
            keepsKeys,
            presetShortName(preset),
          ),
        });
        return;
      }
      setApiKey('');
      if (key && keepsKeys) onKeySaved();
      else if (key) {
        // Still loading and locked, so a second Connect can't race this save.
        await keepKeyForCloudChats(
          client,
          adapter.organizationId,
          key,
          config.baseUrl,
        );
        onKeySaved();
        if (attempt !== attemptRef.current) return;
      }
      const suggestions = suggestModels(
        result.models,
        config.models,
        adapter.organizationId,
      );
      setSelected(
        new Set(
          initialGatewaySelection({
            stored: [],
            candidates: suggestions,
            suggestedIds: preset?.suggestedModelIds ?? [],
            reservedCount: config.models.length,
            limit: MODEL_GATEWAY_MAX_MODELS,
          }),
        ),
      );
      setState({
        kind: 'listed',
        suggestions,
        openWeightIds: openWeightGatewayIds(result.models),
      });
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setState({
        kind: 'failed',
        copy: errorCopy.actionFailure(err, {
          action: 'refresh your models',
          known: AI_GATEWAY_KNOWN_ERRORS,
        }).copy,
      });
    } finally {
      discoveringRef.current = false;
    }
  };

  // Opening Refresh is the request on a host with a stored key. Closing
  // drops any answer still on its way.
  useEffect(() => {
    if (keepsKeys) void discover('');
    return (): void => {
      attemptRef.current += 1;
    };
    // Runs once per dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listed = state.kind === 'listed' ? state.suggestions : NO_MODELS;
  // Stable across renders that don't change it: the browser indexes the
  // catalog once per array.
  const models = useMemo(() => [...listed, ...manual], [listed, manual]);
  const chosen = models.filter((model) => selected.has(model.id));
  const atCapacity =
    config.models.length + chosen.length >= MODEL_GATEWAY_MAX_MODELS;
  // A safety net only: the browser stops turning models on at the limit.
  const overLimit =
    config.models.length + chosen.length > MODEL_GATEWAY_MAX_MODELS;
  const openManual = (gatewayId: string): void => {
    setManualGatewayId(gatewayId);
    setManualOpen(true);
  };

  return (
    <DialogModal
      title="Refresh models"
      subtitle={
        <span className={maskClassName}>
          {preset?.name ?? gatewayHostname(config.baseUrl)}
        </span>
      }
      maxWidth="xl"
      dataTestId="ai-gateway-refresh-dialog"
      closeOnBackdrop={!saving}
      closeButtonDisabled={saving}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {keepsKeys ? null : (
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <FormField label="API key">
                {(control) => (
                  <div className={maskClassName}>
                    <TextInput
                      {...control}
                      density="settings"
                      mono
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      disabled={state.kind === 'loading'}
                      data-testid="ai-gateway-refresh-key"
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                  </div>
                )}
              </FormField>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={state.kind === 'loading' || apiKey.trim() === ''}
              data-testid="ai-gateway-refresh-connect"
              onClick={() => void discover(apiKey.trim())}
            >
              Connect
            </Button>
          </div>
        )}
        <div role="status" className="text-xs fg-secondary">
          {state.kind === 'loading' ? 'Checking your gateway…' : null}
          {state.kind === 'failed' ? (
            <StatusLabel tone="destructive" size="xs">
              {state.copy}
            </StatusLabel>
          ) : null}
          {state.kind === 'listed' && listed.length === 0
            ? 'No new models found.'
            : null}
        </div>
        {state.kind === 'failed' && keepsKeys ? (
          <div>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              onClick={() => void discover('')}
            >
              Try again
            </Button>
          </div>
        ) : null}
        <GatewayModelBrowser
          models={models}
          selected={selected}
          suggestedIds={preset?.suggestedModelIds}
          {...(state.kind === 'listed'
            ? { openWeightIds: state.openWeightIds }
            : {})}
          reservedCount={config.models.length}
          limit={MODEL_GATEWAY_MAX_MODELS}
          capHint={
            config.models.length >= MODEL_GATEWAY_MAX_MODELS
              ? REFRESH_CAP_HINT
              : AI_GATEWAY_SETUP_CAP_HINT
          }
          disabled={saving}
          layout="dialog"
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
        {manualOpen ? (
          <div className="flex flex-col">
            <AddGatewayModelForm
              key={manualGatewayId}
              busy={saving}
              existing={[...config.models, ...models]}
              atCapacity={atCapacity}
              initialGatewayId={manualGatewayId}
              organizationId={adapter.organizationId}
              onAdd={(model) => {
                setManual((previous) => [...previous, model]);
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
              data-testid="ai-gateway-refresh-add-manual"
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
            data-testid="ai-gateway-refresh-save"
            onClick={() => {
              if (savingRef.current) return;
              savingRef.current = true;
              setSaving(true);
              void onAdd(chosen).finally(() => {
                savingRef.current = false;
                setSaving(false);
              });
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
