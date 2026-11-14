'use client';

import { useId, useMemo, useState, type JSX } from 'react';
import { Fieldset } from './Fieldset';
import { ChoiceField } from './Choice';
import { TextInput, FieldError } from './Field';
import { FormField } from './FormField';
import { Button } from './Button';
import { SearchEmptyState, SearchField } from './SearchField';
import { Skeleton } from './Skeleton';
import { Tooltip } from './Tooltip';
import { GitHubIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

export interface MultiRepoProjectOption {
  readonly id: string;
  readonly name: string;
  readonly selected: boolean;
  readonly description?: string;
  readonly repositoryUrl?: string;
  readonly locked?: boolean;
}
export interface MultiRepoProjectSetupFieldsProps {
  readonly name: string;
  readonly onNameChange: (name: string) => void;
  readonly options: readonly MultiRepoProjectOption[];
  readonly onToggle: (id: string) => void;
  readonly optionsLabel?: string;
  readonly onOpenRepository?: (url: string) => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly error?: string | null;
}

/** A list this long is easier to search than to scan. */
const SEARCH_MIN_OPTIONS = 7;
const LOADING_ROW_SAMPLES = [
  'organization/repository',
  'organization/another-repository',
  'organization/repo',
  'organization/longer-repository-name',
];

/** Controlled fields: eligibility, expansion, persistence and cloning stay outside. */
export function MultiRepoProjectSetupFields({
  name,
  onNameChange,
  options,
  onToggle,
  optionsLabel = 'Source projects',
  onOpenRepository,
  disabled,
  loading,
  error,
}: MultiRepoProjectSetupFieldsProps): JSX.Element {
  const id = useId();
  const [searchQuery, setSearchQuery] = useState('');
  const visibleOptions = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) =>
      `${option.name} ${option.description ?? ''}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [options, searchQuery]);
  // An active query keeps its field: a refresh can shorten the list under it.
  const showSearch = options.length >= SEARCH_MIN_OPTIONS || searchQuery !== '';
  return (
    <div
      className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3"
      aria-busy={loading}
    >
      <FormField id={`${id}-name`} label="Project name">
        {(control) => (
          <TextInput
            {...control}
            value={name}
            maxLength={256}
            onChange={(event) => onNameChange(event.target.value)}
            disabled={disabled}
            // The setup error is about the whole form, not this field.
            aria-describedby={error ? `${id}-error` : undefined}
          />
        )}
      </FormField>
      <Fieldset
        className="min-h-0 flex-1"
        gap="inline"
        legend={<span className="text-s fg-primary">{optionsLabel}</span>}
      >
        {showSearch && (
          <SearchField
            size="sm"
            value={searchQuery}
            onValueChange={setSearchQuery}
            placeholder="Search repositories"
            aria-label="Search repositories"
            data-testid="multi-repo-setup-search"
          />
        )}
        {loading && options.length === 0 ? (
          <Skeleton
            loading
            label="Loading repositories"
            testId="multi-repo-setup-loading"
          >
            <div className="flex flex-col gap-2">
              {LOADING_ROW_SAMPLES.map((sample) => (
                <ChoiceField
                  key={sample}
                  checked={false}
                  disabled
                  readOnly
                  label={sample}
                />
              ))}
            </div>
          </Skeleton>
        ) : visibleOptions.length === 0 && searchQuery !== '' ? (
          <SearchEmptyState
            testId="multi-repo-setup-no-matches"
            title="No repositories match your search."
            actionLabel="Clear search"
            onAction={() => setSearchQuery('')}
            actionTestId="multi-repo-setup-clear-search"
          />
        ) : (
          // The inset keeps each control's focus ring inside the scroller.
          <div
            className="flex max-h-[40vh] min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-1"
            data-testid="multi-repo-setup-options"
          >
            {visibleOptions.map((option) => (
              <div key={option.id} className="flex min-w-0 items-center gap-2">
                <ChoiceField
                  className="min-w-0 flex-1"
                  aria-label={option.description ? option.name : undefined}
                  checked={option.selected}
                  disabled={disabled || option.locked}
                  onChange={() => onToggle(option.id)}
                  label={
                    <span className="flex min-w-0 items-center gap-2 fg-primary">
                      <span
                        className={`min-w-0 truncate ${REPLAY_MASK_CLASS}`}
                        title={option.name}
                      >
                        {option.name}
                      </span>
                      {option.description && (
                        <Tooltip
                          label={option.description}
                          clamp
                          allowShrink
                          replayBlock
                        >
                          <span
                            className={`min-w-0 truncate fg-tertiary ${REPLAY_MASK_CLASS}`}
                          >
                            {option.description}
                          </span>
                        </Tooltip>
                      )}
                      {option.locked && (
                        <span className="shrink-0 text-xs fg-secondary">
                          Included
                        </span>
                      )}
                    </span>
                  }
                />
                {option.repositoryUrl && onOpenRepository && (
                  <Tooltip label="Open on GitHub">
                    <Button
                      type="button"
                      iconOnly
                      size="compact"
                      variant="ghost-quiet"
                      aria-label="Open on GitHub"
                      disabled={disabled}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (option.repositoryUrl)
                          onOpenRepository(option.repositoryUrl);
                      }}
                    >
                      <GitHubIcon />
                    </Button>
                  </Tooltip>
                )}
              </div>
            ))}
          </div>
        )}
      </Fieldset>
      {loading && (
        <p role="status" className="text-s fg-secondary">
          Checking repositories…
        </p>
      )}
      {error && (
        <FieldError id={`${id}-error`} announce>
          {error}
        </FieldError>
      )}
    </div>
  );
}
