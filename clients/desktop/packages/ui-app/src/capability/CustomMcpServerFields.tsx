'use client';

import {
  useRef,
  useState,
  type ComponentProps,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { MAX_MCP_EXTRA_HEADERS } from '@canopy/protocol/mcp-servers';
import {
  Button,
  DialogFormField,
  Disclosure,
  FieldError,
  FORM_FIELD_DESCRIPTION_CLASS,
  TextInput,
} from '@canopy/ui-shared/components';
import { TrashIcon } from '@canopy/ui-shared/icons/AppIcons';
import type {
  CustomMcpHeaderRow,
  CustomMcpHeadersCheck,
} from './customMcpServerForm';

interface CustomMcpFieldProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (describedBy: string | undefined) => ReactNode;
}

export function CustomMcpField({
  id,
  label,
  hint,
  error,
  children,
}: CustomMcpFieldProps): JSX.Element {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <DialogFormField label={label} htmlFor={id}>
      <div className="flex w-full min-w-0 flex-col gap-1.5">
        {children(describedBy)}
        {error && errorId && (
          <FieldError id={errorId} data-testid={errorId}>
            {error}
          </FieldError>
        )}
        {hint && (
          <p
            id={hintId}
            className={FORM_FIELD_DESCRIPTION_CLASS}
            data-testid={hintId}
          >
            {hint}
          </p>
        )}
      </div>
    </DialogFormField>
  );
}

function withoutRow(
  errors: Readonly<Record<number, string>>,
  id: number,
): Readonly<Record<number, string>> {
  return Object.fromEntries(
    Object.entries(errors).filter(([key]) => key !== String(id)),
  );
}

export interface CustomMcpHeaderRows {
  readonly rows: readonly CustomMcpHeaderRow[];
  readonly rowErrors: Readonly<Record<number, string>>;
  readonly error: string | null;
  readonly addRef: RefObject<HTMLButtonElement | null>;
  readonly bindNameInput: (
    id: number,
  ) => (element: HTMLInputElement | null) => void;
  readonly add: () => void;
  readonly update: (
    id: number,
    patch: Partial<Pick<CustomMcpHeaderRow, 'name' | 'value'>>,
  ) => void;
  readonly remove: (id: number) => void;
  /** Shows a check's problems on the rows without moving focus. */
  readonly show: (check: CustomMcpHeadersCheck) => void;
  /** Focuses the first row the check faults. True when the check has any problem. */
  readonly focusProblem: (check: CustomMcpHeadersCheck) => boolean;
  /**
   * Places a message on the row naming a header the server refused and
   * focuses it. False when no row names it.
   */
  readonly refuse: (header: string | undefined, message: string) => boolean;
}

export function useCustomMcpHeaderRows(): CustomMcpHeaderRows {
  const addRef = useRef<HTMLButtonElement>(null);
  const nameRefs = useRef(new Map<number, HTMLInputElement>());
  const nextId = useRef(0);
  const [rows, setRows] = useState<readonly CustomMcpHeaderRow[]>([]);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<number, string>>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);

  const focusRow = (id: number): void => nameRefs.current.get(id)?.focus();

  return {
    rows,
    rowErrors,
    error,
    addRef,
    bindNameInput: (id) => (element) => {
      if (element) nameRefs.current.set(id, element);
      else nameRefs.current.delete(id);
    },
    add: () => {
      const id = nextId.current;
      nextId.current += 1;
      setRows((current) => [...current, { id, name: '', value: '' }]);
      setError(null);
      requestAnimationFrame(() => focusRow(id));
    },
    update: (id, patch) => {
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      );
      setRowErrors((current) =>
        current[id] === undefined ? current : withoutRow(current, id),
      );
    },
    remove: (id) => {
      setRows((current) => current.filter((row) => row.id !== id));
      setRowErrors((current) => withoutRow(current, id));
      setError(null);
      nameRefs.current.delete(id);
      addRef.current?.focus();
    },
    show: (check) => {
      setRowErrors(check.rowErrors);
      setError(check.error);
    },
    focusProblem: (check) => {
      const faulted = rows.find((row) => check.rowErrors[row.id] !== undefined);
      if (faulted) focusRow(faulted.id);
      return faulted !== undefined || check.error !== null;
    },
    refuse: (header, message) => {
      const refused = header ? header.toLowerCase() : undefined;
      const row =
        refused === undefined
          ? undefined
          : rows.find(
              (candidate) => candidate.name.trim().toLowerCase() === refused,
            );
      if (!row) return false;
      setRowErrors({ [row.id]: message });
      focusRow(row.id);
      return true;
    },
  };
}

interface CustomMcpHeaderRowsEditorProps {
  headers: CustomMcpHeaderRows;
  testIdPrefix: string;
}

/**
 * The header rows, the Add header button (or the limit once reached), and a
 * problem that belongs to no single row. Test ids are `${testIdPrefix}-header-…`.
 */
