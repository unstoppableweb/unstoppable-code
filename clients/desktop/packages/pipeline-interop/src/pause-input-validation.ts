// Pause input requests and answers (`builtin/pause` and `runs.using: host`
// input steps): the one validation the executor applies and every host that
// takes answers checks against before it resumes a run (CAN-6214). Pure and
// browser-safe, so the web core and the desktop renderer share it.
import type { PauseInputType, PipelineScalar } from './document';

export interface PauseInputField {
  key: string;
  label: string;
  type: PauseInputType;
  description?: string;
  required?: boolean;
  default?: PipelineScalar;
  options?: string[];
  min?: number;
  max?: number;
  multiline?: boolean;
}

export interface PauseInputRequest {
  title?: string;
  message?: string;
  fields: PauseInputField[];
}

const FIELD_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export interface PauseInputAnswerError {
  field?: string;
  message: string;
}

function isPauseInputType(value: string): value is PauseInputType {
  return (
    value === 'string' ||
    value === 'boolean' ||
    value === 'number' ||
    value === 'choice'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPipelineScalar(value: unknown): value is PipelineScalar {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function validateDefaultValue(
  field: Pick<PauseInputField, 'type' | 'options'>,
  value: unknown,
): PipelineScalar | undefined {
  if (!isPipelineScalar(value)) {
    return undefined;
  }

  if (field.type === 'boolean') {
    return typeof value === 'boolean' ? value : undefined;
  }

  if (field.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }

  if (field.type === 'choice') {
    const normalized = String(value);
    return field.options?.includes(normalized) ? normalized : undefined;
  }

  if (field.type === 'string') {
    return typeof value === 'string' ? value : undefined;
  }

  return undefined;
}

function validateField(value: unknown): PauseInputField | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const key = value.key;
  const label = value.label;
  const type = value.type;

  if (
    typeof key !== 'string' ||
    key.trim() === '' ||
    !FIELD_KEY_PATTERN.test(key) ||
    typeof label !== 'string' ||
    label.trim() === '' ||
    typeof type !== 'string' ||
    !isPauseInputType(type)
  ) {
    return undefined;
  }

  const field: PauseInputField = {
    key,
    label,
    type,
  };

  if (typeof value.description === 'string') {
    field.description = value.description;
  }
  if (typeof value.required === 'boolean') {
    field.required = value.required;
  }
  if (field.type === 'string' && typeof value.multiline === 'boolean') {
    field.multiline = value.multiline;
  }

  if (field.type === 'choice') {
    if (
      !Array.isArray(value.options) ||
      value.options.length === 0 ||
      !value.options.every((option) => typeof option === 'string')
    ) {
      return undefined;
    }
    field.options = value.options;
  }

  if (field.type === 'number' && value.min !== undefined) {
    if (typeof value.min !== 'number' || !Number.isFinite(value.min)) {
      return undefined;
    }
    field.min = value.min;
  }
  if (field.type === 'number' && value.max !== undefined) {
    if (typeof value.max !== 'number' || !Number.isFinite(value.max)) {
      return undefined;
    }
    field.max = value.max;
  }
  if (
    field.min !== undefined &&
    field.max !== undefined &&
    field.min > field.max
  ) {
    return undefined;
  }

  if (value.default !== undefined) {
    const defaultValue = validateDefaultValue(field, value.default);
    if (defaultValue === undefined) {
      return undefined;
    }
    field.default = defaultValue;
  }

  return field;
}

export function validatePauseInputRequest(
  request: unknown,
): PauseInputRequest | undefined {
  if (!isRecord(request) || !Array.isArray(request.fields)) {
    return undefined;
  }

  const result: PauseInputRequest = { fields: [] };
  const seenKeys = new Set<string>();
  for (const rawField of request.fields) {
    const field = validateField(rawField);
    if (!field || seenKeys.has(field.key)) {
      return undefined;
    }
    seenKeys.add(field.key);
    result.fields.push(field);
  }

  if (typeof request.title === 'string') {
    result.title = request.title;
  }
  if (typeof request.message === 'string') {
    result.message = request.message;
  }

  return result;
}

function valueIsMissing(value: PipelineScalar | undefined): boolean {
  return (
    value === undefined || (typeof value === 'string' && value.trim() === '')
  );
}

export function validatePauseInputAnswerErrors(
  request: PauseInputRequest,
  answers: Record<string, PipelineScalar>,
): PauseInputAnswerError[] {
  const errors: PauseInputAnswerError[] = [];
  const fieldsByKey = new Map(
    request.fields.map((field) => [field.key, field]),
  );

  for (const key of Object.keys(answers)) {
    if (!fieldsByKey.has(key)) {
      errors.push({
        field: key,
        message: `${key} is not an expected field`,
      });
    }
  }

  for (const field of request.fields) {
    const value = answers[field.key];

    if (valueIsMissing(value)) {
      if (field.required) {
        errors.push({ field: field.key, message: `${field.key} is required` });
      }
      continue;
    }

    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        errors.push({
          field: field.key,
          message: `${field.key} must be true or false`,
        });
      }
      continue;
    }

    if (field.type === 'string') {
      if (typeof value !== 'string') {
        errors.push({ field: field.key, message: `${field.key} must be text` });
      }
      continue;
    }

    if (field.type === 'choice') {
      const options = field.options ?? [];
      if (!options.includes(String(value))) {
        errors.push({
          field: field.key,
          message: `${field.key} must be one of: ${options.join(', ')}`,
        });
      }
      continue;
    }

    if (field.type === 'number') {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) {
        errors.push({
          field: field.key,
          message: `${field.key} must be a number`,
        });
      } else if (field.min !== undefined && field.max !== undefined) {
        if (num < field.min || num > field.max) {
          errors.push({
            field: field.key,
            message: `${field.key} must be between ${field.min} and ${field.max}`,
          });
        }
      } else if (field.min !== undefined && num < field.min) {
        errors.push({
          field: field.key,
          message: `${field.key} must be at least ${field.min}`,
        });
      } else if (field.max !== undefined && num > field.max) {
        errors.push({
          field: field.key,
          message: `${field.key} must be at most ${field.max}`,
        });
      }
    }
  }

  return errors;
}

export function validatePauseInputAnswers(
  request: PauseInputRequest,
  answers: Record<string, PipelineScalar>,
): string[] {
  return validatePauseInputAnswerErrors(request, answers).map(
    (error) => error.message,
  );
}
