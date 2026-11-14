'use client';

import { useCallback, useMemo, type JSX, type RefObject } from 'react';
import {
  getModelCatalogProviderLabel,
  MODEL_PICKER_AUTO_REASONS,
  managedOpenCodeAutoUnavailableReason,
  ModelPickerMenu,
  changeSelectedModel,
  selectedAgentId,
  modelLibraryUnlockHint,
  Notice,
  noticeButtonClassName,
  modelLibraryUnlockLabel,
  preferredGatewayTabId,
  resolveModelPickerRowCue,
  type ModelCatalog,
  type ModelCatalogOption,
  type ModelCatalogProvider,
  type ModelPickerAutoOption,
  type ModelPickerGatewayTab,
  type ModelPickerOptionState,
  type ModelPickerRowFact,
  type ModelPickerSelectionContext,
} from '@canopy/ui-shared';
import {
  AgentModelPicker,
  type AgentPickerOption,
} from '@canopy/ui-shared/components';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import {
  resolveModelCatalogHarnessChoice,
  type AgentExecutionHarness,
  type ModelLibraryAccess,
} from '@canopy/protocol/models';
import type { PortalChatProviderAvailability } from '@canopy/protocol/portal';

export interface PortalModelPickerProps {
  /** Existing paired hosts keep their combined Agent rows until default metadata is wired. */
  readonly allowLegacyAgentRows?: boolean;
  /** Only a local-route host can supply Agent defaults; cloud definitions cannot. */
  readonly agentSelection?: {
    readonly agents: readonly AgentPickerOption[];
    readonly effectiveModel: string | undefined;
  };
  /** Opt in only in the shared composer status row; other consumers keep their current trigger. */
  readonly statusRow?: boolean;
  readonly compact?: boolean;
  readonly menuAlignRef?: RefObject<HTMLElement | null>;
  readonly triggerTooltip?: string | null;
  readonly disabled?: boolean;
  /** Opens the menu whenever it changes, as a host keyboard shortcut does. */
  readonly openSignal?: number;
  readonly catalog: ModelCatalog;
  readonly currentModel?: string;
  readonly currentModelLabel?: string;
  readonly providerType?: string;
  readonly providerAvailability?: PortalChatProviderAvailability;
  readonly capturedHarness?: AgentExecutionHarness;
  readonly selectedHarness?: AgentExecutionHarness;
  /**
   * Display name of the running brand, used to label gateway rows that carry
   * no vendor of their own. Injected by the host: the brand runtime is an
   * app-level concern, and this component is shared.
   */
  readonly brandDisplayName?: string;
  /**
   * Per-turn Auto routing row. Omitted entirely when the rollout flag is off,
   * the server lacks `model-routing-v1`, or the paired desktop projects no
   * Auto support — the shared menu then renders exactly as it does today.
   */
  readonly autoOption?: ModelPickerAutoOption;
  /**
   * Model-library access for the chat's work owner, from the host. Rows the
   * host marked `libraryEligibility: 'locked'` stay reachable and start
   * `onUnlock` instead of selecting; Auto needs unlocked access too. Omitted
   * (or `unlocked`) renders the picker exactly as before.
   */
  readonly modelLibrary?: {
    readonly access: ModelLibraryAccess;
    /** Start recovery. `modelId` is absent when the locked row was Auto. */
    readonly onUnlock: (
      modelId?: string,
      harness?: AgentExecutionHarness,
    ) => void;
  };
  /**
   * The work owner's model-library access, forwarded to the shared menu.
   * It no longer changes the credits tag, which always reads `AI Credits`
   * (CAN-4769). Hosts pass it only for Personal work.
   */
  readonly libraryAccess?: ModelLibraryAccess;
  /**
   * CAN-5213 — settled facts for the shared availability cues, shown only to
   * a library-locked viewer (`modelLibrary.access`). Omitted, every row keeps
   * its current presentation: the picker never infers Available from
   * `libraryEligibility`, which grants permission, not readiness.
   */
  readonly rowReadiness?: {
    /** Whether the row runs a new turn now; `unknown` until settled. */
    readonly usableNow: (modelId: string) => ModelPickerRowFact;
    /** Spendable AI Credits cover a credits-route row. */
    readonly creditsSufficient: ModelPickerRowFact;
  };
  readonly onSelect: (modelId: string, harness?: AgentExecutionHarness) => void;
  /** Why the work owner's AI gateway models are missing, with where to fix it. */
  readonly gatewayNotice?: {
    /** The state in a few words, shown ahead of the message. */
    readonly title: string;
    readonly message: string;
    /** Omitted when the viewer can't open the settings page. */
    readonly href?: string;
    readonly linkLabel?: string;
  };
}

