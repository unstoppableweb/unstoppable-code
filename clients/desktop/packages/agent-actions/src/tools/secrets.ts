import { z } from 'zod';
import {
  AGENT_SECRET_NAME_PATTERN,
  AGENT_SECRET_VALUE_MAX_LENGTH,
} from '@canopy/protocol/agent-secrets';
import { isSafePortableRelativePath } from '@canopy/protocol/safe-relative-path';
import type { AgentJsonSchema } from './definition';

/*
 * RequestSecrets, RunWithSecrets and WriteSecretsFile: the agent secret
 * request tools, defined once for every host. An agent asks the person for
 * named secrets, then uses them by name; values never appear in a tool
 * argument or result. Desktop and the cloud (Agentic Core) take these
 * schemas, results and fixed texts unchanged, so the model sees the same
 * contract everywhere. No surface offers the tools yet: hosts wire them
 * behind the `canopy-shared-agent-secret-requests` flag.
 */

/** Canonical injected-tool keys of the secret tools. */
export const AGENT_SECRET_TOOL_KEYS = [
  'request_secrets',
  'run_with_secrets',
  'write_secrets_file',
] as const;
export type AgentSecretToolKey = (typeof AGENT_SECRET_TOOL_KEYS)[number];

export const AGENT_SECRET_TOOL_DISPLAY_NAMES = {
  request_secrets: 'RequestSecrets',
  run_with_secrets: 'RunWithSecrets',
  write_secrets_file: 'WriteSecretsFile',
} as const satisfies Record<AgentSecretToolKey, string>;

export { AGENT_SECRET_NAME_PATTERN, AGENT_SECRET_VALUE_MAX_LENGTH };

// Limits. -------------------------------------------------------------------

export const REQUEST_SECRETS_REASON_MAX_LENGTH = 300;
export const REQUEST_SECRETS_MAX_ITEMS = 10;
export const REQUEST_SECRETS_LABEL_MAX_LENGTH = 80;
export const REQUEST_SECRETS_DESCRIPTION_MAX_LENGTH = 200;
export const REQUEST_SECRETS_HINT_PREFIX_MAX_LENGTH = 32;
export const REQUEST_SECRETS_HINT_MIN_LENGTH_MAX = 4096;
export const REQUEST_SECRET_KINDS = ['password', 'token', 'multiline'] as const;
export type RequestSecretKind = (typeof REQUEST_SECRET_KINDS)[number];

export const RUN_WITH_SECRETS_COMMAND_MAX_LENGTH = 16_384;
export const RUN_WITH_SECRETS_MAX_ENV = 32;
export const RUN_WITH_SECRETS_MIN_TIMEOUT_MS = 1_000;
export const RUN_WITH_SECRETS_MAX_TIMEOUT_MS = 600_000;
export const RUN_WITH_SECRETS_DEFAULT_TIMEOUT_MS = 120_000;

export const WRITE_SECRETS_FILE_MAX_ENTRIES = 64;
export const WRITE_SECRETS_FILE_KEY_MAX_LENGTH = 256;
export const WRITE_SECRETS_FILE_FORMATS = ['dotenv', 'json', 'raw'] as const;
export type WriteSecretsFileFormat =
  (typeof WRITE_SECRETS_FILE_FORMATS)[number];
export const WRITE_SECRETS_FILE_MODES = ['merge', 'replace'] as const;
export type WriteSecretsFileMode = (typeof WRITE_SECRETS_FILE_MODES)[number];

/** The longest relative path `cwd` and `path` accept. */
export const AGENT_SECRET_PATH_MAX_LENGTH = 4096;

/**
 * A dotenv key: a variable name a dotenv parser reads back as written, so a
 * key can never carry `=`, a quote or a line break into the file.
 */
export const DOTENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * A path inside the worktree or sandbox: relative, `/`-separated, with no
 * empty, `.` or `..` segment. Matches {@link isSafePortableRelativePath}.
 */
const RELATIVE_PATH_PATTERN_SOURCE =
  '^(?![A-Za-z]:)(?!/)(?![\\s\\S]*\\\\)(?![\\s\\S]*//)(?![\\s\\S]*/$)(?!(?:[\\s\\S]*/)?\\.{1,2}(?:/|$))[^\\u0000]+$';

// Texts the model sees. ------------------------------------------------------

/** Every RequestSecrets result carries this usage text. */
export const REQUEST_SECRETS_USAGE_TEXT =
  'Values are hidden from you. Use RunWithSecrets or WriteSecretsFile with these names. Never ask the person to paste a secret into chat.';

/** Added to the usage text of declined, expired and cancelled results. */
export const REQUEST_SECRETS_DECLINED_TEXT =
  'Continue without these secrets or stop. Do not ask for them in chat.';

