import {
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_VAULT_QUERY_DEFINITIONS,
  CORE_VAULT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_MIGRATION_INSTRUCTION_DEFINITIONS,
  CORE_W5_RECOVERY_INSTRUCTIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_STREAM_DEFINITIONS,
  WORKER_SCRIPT_STREAM_DEFINITIONS,
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_QUERY_DEFINITIONS,
  WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_STREAM_DEFINITIONS,
  type CanopyInstructionDefinitionMap,
  type CanopyOperationPlacement,
  type CanopyQueryDefinitionMap,
  type CanopyStreamDefinitionMap,
  type CoreRuntimeManifestOperation,
} from '@canopy/protocol/canopy-core';
import type { CanopyRuntimeProfile } from '../runtime/types';
import {
  RUNTIME_PROFILE_ACCESS_MODES,
  RUNTIME_PROFILE_AUTHORITY_ONLY,
  RUNTIME_PROFILE_DOMAINS,
} from './runtime-profile-policy.generated';

export const RUNTIME_PRINCIPALS = [
  'interface',
  'owning-core',
  'delegating-primary',
  'migration-launcher',
] as const;
export type RuntimePrincipal = (typeof RUNTIME_PRINCIPALS)[number];
export type RuntimeOperationKind = 'query' | 'instruction' | 'stream';

const CATALOG = {
  query: {
    ...CANOPY_QUERY_DEFINITIONS,
    ...CORE_TRANSPORT_QUERY_DEFINITIONS,
    // Admission only: the daemon explicitly installs these, never Electron.
    ...CORE_VAULT_QUERY_DEFINITIONS,
    ...CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
    ...WORKER_TERMINAL_QUERY_DEFINITIONS,
  },
  instruction: {
    ...CANOPY_INSTRUCTION_DEFINITIONS,
    ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    ...CORE_MIGRATION_INSTRUCTION_DEFINITIONS,
    ...CORE_W5_RECOVERY_INSTRUCTIONS,
    ...CORE_VAULT_INSTRUCTION_DEFINITIONS,
    ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
    // The W5 metadata commands the qualification daemon composes (W7a-3);
    // their own registries, not re-listed.
    'core.workspace.update':
      CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS['core.workspace.update'],
    ...CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS,
    // The terminal operations the daemon's terminal module composes
    // (CAN-5088); the web core serves the first set too (CAN-4160).
    ...WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
    ...WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
  },
  stream: {
    ...CANOPY_STREAM_DEFINITIONS,
    ...CORE_TRANSPORT_STREAM_DEFINITIONS,
    ...WORKER_TERMINAL_STREAM_DEFINITIONS,
    // The script output stream the daemon's script module composes (CAN-5087).
    ...WORKER_SCRIPT_STREAM_DEFINITIONS,
    // The generation queue stream the daemon's code-graph module composes (CAN-5628).
    ...WORKER_CODE_GRAPH_STREAM_DEFINITIONS,
  },
};

interface DomainPolicy {
  readonly installed: readonly string[];
  readonly principals: readonly string[];
  readonly modes: Readonly<Record<string, readonly string[]>>;
}
// Annotations, not casts: the compiler checks the generated shape.
const DOMAINS: Readonly<
  Record<CanopyRuntimeProfile, Readonly<Record<string, DomainPolicy>>>
> = RUNTIME_PROFILE_DOMAINS;
const ACCESS_MODES: Readonly<Record<string, readonly string[]>> =
  RUNTIME_PROFILE_ACCESS_MODES;
const AUTHORITY_ONLY: readonly string[] = RUNTIME_PROFILE_AUTHORITY_ONLY;

export interface EffectiveRuntimeOperationsInput {
  profile: CanopyRuntimeProfile;
  /** The definitions the composition registered, never the whole catalog. */
  definitions: {
    queries: CanopyQueryDefinitionMap;
    instructions: CanopyInstructionDefinitionMap;
    streams: CanopyStreamDefinitionMap;
  };
  /** Resolved by the trusted host, never from caller identity fields; `null` fails closed. */
  principal: RuntimePrincipal | null;
  grants: readonly string[];
  /** Also list reachable operations the grants do not cover. */
  includeUnavailable?: boolean;
}

