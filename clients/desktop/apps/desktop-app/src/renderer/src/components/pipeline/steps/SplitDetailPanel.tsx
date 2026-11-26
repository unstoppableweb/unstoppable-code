import { useRef, useState, type JSX } from 'react';
import type { Step } from '@canopy/execution-engine/types/pipeline';
import { Button, Notice, Stack, Heading } from '@canopy/ui-shared/components';
import { PlusIcon, TrashIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { FormField } from '../shared/FormField';
import { TextField } from '../shared/TextField';
import { TextAreaField } from '../shared/TextAreaField';
import { PipelineDetailPanelShell } from './PipelinePanelPrimitives';

export interface SplitDetailPath {
  readonly jobId: string;
  readonly label: string;
}

interface SplitDetailPanelProps {
  /** The split's router step. */
  step: Step;
  paths: readonly SplitDetailPath[];
  readonly?: boolean;
  /** Missing `text` and `text_file`: the router has nothing to decide on. */
  missingInput: boolean;
  onChange: (step: Step) => void;
  /** Renames a path's route and guard together; returns why it was refused. */
  onRenamePath: (pathJobId: string, label: string) => string | null;
  onAddPath: () => void;
  onRemovePath: (pathJobId: string) => void;
  onClose: () => void;
}

function inputText(step: Step, key: string): string {
  const value = step.with?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * One path's name, applied as typed through the split's check, so a save
 * from the keyboard writes what the field shows. A refused name is never
 * left applied: the path goes back to the name it had when the field took
 * focus, and the field says why until the next keystroke.
 */
function PathNameField({
  path,
  number,
  readonly,
  canRemove,
  onRename,
  onRemove,
}: {
  path: SplitDetailPath;
  number: number;
  readonly: boolean;
  canRemove: boolean;
  onRename: (label: string) => string | null;
  onRemove: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(path.label);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(path.label);
  const original = useRef(path.label);
  // The label changed elsewhere (undo, say): show it.
  if (shown !== path.label) {
    setShown(path.label);
    setDraft(path.label);
    setError(null);
  }
  const rename = (next: string): void => {
    setDraft(next);
    const refused = next === path.label ? null : onRename(next);
    if (refused === null) {
      setShown(next);
      setError(null);
      return;
    }
    if (path.label !== original.current && onRename(original.current) === null)
      setShown(original.current);
    setError(refused);
  };
  return (
    <FormField
      label={`Path ${String(number)}`}
      {...(error !== null
        ? {
            // It can quote an authored name: never recorded.
            error: (
              <span className={REPLAY_BLOCK_CLASS}>
                {`${error} The path keeps its name.`}
              </span>
            ),
          }
        : {})}
      {...(canRemove && !readonly
        ? {
            trailingAction: (
              <Button
                variant="ghost"
                size="compact"
                iconOnly
                aria-label={`Remove path ${String(number)}`}
                data-testid="split-panel-remove-path"
                onClick={onRemove}
              >
                <TrashIcon size="sm" aria-hidden="true" />
              </Button>
            ),
          }
        : {})}
    >
      <TextField
        value={draft}
        onFocus={(): void => {
          original.current = path.label;
        }}
        onChange={(event): void => rename(event.target.value)}
        onBlur={(): void => {
          // Refused text never outlives the field's focus: it shows the name
          // the path has, which is the one a save writes.
          if (error !== null) {
            setDraft(original.current);
            setError(null);
          }
        }}
        disabled={readonly}
        data-testid="split-panel-path-name"
      />
    </FormField>
  );
}

/**
 * The details of a split the Designer draws as paths (CAN-4224 phase 03):
 * what the router decides on, how, and its paths' names. Its routes, action
 * and ID change only through these path edits, so routes and guards stay
 * in step.
 */
export function SplitDetailPanel({
  step,
  paths,
  readonly = false,
  missingInput,
  onChange,
  onRenamePath,
  onAddPath,
  onRemovePath,
  onClose,
}: SplitDetailPanelProps): JSX.Element {
  const setInput = (key: 'text' | 'criteria', value: string): void => {
    const next = { ...step.with };
    if (key === 'criteria' && value === '') delete next.criteria;
    else next[key] = value;
    onChange({ ...step, with: next });
  };
  // The router reads a file in place of `text` when `text_file` is set.
  const fromFile = inputText(step, 'text_file').trim() !== '';
  return (
    <PipelineDetailPanelShell title="Split into paths" onClose={onClose}>
      {fromFile ? (
        <Notice intent="neutral" role="none">
          This split reads what it decides on from a file. Change it in YAML.
        </Notice>
      ) : null}
      {missingInput ? (
        <Notice intent="attention" role="none">
          Choose what to decide on. The split fails when it runs without it.
        </Notice>
      ) : null}
      <FormField
        label="Decide on"
        hint="The text the split reads to choose a path. It can use step outputs, such as ${{ steps.<id>.outputs.<name> }}."
      >
        <TextAreaField
          value={inputText(step, 'text')}
          onChange={(event): void => setInput('text', event.target.value)}
          disabled={readonly || fromFile}
          data-testid="split-panel-text"
        />
      </FormField>
      <FormField
        label="How to choose"
        hint="Optional. What makes each path the right one."
      >
        <TextAreaField
          value={inputText(step, 'criteria')}
          onChange={(event): void => setInput('criteria', event.target.value)}
          disabled={readonly}
          data-testid="split-panel-criteria"
        />
      </FormField>
      <Stack gap="inline">
        <Heading level={4} variant="label">
          Paths
        </Heading>
        {paths.map((path, index) => (
          <PathNameField
            key={path.jobId}
            path={path}
            number={index + 1}
            readonly={readonly}
            canRemove={paths.length > 2}
            onRename={(label) => onRenamePath(path.jobId, label)}
            onRemove={() => onRemovePath(path.jobId)}
          />
        ))}
        {readonly ? null : (
          <span>
            <Button
              variant="secondary"
              size="compact"
              data-testid="split-panel-add-path"
              onClick={onAddPath}
            >
              <PlusIcon size="sm" aria-hidden="true" />
              Add path
            </Button>
          </span>
        )}
      </Stack>
    </PipelineDetailPanelShell>
  );
}