/** Every WriteSecretsFile result carries this warning. */
export const WRITE_SECRETS_FILE_WARNING =
  "This file holds the values in plain text. Your shell commands, and any program that reads the file or a copy of it, see them; only the app's own views hide them. Prefer RunWithSecrets when a command can take the secrets from its environment, and remove the file when it is no longer needed.";

export const REQUEST_SECRETS_DESCRIPTION =
  'Ask the person for one or more secrets, such as passwords, API keys, tokens or connection strings. The person fills a masked form; you get back only the names that are now available, never the values. Name each secret like an environment variable (for example DATABASE_URL) and explain in reason why you need it. Then use the secrets by name with RunWithSecrets or WriteSecretsFile. Never ask the person to paste a secret into chat.';

export const RUN_WITH_SECRETS_DESCRIPTION =
  'Run a shell command with secrets from RequestSecrets set as environment variables. env maps each variable the command reads to a secret name, for example { "PGURL": "DATABASE_URL" }; stdin optionally names a secret to pipe to the command\'s input. Values never appear in the command, its record or its result: stdout and stderr come back with every held secret replaced by [secret:NAME], and redactions counts the replacements. If a named secret is not held, the command is not run and missing lists it.';

export const WRITE_SECRETS_FILE_DESCRIPTION =
  'Write secrets from RequestSecrets into a file inside the worktree, for tools that read configuration from a file. entries maps each key in the file to a secret name. format dotenv writes KEY=value lines, json writes an object, and raw writes the one secret as the whole file. mode merge keeps other keys already in a dotenv or json file; replace overwrites it. The file is written with owner-only permissions; a git-tracked path is refused, and an untracked path not already ignored is added to .git/info/exclude. The values are in the file in plain text, so your shell commands can read them: prefer RunWithSecrets.';

// Input schemas. -------------------------------------------------------------

const secretNameSchema = z.string().regex(AGENT_SECRET_NAME_PATTERN, {
  message:
    'Secret names are 1-64 upper-case letters, digits and underscores, not starting with a digit.',
});

function isSafeRelativePath(value: string): boolean {
  return !value.includes('\0') && isSafePortableRelativePath(value);
}

const relativePathSchema = z
  .string()
  .min(1)
  .max(AGENT_SECRET_PATH_MAX_LENGTH)
  .refine(isSafeRelativePath, {
    message:
      'Use a relative path inside the worktree, separated by /, with no empty, . or .. segments.',
  });

