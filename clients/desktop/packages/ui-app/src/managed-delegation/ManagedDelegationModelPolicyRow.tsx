'use client';

import { useState, type JSX } from 'react';
import {
  Button,
  ChoiceField,
  ErrorBanner,
  FilterMenuButton,
  Heading,
  Inline,
  Notice,
  SearchEmptyState,
  SearchField,
  SegmentedControl,
  SettingsRowsRow,
  SettingsRowsSubRow,
  Stack,
  ToggleSwitch,
  pageFilter,
  type FilterOption,
} from '@canopy/ui-shared/components';
import {
  initialManagedDelegationModelRoutes,
  managedDelegationModelPolicyFitsLimits,
  MANAGED_DELEGATION_MODEL_POLICY_LIMITS,
  type ManagedDelegationModelPolicy,
  type ManagedDelegationModelPolicyMode,
  type ManagedDelegationPolicyBillingGroup,
  type ManagedDelegationPolicyCatalog,
  type ManagedDelegationPolicyModel,
} from '@canopy/protocol/delegation/model-policy';

export type ManagedDelegationPolicyCatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: string }
  | {
      readonly status: 'ready';
      readonly catalog: ManagedDelegationPolicyCatalog;
    };

export interface ManagedDelegationModelPolicyRowProps {
  /** Saved policy; `undefined` is the legacy All models default. */
  readonly policy: ManagedDelegationModelPolicy | undefined;
  readonly catalog: ManagedDelegationPolicyCatalogState;
  readonly onRetryCatalog: () => void;
  /** The host saves, reads back, and rolls back on failure. */
  readonly onChange: (next: ManagedDelegationModelPolicy) => void;
  /** Saving or unsupported: every control is read-only. */
  readonly disabled: boolean;
  readonly delegationOff: boolean;
}

const LEGACY_POLICY: ManagedDelegationModelPolicy = {
  version: 1,
  mode: 'all',
  disabledBillingGroups: [],
  selectedModelIds: [],
  modelRoutes: {},
};

/** Models per page in Selected models; selected models sort first. */
const PAGE_SIZE = 10;

/** One filter value per distinct id, counted over the whole catalog. */
function filterOptions(
  values: readonly (
    | { readonly id: string; readonly label: string }
    | undefined
  )[],
): FilterOption<string>[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const value of values) {
    if (!value) continue;
    const entry = counts.get(value.id);
    counts.set(value.id, {
      label: value.label,
      count: (entry?.count ?? 0) + 1,
    });
  }
  return Array.from(counts, ([value, { label, count }]) => ({
    value,
    label,
    count,
  })).sort((a, b) => a.label.localeCompare(b.label));
}

function toggled(
  values: readonly string[],
  value: string,
  on: boolean,
): string[] {
  const rest = values.filter((item) => item !== value);
  return on ? [...rest, value] : rest;
}

/**
 * Settings → Labs → Managed delegation → Allowed models. Prop-driven: the
 * host owns persistence, the catalog transport and enforcement.
 */
