import { useState, type JSX } from 'react';
import {
  Button,
  EmptyStateRow,
  SegmentedControl,
  TextInput,
  ToggleSwitch,
  FieldError,
} from '@canopy/ui-shared/components';
import { TrashIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import type {
  PlanDetectionRule,
  PlanDetectionRuleKind,
} from '@canopy/desktop-shared/types';

function isPlanDetectionRuleKind(
  value: string,
): value is PlanDetectionRuleKind {
  return value === 'include' || value === 'exclude';
}

export interface InheritedRuleRow {
  rule: PlanDetectionRule;
  /** Provenance chip text, e.g. 'built-in' | 'global' | 'canopy.json'. */
  origin: string;
  /** Whether this inherited rule is currently disabled at this tier. */
  disabled: boolean;
}

export interface PlanDetectionRulesEditorProps {
  inherited: InheritedRuleRow[];
  customRules: PlanDetectionRule[];
  onToggleInherited?: (ruleId: string, disabled: boolean) => void;
  onAddCustomRule: (rule: Omit<PlanDetectionRule, 'id'>) => void;
  onRemoveCustomRule: (ruleId: string) => void;
  /** When true, inherited rows show no enable toggle (global tier has no parent). */
  hideInheritedToggle?: boolean;
  dataTestIdPrefix: string;
}

export function PlanDetectionRulesEditor({
  inherited,
  customRules,
  onToggleInherited,
  onAddCustomRule,
  onRemoveCustomRule,
  hideInheritedToggle,
  dataTestIdPrefix,
}: PlanDetectionRulesEditorProps): JSX.Element {
  const [kind, setKind] = useState<PlanDetectionRuleKind>('include');
  const [label, setLabel] = useState('');
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAdd = (): void => {
    const trimmedPattern = pattern.trim();
    if (!trimmedPattern) {
      setError('Pattern is required.');
      return;
    }
    onAddCustomRule({
      label: label.trim() || trimmedPattern,
      kind,
      pattern: trimmedPattern,
      enabled: true,
    });
    setLabel('');
    setPattern('');
    setError(null);
  };

  const ruleKindLabel = (value: PlanDetectionRuleKind): string =>
    value === 'include' ? 'Include' : 'Exclude';

  return (
    <div
      className="flex flex-col gap-10"
      data-testid={`${dataTestIdPrefix}-editor`}
    >
      {inherited.length > 0 && (
        <SettingsSection
          title="Inherited rules"
          description="From your settings and canopy.json. Turn off the ones this project doesn’t need."
        >
          <SettingsGroup>
            {inherited.map(({ rule, origin, disabled }) => (
              <SettingsRow
                key={rule.id}
                dataTestId={`${dataTestIdPrefix}-inherited-${rule.id}`}
                label={rule.label}
                description={
                  <>
                    {ruleKindLabel(rule.kind)} · {origin} ·{' '}
                    <span className="font-mono">{rule.pattern}</span>
                  </>
                }
                control={
                  !hideInheritedToggle && onToggleInherited ? (
                    <ToggleSwitch
                      checked={!disabled}
                      label={rule.label}
                      onChange={(): void =>
                        onToggleInherited(rule.id, !disabled)
                      }
                    />
                  ) : undefined
                }
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection title="Project rules">
        <SettingsGroup>
          {customRules.length === 0 ? (
            <EmptyStateRow
              testId={`${dataTestIdPrefix}-empty`}
              title="No project rules yet."
            />
          ) : (
            customRules.map((rule) => (
              <SettingsRow
                key={rule.id}
                dataTestId={`${dataTestIdPrefix}-custom-${rule.id}`}
                label={rule.label}
                description={
                  <>
                    {ruleKindLabel(rule.kind)} ·{' '}
                    <code className="font-mono">{rule.pattern}</code>
                  </>
                }
                control={
                  <Button
                    size="compact"
                    variant="ghost"
                    iconOnly
                    aria-label={`Remove ${rule.label}`}
                    onClick={(): void => onRemoveCustomRule(rule.id)}
                  >
                    <TrashIcon aria-hidden={true} />
                  </Button>
                }
              />
            ))
          )}
          <div className="flex flex-col gap-2">
            <div className="flex min-h-10 items-center gap-2">
              <SegmentedControl
                label="Rule type"
                value={kind}
                width="content"
                dataTestId={`${dataTestIdPrefix}-kind`}
                options={[
                  { value: 'include', label: 'Include' },
                  { value: 'exclude', label: 'Exclude' },
                ]}
                onChange={(next): void => {
                  if (isPlanDetectionRuleKind(next)) setKind(next);
                }}
              />
              <span className="inline-flex w-36 shrink-0">
                <TextInput
                  density="settings"
                  value={label}
                  onChange={(event): void => setLabel(event.target.value)}
                  placeholder="Label (optional)"
                  aria-label="Rule label"
                  data-testid={`${dataTestIdPrefix}-label`}
                />
              </span>
              <span className="inline-flex min-w-0 flex-1">
                <TextInput
                  density="settings"
                  mono
                  value={pattern}
                  onChange={(event): void => {
                    setPattern(event.target.value);
                    if (error) {
                      setError(null);
                    }
                  }}
                  onKeyDown={(event): void => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleAdd();
                    }
                  }}
                  placeholder="docs/plans/*.md"
                  aria-label="Rule pattern"
                  aria-invalid={error !== null || undefined}
                  data-testid={`${dataTestIdPrefix}-pattern`}
                />
              </span>
              <Button
                size="compact"
                onClick={handleAdd}
                disabled={pattern.trim().length === 0}
                data-testid={`${dataTestIdPrefix}-add`}
              >
                Add rule
              </Button>
            </div>
            {error !== null && (
              <FieldError
                id={`${dataTestIdPrefix}-error`}
                data-testid={`${dataTestIdPrefix}-error`}
              >
                {error}
              </FieldError>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
