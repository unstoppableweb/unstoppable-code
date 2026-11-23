// ---------------------------------------------------------------------------
// Portable definition documents carried by a shared container's capability
// package (CAN-4655).
//
// A shared worktree or Cowork revision can carry the pipelines, automations,
// Agents and hooks its work used. Each travels as one `*_definition` package
// resource whose single read-only tree entry is the canonical JSON document
// defined here, at {@link SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH}. The
// document's canonical bytes are what the resource digest covers, so the
// canonical form excludes timestamps, run history and every other piece of
// local bookkeeping.
//
// Documents never carry source-machine identifiers. Packaged definitions refer
// to each other by manifest resource id, automations target the fork
// destination through an explicit portable descriptor, and hooks name their
// repository by a portable identity instead of a local repository id.
//
// Validation is strict, like the shared automation and Agent documents it
// reuses: unknown fields are rejected rather than dropped, credential-shaped
// values and absolute machine paths are refused, and every field is capped.
//
// This module must remain pure: no Node, Electron, React, Prisma, or app
// imports. It runs in the renderer, the main process, and the web app.
// ---------------------------------------------------------------------------

import {
  validateSharedAgentDocument,
  type SharedAgentDocument,
} from '../agents';
import {
  isCodexSpeed,
  validateSharedAutomationDocument,
  type CodexSpeed,
  type SharedAutomationDocument,
  type SharedAutomationModelConfig,
} from '../automations';
import {
  findSecretMaterialRule,
  type SecretMaterialRule,
  isPortableCapabilityPathSegment,
  isSafeCapabilityRelativePath,
} from '../capability-files';
import {
  isValidatedConfiguredPromptReferences,
  validateConfiguredPromptReferences,
  type ConfiguredPromptReference,
} from '../configured-prompt-references';
import { isHookTriggerName, type HookTriggerName } from '../hook-triggers';
import { CAPABILITY_PACKAGE_DEFINITION_KINDS } from '../pipelines/package';
import { isShareablePluginRef, type ShareablePluginRef } from '../plugins';
import { isThinkingLevel } from '../thinking';

/** The single read-mode file inside every definition resource tree. */
export const SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH = 'definition.json';

/** Version of the definition document format. Bump only on breaking changes. */
export const SHARED_CONTAINER_DEFINITION_DOCUMENT_VERSION = 1;

/** Cap on one document's canonical UTF-8 bytes; below the package per-file cap. */
export const MAX_SHARED_CONTAINER_DEFINITION_DOCUMENT_BYTES = 2 * 1024 * 1024;
/** Cap on a pipeline definition's portable YAML. */
export const MAX_SHARED_CONTAINER_PIPELINE_YAML_BYTES = 1024 * 1024;
export const MAX_SHARED_CONTAINER_DEFINITION_NAME_LENGTH = 200;
export const MAX_SHARED_CONTAINER_DEFINITION_DESCRIPTION_BYTES = 4 * 1024;
export const MAX_SHARED_CONTAINER_DEFINITION_REFERENCES = 256;
export const MAX_SHARED_CONTAINER_HOOK_ACTIONS = 32;
export const MAX_SHARED_CONTAINER_HOOK_TEXT_BYTES = 64 * 1024;
export const MAX_SHARED_CONTAINER_HOOK_PIPELINE_INPUTS = 64;
export const MAX_SHARED_CONTAINER_HOOK_PLUGINS = 64;
export const MAX_SHARED_CONTAINER_REPOSITORY_URL_LENGTH = 2048;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_MODEL_LENGTH = 200;

export type SharedContainerDefinitionKind =
  (typeof CAPABILITY_PACKAGE_DEFINITION_KINDS)[number];

export function isSharedContainerDefinitionKind(
  value: unknown,
): value is SharedContainerDefinitionKind {
  return CAPABILITY_PACKAGE_DEFINITION_KINDS.some((kind) => kind === value);
}

/**
 * Where a packaged definition came from, when that is not simply the current
 * local definition. A historical snapshot is the definition as it ran in the
 * container; a substituted current definition stands in for a snapshot that
 * could not be recovered, so recipients can tell it may differ from what ran.
 */
export type SharedContainerDefinitionProvenance =
  | { historicalSnapshot: true }
  | { substitutedCurrentDefinition: true };

interface SharedContainerDefinitionDocumentCommon<
  K extends SharedContainerDefinitionKind,
> {
  version: typeof SHARED_CONTAINER_DEFINITION_DOCUMENT_VERSION;
  kind: K;
  /**
   * Manifest resource ids of the other packaged definitions this one needs,
   * sorted and unique. Every id must also appear in the resource's
   * `dependencyResourceIds`; the analyzer refuses a dangling reference.
   */
  references: string[];
  provenance?: SharedContainerDefinitionProvenance;
}

/** A local user or project pipeline, as portable YAML. */
export interface SharedContainerPipelineDefinitionDocument extends SharedContainerDefinitionDocumentCommon<'pipeline_definition'> {
  name: string;
  description?: string;
  /** The pipeline's portable YAML, byte-for-byte as it is shared. */
  yaml: string;
}

/**
 * Portable automation target: install the automation against the destination
 * a fork creates from this container (the fork worktree's project, or the
 * Cowork project). The source container's workspace, worktree, base worktree,
 * chat project and chat never travel.
 */
export interface SharedContainerDefinitionTarget {
  kind: 'source-container';
}

/** Packaged definitions an automation's action runs, by manifest resource id. */
export interface SharedContainerAutomationDefinitionUses {
  /** The `pipeline_definition` a `worktree_pipeline` action runs. */
  pipeline?: string;
  /** The `agent_definition` a prompt action's model routes through. */
  agent?: string;
}

export interface SharedContainerAutomationDefinitionDocument extends SharedContainerDefinitionDocumentCommon<'automation_definition'> {
  /**
   * The validated shared automation document. It never carries its own
   * `capabilityPackage`; the container package carries capabilities. A
   * pipeline the container packages is `{ source: 'unresolved' }` here and
   * named by {@link SharedContainerAutomationDefinitionUses.pipeline}.
   */
  automation: SharedAutomationDocument;
  target: SharedContainerDefinitionTarget;
  uses?: SharedContainerAutomationDefinitionUses;
}

export interface SharedContainerAgentDefinitionDocument extends SharedContainerDefinitionDocumentCommon<'agent_definition'> {
  /** Selections are portable references only; local skills travel as dependencies. */
  agent: SharedAgentDocument;
}