// Concrete shape: the manifest schema's catchall would widen fields to JSON.
interface Operation {
  name: string;
  kind: RuntimeOperationKind;
  version: number;
  placement: CanopyOperationPlacement;
  requiredGrants: string[];
}
interface OperationDefinition {
  readonly version: number;
  readonly placement: CanopyOperationPlacement;
  readonly requiredGrants: readonly string[];
}

/** Matches one operation against '*', 'reads', names, and '!name' tokens. */
function listed(
  tokens: readonly string[],
  name: string,
  kind: RuntimeOperationKind,
): boolean {
  return (
    !tokens.includes(`!${name}`) &&
    tokens.some(
      (token) =>
        token === '*' ||
        token === name ||
        (token === 'reads' && kind !== 'instruction'),
    )
  );
}

function policyFor(
  profile: CanopyRuntimeProfile,
  name: string,
): DomainPolicy | undefined {
  const rows = DOMAINS[profile];
  const domain = name.split('.').slice(0, 2).join('.');
  return Object.keys(rows).includes(domain) ? rows[domain] : undefined;
}

/** Whether `profile` installs the operation; absent domains install nothing. */
export function runtimeProfileInstalls(
  profile: CanopyRuntimeProfile,
  name: string,
  kind: RuntimeOperationKind,
): boolean {
  const policy = policyFor(profile, name);
  return (
    Object.prototype.hasOwnProperty.call(CATALOG[kind], name) &&
    policy !== undefined &&
    listed(policy.installed, name, kind)
  );
}

function operationsOf(
  definitions: EffectiveRuntimeOperationsInput['definitions'],
): Operation[] {
  const groups: readonly (readonly [
    RuntimeOperationKind,
    Readonly<Record<string, OperationDefinition>>,
  ])[] = [
    ['query', definitions.queries],
    ['instruction', definitions.instructions],
    ['stream', definitions.streams],
  ];
  return groups.flatMap(([kind, map]) =>
    Object.keys(map).map((name) => {
      const { version, placement, requiredGrants } = map[name];
      return {
        name,
        kind,
        version,
        placement,
        requiredGrants: [...requiredGrants],
      };
    }),
  );
}

/**
 * The installed operations `principal` may reach under runtime-profiles.yaml:
 * the domain row admits the principal and an access mode open to it lists the
 * operation. Core and authorityOnly operations stay with the host owner, so
 * only the authority mode reaches them. Domains without a row (fixtures,
 * unclassified modules) advertise nothing; use `runtimeProfileInstalls` to
 * reject them at composition.
 */
export function effectiveRuntimeOperations(
  input: EffectiveRuntimeOperationsInput,
): CoreRuntimeManifestOperation[] {
  const { profile, principal, grants } = input;
  if (principal === null || !RUNTIME_PRINCIPALS.includes(principal)) return [];
  const restricted = (name: string): boolean =>
    name.startsWith('core.') || AUTHORITY_ONLY.includes(name);
  const manifest: CoreRuntimeManifestOperation[] = [];
  for (const operation of operationsOf(input.definitions)) {
    const { name, kind } = operation;
    const policy = policyFor(profile, name);
    if (
      !policy?.principals.includes(principal) ||
      !runtimeProfileInstalls(profile, name, kind)
    )
      continue;
    const reachable = Object.keys(ACCESS_MODES).some(
      (mode) =>
        ACCESS_MODES[mode].includes(principal) &&
        (mode === 'authority' || !restricted(name)) &&
        listed(policy.modes[mode] ?? [], name, kind),
    );
    const available = operation.requiredGrants.every((grant) =>
      grants.includes(grant),
    );
    if (reachable && (available || input.includeUnavailable))
      manifest.push({ ...operation, available });
  }
  return manifest.sort((a, b) => a.name.localeCompare(b.name));
}