export function CustomMcpHeaderRowsEditor({
  headers,
  testIdPrefix,
}: CustomMcpHeaderRowsEditorProps): JSX.Element {
  const { rows, rowErrors, error, addRef, bindNameInput, add, update, remove } =
    headers;
  return (
    <>
      {rows.map((row, index) => {
        const rowError = rowErrors[row.id];
        const errorId = `${testIdPrefix}-header-error-${String(index)}`;
        const label = row.name.trim() || `header ${String(index + 1)}`;
        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <TextInput
                ref={bindNameInput(row.id)}
                mono
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="Name"
                aria-label={`Header ${String(index + 1)} name`}
                value={row.name}
                onChange={(event) =>
                  update(row.id, { name: event.target.value })
                }
                aria-invalid={rowError ? true : undefined}
                aria-describedby={rowError ? errorId : undefined}
                data-testid={`${testIdPrefix}-header-name-${String(index)}`}
                className="min-w-0 flex-1"
              />
              <TextInput
                type="password"
                autoComplete="off"
                placeholder="Value"
                aria-label={`Header ${String(index + 1)} value`}
                value={row.value}
                onChange={(event) =>
                  update(row.id, { value: event.target.value })
                }
                aria-invalid={rowError ? true : undefined}
                aria-describedby={rowError ? errorId : undefined}
                data-testid={`${testIdPrefix}-header-value-${String(index)}`}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="md"
                iconOnly
                aria-label={`Remove ${label}`}
                onClick={() => remove(row.id)}
                data-testid={`${testIdPrefix}-header-remove-${String(index)}`}
              >
                <TrashIcon />
              </Button>
            </div>
            {rowError && (
              <FieldError id={errorId} data-testid={errorId}>
                {rowError}
              </FieldError>
            )}
          </div>
        );
      })}
      {rows.length < MAX_MCP_EXTRA_HEADERS ? (
        <Button
          ref={addRef}
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={add}
          data-testid={`${testIdPrefix}-header-add`}
        >
          Add header
        </Button>
      ) : (
        <p
          className="text-xs fg-secondary"
          data-testid={`${testIdPrefix}-header-limit`}
        >
          You can add up to {String(MAX_MCP_EXTRA_HEADERS)} headers.
        </p>
      )}
      {error && (
        <FieldError
          id={`${testIdPrefix}-headers-error`}
          data-testid={`${testIdPrefix}-headers-error`}
        >
          {error}
        </FieldError>
      )}
    </>
  );
}

/** One of the custom server fields; everything else is the host's to pass. */
export interface CustomMcpTextField {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly error?: string;
  readonly hint?: ReactNode;
  readonly testId?: string;
  readonly inputProps?: Omit<
    ComponentProps<typeof TextInput>,
    'id' | 'value' | 'onChange' | 'aria-invalid' | 'aria-describedby'
  >;
}

function CustomMcpTextInput({
  field,
}: {
  field: CustomMcpTextField;
}): JSX.Element {
  return (
    <CustomMcpField
      id={field.id}
      label={field.label}
      error={field.error}
      hint={field.hint}
    >
      {(describedBy) => (
        <TextInput
          {...field.inputProps}
          id={field.id}
          value={field.value}
          onChange={(event) => field.onChange(event.target.value)}
          aria-invalid={field.error ? true : undefined}
          aria-describedby={describedBy}
          data-testid={field.testId}
        />
      )}
    </CustomMcpField>
  );
}

export interface CustomMcpServerFieldsProps {
  readonly name: CustomMcpTextField;
  /** Omitted while the server has no URL of its own to enter. */
  readonly url?: CustomMcpTextField;
  /** A host's own fields between the two, such as a description. */
  readonly between?: ReactNode;
}

/** The name and URL every custom MCP server form asks for, on either host. */
export function CustomMcpServerFields({
  name,
  url,
  between,
}: CustomMcpServerFieldsProps): JSX.Element {
  return (
    <>
      <CustomMcpTextInput field={name} />
      {between}
      {url && <CustomMcpTextInput field={url} />}
    </>
  );
}

/** Always visible beside Add server, including when Advanced is collapsed. */
export function CustomMcpServerPlacement({
  placement,
  hasHeaders = false,
  hasToken = false,
}: {
  readonly placement: 'account' | 'desktop';
  readonly hasHeaders?: boolean;
  readonly hasToken?: boolean;
}): JSX.Element {
  return (
    <p
      className="text-xs fg-secondary text-pretty"
      data-testid="custom-mcp-placement"
    >
      {placement === 'account'
        ? hasHeaders && hasToken
          ? 'Adds the server URL, headers and access token to your cloud account.'
          : hasHeaders
            ? 'Adds the server URL and headers to your cloud account.'
            : hasToken
              ? 'Adds the server URL and access token to your cloud account.'
              : 'Adds the server URL to your cloud account.'
        : 'Adds the server to this desktop. Its credentials stay here.'}
    </p>
  );
}

export interface CustomMcpAdvancedProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Names the non-default choices inside, so closing never hides them. */
  readonly hint?: string;
  readonly dataTestId: string;
  readonly children: ReactNode;
}

/**
 * The optional settings under a create form's Name and URL. The body stays
 * mounted, so what was typed there survives closing it.
 */
export function CustomMcpAdvanced({
  open,
  onOpenChange,
  hint,
  dataTestId,
  children,
}: CustomMcpAdvancedProps): JSX.Element {
  return (
    <Disclosure
      label="Advanced"
      open={open}
      onOpenChange={onOpenChange}
      hint={hint}
      keepMounted
      dataTestId={dataTestId}
    >
      <div className="flex flex-col gap-5">{children}</div>
    </Disclosure>
  );
}