const CLAUDE_SORT_ORDER = 100;
const CODEX_SORT_ORDER = 200;
/** An own gateway follows native Claude and Codex, before AI Credits. */
const OWN_GATEWAY_SORT_ORDER = 250;
/** Section for rows served by the user's or organization's own gateway. */
const OWN_GATEWAY_VENDOR = 'org-gateway';
/** A desktop gateway row's vendor: `org-gateway:<organization id>`. */
const ORG_GATEWAY_VENDOR_PREFIX = 'org-gateway:';

/** A row served by the owner's or an organization's own AI gateway. */
function isOwnGatewayRow(option: ModelCatalogOption): boolean {
  return (
    option.funding === 'org-gateway' ||
    option.vendor?.startsWith(ORG_GATEWAY_VENDOR_PREFIX) === true
  );
}
const OWN_GATEWAY_LABEL = 'AI gateway';
const ZAI_SORT_ORDER = 300;
const OTHER_SORT_ORDER = 400;

const GATEWAY_VENDOR_SORT_ORDER: Readonly<Record<string, number>> = {
  anthropic: CLAUDE_SORT_ORDER,
  claude: CLAUDE_SORT_ORDER,
  openai: CODEX_SORT_ORDER,
  codex: CODEX_SORT_ORDER,
  zai: ZAI_SORT_ORDER,
};

function gatewayVendorSortOrder(vendor: string | undefined): number {
  const normalized = vendor?.trim().toLowerCase() ?? '';
  const known = Object.prototype.hasOwnProperty.call(
    GATEWAY_VENDOR_SORT_ORDER,
    normalized,
  )
    ? GATEWAY_VENDOR_SORT_ORDER[normalized]
    : undefined;
  return known ?? OTHER_SORT_ORDER;
}

function optionSource(
  option: ModelCatalogOption,
): ModelCatalogOption['source'] | ModelCatalogProvider {
  return option.source ?? option.provider;
}

function optionHarness(
  option: ModelCatalogOption,
): AgentExecutionHarness | undefined {
  if (option.harness) return option.harness;
  if (
    option.source === 'claude' ||
    option.source === 'codex' ||
    option.source === 'cursor' ||
    option.source === 'antigravity' ||
    option.source === 'copilot' ||
    option.source === 'opencode'
  ) {
    return option.source;
  }
  if (option.source === undefined) {
    if (
      option.provider === 'claude' ||
      option.provider === 'cursor' ||
      option.provider === 'antigravity' ||
      option.provider === 'copilot' ||
      option.provider === 'opencode'
    )
      return option.provider;
    if (option.provider === 'codex' || option.provider === 'ollama') {
      return 'codex';
    }
  }
  return undefined;
}

/** Portal wiring for the browser-safe shared model picker. */
export function PortalModelPicker(props: PortalModelPickerProps): JSX.Element {
  const capability = props.agentSelection;
  const agentId = selectedAgentId(props.currentModel);
  const selectModel = (
    model: string,
    harness?: AgentExecutionHarness,
  ): void => {
    props.onSelect(
      capability
        ? (changeSelectedModel(props.currentModel, model) ?? model)
        : model,
      harness,
    );
  };
  return (
    <AgentModelPicker
      agentRoutesSupported={capability !== undefined}
      selection={props.currentModel}
      effectiveModel={capability?.effectiveModel}
      agents={capability?.agents ?? []}
      onAgentChange={(selection): void => {
        if (selection) props.onSelect(selection);
      }}
      disabled={props.disabled}
    >
      <PortalConcreteModelPicker
        {...props}
        catalog={
          capability || props.allowLegacyAgentRows === false
            ? props.catalog.filter((option) => option.kind !== 'agent')
            : props.catalog
        }
        {...(capability
          ? {
              currentModel: capability.effectiveModel,
              currentModelLabel: undefined,
              ...(props.autoOption && agentId
                ? {
                    autoOption: {
                      ...props.autoOption,
                      unavailableReason: 'Remove the agent to use Auto',
                      unavailableAction: undefined,
                      onSelect: (): void => undefined,
                    },
                  }
                : {}),
            }
          : {})}
        onSelect={selectModel}
      />
    </AgentModelPicker>
  );
}

