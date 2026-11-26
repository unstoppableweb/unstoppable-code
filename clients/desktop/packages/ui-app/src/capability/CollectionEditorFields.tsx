import { useId, type JSX, type ReactNode } from 'react';
import { DESCRIPTION_MARKDOWN_HINT } from '@canopy/ui-shared';
import { FormField, TextInput, TextArea } from '@canopy/ui-shared/components';

export function collectionNameValid(name: string): boolean {
  return name.trim().length > 0;
}

/** Controlled editor unit; hosts supply the member picker and persistence. */
export function CollectionEditorFields({
  name,
  description,
  onNameChange,
  onDescriptionChange,
  disabled = false,
  children,
}: {
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  disabled?: boolean;
  children?: ReactNode;
}): JSX.Element {
  const nameFieldId = useId();
  const descriptionFieldId = useId();
  return (
    <>
      <FormField
        label={
          <>
            Name <span className="fg-destructive">*</span>
          </>
        }
        id={nameFieldId}
      >
        <TextInput
          id={nameFieldId}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="My collection"
          disabled={disabled}
          autoFocus
        />
      </FormField>
      <FormField
        label="Description"
        id={descriptionFieldId}
        description={
          <span data-testid="collection-description-hint">
            {DESCRIPTION_MARKDOWN_HINT}
          </span>
        }
      >
        <TextArea
          id={descriptionFieldId}
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder="Optional description"
          rows={2}
          disabled={disabled}
        />
      </FormField>
      {children}
    </>
  );
}