/**
 * Portable identity of one repository in a container's layout. A remote name
 * alone is not unique across a multi-repo workspace, so the identity pairs the
 * credential-free remote URL with the repository's directory name within the
 * layout.
 */
export interface SharedContainerRepositoryIdentity {
  /** Remote URL without credentials, query or fragment; null when none is shareable. */
  remoteUrl: string | null;
  /** The repository's directory name within the multi-repo layout. */
  layoutName: string;
}

export type SharedContainerHookTarget =
  /** A single-repository project's hooks. */
  | { kind: 'project' }
  /** A multi-repo workspace's root hooks. */
  | { kind: 'workspace-root' }
  /** One repository's hooks inside a multi-repo workspace. */
  | { kind: 'workspace-repo'; repository: SharedContainerRepositoryIdentity };

export interface SharedContainerHookCommandShell {
  windows?: 'cmd' | 'powershell' | 'bash';
  mac?: 'zsh' | 'bash';
}

/** A hook chat's model tuning; the model is never a local Agent id. */
export type SharedContainerHookModelConfig = SharedAutomationModelConfig;

export type SharedContainerHookPipelineRef =
  | { source: 'bundled'; id: string }
  | { source: 'curated'; id: string }
  /** Relative YAML path under the target repository's pipeline directory. */
  | { source: 'project'; path: string }
  /** A `pipeline_definition` this package carries, by manifest resource id. */
  | { source: 'packaged'; resourceId: string };

export type SharedContainerHookAction =
  | {
      type: 'command';
      /** The command is the hook's definition content and travels verbatim. */
      command: string;
      shell?: SharedContainerHookCommandShell;
      interactive?: true;
    }
  | {
      type: 'chat';
      prompt: string;
      promptReferences?: ConfiguredPromptReference[];
      planMode?: boolean;
      modelConfig?: SharedContainerHookModelConfig;
      /** The `agent_definition` the chat runs as, by manifest resource id. */
      agent?: string;
      /** Run-condition command; travels as definition content. */
      ifCommand?: string;
      plugins: ShareablePluginRef[];
      allowChatConcurrency?: true;
      autoArchive?: true;
    }
  | {
      type: 'pipeline';
      pipeline: SharedContainerHookPipelineRef;
      inputs?: Record<string, string>;
      modelConfig?: { speed?: CodexSpeed; fastMode?: boolean };
      allowPipelineConcurrency?: true;
    };

export interface SharedContainerHookDefinitionDocument extends SharedContainerDefinitionDocumentCommon<'hook_definition'> {
  triggerName: HookTriggerName;
  target: SharedContainerHookTarget;
  actions: SharedContainerHookAction[];
}

export type SharedContainerDefinitionDocument =
  | SharedContainerPipelineDefinitionDocument
  | SharedContainerAutomationDefinitionDocument
  | SharedContainerAgentDefinitionDocument
  | SharedContainerHookDefinitionDocument;

export type SharedContainerDefinitionValidationResult =
  | { ok: true; value: SharedContainerDefinitionDocument }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

// Every pattern below runs synchronously over untrusted text of up to 1 MiB
// while a recipient validates a package, and a regex cannot be aborted, so
// each must stay linear in the input length. A delimited body never contains
// its own opening delimiter and is capped, so a match attempt stops at the
// next possible start instead of rescanning to the end of the line; unbounded
// runs appear only where nothing before them can start another attempt.

/**
 * Named placeholders: `<password>`, `${{ secrets.TOKEN }}`, `{{ inputs.token }}`,
 * `$(gh auth token)` (with one level of nested `$(…)`), `$TOKEN`, `${TOKEN}`
 * and `process.env.TOKEN` name where a value comes from rather than carry
 * one. A single-brace `{value}` is not a placeholder: `password={hunter2}`
 * carries its value.
 */
const NAMED_PLACEHOLDER_SOURCE = [
  String.raw`<[^<>\r\n]{1,256}>`,
  String.raw`\$\{\{[^{}\r\n]{1,256}\}\}`,
  String.raw`\{\{[^{}\r\n]{1,256}\}\}`,
  String.raw`\$\((?:[^()\r\n]|\$\([^()\r\n]{0,256}\)){0,1024}\)`,
  String.raw`\$[A-Za-z_][A-Za-z0-9_]*`,
  String.raw`\$\{[A-Za-z_][A-Za-z0-9_]*\}`,
  String.raw`(?:process\.)?env\.[A-Za-z_][A-Za-z0-9_]*`,
].join('|');

const NAMED_PLACEHOLDER_VALUE_PATTERN = new RegExp(
  `^\\s*["']?(?:${NAMED_PLACEHOLDER_SOURCE})["']?\\s*$`,
);

const NAMED_PLACEHOLDER_PATTERN = new RegExp(NAMED_PLACEHOLDER_SOURCE, 'g');

/**
 * Placeholder assignments such as `token=$TOKEN`, `NPM_TOKEN=$NPM_TOKEN`,
 * `password: <password>` and `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` are
 * neutralized before the credential scan. The keyword may carry any prefix.
 */
const SECRET_PLACEHOLDER_ASSIGNMENT_PATTERN = new RegExp(
  `(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|token|secret|password|passwd|pwd)["']?\\s*(?:=|:)\\s*["']?(?:${NAMED_PLACEHOLDER_SOURCE})`,
  'gi',
);

/**
 * Neutralizes a placeholder assignment unless the placeholder itself holds
 * secret material: `token: <ghp_…>` or `token: ${{ ghp_… }}` carries a real
 * value in brackets, so it stays and is scanned (CAN-7226). Only the part
 * after the separator is checked, so the keyword never trips a rule itself.
 */
export function neutralizePlaceholderAssignment(assignment: string): string {
  const placeholder = assignment.slice(assignment.search(/[=:]/) + 1);
  return findSecretMaterialRule(placeholder) === null
    ? 'placeholder=example'
    : assignment;
}

/**
 * How a credential check treats what is inside a placeholder. `checked`, for
 * text being written or shared, refuses a real value in placeholder
 * brackets. `ignored` reads every placeholder as a placeholder, as stored
 * definitions were checked when they were written, so one already stored
 * still loads (CAN-7226).
 */
export interface SharedCredentialCheckOptions {
  readonly placeholderContents?: 'checked' | 'ignored';
}

