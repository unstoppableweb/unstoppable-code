import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { type JSX, type ReactNode, useMemo } from 'react';
import type {
  GlobalInstructionHarness,
  GlobalInstructionMode,
  GlobalInstructionsConfig,
  GlobalInstructionsSection,
  GlobalInstructionWorkspaceType,
  ScopedGlobalInstruction,
} from '@canopy/desktop-shared/types';
import {
  AI_GATEWAY_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  OLLAMA_MODELS,
  getExecutionHarnessForModel,
  getModelDisplayName,
} from '@canopy/desktop-shared/types';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import type { GlobalInstructionOverlapWarning } from '@canopy/execution-engine/lib/global-instructions';
import { computeGlobalInstructionOverlapWarnings } from '@canopy/execution-engine/lib/global-instructions';
import {
  Button,
  ChoiceList,
  ChoiceField,
  Notice,
} from '@canopy/ui-shared/components';
import {
  ChevronDown,
  ChevronUp,
  PlusIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSegmentedControl,
  SettingsTextArea,
} from './SettingsLayout';

type SectionKind = 'chats' | 'pipelines';

const MODE_LABELS: Record<GlobalInstructionMode, string> = {
  append: 'Append',
  replace: 'Replace',
};

const HARNESS_OPTIONS: ReadonlyArray<{
  value: GlobalInstructionHarness;
  label: string;
}> = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'ollama', label: 'Ollama' },
];

const WORKSPACE_TYPE_OPTIONS: ReadonlyArray<{
  value: GlobalInstructionWorkspaceType;
  label: string;
}> = [
  { value: 'cowork', label: 'Cowork' },
  { value: 'code', label: 'Code' },
  { value: 'app-advisor', label: ORCHESTRATOR_LABEL },
];

function visibleHarnessOptions(): ReadonlyArray<{
  value: GlobalInstructionHarness;
  label: string;
}> {
  return isOllamaSupportedOnPlatform()
    ? HARNESS_OPTIONS
    : HARNESS_OPTIONS.filter((option) => option.value !== 'ollama');
}

function modelGroups(): ReadonlyArray<{
  label: string;
  models: readonly string[];
}> {
  const gatewayModels = Array.from(new Set(AI_GATEWAY_MODELS));
  const gatewayModelIds = new Set(gatewayModels);
  const groups = [
    {
      label: 'Claude',
      models: CLAUDE_MODELS.filter((model) => !gatewayModelIds.has(model)),
    },
    {
      label: 'Codex',
      models: CODEX_MODELS.filter((model) => !gatewayModelIds.has(model)),
    },
    { label: 'AI Credits', models: gatewayModels },
  ];
  if (isOllamaSupportedOnPlatform() && OLLAMA_MODELS.length > 0) {
    groups.push({ label: 'Ollama', models: OLLAMA_MODELS });
  }
  return groups.filter((group) => group.models.length > 0);
}

function modelsByHarness(): Partial<
  Record<GlobalInstructionHarness, readonly string[]>
> {
  const gatewayModels = Array.from(new Set(AI_GATEWAY_MODELS));
  const gatewayClaudeModels: string[] = [];
  const gatewayCodexModels: string[] = [];
  for (const model of gatewayModels) {
    const harness = getExecutionHarnessForModel(model);
    if (harness === 'claude') gatewayClaudeModels.push(model);
    if (harness === 'codex') gatewayCodexModels.push(model);
  }
  return {
    claude: Array.from(new Set([...CLAUDE_MODELS, ...gatewayClaudeModels])),
    codex: Array.from(new Set([...CODEX_MODELS, ...gatewayCodexModels])),
    ollama: OLLAMA_MODELS,
  };
}