const requestedSecretSchema = z
  .object({
    name: secretNameSchema,
    label: z.string().min(1).max(REQUEST_SECRETS_LABEL_MAX_LENGTH).optional(),
    description: z
      .string()
      .min(1)
      .max(REQUEST_SECRETS_DESCRIPTION_MAX_LENGTH)
      .optional(),
    kind: z.enum(REQUEST_SECRET_KINDS).optional(),
    required: z.boolean().optional(),
    hint: z
      .object({
        prefix: z
          .string()
          .min(1)
          .max(REQUEST_SECRETS_HINT_PREFIX_MAX_LENGTH)
          .optional(),
        minLength: z
          .number()
          .int()
          .min(1)
          .max(REQUEST_SECRETS_HINT_MIN_LENGTH_MAX)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const requestSecretsInputSchema = z
  .object({
    reason: z.string().min(1).max(REQUEST_SECRETS_REASON_MAX_LENGTH),
    secrets: z
      .array(requestedSecretSchema)
      .min(1)
      .max(REQUEST_SECRETS_MAX_ITEMS)
      .refine(
        (secrets) =>
          new Set(secrets.map((secret) => secret.name)).size === secrets.length,
        { message: 'Each secret name may appear only once.' },
      ),
  })
  .strict();

const envMapSchema = z.record(secretNameSchema, secretNameSchema).refine(
  (env) => {
    const size = Object.keys(env).length;
    return size >= 1 && size <= RUN_WITH_SECRETS_MAX_ENV;
  },
  {
    message: `env maps 1 to ${RUN_WITH_SECRETS_MAX_ENV} variables to secret names.`,
  },
);

export const runWithSecretsInputSchema = z
  .object({
    command: z.string().min(1).max(RUN_WITH_SECRETS_COMMAND_MAX_LENGTH),
    env: envMapSchema,
    stdin: secretNameSchema.optional(),
    cwd: z.union([z.literal('.'), relativePathSchema]).optional(),
    timeoutMs: z
      .number()
      .int()
      .min(RUN_WITH_SECRETS_MIN_TIMEOUT_MS)
      .max(RUN_WITH_SECRETS_MAX_TIMEOUT_MS)
      .optional(),
  })
  .strict();

export const writeSecretsFileInputSchema = z
  .object({
    path: relativePathSchema,
    format: z.enum(WRITE_SECRETS_FILE_FORMATS),
    entries: z
      .record(
        z.string().min(1).max(WRITE_SECRETS_FILE_KEY_MAX_LENGTH),
        secretNameSchema,
      )
      .refine(
        (entries) => {
          const size = Object.keys(entries).length;
          return size >= 1 && size <= WRITE_SECRETS_FILE_MAX_ENTRIES;
        },
        {
          message: `entries maps 1 to ${WRITE_SECRETS_FILE_MAX_ENTRIES} keys to secret names.`,
        },
      ),
    mode: z.enum(WRITE_SECRETS_FILE_MODES).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const keys = Object.keys(input.entries);
    if (input.format === 'raw') {
      if (keys.length !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['entries'],
          message: 'raw writes exactly one secret, so entries has one key.',
        });
      }
      if (input.mode === 'merge') {
        context.addIssue({
          code: 'custom',
          path: ['mode'],
          message: 'raw files cannot be merged; omit mode or use replace.',
        });
      }
    }
    if (input.format === 'dotenv') {
      for (const key of keys) {
        if (!DOTENV_KEY_PATTERN.test(key)) {
          context.addIssue({
            code: 'custom',
            path: ['entries', key],
            message:
              'dotenv keys are letters, digits, underscores and dots, not starting with a digit or dot.',
          });
        }
      }
    }
  });

export type RequestSecretsInput = z.infer<typeof requestSecretsInputSchema>;
export type RunWithSecretsInput = z.infer<typeof runWithSecretsInputSchema>;
export type WriteSecretsFileInput = z.infer<typeof writeSecretsFileInputSchema>;

// JSON schemas hosts advertise. ------------------------------------------------

const SECRET_NAME_JSON: AgentJsonSchema = {
  type: 'string',
  pattern: AGENT_SECRET_NAME_PATTERN.source,
};

const RELATIVE_PATH_JSON: AgentJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: AGENT_SECRET_PATH_MAX_LENGTH,
  pattern: RELATIVE_PATH_PATTERN_SOURCE,
};

export const REQUEST_SECRETS_JSON_SCHEMA: AgentJsonSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: REQUEST_SECRETS_REASON_MAX_LENGTH,
      description: 'Why you need these secrets. Shown to the person.',
    },
    secrets: {
      type: 'array',
      minItems: 1,
      maxItems: REQUEST_SECRETS_MAX_ITEMS,
      description: 'The secrets to ask for; each name once.',
      items: {
        type: 'object',
        properties: {
          name: {
            ...SECRET_NAME_JSON,
            description:
              'Environment-variable-shaped name, for example STRIPE_SECRET_KEY. Also the handle you use afterwards.',
          },
          label: {
            type: 'string',
            minLength: 1,
            maxLength: REQUEST_SECRETS_LABEL_MAX_LENGTH,
            description: 'Short human label, for example "Stripe secret key".',
          },
          description: {
            type: 'string',
            minLength: 1,
            maxLength: REQUEST_SECRETS_DESCRIPTION_MAX_LENGTH,
            description: 'Where to find the value or what it is for.',
          },
          kind: {
            type: 'string',
            enum: [...REQUEST_SECRET_KINDS],
            description:
              'password, token (the default) or multiline for PEM keys and JSON credentials.',
          },
          required: {
            type: 'boolean',
            description:
              'Whether the person must provide it. Defaults to true; an optional secret can be skipped.',
          },
          hint: {
            type: 'object',
            description: 'Checks the form applies before submitting.',
            properties: {
              prefix: {
                type: 'string',
                minLength: 1,
                maxLength: REQUEST_SECRETS_HINT_PREFIX_MAX_LENGTH,
                description:
                  'Expected start of the value, for example sk_live_.',
              },
              minLength: {
                type: 'integer',
                minimum: 1,
                maximum: REQUEST_SECRETS_HINT_MIN_LENGTH_MAX,
                description: 'Shortest acceptable value.',
              },
            },
            additionalProperties: false,
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  required: ['reason', 'secrets'],
  additionalProperties: false,
};

export const RUN_WITH_SECRETS_JSON_SCHEMA: AgentJsonSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      minLength: 1,
      maxLength: RUN_WITH_SECRETS_COMMAND_MAX_LENGTH,
      description:
        "Shell command to run in the chat's worktree. Refer to secrets through the environment variables in env, never by value.",
    },
    env: {
      type: 'object',
      minProperties: 1,
      maxProperties: RUN_WITH_SECRETS_MAX_ENV,
      propertyNames: SECRET_NAME_JSON,
      additionalProperties: SECRET_NAME_JSON,
      description:
        'Environment variable the command reads -> secret name, for example { "PGURL": "DATABASE_URL" }.',
    },
    stdin: {
      ...SECRET_NAME_JSON,
      description:
        "A secret name to write to the command's standard input, then close it. For password prompts.",
    },
    cwd: {
      ...RELATIVE_PATH_JSON,
      pattern: `^\\.$|${RELATIVE_PATH_PATTERN_SOURCE}`,
      description:
        'Working directory relative to the worktree root. Defaults to the root.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: RUN_WITH_SECRETS_MIN_TIMEOUT_MS,
      maximum: RUN_WITH_SECRETS_MAX_TIMEOUT_MS,
      description: `Milliseconds before the command is stopped. Defaults to ${RUN_WITH_SECRETS_DEFAULT_TIMEOUT_MS}.`,
    },
  },
  required: ['command', 'env'],
  additionalProperties: false,
};