export function ManagedDelegationModelPolicyRow({
  policy,
  catalog,
  onRetryCatalog,
  onChange,
  disabled,
  delegationOff,
}: ManagedDelegationModelPolicyRowProps): JSX.Element {
  const [limitError, setLimitError] = useState(false);
  // An edit the saved form can't hold is refused here, never saved and read
  // back as the fail-closed policy.
  const change = (next: ManagedDelegationModelPolicy): void => {
    const fits = managedDelegationModelPolicyFitsLimits(next);
    setLimitError(!fits);
    if (fits) onChange(next);
  };
  const [query, setQueryValue] = useState('');
  const [selectedOnly, setSelectedOnlyValue] = useState(false);
  const [families, setFamiliesValue] = useState<readonly string[]>([]);
  const [providers, setProvidersValue] = useState<readonly string[]>([]);
  const [page, setPage] = useState(0);
  // Any change to what is listed starts again at the first page.
  const setQuery = (value: string): void => {
    setQueryValue(value);
    setPage(0);
  };
  const setSelectedOnly = (value: boolean): void => {
    setSelectedOnlyValue(value);
    setPage(0);
  };
  const setFamilies = (value: readonly string[]): void => {
    setFamiliesValue(value);
    setPage(0);
  };
  const setProviders = (value: readonly string[]): void => {
    setProvidersValue(value);
    setPage(0);
  };
  const current = policy ?? LEGACY_POLICY;
  const ready = catalog.status === 'ready' ? catalog.catalog : undefined;
  const models = ready?.models ?? [];
  const selected = current.selectedModelIds;

  const routesFor = (model: ManagedDelegationPolicyModel): readonly string[] =>
    initialManagedDelegationModelRoutes(
      current,
      model.modelId,
      model.routes.map((route) => route.key),
    );

  // Saved choices the catalog doesn't list stay visible and keep intent.
  const groups: ManagedDelegationPolicyBillingGroup[] = [
    ...(ready?.billingGroups ?? []),
    ...current.disabledBillingGroups
      .filter((id) => !ready?.billingGroups.some((group) => group.id === id))
      .map((id) => ({
        id,
        label: id,
        description: 'Not available on this device. Your choice is kept.',
      })),
  ];
  const missingSelected: ManagedDelegationPolicyModel[] = selected
    .filter((id) => !models.some((model) => model.modelId === id))
    .map((id) => ({
      modelId: id,
      label: id,
      routes: [],
      unavailableReason:
        catalog.status === 'ready'
          ? 'Not in the current model catalog. Your choice is kept.'
          : 'Saved choice.',
    }));
  const needle = query.trim().toLowerCase();
  const matches = (model: ManagedDelegationPolicyModel): boolean =>
    (!selectedOnly || selected.includes(model.modelId)) &&
    (families.length === 0 ||
      (model.family !== undefined && families.includes(model.family.id))) &&
    (providers.length === 0 ||
      (model.provider !== undefined &&
        providers.includes(model.provider.id))) &&
    `${model.label} ${model.vendor ?? ''} ${model.family?.label ?? ''}`
      .toLowerCase()
      .includes(needle);
  const visible = [...models, ...missingSelected].filter(matches);
  const ordered = [
    ...visible.filter((model) => selected.includes(model.modelId)),
    ...visible.filter((model) => !selected.includes(model.modelId)),
  ];
  const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageItems = ordered.slice(pageStart, pageStart + PAGE_SIZE);
  const familyFilter = pageFilter({
    key: 'family',
    title: 'Family',
    anyLabel: 'Any family',
    options: filterOptions(models.map((model) => model.family)),
    selected: families,
    multiple: true,
    onToggle: (value): void =>
      setFamilies(toggled(families, value, !families.includes(value))),
    onClear: (): void => setFamilies([]),
    testId: 'settings-managed-delegation-filter-family',
  });
  const providerFilter = pageFilter({
    key: 'provider',
    title: 'Provider',
    anyLabel: 'Any provider',
    options: filterOptions(models.map((model) => model.provider)),
    selected: providers,
    multiple: true,
    onToggle: (value): void =>
      setProviders(toggled(providers, value, !providers.includes(value))),
    onClear: (): void => setProviders([]),
    testId: 'settings-managed-delegation-filter-provider',
  });
  const hiddenSelected = selected.filter(
    (id) => !visible.some((model) => model.modelId === id),
  ).length;

  const allowed =
    current.mode === 'all'
      ? catalog.status !== 'ready' ||
        groups.length === 0 ||
        groups.some(
          (group) => !current.disabledBillingGroups.includes(group.id),
        )
      : selected.some((id) => (current.modelRoutes[id]?.length ?? 0) > 0);

  function selectModel(model: ManagedDelegationPolicyModel, on: boolean): void {
    change({
      ...current,
      selectedModelIds: toggled(selected, model.modelId, on),
      modelRoutes: {
        ...current.modelRoutes,
        [model.modelId]: routesFor(model),
      },
    });
  }

  return (
    <SettingsRowsRow
      label="Allowed models"
      description="Choose which models and billing options subagents can use."
      contentGap="group"
      dataTestId="settings-managed-delegation-allowed-models"
      control={
        <SegmentedControl<ManagedDelegationModelPolicyMode>
          label="Allowed models"
          value={current.mode}
          disabled={disabled}
          options={[
            { value: 'all', label: 'All models' },
            { value: 'selected', label: 'Selected models' },
          ]}
          onChange={(mode): void => change({ ...current, mode })}
        />
      }
    >
      <Stack gap="group">
        {delegationOff ? (
          <Notice role="none" intent="neutral" title="Delegation is off.">
            These choices apply when delegation is enabled.
          </Notice>
        ) : null}
        {!allowed ? (
          <Notice
            role="status"
            intent="attention"
            title="No models are allowed."
            data-testid="settings-managed-delegation-none-allowed"
          >
            New subagents cannot start.
          </Notice>
        ) : null}
        {limitError ? (
          <ErrorBanner
            errorSource="managed-delegation-model-policy-limit"
            error={`Couldn't save this change. Allowed models can keep choices for up to ${MANAGED_DELEGATION_MODEL_POLICY_LIMITS.models} models.`}
            onDismiss={(): void => setLimitError(false)}
            testId="settings-managed-delegation-limit-error"
          />
        ) : null}
        {catalog.status === 'error' ? (
          <ErrorBanner
            errorSource="managed-delegation-model-policy-catalog"
            error={`${catalog.error} Saved choices are kept; other models aren't shown.`}
            onRetry={onRetryCatalog}
            testId="settings-managed-delegation-catalog-error"
          />
        ) : null}
        {current.mode === 'all' ? (
          <Stack gap="item">
            <Heading level={3} variant="label">
              Providers and billing
            </Heading>
            {catalog.status === 'loading' ? (
              <p className="text-xs text-pretty fg-secondary">
                Loading providers…
              </p>
            ) : (
              <Stack gap="item">
                {groups.map((group) => (
                  <SettingsRowsSubRow
                    key={group.id}
                    label={group.label}
                    description={group.description}
                    control={
                      <ToggleSwitch
                        label={group.label}
                        checked={
                          !current.disabledBillingGroups.includes(group.id)
                        }
                        disabled={disabled || catalog.status !== 'ready'}
                        onChange={(on): void =>
                          change({
                            ...current,
                            disabledBillingGroups: toggled(
                              current.disabledBillingGroups,
                              group.id,
                              !on,
                            ),
                          })
                        }
                        dataTestId={`settings-managed-delegation-billing-${group.id}`}
                      />
                    }
                  />
                ))}
              </Stack>
            )}
            <p className="text-xs text-pretty fg-secondary">
              Each switch applies to all current and future models using that
              option. New provider and billing options are allowed by default.
            </p>
          </Stack>
        ) : (
          <Stack gap="item">
            <Inline gap="inline">
              <div className="min-w-0 flex-1">
                <SearchField
                  aria-label="Search models"
                  placeholder="Search models"
                  value={query}
                  onValueChange={setQuery}
                  size="sm"
                  disabled={catalog.status !== 'ready'}
                  count={
                    needle || families.length > 0 || providers.length > 0
                      ? `${visible.length} of ${models.length}`
                      : undefined
                  }
                />
              </div>
              <FilterMenuButton
                name="Filter models"
                groups={[familyFilter.group, providerFilter.group]}
                onClearAll={(): void => {
                  setFamilies([]);
                  setProviders([]);
                }}
                testId="settings-managed-delegation-filter"
              />
            </Inline>
            <Inline gap="inline" justify="between" wrap>
              <span
                className="text-xs text-pretty fg-secondary"
                data-testid="settings-managed-delegation-selected-count"
              >
                {selected.length} selected
                {hiddenSelected > 0
                  ? ` · ${hiddenSelected} hidden by search or filters`
                  : ''}
              </span>
              <Button
                variant="ghost"
                size="compact"
                disabled={catalog.status !== 'ready'}
                onClick={(): void => {
                  setSelectedOnly(!selectedOnly);
                  setQuery('');
                }}
              >
                {selectedOnly ? 'Show all models' : 'Show selected'}
              </Button>
            </Inline>
            {catalog.status === 'loading' ? (
              <p className="text-xs text-pretty fg-secondary">
                Loading models…
              </p>
            ) : null}
            <div
              className="flex flex-col divide-y"
              data-testid="settings-managed-delegation-model-list"
            >
              {pageItems.map((model) => {
                const isSelected = selected.includes(model.modelId);
                const enabledRoutes = routesFor(model);
                const known = models.includes(model);
                return (
                  <div className="py-3" key={model.modelId}>
                    <Stack gap="item">
                      <ChoiceField
                        kind="checkbox"
                        id={`managed-delegation-model-${model.modelId}`}
                        label={model.label}
                        description={model.unavailableReason ?? model.vendor}
                        checked={isSelected}
                        // A missing saved model can still be removed.
                        disabled={
                          disabled ||
                          catalog.status !== 'ready' ||
                          (!known && !isSelected)
                        }
                        onChange={(event): void =>
                          selectModel(model, event.target.checked)
                        }
                      />
                      {isSelected && model.routes.length > 0 ? (
                        <div className="pl-7">
                          <Stack gap="item">
                            {model.routes.map((route) => (
                              <SettingsRowsSubRow
                                key={route.key}
                                label={route.label}
                                description={
                                  route.availability === 'available'
                                    ? undefined
                                    : route.reason
                                }
                                control={
                                  <ToggleSwitch
                                    label={`${model.label} · ${route.label}`}
                                    checked={enabledRoutes.includes(route.key)}
                                    disabled={
                                      disabled || catalog.status !== 'ready'
                                    }
                                    onChange={(on): void =>
                                      change({
                                        ...current,
                                        modelRoutes: {
                                          ...current.modelRoutes,
                                          [model.modelId]: toggled(
                                            enabledRoutes,
                                            route.key,
                                            on,
                                          ),
                                        },
                                      })
                                    }
                                  />
                                }
                              />
                            ))}
                            {enabledRoutes.length === 0 ? (
                              <Notice role="status" intent="attention">
                                Choose a provider or billing option to allow
                                this model.
                              </Notice>
                            ) : null}
                          </Stack>
                        </div>
                      ) : null}
                    </Stack>
                  </div>
                );
              })}
            </div>
            {pageCount > 1 ? (
              <Inline
                gap="inline"
                justify="between"
                wrap
                data-testid="settings-managed-delegation-pagination"
              >
                <span className="text-xs tabular-nums fg-secondary">
                  {`${pageStart + 1}–${pageStart + pageItems.length} of ${ordered.length}`}
                </span>
                <Inline gap="inline">
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={currentPage === 0}
                    onClick={(): void => setPage(currentPage - 1)}
                    data-testid="settings-managed-delegation-page-previous"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={currentPage >= pageCount - 1}
                    onClick={(): void => setPage(currentPage + 1)}
                    data-testid="settings-managed-delegation-page-next"
                  >
                    Next
                  </Button>
                </Inline>
              </Inline>
            ) : null}
            {catalog.status === 'ready' && visible.length === 0 ? (
              <SearchEmptyState
                title={
                  models.length === 0
                    ? 'No models are configured.'
                    : 'No models match your search or filters.'
                }
                actionLabel="Clear search"
                onAction={(): void => {
                  setQuery('');
                  setSelectedOnly(false);
                  setFamilies([]);
                  setProviders([]);
                }}
              />
            ) : null}
            <p className="text-xs text-pretty fg-secondary">
              Only selected models and their enabled options are allowed. New
              models and billing options stay off until you choose them.
            </p>
          </Stack>
        )}
        <p className="text-xs text-pretty fg-secondary">
          Applies when a subagent starts or starts another turn. Running turns
          continue.
        </p>
      </Stack>
    </SettingsRowsRow>
  );
}