function createScopedInstruction(): ScopedGlobalInstruction {
  return {
    id:
      typeof globalThis.crypto !== 'undefined' &&
      typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `instruction-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
    text: '',
    mode: 'append',
    harnesses: [],
    models: [],
    workspaceTypes: [],
  };
}

function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

const MODE_HINTS: Record<GlobalInstructionMode, string> = {
  append: 'Added after the overall instructions when this scope matches.',
  replace:
    'Replaces the global instructions when this scope matches. The first matching Replace wins.',
};

interface ScopeCheckboxProps {
  checked: boolean;
  label: string;
  testId: string;
  onToggle: () => void;
}

function ScopeCheckbox({
  checked,
  label,
  testId,
  onToggle,
}: ScopeCheckboxProps): JSX.Element {
  return (
    <ChoiceField
      layout="row"
      checked={checked}
      onChange={onToggle}
      data-testid={testId}
      label={label}
    />
  );
}

interface ScopeOptionColumnProps {
  title: string;
  /** Long model lists scroll inside the column instead of stretching it. */
  scrolls?: boolean;
  children: ReactNode;
}

/** One multi-select column of the "Applies to" block: a caption over boxes. */
function ScopeOptionColumn({
  title,
  scrolls = false,
  children,
}: ScopeOptionColumnProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-xs fg-tertiary">
        {title}
      </span>
      {/* A long list scrolls inside the box instead of stretching it. */}
      <div
        className={scrolls ? 'flex max-h-32 min-h-0 flex-col' : 'flex flex-col'}
      >
        <ChoiceList aria-label={title}>{children}</ChoiceList>
      </div>
    </div>
  );
}

interface ScopedInstructionItemProps {
  kind: SectionKind;
  index: number;
  count: number;
  item: ScopedGlobalInstruction;
  warnings: GlobalInstructionOverlapWarning[];
  onChange: (item: ScopedGlobalInstruction) => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
}

/**
 * One scoped instruction as a list item of its section's group: the title,
 * mode, and order actions on one line, then the text and the scope it
 * narrows to.
 */
function ScopedInstructionItem({
  kind,
  index,
  count,
  item,
  warnings,
  onChange,
  onDelete,
  onMove,
}: ScopedInstructionItemProps): JSX.Element {
  const idPrefix = `global-instructions-${kind}-item-${index}`;
  const title = `Scoped instruction #${index + 1}`;
  return (
    <SettingsRow
      label={title}
      description={MODE_HINTS[item.mode]}
      dataTestId={idPrefix}
      control={
        <>
          <SettingsSegmentedControl
            label={`${title} mode`}
            value={item.mode}
            onChange={(mode): void => onChange({ ...item, mode })}
            options={(
              ['append', 'replace'] satisfies GlobalInstructionMode[]
            ).map((mode) => ({
              value: mode,
              label: MODE_LABELS[mode],
              dataTestId: `${idPrefix}-mode-${mode}`,
            }))}
          />
          <div className="flex items-center gap-1">
            <Button
              size="compact"
              variant="secondary"
              iconOnly
              // `aria-disabled` keeps the secondary surface; `disabled` would paint
              // the shared disabled fill on the first row's arrow.
              aria-disabled={index === 0}
              onClick={(): void => {
                if (index > 0) onMove(-1);
              }}
              data-testid={`${idPrefix}-move-up`}
              aria-label={`Move scoped instruction ${index + 1} up`}
            >
              <ChevronUp size="sm" aria-hidden="true" />
            </Button>
            <Button
              size="compact"
              variant="secondary"
              iconOnly
              aria-disabled={index === count - 1}
              onClick={(): void => {
                if (index < count - 1) onMove(1);
              }}
              data-testid={`${idPrefix}-move-down`}
              aria-label={`Move scoped instruction ${index + 1} down`}
            >
              <ChevronDown size="sm" aria-hidden="true" />
            </Button>
            <Button
              size="compact"
              variant="secondary"
              iconOnly
              onClick={onDelete}
              data-testid={`${idPrefix}-delete`}
              aria-label={`Delete scoped instruction ${index + 1}`}
            >
              <TrashIcon size="sm" aria-hidden="true" />
            </Button>
          </div>
        </>
      }
    >
      <SettingsTextArea
        value={item.text}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>): void =>
          onChange({ ...item, text: e.target.value })
        }
        placeholder="Instructions applied when this scope matches the session…"
        aria-label={`${title} text`}
        rows={3}
        data-testid={`${idPrefix}-text`}
      />

      {/* Narrowing scope: one grouped multi-select; the instruction applies
          when the session matches ANY selected option. */}
      <div className="flex flex-col gap-2">
        <p className="text-xs fg-secondary">
          Applies when the session matches any selected option. Leave all empty
          for every session.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <ScopeOptionColumn title="Harness">
            {visibleHarnessOptions().map((option) => (
              <ScopeCheckbox
                key={option.value}
                checked={item.harnesses.includes(option.value)}
                label={option.label}
                testId={`${idPrefix}-harness-${option.value}`}
                onToggle={(): void =>
                  onChange({
                    ...item,
                    harnesses: toggleValue(item.harnesses, option.value),
                  })
                }
              />
            ))}
          </ScopeOptionColumn>
          {modelGroups().map((group) => (
            <ScopeOptionColumn
              key={group.label}
              title={`${group.label} models`}
              scrolls
            >
              {group.models.map((model) => (
                <ScopeCheckbox
                  key={model}
                  checked={item.models.includes(model)}
                  label={getModelDisplayName(model)}
                  testId={`${idPrefix}-model-${model}`}
                  onToggle={(): void =>
                    onChange({
                      ...item,
                      models: toggleValue(item.models, model),
                    })
                  }
                />
              ))}
            </ScopeOptionColumn>
          ))}
          {kind === 'chats' && (
            <ScopeOptionColumn title="Project type">
              {WORKSPACE_TYPE_OPTIONS.map((option) => (
                <ScopeCheckbox
                  key={option.value}
                  checked={item.workspaceTypes.includes(option.value)}
                  label={option.label}
                  testId={`${idPrefix}-workspace-${option.value}`}
                  onToggle={(): void =>
                    onChange({
                      ...item,
                      workspaceTypes: toggleValue(
                        item.workspaceTypes,
                        option.value,
                      ),
                    })
                  }
                />
              ))}
            </ScopeOptionColumn>
          )}
        </div>
      </div>

      {warnings.length > 0 && (
        <Notice
          intent="attention"
          role="status"
          data-testid={`${idPrefix}-warning`}
        >
          {warnings.map((warning) => (
            <p key={`${warning.winnerId}-${warning.itemId}`}>
              {warning.message}
            </p>
          ))}
        </Notice>
      )}
    </SettingsRow>
  );
}