export const WRITE_SECRETS_FILE_JSON_SCHEMA: AgentJsonSchema = {
  type: 'object',
  properties: {
    path: {
      ...RELATIVE_PATH_JSON,
      description:
        'File path relative to the worktree root, for example .env.local.',
    },
    format: {
      type: 'string',
      enum: [...WRITE_SECRETS_FILE_FORMATS],
      description:
        'dotenv (KEY=value lines), json (an object) or raw (one secret as the whole file).',
    },
    entries: {
      type: 'object',
      minProperties: 1,
      maxProperties: WRITE_SECRETS_FILE_MAX_ENTRIES,
      propertyNames: {
        type: 'string',
        minLength: 1,
        maxLength: WRITE_SECRETS_FILE_KEY_MAX_LENGTH,
      },
      additionalProperties: SECRET_NAME_JSON,
      description:
        'Key in the file -> secret name. raw takes exactly one entry. dotenv keys are letters, digits, underscores and dots.',
    },
    mode: {
      type: 'string',
      enum: [...WRITE_SECRETS_FILE_MODES],
      description:
        'merge (the default) keeps other keys in an existing dotenv or json file; replace overwrites the file.',
    },
  },
  required: ['path', 'format', 'entries'],
  additionalProperties: false,
};

// Results. -------------------------------------------------------------------

export const REQUEST_SECRETS_STATUSES = [
  'provided',
  'partial',
  'declined',
  'expired',
  'cancelled',
] as const;
export type RequestSecretsStatus = (typeof REQUEST_SECRETS_STATUSES)[number];

export const REQUESTED_SECRET_STATES = [
  'provided',
  'skipped',
  'unavailable',
] as const;
export type RequestedSecretState = (typeof REQUESTED_SECRET_STATES)[number];

/** Where a provided value came from; `chat` means the chat already held it. */
export const AGENT_SECRET_SOURCES = ['entered', 'saved', 'chat'] as const;
export type AgentSecretSource = (typeof AGENT_SECRET_SOURCES)[number];

export const AGENT_SECRET_SCOPES = ['chat', 'project'] as const;
export type AgentSecretScope = (typeof AGENT_SECRET_SCOPES)[number];

/**
 * The RequestSecrets result, all the model ever sees of a request. Never
 * carries a value, prefix, length, hash or fingerprint.
 */
export interface RequestSecretsResult {
  status: RequestSecretsStatus;
  secrets: Array<{
    name: string;
    state: RequestedSecretState;
    source?: AgentSecretSource;
    scope?: AgentSecretScope;
  }>;
  usage: string;
}

export interface RunWithSecretsResult {
  /** Null when the command timed out or was killed. */
  exitCode: number | null;
  signal?: string;
  timedOut?: boolean;
  /** Redacted, and truncated as the host's shell tool truncates. */
  stdout: string;
  /** Redacted. */
  stderr: string;
  redactions: number;
  /** Names the chat does not hold. When present, the command was not run. */
  missing?: string[];
}

export interface WriteSecretsFileResult {
  path: string;
  /** The keys written. */
  written: string[];
  /** True when the path was added to .git/info/exclude. */
  gitExcluded: boolean;
  warning: string;
}

/** The usage text for a RequestSecrets result with `status`. */
export function requestSecretsUsageText(status: RequestSecretsStatus): string {
  return status === 'declined' || status === 'expired' || status === 'cancelled'
    ? `${REQUEST_SECRETS_USAGE_TEXT} ${REQUEST_SECRETS_DECLINED_TEXT}`
    : REQUEST_SECRETS_USAGE_TEXT;
}
