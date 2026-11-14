'use client';

import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  LedgerFileRef,
  LedgerPublicEntryType,
  LedgerStatus,
} from '@canopy/protocol/canopy-core';
import { countLedgerCodePoints } from '../../lib/ledger-display';
import { Button } from '../Button';
import { TextArea, TextInput } from '../Field';
import { FormField } from '../FormField';
import { Notice } from '../Notice';
import { LedgerEntryTypePicker } from './LedgerEntryTypePicker';
import { LedgerStatusControl } from './LedgerStatusControl';
import { Heading } from '../Heading';

/** The Ledger's limits, in code points and items. */
export const LEDGER_FORM_LIMITS = {
  title: 100,
  content: 1_000,
  highlight: 100,
  highlights: 5,
  referenceFiles: 25,
} as const;

/** The fields a person writes; the owner is chosen through `ownerControl`. */
export interface LedgerEntryFormValue {
  readonly type: LedgerPublicEntryType;
  readonly title: string;
  readonly content: string;
  readonly highlights: readonly string[];
  readonly referenceFiles: readonly LedgerFileRef[];
  readonly status: LedgerStatus;
}

export interface LedgerEntryFormProps {
  value: LedgerEntryFormValue;
  /** The entry a correction corrects; null for a new entry. */
  correctionOf: { readonly title: string } | null;
  saving: boolean;
  /** Why the last save did not apply, first in the form. */
  problem: string | null;
  /**
   * Where the entry goes, before every field: the Feed's project, task and
   * owner. Omitted where the form belongs to one scope already.
   */
  targetControl?: ReactNode;
  /**
   * The owner picker, after the content. Its trigger takes the ID
   * `${labelId}-picker`, which the form's "Owner" label activates, and
   * `aria-labelledby={labelId}`. Omitted when `targetControl` chooses the
   * owner.
   */
  ownerControl?: (labelId: string) => ReactNode;
  /** Why the entry can't be saved yet, such as no task chosen; Save waits. */
  saveBlockedReason?: string | null;
  /** Focuses Content when the form mounts; defaults to true. */
  autoFocusContent?: boolean;
  /** Finds files to reference; omitted where the host has no file search. */
  fileSearch?: ReactNode;
  /**
   * Whether entries here can reference files at all; false leaves out the
   * Files section. Defaults to true.
   */
  referencesFiles?: boolean;
  onChange: (patch: Partial<LedgerEntryFormValue>) => void;
  onSave: () => void;
  onDiscard: () => void;
}

function Counter({
  value,
  limit,
  id,
}: {
  value: string;
  limit: number;
  id: string;
}): JSX.Element {
  const count = countLedgerCodePoints(value);
  return (
    <span
      id={id}
      aria-live="polite"
      className={`text-2xs tabular-nums ${count > limit ? 'fg-destructive' : 'fg-tertiary'}`}
    >
      {`${count}/${limit}`}
    </span>
  );
}

function fileLabel(file: LedgerFileRef): string {
  return file.startLine === undefined
    ? file.path
    : `${file.path}:${file.startLine}`;
}

function withLine(file: LedgerFileRef, text: string): LedgerFileRef {
  const line = Number.parseInt(text, 10);
  return Number.isSafeInteger(line) && line >= 1
    ? { ...file, startLine: line }
    : { rootId: file.rootId, path: file.path };
}

/**
 * Writes a new entry or a correction. Every field keeps its label; title,
 * highlights, and files are optional. The title and content show their length
 * against the Ledger's limits. The person is the author, so there is no author
 * field; the owner starts as "You".
 */