/**
 * Environment-style assignments with any prefix, such as `NPM_TOKEN=npm_x`
 * or `DATABASE_PASSWORD=hunter2`. Comparisons (`==`) and empty quoted values
 * are not assignments of a credential. The search is unanchored, so the
 * keyword alone already matches with any prefix; a leading identifier run
 * would only rescan long words from every position.
 */
const SECRET_ENV_ASSIGNMENT_PATTERN =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[ \t]*=(?!=)[ \t]*["']?[^\s"']/i;

/**
 * URL user-info carrying a password, such as `postgres://admin:pw@db`. A
 * match starts at `://` after a scheme character rather than at the scheme,
 * so dotted and hyphenated runs are never rescanned from each word start.
 * User and password runs exclude `/`, so an attempt ends before the next `://`.
 */
const URL_USER_INFO_PATTERN =
  /(?<=[A-Za-z0-9+.-]):\/\/[^\s/?#@:]*:([^\s/?#@]+)@(?!sha\d+:)/g;

/** Basic-auth flags such as `curl -u admin:pw` or `--user=admin:pw`. */
const USER_FLAG_PATTERN =
  /(?:^|[\s"'`])(?:-u|--user)(?:[ \t]+|=)["']?([^\s"':]+):([^\s"']+)/g;

/** Record keys whose value is a credential, with any prefix (`NPM_TOKEN`). */
const SECRET_KEY_NAME_PATTERN =
  /(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)$/i;

/** Stands in for a named placeholder when checking user-info passwords. */
const PLACEHOLDER_MARKER = '\u0001';

function isPlaceholderMarker(value: string): boolean {
  return value.length > 0 && value.split(PLACEHOLDER_MARKER).join('') === '';
}

function containsUserInfoCredential(
  text: string,
  checkContents: boolean,
): boolean {
  const marked = text.replace(NAMED_PLACEHOLDER_PATTERN, (placeholder) =>
    !checkContents || findSecretMaterialRule(placeholder) === null
      ? PLACEHOLDER_MARKER
      : placeholder,
  );
  for (const match of Array.from(marked.matchAll(URL_USER_INFO_PATTERN))) {
    const password = match[1];
    if (password !== undefined && !isPlaceholderMarker(password)) return true;
  }
  for (const match of Array.from(marked.matchAll(USER_FLAG_PATTERN))) {
    const user = match[1];
    const password = match[2];
    if (user === undefined || password === undefined) continue;
    if (isPlaceholderMarker(password)) continue;
    // `docker run -u 1000:1000` names a uid and gid, not a password.
    if (/^\d+$/.test(user) && /^\d+$/.test(password)) continue;
    return true;
  }
  return false;
}

/**
 * Absolute paths that identify one machine or account: home folders, macOS
 * temporary folders, Windows profile folders, UNC shares and file URLs.
 */
const MACHINE_PATH_PATTERN =
  /(?:^|[\s"'`=:(\[{,;|>])(?:\/Users\/[^\s/"'`]+|\/home\/[^\s/"'`]+|\/root\/|\/(?:private\/)?var\/folders\/|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\\\\[^\s\\]+\\[^\s\\]+)|file:\/\//i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isResourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    RESOURCE_ID_PATTERN.test(value) &&
    isPortableCapabilityPathSegment(value, { maxLength: MAX_IDENTIFIER_LENGTH })
  );
}

/** Which credential check a shared text tripped. */
export type SharedTextCredentialRule =
  | SecretMaterialRule
  | 'env_assignment'
  | 'url_credentials';

/**
 * The first credential check a shared text trips once named placeholders
 * are neutralized, or null. Names the rule only, never the matched text.
 * Placeholder contents are checked unless the caller reads stored text.
 */
export function findSharedTextCredentialRule(
  text: string,
  options: SharedCredentialCheckOptions = {},
): SharedTextCredentialRule | null {
  const checkContents = options.placeholderContents !== 'ignored';
  const neutralized = text.replace(
    SECRET_PLACEHOLDER_ASSIGNMENT_PATTERN,
    (assignment) =>
      checkContents
        ? neutralizePlaceholderAssignment(assignment)
        : 'placeholder=example',
  );
  const material = findSecretMaterialRule(neutralized);
  if (material !== null) return material;
  if (SECRET_ENV_ASSIGNMENT_PATTERN.test(neutralized)) return 'env_assignment';
  if (containsUserInfoCredential(text, checkContents)) return 'url_credentials';
  return null;
}

/** Whether text carries a credential once named placeholders are neutralized. */
export function sharedContainerDefinitionTextContainsCredential(
  text: string,
  options: SharedCredentialCheckOptions = {},
): boolean {
  return findSharedTextCredentialRule(text, options) !== null;
}

/** Whether a record value under a secret-named key carries a credential. */
function isSecretKeyedValue(key: string, value: string): boolean {
  return (
    SECRET_KEY_NAME_PATTERN.test(key) &&
    value.trim().length > 0 &&
    !NAMED_PLACEHOLDER_VALUE_PATTERN.test(value)
  );
}

/** Whether text names an absolute path that only exists on one machine. */
export function sharedContainerDefinitionTextContainsMachinePath(
  text: string,
): boolean {
  return MACHINE_PATH_PATTERN.test(text);
}

function scanStrings(
  value: unknown,
  path: string,
  errors: string[],
  seen: { credential: boolean; machinePath: boolean },
  options: SharedCredentialCheckOptions,
  credentialFindings: string[] = errors,
): void {
  if (typeof value === 'string') {
    const rule = seen.credential
      ? null
      : findSharedTextCredentialRule(value, options);
    if (rule !== null) {
      seen.credential = true;
      credentialFindings.push(credentialError(path, rule));
    }
    if (
      !seen.machinePath &&
      sharedContainerDefinitionTextContainsMachinePath(value)
    ) {
      seen.machinePath = true;
      errors.push(`${path} contains an absolute machine path`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanStrings(
        item,
        `${path}[${index}]`,
        errors,
        seen,
        options,
        credentialFindings,
      ),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const keyPath = `${path}.${credentialPathSegment(key)}`;
      if (
        !seen.credential &&
        typeof item === 'string' &&
        isSecretKeyedValue(key, item)
      ) {
        seen.credential = true;
        credentialFindings.push(credentialError(keyPath));
      }
      scanStrings(item, keyPath, errors, seen, options, credentialFindings);
    }
  }
}

const CREDENTIAL_ERROR_INFIX = ' may contain a credential. ';

/** What to do about a credential in a field, in a plain sentence. */
export const CREDENTIAL_PLACEHOLDER_NEXT_STEP =
  'Replace it with a placeholder such as ${{ secrets.NAME }}.';

/**
 * What to do about a credential in an authorization header. A placeholder
 * there is still refused (CAN-7314), so the advice is to drop the value.
 */
export const CREDENTIAL_HEADER_NEXT_STEP =
  'Remove the header line, or say which header to send without writing its value.';

/** The next step a credential refusal gives, by the rule that matched. */
export function credentialNextStep(
  rule: SharedTextCredentialRule | null,
): string {
  return rule === 'auth_header'
    ? CREDENTIAL_HEADER_NEXT_STEP
    : CREDENTIAL_PLACEHOLDER_NEXT_STEP;
}

/**
 * An object key as it may appear in a reported field path. A key that itself
 * looks like a secret is never echoed: it reads as [redacted key] (CAN-7226).
 */
export function credentialPathSegment(key: string): string {
  return findSecretMaterialRule(key) === null ? key : '[redacted key]';
}

/** A credential finding names the field and asks for a placeholder, never the value. */
function credentialError(
  path: string,
  rule: SharedTextCredentialRule | null = null,
): string {
  return `${path}${CREDENTIAL_ERROR_INFIX}${credentialNextStep(rule)}`;
}

function parseCredentialError(
  error: string,
): { field: string; nextStep: string } | null {
  for (const nextStep of [
    CREDENTIAL_PLACEHOLDER_NEXT_STEP,
    CREDENTIAL_HEADER_NEXT_STEP,
  ]) {
    const suffix = `${CREDENTIAL_ERROR_INFIX}${nextStep}`;
    if (error.endsWith(suffix))
      return { field: error.slice(0, -suffix.length), nextStep };
  }
  return null;
}

/** The next step a definition credential error gives, or null. */
export function sharedContainerCredentialErrorNextStep(
  error: string,
): string | null {
  return parseCredentialError(error)?.nextStep ?? null;
}

/**
 * The field a definition validation error says may hold a credential, or
 * null when the error is about something else, such as a malformed or
 * machine-specific document (CAN-7226).
 */
export function sharedContainerCredentialErrorField(
  error: string,
): string | null {
  return parseCredentialError(error)?.field ?? null;
}

function validateReferences(
  value: unknown,
  errors: string[],
): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push('references must be an array');
    return undefined;
  }
  if (value.length > MAX_SHARED_CONTAINER_DEFINITION_REFERENCES) {
    errors.push('references exceed the limit');
    return undefined;
  }
  const items: unknown[] = value;
  const references: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isResourceId(item)) {
      errors.push(`references[${index}] is not a resource id`);
      continue;
    }
    if (references.includes(item)) {
      errors.push(`references[${index}] is duplicated`);
      continue;
    }
    references.push(item);
  }
  return references.sort(compareStrings);
}

function validateProvenance(
  value: unknown,
  errors: string[],
): SharedContainerDefinitionProvenance | undefined {
  if (value === undefined) return undefined;
  if (isRecord(value) && Object.keys(value).length === 1) {
    if (value.historicalSnapshot === true) return { historicalSnapshot: true };
    if (value.substitutedCurrentDefinition === true)
      return { substitutedCurrentDefinition: true };
  }
  errors.push(
    'provenance must be { historicalSnapshot: true } or { substitutedCurrentDefinition: true }',
  );
  return undefined;
}

function validateName(
  value: unknown,
  label: string,
  errors: string[],
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${label} is required`);
    return undefined;
  }
  if (value.length > MAX_SHARED_CONTAINER_DEFINITION_NAME_LENGTH) {
    errors.push(
      `${label} exceeds ${MAX_SHARED_CONTAINER_DEFINITION_NAME_LENGTH} characters`,
    );
    return undefined;
  }
  return value;
}

function requireReferenced(
  id: string,
  references: readonly string[] | undefined,
  label: string,
  errors: string[],
): void {
  if (references && !references.includes(id))
    errors.push(`${label} must also be listed in references`);
}

function validateBoundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  errors: string[],
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.trim().length === 0)
  ) {
    errors.push(`${label} must be a non-empty string`);
    return undefined;
  }
  if (utf8ByteLength(value) > maxBytes) {
    errors.push(`${label} exceeds ${maxBytes} bytes`);
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Kind validators
// ---------------------------------------------------------------------------

const COMMON_KEYS = ['version', 'kind', 'references', 'provenance'] as const;

function validatePipelineDocument(
  doc: Record<string, unknown>,
  references: string[] | undefined,
  provenance: SharedContainerDefinitionProvenance | undefined,
  errors: string[],
): SharedContainerPipelineDefinitionDocument | undefined {
  const extra = unknownKeys(doc, [
    ...COMMON_KEYS,
    'name',
    'description',
    'yaml',
  ]);
  if (extra.length > 0)
    errors.push(`Pipeline definition has unknown fields: ${extra.join(', ')}`);
  const name = validateName(doc.name, 'name', errors);
  let description: string | undefined;
  if (doc.description !== undefined) {
    description = validateBoundedText(
      doc.description,
      'description',
      MAX_SHARED_CONTAINER_DEFINITION_DESCRIPTION_BYTES,
      errors,
      { allowEmpty: true },
    );
  }
  const yaml = validateBoundedText(
    doc.yaml,
    'yaml',
    MAX_SHARED_CONTAINER_PIPELINE_YAML_BYTES,
    errors,
  );
  if (
    name === undefined ||
    yaml === undefined ||
    references === undefined ||
    (doc.description !== undefined && description === undefined)
  )
    return undefined;
  return {
    version: SHARED_CONTAINER_DEFINITION_DOCUMENT_VERSION,
    kind: 'pipeline_definition',
    references,
    ...(provenance ? { provenance } : {}),
    name,
    ...(description !== undefined ? { description } : {}),
    yaml,
  };
}

function automationHasRepositoryFileReference(
  automation: SharedAutomationDocument,
): boolean {
  const action = automation.action;
  if (action.type === 'worktree_pipeline') return false;
  return (action.promptReferences ?? []).some(
    (reference) => reference.kind === 'file' && reference.root.kind === 'repo',
  );
}

function validateAutomationDocument(
  doc: Record<string, unknown>,
  references: string[] | undefined,
  provenance: SharedContainerDefinitionProvenance | undefined,
  errors: string[],
): SharedContainerAutomationDefinitionDocument | undefined {
  const extra = unknownKeys(doc, [
    ...COMMON_KEYS,
    'automation',
    'target',
    'uses',
  ]);
  if (extra.length > 0)
    errors.push(
      `Automation definition has unknown fields: ${extra.join(', ')}`,
    );
  const validated = validateSharedAutomationDocument(doc.automation);
  if (!validated.ok) {
    errors.push(`automation: ${validated.error}`);
  }
  const automation = validated.ok ? validated.document : undefined;
  if (
    !isRecord(doc.target) ||
    doc.target.kind !== 'source-container' ||
    unknownKeys(doc.target, ['kind']).length > 0
  ) {
    errors.push("target must be { kind: 'source-container' }");
  }
  let uses: SharedContainerAutomationDefinitionUses | undefined;
  if (doc.uses !== undefined) {
    if (
      !isRecord(doc.uses) ||
      unknownKeys(doc.uses, ['pipeline', 'agent']).length > 0
    ) {
      errors.push('uses may only name a pipeline and an agent');
    } else {
      uses = {};
      if (doc.uses.pipeline !== undefined) {
        if (isResourceId(doc.uses.pipeline)) uses.pipeline = doc.uses.pipeline;
        else errors.push('uses.pipeline is not a resource id');
      }
      if (doc.uses.agent !== undefined) {
        if (isResourceId(doc.uses.agent)) uses.agent = doc.uses.agent;
        else errors.push('uses.agent is not a resource id');
      }
      if (Object.keys(uses).length === 0) {
        errors.push('uses must name a pipeline or an agent');
      }
    }
  }
  if (automation) {
    if (automation.capabilityPackage !== undefined)
      errors.push(
        'automation must not carry its own capability package; the container package carries capabilities',
      );
    const action = automation.action;
    if (action.type === 'app_advisor_prompt')
      errors.push('App Advisor automations do not target a shared container');
    if (action.type === 'worktree_pipeline') {
      if (action.pipeline.source === 'inline')
        errors.push(
          'An inline pipeline must travel as its own pipeline definition',
        );
      if (action.pipeline.source === 'unresolved' && !uses?.pipeline)
        errors.push(
          'A container pipeline automation must name its packaged pipeline in uses.pipeline',
        );
      if (uses?.pipeline && action.pipeline.source !== 'unresolved')
        errors.push('uses.pipeline requires an unresolved pipeline reference');
      if (uses?.agent)
        errors.push('uses.agent applies only to prompt automations');
    } else if (uses?.pipeline) {
      errors.push('uses.pipeline applies only to pipeline automations');
    }
    if (automationHasRepositoryFileReference(automation))
      errors.push(
        'Repository file references name a local repository and cannot travel',
      );
  }
  if (uses?.pipeline)
    requireReferenced(uses.pipeline, references, 'uses.pipeline', errors);
  if (uses?.agent)
    requireReferenced(uses.agent, references, 'uses.agent', errors);
  if (!automation || references === undefined) return undefined;
  return {
    version: SHARED_CONTAINER_DEFINITION_DOCUMENT_VERSION,
    kind: 'automation_definition',
    references,
    ...(provenance ? { provenance } : {}),
    automation,
    target: { kind: 'source-container' },
    ...(uses ? { uses } : {}),
  };
}

function validateAgentDocument(
  doc: Record<string, unknown>,
  references: string[] | undefined,
  provenance: SharedContainerDefinitionProvenance | undefined,
  errors: string[],
): SharedContainerAgentDefinitionDocument | undefined {
  const extra = unknownKeys(doc, [...COMMON_KEYS, 'agent']);
  if (extra.length > 0)
    errors.push(`Agent definition has unknown fields: ${extra.join(', ')}`);
  if (isRecord(doc.agent)) {
    const agentExtra = unknownKeys(doc.agent, [
      'version',
      'id',
      'name',
      'baseModel',
      'instructions',
      'plugins',
    ]);
    if (agentExtra.length > 0)
      errors.push(`agent has unknown fields: ${agentExtra.join(', ')}`);
  }
  const validated = validateSharedAgentDocument(doc.agent);
  if (!validated.ok) {
    errors.push(`agent: ${validated.error}`);
    return undefined;
  }
  if (references === undefined) return undefined;
  return {
    version: SHARED_CONTAINER_DEFINITION_DOCUMENT_VERSION,
    kind: 'agent_definition',
    references,
    ...(provenance ? { provenance } : {}),
    agent: validated.document,
  };
}

function isSanitizedRemoteUrl(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_SHARED_CONTAINER_REPOSITORY_URL_LENGTH
  )
    return false;
  if (/\s/.test(value)) return false;
  if (/^git@[^:/\s]+:[^?#\s]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' ||
        url.protocol === 'http:' ||
        url.protocol === 'ssh:' ||
        url.protocol === 'git:') &&
      url.hostname.length > 0 &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function validateHookTarget(
  value: unknown,
  errors: string[],
): SharedContainerHookTarget | undefined {
  if (!isRecord(value)) {
    errors.push('target must be an object');
    return undefined;
  }
  if (value.kind === 'project' || value.kind === 'workspace-root') {
    if (unknownKeys(value, ['kind']).length > 0) {
      errors.push('target has unknown fields');
      return undefined;
    }
    return { kind: value.kind };
  }
  if (value.kind !== 'workspace-repo') {
    errors.push('target.kind is invalid');
    return undefined;
  }
  if (unknownKeys(value, ['kind', 'repository']).length > 0) {
    errors.push('target has unknown fields');
    return undefined;
  }
  const repository = value.repository;
  if (
    !isRecord(repository) ||
    unknownKeys(repository, ['remoteUrl', 'layoutName']).length > 0
  ) {
    errors.push('target.repository must name a remote URL and a layout name');
    return undefined;
  }
  const remoteUrl = repository.remoteUrl;
  if (
    remoteUrl !== null &&
    (typeof remoteUrl !== 'string' || !isSanitizedRemoteUrl(remoteUrl))
  ) {
    errors.push(
      'target.repository.remoteUrl must be a credential-free remote URL or null',
    );
    return undefined;
  }
  if (
    !isPortableCapabilityPathSegment(repository.layoutName, { maxLength: 255 })
  ) {
    errors.push(
      'target.repository.layoutName must be one portable path segment',
    );
    return undefined;
  }
  return {
    kind: 'workspace-repo',
    repository: { remoteUrl, layoutName: repository.layoutName },
  };
}

function validateModelConfig(
  value: unknown,
  label: string,
  errors: string[],
): SharedContainerHookModelConfig | undefined {
  if (
    !isRecord(value) ||
    unknownKeys(value, ['model', 'thinkingLevel', 'speed', 'fastMode']).length >
      0
  ) {
    errors.push(`${label} is invalid`);
    return undefined;
  }
  const config: SharedContainerHookModelConfig = {};
  if (value.model !== undefined) {
    if (
      typeof value.model !== 'string' ||
      value.model.trim().length === 0 ||
      value.model.length > MAX_MODEL_LENGTH ||
      value.model.startsWith('agent_model_')
    ) {
      errors.push(`${label}.model must be a provider model id`);
      return undefined;
    }
    config.model = value.model;
  }
  if (value.thinkingLevel !== undefined) {
    if (!isThinkingLevel(value.thinkingLevel)) {
      errors.push(`${label}.thinkingLevel is invalid`);
      return undefined;
    }
    config.thinkingLevel = value.thinkingLevel;
  }
  if (value.speed !== undefined) {
    if (!isCodexSpeed(value.speed)) {
      errors.push(`${label}.speed is invalid`);
      return undefined;
    }
    config.speed = value.speed;
  }
  if (value.fastMode !== undefined) {
    if (typeof value.fastMode !== 'boolean') {
      errors.push(`${label}.fastMode is invalid`);
      return undefined;
    }
    config.fastMode = value.fastMode;
  }
  return config;
}

function validateHookPipelineRef(
  value: unknown,
  label: string,
  errors: string[],
): SharedContainerHookPipelineRef | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  if (value.source === 'bundled' || value.source === 'curated') {
    if (
      unknownKeys(value, ['source', 'id']).length > 0 ||
      typeof value.id !== 'string' ||
      value.id.trim().length === 0 ||
      value.id.length > MAX_IDENTIFIER_LENGTH
    ) {
      errors.push(`${label} must name a ${value.source} pipeline id`);
      return undefined;
    }
    return { source: value.source, id: value.id };
  }
  if (value.source === 'project') {
    if (
      unknownKeys(value, ['source', 'path']).length > 0 ||
      !isSafeCapabilityRelativePath(value.path, {
        maxPathLength: 1_024,
        maxSegmentLength: 255,
      })
    ) {
      errors.push(`${label}.path must be a safe repository-relative path`);
      return undefined;
    }
    return { source: 'project', path: value.path };
  }
  if (value.source === 'packaged') {
    if (
      unknownKeys(value, ['source', 'resourceId']).length > 0 ||
      !isResourceId(value.resourceId)
    ) {
      errors.push(`${label}.resourceId is not a resource id`);
      return undefined;
    }
    return { source: 'packaged', resourceId: value.resourceId };
  }
  errors.push(`${label}.source is invalid`);
  return undefined;
}

function validateHookAction(
  value: unknown,
  label: string,
  references: readonly string[] | undefined,
  errors: string[],
): SharedContainerHookAction | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  if (value.type === 'command') {
    const extra = unknownKeys(value, [
      'type',
      'command',
      'shell',
      'interactive',
    ]);
    if (extra.length > 0) {
      errors.push(`${label} has unknown fields: ${extra.join(', ')}`);
      return undefined;
    }
    const command = validateBoundedText(
      value.command,
      `${label}.command`,
      MAX_SHARED_CONTAINER_HOOK_TEXT_BYTES,
      errors,
    );
    let shell: SharedContainerHookCommandShell | undefined;
    if (value.shell !== undefined) {
      const raw = value.shell;
      if (
        !isRecord(raw) ||
        unknownKeys(raw, ['windows', 'mac']).length > 0 ||
        (raw.windows !== undefined &&
          raw.windows !== 'cmd' &&
          raw.windows !== 'powershell' &&
          raw.windows !== 'bash') ||
        (raw.mac !== undefined && raw.mac !== 'zsh' && raw.mac !== 'bash') ||
        (raw.windows === undefined && raw.mac === undefined)
      ) {
        errors.push(`${label}.shell is invalid`);
        return undefined;
      }
      shell = {};
      if (
        raw.windows === 'cmd' ||
        raw.windows === 'powershell' ||
        raw.windows === 'bash'
      )
        shell.windows = raw.windows;
      if (raw.mac === 'zsh' || raw.mac === 'bash') shell.mac = raw.mac;
    }
    if (value.interactive !== undefined && value.interactive !== true) {
      errors.push(`${label}.interactive must be true when present`);
      return undefined;
    }
    if (command === undefined) return undefined;
    return {
      type: 'command',
      command,
      ...(shell ? { shell } : {}),
      ...(value.interactive === true ? { interactive: true } : {}),
    };
  }
  if (value.type === 'chat') {
    const extra = unknownKeys(value, [
      'type',
      'prompt',
      'promptReferences',
      'planMode',
      'modelConfig',
      'agent',
      'ifCommand',
      'plugins',
      'allowChatConcurrency',
      'autoArchive',
    ]);
    if (extra.length > 0) {
      errors.push(`${label} has unknown fields: ${extra.join(', ')}`);
      return undefined;
    }
    const prompt = validateBoundedText(
      value.prompt,
      `${label}.prompt`,
      MAX_SHARED_CONTAINER_HOOK_TEXT_BYTES,
      errors,
    );
    if (prompt === undefined) return undefined;
    let promptReferences: ConfiguredPromptReference[] | undefined;
    if (value.promptReferences !== undefined) {
      if (
        !isValidatedConfiguredPromptReferences(prompt, value.promptReferences, {
          portableOnly: true,
        })
      ) {
        errors.push(
          `${label}.promptReferences: ${
            validateConfiguredPromptReferences(prompt, value.promptReferences, {
              portableOnly: true,
            }) ?? 'invalid'
          }`,
        );
        return undefined;
      }
      if (
        value.promptReferences.some(
          (reference) =>
            reference.kind === 'file' && reference.root.kind === 'repo',
        )
      ) {
        errors.push(
          `${label}.promptReferences name a local repository and cannot travel`,
        );
        return undefined;
      }
      promptReferences = value.promptReferences;
    }
    if (value.planMode !== undefined && typeof value.planMode !== 'boolean') {
      errors.push(`${label}.planMode must be a boolean`);
      return undefined;
    }
    const modelConfig =
      value.modelConfig === undefined
        ? undefined
        : validateModelConfig(
            value.modelConfig,
            `${label}.modelConfig`,
            errors,
          );
    if (value.modelConfig !== undefined && modelConfig === undefined)
      return undefined;
    let agent: string | undefined;
    if (value.agent !== undefined) {
      if (!isResourceId(value.agent)) {
        errors.push(`${label}.agent is not a resource id`);
        return undefined;
      }
      agent = value.agent;
      if (modelConfig?.model !== undefined) {
        errors.push(`${label} cannot name both a model and an agent`);
        return undefined;
      }
      requireReferenced(agent, references, `${label}.agent`, errors);
    }
    let ifCommand: string | undefined;
    if (value.ifCommand !== undefined) {
      ifCommand = validateBoundedText(
        value.ifCommand,
        `${label}.ifCommand`,
        MAX_SHARED_CONTAINER_HOOK_TEXT_BYTES,
        errors,
      );
      if (ifCommand === undefined) return undefined;
    }
    if (
      !Array.isArray(value.plugins) ||
      value.plugins.length > MAX_SHARED_CONTAINER_HOOK_PLUGINS
    ) {
      errors.push(`${label}.plugins must be a bounded array`);
      return undefined;
    }
    const plugins: ShareablePluginRef[] = [];
    for (const plugin of value.plugins) {
      if (!isShareablePluginRef(plugin)) {
        errors.push(`${label}.plugins must all be shareable plugin refs`);
        return undefined;
      }
      plugins.push(plugin);
    }
    for (const flag of ['allowChatConcurrency', 'autoArchive'] as const) {
      if (value[flag] !== undefined && value[flag] !== true) {
        errors.push(`${label}.${flag} must be true when present`);
        return undefined;
      }
    }
    return {
      type: 'chat',
      prompt,
      ...(promptReferences ? { promptReferences } : {}),
      ...(typeof value.planMode === 'boolean'
        ? { planMode: value.planMode }
        : {}),
      ...(modelConfig ? { modelConfig } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(ifCommand !== undefined ? { ifCommand } : {}),
      plugins,
      ...(value.allowChatConcurrency === true
        ? { allowChatConcurrency: true }
        : {}),
      ...(value.autoArchive === true ? { autoArchive: true } : {}),
    };
  }
  if (value.type === 'pipeline') {
    const extra = unknownKeys(value, [
      'type',
      'pipeline',
      'inputs',
      'modelConfig',
      'allowPipelineConcurrency',
    ]);
    if (extra.length > 0) {
      errors.push(`${label} has unknown fields: ${extra.join(', ')}`);
      return undefined;
    }
    const pipeline = validateHookPipelineRef(
      value.pipeline,
      `${label}.pipeline`,
      errors,
    );
    if (!pipeline) return undefined;
    if (pipeline.source === 'packaged')
      requireReferenced(
        pipeline.resourceId,
        references,
        `${label}.pipeline.resourceId`,
        errors,
      );
    let inputs: Record<string, string> | undefined;
    if (value.inputs !== undefined) {
      if (
        !isRecord(value.inputs) ||
        Object.keys(value.inputs).length >
          MAX_SHARED_CONTAINER_HOOK_PIPELINE_INPUTS
      ) {
        errors.push(`${label}.inputs must be a bounded object`);
        return undefined;
      }
      inputs = {};
      for (const [key, input] of Object.entries(value.inputs)) {
        if (
          key.length === 0 ||
          key.length > MAX_IDENTIFIER_LENGTH ||
          typeof input !== 'string' ||
          utf8ByteLength(input) > MAX_SHARED_CONTAINER_HOOK_TEXT_BYTES
        ) {
          errors.push(`${label}.inputs.${key} is invalid`);
          return undefined;
        }
        inputs[key] = input;
      }
    }
    let modelConfig: { speed?: CodexSpeed; fastMode?: boolean } | undefined;
    if (value.modelConfig !== undefined) {
      const raw = value.modelConfig;
      if (
        !isRecord(raw) ||
        unknownKeys(raw, ['speed', 'fastMode']).length > 0 ||
        (raw.speed !== undefined && !isCodexSpeed(raw.speed)) ||
        (raw.fastMode !== undefined && typeof raw.fastMode !== 'boolean')
      ) {
        errors.push(`${label}.modelConfig is invalid`);
        return undefined;
      }
      modelConfig = {};
      if (isCodexSpeed(raw.speed)) modelConfig.speed = raw.speed;
      if (typeof raw.fastMode === 'boolean')
        modelConfig.fastMode = raw.fastMode;
    }
    if (
      value.allowPipelineConcurrency !== undefined &&
      value.allowPipelineConcurrency !== true
    ) {
      errors.push(
        `${label}.allowPipelineConcurrency must be true when present`,
      );
      return undefined;
    }
    return {
      type: 'pipeline',
      pipeline,
      ...(inputs ? { inputs } : {}),
      ...(modelConfig ? { modelConfig } : {}),
      ...(value.allowPipelineConcurrency === true
        ? { allowPipelineConcurrency: true }
        : {}),
    };
  }
  errors.push(`${label}.type is invalid`);
  return undefined;
}

function validateHookDocument(
  doc: Record<string, unknown>,
  references: string[] | undefined,
  provenance: SharedContainerDefinitionProvenance | undefined,
  errors: string[],
): SharedContainerHookDefinitionDocument | undefined {
  const extra = unknownKeys(doc, [
    ...COMMON_KEYS,
    'triggerName',
    'target',
    'actions',
  ]);
  if (extra.length > 0)
    errors.push(`Hook definition has unknown fields: ${extra.join(', ')}`);
  const triggerName =
    typeof doc.triggerName === 'string' && isHookTriggerName(doc.triggerName)
      ? doc.triggerName
      : undefined;
  if (!triggerName) errors.push('triggerName is not a supported hook trigger');
  const target = validateHookTarget(doc.target, errors);
  if (
    !Array.isArray(doc.actions) ||
    doc.actions.length === 0 ||
    doc.actions.length > MAX_SHARED_CONTAINER_HOOK_ACTIONS
  ) {
    errors.push(
      `actions must list 1 to ${MAX_SHARED_CONTAINER_HOOK_ACTIONS} hook actions`,
    );
    return undefined;
  }
  const actions: SharedContainerHookAction[] = [];
  doc.actions.forEach((action, index) => {
    const validated = validateHookAction(
      action,
      `actions[${index}]`,
      references,
      errors,
    );
    if (validated) actions.push(validated);
  });
  if (
    !triggerName ||
    !target ||
    references === undefined ||
    actions.length !== doc.actions.length
  )
    return undefined;
  return {
    version: SHARED_CONTAINER_DEFINITION_DOCUMENT_VERSION,
    kind: 'hook_definition',
    references,
    ...(provenance ? { provenance } : {}),
    triggerName,
    target,
    actions,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) {
      const item = value[key];
      if (item !== undefined) sorted[key] = stableValue(item);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/**
 * Validate an untrusted value as a {@link SharedContainerDefinitionDocument}.
 * The returned document is rebuilt field by field: unknown fields anywhere are
 * rejected, `references` come back sorted, and the embedded automation and
 * Agent documents pass their own protocol validators.
 */
export function validateSharedContainerDefinitionDocument(
  value: unknown,
  options: SharedCredentialCheckOptions = { placeholderContents: 'ignored' },
  /** Where credential findings go instead of `errors`; see the parse below. */
  credentialFindings?: string[],
): SharedContainerDefinitionValidationResult {
  if (!isRecord(value))
    return { ok: false, errors: ['Definition document must be an object'] };
  const errors: string[] = [];
  if (value.version !== SHARED_CONTAINER_DEFINITION_DOCUMENT_VERSION)
    errors.push(
      `Unsupported definition document version; expected ${SHARED_CONTAINER_DEFINITION_DOCUMENT_VERSION}`,
    );
  if (!isSharedContainerDefinitionKind(value.kind))
    return {
      ok: false,
      errors: [...errors, 'Definition document kind is invalid'],
    };
  const references = validateReferences(value.references, errors);
  const provenance = validateProvenance(value.provenance, errors);
  let document: SharedContainerDefinitionDocument | undefined;
  switch (value.kind) {
    case 'pipeline_definition':
      document = validatePipelineDocument(
        value,
        references,
        provenance,
        errors,
      );
      break;
    case 'automation_definition':
      document = validateAutomationDocument(
        value,
        references,
        provenance,
        errors,
      );
      break;
    case 'agent_definition':
      document = validateAgentDocument(value, references, provenance, errors);
      break;
    case 'hook_definition':
      document = validateHookDocument(value, references, provenance, errors);
      break;
  }
  if (document) {
    scanStrings(
      document,
      value.kind,
      errors,
      { credential: false, machinePath: false },
      options,
      credentialFindings,
    );
    if (
      utf8ByteLength(stableStringify(document)) >
      MAX_SHARED_CONTAINER_DEFINITION_DOCUMENT_BYTES
    )
      errors.push(
        `Definition document exceeds ${MAX_SHARED_CONTAINER_DEFINITION_DOCUMENT_BYTES} bytes`,
      );
  }
  if (errors.length > 0 || !document) {
    return {
      ok: false,
      errors: errors.length > 0 ? errors : ['Definition document is invalid'],
    };
  }
  return { ok: true, value: document };
}

/**
 * Deterministic JSON for a definition document: validated, rebuilt, with
 * object keys sorted at every depth and absent optional fields omitted. These
 * are the bytes stored at {@link SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH}
 * and hashed into the resource digest. Array order is preserved where it is
 * meaningful (hook actions, plugin lists); `references` are sorted.
 *
 * Throws when the document is invalid, so invalid content can never acquire
 * canonical bytes.
 */
export function canonicalizeSharedContainerDefinitionDocument(
  document: SharedContainerDefinitionDocument,
): string {
  const validated = validateSharedContainerDefinitionDocument(document);
  if (!validated.ok)
    throw new Error(
      `Invalid shared container definition document: ${validated.errors.join('; ')}`,
    );
  return stableStringify(validated.value);
}

/** The canonical UTF-8 bytes of a definition document. */
export function encodeSharedContainerDefinitionDocument(
  document: SharedContainerDefinitionDocument,
): Uint8Array {
  return new TextEncoder().encode(
    canonicalizeSharedContainerDefinitionDocument(document),
  );
}

/**
 * Parse and validate stored definition bytes. The bytes must be strict UTF-8
 * JSON and already canonical, so a document cannot carry two encodings of the
 * same content under different digests.
 */
export function parseSharedContainerDefinitionDocument(
  bytes: Uint8Array,
  options: SharedCredentialCheckOptions = { placeholderContents: 'ignored' },
): SharedContainerDefinitionValidationResult {
  return parseDefinitionDocument(bytes, options, undefined);
}

/**
 * Parse stored definition bytes with every check
 * parseSharedContainerDefinitionDocument applies, canonical form included,
 * except that credential findings are returned apart instead of failing the
 * document. Installing a package uses it to leave one definition out while
 * every other fault still refuses the package (CAN-7585).
 */
export function parseSharedContainerDefinitionDocumentApartFromCredentials(
  bytes: Uint8Array,
  options: SharedCredentialCheckOptions = { placeholderContents: 'ignored' },
): {
  result: SharedContainerDefinitionValidationResult;
  credentialFindings: string[];
} {
  const credentialFindings: string[] = [];
  const result = parseDefinitionDocument(bytes, options, credentialFindings);
  return { result, credentialFindings };
}

function parseDefinitionDocument(
  bytes: Uint8Array,
  options: SharedCredentialCheckOptions,
  credentialFindings: string[] | undefined,
): SharedContainerDefinitionValidationResult {
  if (bytes.byteLength > MAX_SHARED_CONTAINER_DEFINITION_DOCUMENT_BYTES)
    return {
      ok: false,
      errors: [
        `Definition document exceeds ${MAX_SHARED_CONTAINER_DEFINITION_DOCUMENT_BYTES} bytes`,
      ],
    };
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['Definition document is not UTF-8 JSON'] };
  }
  const validated = validateSharedContainerDefinitionDocument(
    parsed,
    options,
    credentialFindings,
  );
  if (!validated.ok) return validated;
  if (stableStringify(validated.value) !== text)
    return { ok: false, errors: ['Definition document is not canonical'] };
  return validated;
}
