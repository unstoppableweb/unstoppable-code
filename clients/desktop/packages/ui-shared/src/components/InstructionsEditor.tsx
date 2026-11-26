'use client';

import { useId, type JSX, type ReactNode } from 'react';
import { TextArea } from '../primitives/Field';
import { Heading } from '../primitives/Heading';

export interface InstructionsEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /**
   * Accessible name of the editor. Shown as the editor's heading when
   * `showHeading` is set; otherwise it only names the field.
   */
  readonly label: string;
  /** Render `label` and `description` as a visible header above the field. */
  readonly showHeading?: boolean;
  readonly description?: ReactNode;
  /**
   * Host-composed notices about what Save will change (for example which
   * files a filesystem-backed host writes). Rendered between the header and
   * the field; hosts without such effects pass nothing.
   */
  readonly notices?: ReactNode;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly mono?: boolean;
  readonly spellCheck?: boolean;
  readonly textareaTestId?: string;
}

/**
 * The instructions editor shared by desktop cowork projects and web
 * workspaces: an optional heading, host-supplied notices, and the
 * full-height text field. Transport, persistence, and any file layout stay
 * with the host, which describes their effects through `notices`.
 */
export function InstructionsEditor({
  value,
  onChange,
  label,
  showHeading = false,
  description,
  notices,
  placeholder,
  disabled,
  mono,
  spellCheck,
  textareaTestId,
}: InstructionsEditorProps): JSX.Element {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const hasDescription =
    showHeading && description !== undefined && description !== null;
  const hasNotices = notices !== undefined && notices !== null;
  return (
    // Fills its parent; the host's wrapper sets placement and any minimum.
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {showHeading && (
        <div className="flex flex-col gap-1">
          <Heading level={3} variant="title" id={labelId}>
            {label}
          </Heading>
          {hasDescription && (
            <p id={descriptionId} className="text-xs fg-secondary">
              {description}
            </p>
          )}
        </div>
      )}
      {hasNotices && <div className="flex flex-col gap-2">{notices}</div>}
      <TextArea
        mono={mono}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        spellCheck={spellCheck}
        {...(showHeading
          ? { 'aria-labelledby': labelId }
          : { 'aria-label': label })}
        {...(hasDescription ? { 'aria-describedby': descriptionId } : {})}
        data-testid={textareaTestId}
        className="min-h-0 flex-1"
        placeholder={placeholder}
      />
    </div>
  );
}