export function LedgerEntryForm({
  value,
  correctionOf,
  saving,
  problem,
  targetControl,
  ownerControl,
  saveBlockedReason = null,
  autoFocusContent = true,
  fileSearch,
  referencesFiles = true,
  onChange,
  onSave,
  onDiscard,
}: LedgerEntryFormProps): JSX.Element {
  const id = useId();
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const shouldFocusContentOnMount = useRef(autoFocusContent);
  useEffect(() => {
    if (shouldFocusContentOnMount.current) contentRef.current?.focus();
  }, []);

  const titleCount = countLedgerCodePoints(value.title);
  const contentCount = countLedgerCodePoints(value.content);
  const complete = value.content.trim().length > 0;
  const withinLimits =
    titleCount <= LEDGER_FORM_LIMITS.title &&
    contentCount <= LEDGER_FORM_LIMITS.content &&
    value.highlights.every(
      (highlight) =>
        countLedgerCodePoints(highlight) <= LEDGER_FORM_LIMITS.highlight,
    );
  const canSave =
    complete && withinLimits && !saving && saveBlockedReason === null;
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (canSave) onSave();
  };
  return (
    <form
      data-testid="ledger-entry-form"
      aria-labelledby={`${id}-heading`}
      onSubmit={onSubmit}
      className="flex min-w-0 flex-col gap-4"
    >
      <header className="flex flex-col gap-1">
        <Heading level={2} variant="title" id={`${id}-heading`}>
          {correctionOf === null ? 'New entry' : 'Correction'}
        </Heading>
        <p
          className="text-2xs fg-tertiary"
          data-testid="ledger-entry-form-author"
        >
          {correctionOf === null
            ? 'Added by you'
            : `Added by you. Corrects "${correctionOf.title}", which stays as it is.`}
        </p>
      </header>
      {problem !== null && (
        <Notice
          errorSource="ledger-entry-form-problem"
          intent="destructive"
          data-testid="ledger-entry-form-problem"
        >
          {problem}
        </Notice>
      )}
      {targetControl}
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <FormField
            id={`${id}-type`}
            label={<span id={`${id}-type-label`}>Type</span>}
          >
            {(control) => (
              <LedgerEntryTypePicker
                id={control.id}
                labelId={`${id}-type-label`}
                value={value.type}
                disabled={saving}
                onChange={(type) => onChange({ type })}
              />
            )}
          </FormField>
        </div>
        <div className="min-w-0">
          <FormField
            id={`${id}-status`}
            label={<span id={`${id}-status-label`}>Status</span>}
          >
            {(control) => (
              <LedgerStatusControl
                variant="field"
                id={control.id}
                labelId={`${id}-status-label`}
                status={value.status}
                saving={saving}
                onChange={(status) => onChange({ status })}
                data-testid="ledger-entry-form-status"
              />
            )}
          </FormField>
        </div>
      </div>
      <FormField
        id={`${id}-title`}
        label={
          <>
            Title <span className="fg-tertiary">(optional)</span>
          </>
        }
        description={
          <span className="flex justify-end">
            <Counter
              id={`${id}-title-count`}
              value={value.title}
              limit={LEDGER_FORM_LIMITS.title}
            />
          </span>
        }
      >
        {(control) => (
          <TextInput
            {...control}
            value={value.title}
            disabled={saving}
            data-testid="ledger-entry-form-title"
            onChange={(event) => onChange({ title: event.target.value })}
          />
        )}
      </FormField>
      <FormField
        id={`${id}-content`}
        label="Content"
        description={
          <span className="flex justify-end">
            <Counter
              id={`${id}-content-count`}
              value={value.content}
              limit={LEDGER_FORM_LIMITS.content}
            />
          </span>
        }
      >
        {(control) => (
          <TextArea
            {...control}
            ref={contentRef}
            value={value.content}
            disabled={saving}
            rows={5}
            data-testid="ledger-entry-form-content"
            onChange={(event) => onChange({ content: event.target.value })}
          />
        )}
      </FormField>
      {ownerControl !== undefined && (
        <FormField
          id={`${id}-owner-picker`}
          label={<span id={`${id}-owner`}>Owner</span>}
        >
          {() => ownerControl(`${id}-owner`)}
        </FormField>
      )}
      <fieldset className="flex flex-col gap-1.5" disabled={saving}>
        <legend className="mb-1 text-xs fg-secondary">
          Highlights <span className="fg-tertiary">(optional)</span>
        </legend>
        {value.highlights.map((highlight, index) => (
          <div key={index} className="flex items-center gap-2">
            <TextInput
              aria-label={`Highlight ${index + 1}`}
              value={highlight}
              data-testid="ledger-entry-form-highlight"
              onChange={(event) =>
                onChange({
                  highlights: value.highlights.map((existing, position) =>
                    position === index ? event.target.value : existing,
                  ),
                })
              }
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove highlight ${index + 1}`}
              onClick={() =>
                onChange({
                  highlights: value.highlights.filter(
                    (_existing, position) => position !== index,
                  ),
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
        {value.highlights.length < LEDGER_FORM_LIMITS.highlights && (
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="ledger-entry-form-add-highlight"
              onClick={() =>
                onChange({ highlights: [...value.highlights, ''] })
              }
            >
              Add highlight
            </Button>
          </div>
        )}
      </fieldset>
      {referencesFiles && (
        <fieldset className="flex flex-col gap-1.5" disabled={saving}>
          <legend className="mb-1 text-xs fg-secondary">
            Files <span className="fg-tertiary">(optional)</span>
          </legend>
          {value.referenceFiles.map((file, index) => (
            <div
              key={`${file.rootId}:${file.path}`}
              data-testid="ledger-entry-form-file"
              className="flex min-w-0 items-center gap-2"
            >
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs fg-primary"
                title={fileLabel(file)}
              >
                {file.path}
              </span>
              <TextInput
                aria-label={`Line in ${file.path} (optional)`}
                inputMode="numeric"
                placeholder="Line"
                value={
                  file.startLine === undefined ? '' : String(file.startLine)
                }
                onChange={(event) =>
                  onChange({
                    referenceFiles: value.referenceFiles.map(
                      (existing, position) =>
                        position === index
                          ? withLine(existing, event.target.value)
                          : existing,
                    ),
                  })
                }
                className="w-16"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${file.path}`}
                onClick={() =>
                  onChange({
                    referenceFiles: value.referenceFiles.filter(
                      (_existing, position) => position !== index,
                    ),
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          {value.referenceFiles.length < LEDGER_FORM_LIMITS.referenceFiles &&
            fileSearch}
        </fieldset>
      )}
      <div className="flex items-center justify-end gap-2">
        {saveBlockedReason !== null && (
          <p
            id={`${id}-save-blocked`}
            data-testid="ledger-entry-form-save-blocked"
            className="mr-auto text-2xs fg-tertiary"
          >
            {saveBlockedReason}
          </p>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          data-testid="ledger-entry-form-discard"
          onClick={onDiscard}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!canSave}
          aria-describedby={
            saveBlockedReason === null ? undefined : `${id}-save-blocked`
          }
          data-testid="ledger-entry-form-save"
        >
          {saving ? 'Saving…' : 'Save entry'}
        </Button>
      </div>
    </form>
  );
}