function PortalConcreteModelPicker({
  openSignal,
  disabled,
  statusRow = false,
  compact = false,
  menuAlignRef,
  triggerTooltip,
  catalog,
  currentModel,
  currentModelLabel,
  providerType,
  providerAvailability,
  capturedHarness,
  selectedHarness = capturedHarness,
  brandDisplayName,
  autoOption,
  modelLibrary,
  libraryAccess,
  rowReadiness,
  onSelect,
  gatewayNotice,
}: PortalModelPickerProps): JSX.Element {
  const unlockHint = modelLibraryUnlockHint(modelLibrary?.access);
  const unlockLabel = modelLibraryUnlockLabel(modelLibrary?.access);
  const onUnlock = modelLibrary?.onUnlock;
  // Only the desktop can establish model equivalence. Never merge by label:
  // two similarly named models or parameter variants may execute differently.
  const modelRoutes = useMemo(() => {
    const optionsById = new Map(catalog.map((option) => [option.id, option]));
    const routes = new Map<string, ModelCatalogOption[]>();
    for (const option of catalog) {
      const canonical = option.canonicalModelId
        ? optionsById.get(option.canonicalModelId)
        : undefined;
      const id =
        option.kind === 'model' &&
        (option.source === 'cursor' ||
          option.source === 'antigravity' ||
          option.source === 'copilot' ||
          option.source === 'opencode') &&
        canonical?.kind === 'model' &&
        !canonical.canonicalModelId
          ? canonical.id
          : option.id;
      const existing = routes.get(id);
      if (existing) existing.push(option);
      else routes.set(id, [option]);
    }
    return routes;
  }, [catalog]);
  const favoriteModelAliases = useMemo(() => {
    const aliases = new Map<string, string>();
    for (const [id, routes] of modelRoutes) {
      for (const route of routes) {
        if (route.id !== id) aliases.set(route.id, id);
        else if (
          route.kind === 'model' &&
          (route.source === 'cursor' ||
            route.source === 'antigravity' ||
            route.source === 'copilot' ||
            route.source === 'opencode') &&
          route.canonicalModelId &&
          !modelRoutes.has(route.canonicalModelId)
        ) {
          // Keep the host's identity link when only the account row remains.
          aliases.set(route.id, route.canonicalModelId);
        }
      }
    }
    return aliases;
  }, [modelRoutes]);
  const supportedModelIds = useMemo(() => {
    const supported: Record<string, string[]> = {};
    for (const [id, routes] of modelRoutes) {
      for (const route of routes) {
        for (const choice of route.harnessChoices ?? []) {
          (supported[choice.harness] ??= []).push(id);
        }
        const harness = optionHarness(route);
        if (harness) (supported[harness] ??= []).push(id);
        else if (optionSource(route) === 'ai-gateway') {
          // Missing cloud curation metadata needs a display group, not a harness.
          (supported.other ??= []).push(id);
        }
      }
    }
    return supported;
  }, [modelRoutes]);
  /**
   * One rail tab per connected AI gateway (CAN-6444), keyed by its desktop
   * organization when the row says so, else by its name: cloud rows carry
   * only the gateway's name, and a cloud chat has at most one gateway.
   */
  const gatewayTabs = useMemo<readonly ModelPickerGatewayTab[]>(() => {
    const tabs = new Map<
      string,
      { label: string; iconProvider?: string; modelIds: string[] }
    >();
    for (const [id, routes] of modelRoutes) {
      const row = routes.find(isOwnGatewayRow);
      if (!row) continue;
      const key = row.vendor?.startsWith(ORG_GATEWAY_VENDOR_PREFIX)
        ? row.vendor.slice(ORG_GATEWAY_VENDOR_PREFIX.length)
        : (row.familyLabel ?? OWN_GATEWAY_VENDOR);
      const tab = tabs.get(key) ?? {
        label: row.familyLabel ?? OWN_GATEWAY_LABEL,
        ...(row.gatewayPresetId ? { iconProvider: row.gatewayPresetId } : {}),
        modelIds: [],
      };
      tab.modelIds.push(id);
      tabs.set(key, tab);
    }
    return Array.from(tabs, ([key, tab]) => ({
      id: `gateway:${key}` as const,
      ...tab,
    }));
  }, [modelRoutes]);
  const rawSelectedModelId =
    currentModel === undefined
      ? undefined
      : (parseAgentRouteModelId(currentModel)?.agentId ?? currentModel);
  const selectedModelId =
    [...modelRoutes].find(([, routes]) =>
      routes.some((route) => route.id === rawSelectedModelId),
    )?.[0] ?? rawSelectedModelId;
  const resolveRoute = useCallback(
    (
      option: ModelCatalogOption,
      selection?: ModelPickerSelectionContext,
    ): ModelCatalogOption => {
      const routes = modelRoutes.get(option.id) ?? [option];
      const harness = selection?.harnessExplicitlyChosen
        ? selection.harness
        : (capturedHarness ?? selection?.harness ?? selectedHarness);
      const route =
        (harness
          ? routes.find((route) => optionHarness(route) === harness)
          : (routes.find((route) => route.id === rawSelectedModelId) ??
            routes.find((route) => route.isDefault))) ??
        routes.find((route) => route.id === option.id) ??
        option;
      return resolveModelCatalogHarnessChoice(route, harness);
    },
    [capturedHarness, selectedHarness, modelRoutes, rawSelectedModelId],
  );
  const menuCatalog = useMemo<ModelCatalog>(
    () =>
      [...modelRoutes].map(([id, routes]) => {
        const identity = routes.find((route) => route.id === id) ?? routes[0];
        const option = routes.some((route) => route.isDefault)
          ? { ...identity, isDefault: true }
          : identity;
        const source = optionSource(option);
        if (option.funding === 'org-gateway') {
          // An own gateway is not AI Credits: its rows get their own section,
          // never the brand's, even when a model shares a hosted vendor.
          return {
            ...option,
            family: OWN_GATEWAY_VENDOR,
            familyLabel: option.familyLabel ?? OWN_GATEWAY_LABEL,
            vendor: OWN_GATEWAY_VENDOR,
            sortOrder: OWN_GATEWAY_SORT_ORDER,
          };
        }
        if (source === 'ai-gateway') {
          // Preserve the projected vendor metadata so gateway rows land in the
          // same per-vendor sections desktop shows; the branded fallback vendor
          // is only for rows whose host projected no vendor at all, and its
          // heading comes from the `vendorLabels` override built below.
          return {
            ...option,
            family: option.family ?? 'ai-gateway',
            familyLabel: option.familyLabel ?? brandDisplayName ?? 'AI Credits',
            vendor: option.vendor ?? 'ai-gateway',
            sortOrder:
              option.sortOrder ?? gatewayVendorSortOrder(option.vendor),
          };
        }
        if (option.sortOrder !== undefined) return option;
        return {
          ...option,
          sortOrder:
            source === 'claude'
              ? CLAUDE_SORT_ORDER
              : source === 'codex'
                ? CODEX_SORT_ORDER
                : OTHER_SORT_ORDER,
        };
      }),
    [brandDisplayName, modelRoutes],
  );
  /*
   * The one vendor whose heading the shared picker cannot name: gateway rows
   * with no vendor of their own belong under the brand, and the brand runtime
   * lives here, not in `@canopy/ui-shared` (CAN-2701).
   */
  const vendorLabels = useMemo<Readonly<Record<string, string>>>(() => {
    // One gateway's rows carry its name; several keep the generic heading.
    const gatewayNames = new Set(
      catalog.flatMap((option) =>
        option.funding === 'org-gateway' && option.familyLabel
          ? [option.familyLabel]
          : [],
      ),
    );
    const [gatewayName] = gatewayNames;
    return {
      'ai-gateway': brandDisplayName ?? 'AI Credits',
      [OWN_GATEWAY_VENDOR]:
        gatewayNames.size === 1 && gatewayName !== undefined
          ? gatewayName
          : OWN_GATEWAY_LABEL,
    };
  }, [brandDisplayName, catalog]);
  const selectedOption = useMemo(
    () =>
      menuCatalog.find((option) => option.id === selectedModelId) ??
      (selectedModelId === undefined
        ? menuCatalog.find((option) => option.isDefault === true)
        : undefined),
    [selectedModelId, menuCatalog],
  );
  const triggerProvider =
    selectedHarness && selectedOption?.provider !== 'ollama'
      ? selectedHarness
      : selectedOption
        ? resolveRoute(selectedOption).provider
        : undefined;

  const getRouteState = useCallback(
    (
      option: ModelCatalogOption,
      selection?: ModelPickerSelectionContext,
    ): ModelPickerOptionState => {
      if (capturedHarness === 'opencode' && currentModel) {
        const current = catalog.find(
          (entry) => entry.id === rawSelectedModelId,
        );
        if (
          current &&
          (optionSource(current) === 'opencode') !==
            (optionSource(option) === 'opencode')
        )
          return {
            disabled: true,
            unavailableReason:
              'Start a new chat to change the OpenCode billing selection.',
          };
      }
      // Cursor runs on the paired desktop's managed runtime. The desktop
      // projects whether that runtime is connected on `providerAvailability.
      // cursor`; anything but an explicit `true` (including a cold "unknown")
      // keeps the row disabled with connect guidance. This branch must stay
      // ahead of the generic provider check below, whose "not signed in"
      // wording does not describe a runtime that is simply not connected.
      if (
        (option.provider === 'antigravity' ||
          option.harness === 'antigravity') &&
        providerAvailability?.antigravity !== true
      ) {
        return {
          disabled: true,
          unavailableReason:
            'Connect your personal Google account on the paired computer.',
        };
      }
      if (
        (option.provider === 'cursor' ||
          option.harness === 'cursor' ||
          option.source === 'cursor') &&
        providerAvailability?.cursor !== true
      )
        return {
          disabled: true,
          unavailableReason:
            'Connect Cursor in the desktop app to use it here.',
        };
      if (
        (option.provider === 'copilot' ||
          option.harness === 'copilot' ||
          option.source === 'copilot') &&
        providerAvailability?.copilot !== true
      )
        return {
          disabled: true,
          unavailableReason:
            'Connect Copilot in the desktop app to use it here.',
        };
      if (
        (option.provider === 'opencode' ||
          option.harness === 'opencode' ||
          option.source === 'opencode') &&
        providerAvailability?.opencode !== true
      )
        return {
          disabled: true,
          unavailableReason:
            'Connect OpenCode in the desktop app to use it here.',
        };
      if (option.kind === 'agent' && !option.available) {
        return {
          disabled: true,
          unavailableReason:
            'This agent is unavailable — its base model is not registered on the desktop app.',
        };
      }
      if (
        capturedHarness !== undefined &&
        optionHarness(option) !== capturedHarness
      ) {
        return {
          disabled: true,
          unavailableReason: `This chat started on the ${getModelCatalogProviderLabel(capturedHarness)} harness and can only switch to models that run on it.`,
        };
      }
      if (
        option.funding === undefined &&
        optionSource(option) !== 'ai-gateway' &&
        option.provider !== 'unknown' &&
        providerAvailability?.[option.provider] === false
      ) {
        return {
          disabled: true,
          unavailableReason: `${getModelCatalogProviderLabel(option.provider)} is not signed in on the desktop app.`,
        };
      }
      // Last on purpose: a provider or harness restriction is not something a
      // sign-in or purchase can clear, so it keeps its own reason.
      if (
        unlockHint !== undefined &&
        onUnlock &&
        option.libraryEligibility === 'locked'
      ) {
        return {
          disabled: false,
          locked: {
            hint: unlockHint,
            ...(unlockLabel === undefined ? {} : { label: unlockLabel }),
            onUnlock: (): void => {
              const harness =
                selection?.harness === undefined
                  ? capturedHarness
                  : optionHarness(option);
              if (harness === undefined) onUnlock(option.id);
              else onUnlock(option.id, harness);
            },
          },
        };
      }
      const cue = rowReadiness
        ? resolveModelPickerRowCue({
            rowKind: option.kind === 'agent' ? 'agent' : 'model',
            viewerAccess: modelLibrary?.access,
            hardDisabled: false,
            libraryLocked: false,
            usableNow: rowReadiness.usableNow(option.id),
            creditsRoute:
              option.funding === 'org-gateway'
                ? 'no'
                : optionSource(option) === 'ai-gateway'
                  ? 'yes'
                  : 'unknown',
            creditsSufficient: rowReadiness.creditsSufficient,
          })
        : undefined;
      if (cue?.kind === 'available')
        return { disabled: false, available: true };
      return { disabled: false };
    },
    [
      capturedHarness,
      currentModel,
      catalog,
      rawSelectedModelId,
      modelLibrary?.access,
      onUnlock,
      providerAvailability,
      rowReadiness,
      unlockHint,
      unlockLabel,
    ],
  );
  const getOptionState = useCallback(
    (
      option: ModelCatalogOption,
      selection?: ModelPickerSelectionContext,
    ): ModelPickerOptionState =>
      getRouteState(resolveRoute(option, selection), selection),
    [getRouteState, resolveRoute],
  );
  // Whether anything outside the user's own gateways can run here; when not,
  // the picker opens on the gateway (CAN-6444).
  const builtInRunnable = useMemo(
    () =>
      menuCatalog.some((option) => {
        if (isOwnGatewayRow(option) || option.kind === 'agent') return false;
        const state = getOptionState(option);
        return !state.disabled && !state.locked;
      }),
    [getOptionState, menuCatalog],
  );
  const preferredGatewayTab = preferredGatewayTabId({
    gatewayTabs,
    currentModel: selectedModelId,
    builtInRunnable,
  });
  const effectiveAutoOption = useMemo<ModelPickerAutoOption | undefined>(() => {
    if (!autoOption || autoOption.unavailableReason) return autoOption;
    if (
      (selectedHarness ?? selectedOption?.harness ?? providerType) ===
      'opencode'
    ) {
      const reason = managedOpenCodeAutoUnavailableReason(
        // A display row can merge a native account with a hosted model. Auto
        // eligibility follows the saved route, never the merged row's funding.
        catalog.find((option) => option.id === rawSelectedModelId),
        catalog.filter((option) => {
          const state = getRouteState(
            resolveModelCatalogHarnessChoice(option, 'opencode'),
          );
          return !state.disabled && !state.locked;
        }),
      );
      return {
        ...autoOption,
        unavailableReason: unlockHint ?? reason,
        unavailableAction: undefined,
      };
    }
    // Auto can route to any model, so it needs unlocked access.
    if (unlockHint !== undefined && onUnlock) {
      return {
        selected: autoOption.selected,
        onSelect: autoOption.onSelect,
        unavailableReason: unlockHint,
        unavailableAction: (): void => onUnlock(),
        ...(autoOption.hideWhenUnavailable
          ? { hideWhenUnavailable: true }
          : {}),
      };
    }
    const selectedSource = selectedOption
      ? optionSource(resolveRoute(selectedOption))
      : undefined;
    // Auto executes raw Claude/Codex routes. A merged display row may borrow
    // their description while manual selection uses a managed account route.
    const eligibleCount = catalog.filter((option) => {
      if (
        option.kind === 'agent' ||
        !option.available ||
        !option.description?.trim()
      )
        return false;
      const harness = optionHarness(option);
      if (harness !== 'claude' && harness !== 'codex') return false;
      const source = optionSource(option);
      if (source !== 'claude' && source !== 'codex' && source !== 'ai-gateway')
        return false;
      const state = getRouteState(option);
      if (state.disabled || state.locked) return false;
      if (selectedSource === 'ai-gateway') return source === 'ai-gateway';
      if (selectedSource !== undefined) {
        return source !== 'ai-gateway';
      }
      return true;
    }).length;
    return eligibleCount >= 2
      ? autoOption
      : {
          selected: autoOption.selected,
          onSelect: autoOption.onSelect,
          // Nothing to open for a candidate-count reason, so no action.
          unavailableReason: MODEL_PICKER_AUTO_REASONS.tooFewCandidates,
          ...(autoOption.hideWhenUnavailable
            ? { hideWhenUnavailable: true }
            : {}),
        };
  }, [
    autoOption,
    selectedHarness,
    rawSelectedModelId,
    providerType,
    catalog,
    getRouteState,
    onUnlock,
    resolveRoute,
    selectedOption,
    unlockHint,
  ]);

  // The descriptors are the host's capability advertisement for explicit setters.
  // Older hosts keep their existing picker and never receive a harness field.
  const supportsChoices = menuCatalog.some(
    (option) => option.harnessChoices?.length,
  );
  const runnable = (
    [
      'claude',
      'codex',
      'cursor',
      'copilot',
      'antigravity',
      'opencode',
      'ollama',
    ] as const
  )
    .filter((id) =>
      menuCatalog.some(
        (option) =>
          optionHarness(option) === id ||
          option.provider === id ||
          option.harnessChoices?.some((choice) => choice.harness === id),
      ),
    )
    .map((id) => ({
      id,
      connected:
        id === 'ollama' ||
        (id === 'antigravity' ||
        id === 'opencode' ||
        id === 'cursor' ||
        id === 'copilot'
          ? providerAvailability?.[id] === true
          : providerAvailability?.[id] !== false),
    }));
  return (
    <ModelPickerMenu
      disabled={disabled}
      {...(openSignal === undefined ? {} : { openSignal })}
      catalog={menuCatalog}
      libraryAccess={libraryAccess}
      currentModel={selectedModelId}
      currentModelLabel={currentModelLabel}
      providerType={providerType}
      triggerProvider={triggerProvider}
      onSelect={(modelId, selection): void => {
        const option = menuCatalog.find((entry) => entry.id === modelId);
        if (!option) return;
        const route = resolveRoute(option, selection);
        if (supportsChoices) onSelect(route.id, optionHarness(route));
        else onSelect(route.id);
      }}
      harnessTabs={{
        allModelsTab: true,
        leadingFavorites: true,
        brandIcon: null,
        brandLabel: brandDisplayName ?? 'AI Credits',
        // The user's own gateway leads when it holds the only runnable
        // models; otherwise the chat's harness, else All.
        initialTab:
          preferredGatewayTab ??
          (selectedHarness === 'claude' ||
          selectedHarness === 'codex' ||
          (selectedHarness && supportedModelIds[selectedHarness]?.length)
            ? selectedHarness
            : 'all'),
        ...(gatewayTabs.length > 0 ? { gatewayTabs } : {}),
        ...(supportsChoices ? { runnableHarnesses: runnable } : {}),
        supportedModelIds,
        favoriteModelAliases,
      }}
      getOptionState={getOptionState}
      getOptionPresentation={resolveRoute}
      vendorLabels={vendorLabels}
      autoOption={effectiveAutoOption}
      variant="capsule"
      menuId="portal-chat-model-menu"
      testIdPrefix="portal-chat-model"
      uniformTestIds
      triggerLabelClassName={
        statusRow ? 'max-w-full' : 'max-w-20 lg:max-w-none'
      }
      allowTriggerShrink={statusRow}
      foldTriggerIconWhenTight={statusRow}
      foldTriggerIconOnTruncate={statusRow}
      hideTriggerChevron={statusRow}
      compactTrigger={statusRow && compact}
      menuAlignRef={menuAlignRef}
      {...(gatewayNotice
        ? {
            footer: (): JSX.Element => (
              <Notice
                intent="neutral"
                role="none"
                data-testid="portal-chat-model-gateway-notice"
                title={gatewayNotice.title}
                actions={
                  gatewayNotice.href && gatewayNotice.linkLabel ? (
                    <a
                      href={gatewayNotice.href}
                      className={noticeButtonClassName('secondary')}
                    >
                      {gatewayNotice.linkLabel}
                    </a>
                  ) : undefined
                }
              >
                {gatewayNotice.message}
              </Notice>
            ),
          }
        : {})}
      {...(statusRow ? { menuAlignEdge: 'left' } : {})}
      {...(statusRow ? { triggerTooltip: triggerTooltip ?? null } : {})}
    />
  );
}