interface SubSectionProps {
  kind: SectionKind;
  title: string;
  description: string;
  overallDescription: string;
  section: GlobalInstructionsSection;
  onChange: (section: GlobalInstructionsSection) => void;
}

function SubSection({
  kind,
  title,
  description,
  overallDescription,
  section,
  onChange,
}: SubSectionProps): JSX.Element {
  const warnings = useMemo(
    () => computeGlobalInstructionOverlapWarnings(section, modelsByHarness()),
    [section],
  );
  const warningsByItemId = useMemo(() => {
    const grouped = new Map<string, GlobalInstructionOverlapWarning[]>();
    for (const warning of warnings) {
      const existing = grouped.get(warning.itemId) ?? [];
      existing.push(warning);
      grouped.set(warning.itemId, existing);
    }
    return grouped;
  }, [warnings]);
  const overallId = `global-instructions-${kind}-overall`;

  return (
    <SettingsSection
      title={title}
      description={description}
      dataTestId={`settings-global-instructions-${kind}`}
    >
      {/* Blocked from session replay: the instruction text and scoped rules.
          The section heading above stays recorded. */}
      <SettingsGroup blockFromReplay>
        <SettingsRow
          label="Overall instructions"
          description={overallDescription}
          htmlFor={overallId}
        >
          <SettingsTextArea
            id={overallId}
            value={section.overall}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>): void =>
              onChange({ ...section, overall: e.target.value })
            }
            placeholder="Instructions applied to every session in this section…"
            rows={3}
            data-testid={overallId}
          />
        </SettingsRow>

        <SettingsRow
          label="Scoped instructions"
          description="Added only when a session matches."
          control={
            <Button
              size="compact"
              variant="secondary"
              aria-label="Add scoped instruction"
              onClick={(): void =>
                onChange({
                  ...section,
                  scoped: [...section.scoped, createScopedInstruction()],
                })
              }
              data-testid={`global-instructions-${kind}-add`}
            >
              <PlusIcon size="sm" aria-hidden="true" />
              Add
            </Button>
          }
        />

        {section.scoped.map((item, index) => (
          <ScopedInstructionItem
            key={item.id}
            kind={kind}
            index={index}
            count={section.scoped.length}
            item={item}
            warnings={warningsByItemId.get(item.id) ?? []}
            onChange={(nextItem): void =>
              onChange({
                ...section,
                scoped: section.scoped.map((candidate, candidateIndex) =>
                  candidateIndex === index ? nextItem : candidate,
                ),
              })
            }
            onDelete={(): void =>
              onChange({
                ...section,
                scoped: section.scoped.filter(
                  (_candidate, candidateIndex) => candidateIndex !== index,
                ),
              })
            }
            onMove={(direction): void =>
              onChange({
                ...section,
                scoped: moveItem(section.scoped, index, index + direction),
              })
            }
          />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}

interface GlobalInstructionsSettingsProps {
  config: GlobalInstructionsConfig;
  onChange: (config: GlobalInstructionsConfig) => void;
}

/**
 * The Chats and Pipelines instruction sections. The page around them states
 * when the combined instructions reach a session.
 */
export function GlobalInstructionsSettings({
  config,
  onChange,
}: GlobalInstructionsSettingsProps): JSX.Element {
  return (
    // The same gap the grouped settings page puts between its sections.
    <div
      className="flex flex-col gap-10"
      data-testid="settings-global-instructions"
    >
      <SubSection
        kind="chats"
        title="Chats"
        description={`Chat sessions in Cowork, Code, and ${ORCHESTRATOR_LABEL}.`}
        overallDescription="Applied to every chat session."
        section={config.chats}
        onChange={(chats): void => onChange({ ...config, chats })}
      />

      <SubSection
        kind="pipelines"
        title="Workflows"
        description="Workflow agent steps: agent prompts and Codex workflow turns."
        overallDescription="Applied to every workflow agent step."
        section={config.pipelines}
        onChange={(pipelines): void => onChange({ ...config, pipelines })}
      />
    </div>
  );
}
