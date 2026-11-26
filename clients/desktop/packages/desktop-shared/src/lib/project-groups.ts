import {
  authorityIdOf,
  authorityOfId,
} from '@canopy/protocol/authority-qualified-id';
import {
  normalizeRepoRemote,
  type CloudProjectBinding,
} from '@canopy/protocol/memory-sync';
import type { RemoteControlSessionShellState } from '@canopy/protocol/remote-control/shell';
import type { SidebarItem } from '../types';

/**
 * Which copies of a project, on this computer and on paired computers, are
 * the same project (CAN-7762, for the one-window work in CAN-7750). The main
 * window shows each project once and lists every computer's tasks under it;
 * the sidebar (CAN-7766) and the "Run on" picker read the groups from here,
 * and nothing else decides which copies belong together.
 *
 * Pure: no IPC, no store, no clock. The adapters below turn each computer's
 * project list into {@link ProjectCopy} inputs ({@link localProjectCopy} for
 * this computer, {@link pairedComputerProjects} for a paired one's session
 * snapshot); {@link createProjectGrouper} groups them. A copy carries what
 * its computer did not send that matching uses in `notSent`, on its member
 * too, and never in a key.
 *
 * The rules:
 *
 * - **Identity first.** Two copies with a project identity (the cloud
 *   project's UUID; see {@link localProjectCopy}) are one project when the
 *   identities and owners are equal, and different projects when the
 *   identities differ, even when their repositories are equal.
 * - **Repository addresses otherwise.** A copy without an identity joins
 *   copies with the same owner, the same kind and the same set of
 *   repository addresses, normalized by `normalizeRepoRemote`: lower-case
 *   host and path, without scheme, user, password or token, port, trailing
 *   slashes or `.git`, so the ssh and https forms of one address are equal.
 *   The set is compared with order and duplicates ignored. A
 *   single-repository project never matches a multi-repository one, so a
 *   multi-repository project with one repository stays apart from it.
 * - **One side with an identity.** A copy without an identity whose
 *   addresses equal those of copies with exactly one identity joins that
 *   identity's group. When they equal those of two or more identities, it
 *   joins none of them and groups only with other copies without one.
 * - **Never by name.** Names are display only.
 * - **Owner always counts.** A Personal copy and an organization copy never
 *   match, nor two organizations' copies, by identity or by address.
 *   Personal means the signed-in account: the relay pairs only one
 *   account's computers.
 * - **Missing data never matches.** A copy with neither an identity nor a
 *   usable address set is its own group. A computer that did not send a
 *   field sends a copy without it; the adapter, not this module, decides
 *   what was sent.
 * - **Copies on one computer never merge.** Two copies on the same
 *   computer stay two groups, as today's sidebar shows local duplicates.
 *   Each may still be joined by copies from other computers: each
 *   computer's copies in a match are ordered (copies with an identity
 *   first, then by identity, then by project id, in code-unit order), and
 *   the n-th copy of every computer forms the n-th group. So a paired
 *   computer's copy joins this computer's first copy in that order.
 *
 * Keys are stable across updates and independent of input order:
 * `project:<owner>:<identity>` for an identity, else
 * `repos:<owner>:<kind>:<sorted addresses>`, else `copy:<member id>` for a
 * copy that matches nothing. When copies on one computer split a match, the
 * first group keeps the match's key and the n-th appends `#` and its first
 * member's id. Raw remotes never reach a copy, a key or a group: the
 * adapters hand this module {@link RepositoryKey}s only.
 *
 * Linear in the number of copies: every match is a map lookup, never a
 * comparison between copies. The grouper returns its previous result object
 * when its input has not changed, so consumers can skip work by identity.
 */

declare const REPOSITORY_KEY: unique symbol;

/** A repository address from {@link repositoryKeyOf}: `host/path`, no credentials. */
export type RepositoryKey = string & { readonly [REPOSITORY_KEY]: true };

/**
 * Whether `value` is already a normalized repository address. The `.git`
 * added here is the one normalization removes, so a key whose repository
 * name itself ends in `.git` reads back unchanged.
 */
export function isRepositoryKey(value: string): value is RepositoryKey {
  return normalizeRepoRemote(`https://${value}.git`)?.remoteKey === value;
}

/**
 * A remote's normalized address, or null when it has none (a local path, a
 * `file:` URL, a bundle or anything malformed). User, password and token
 * are dropped, so the result never carries a credential.
 */
export function repositoryKeyOf(remote: string): RepositoryKey | null {
  const key = normalizeRepoRemote(remote)?.remoteKey;
  return key !== undefined && isRepositoryKey(key) ? key : null;
}

export type ProjectOwner =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly organizationId: string };

export type ProjectKind = 'single-repo' | 'multi-repo' | 'cowork';

/** One computer's copy of a project, as the grouper reads it. */
export interface ProjectCopy {
  /** The project's id on its own computer, never qualified. */
  readonly projectId: string;
  readonly name: string;
  readonly color: string | null;
  readonly kind: ProjectKind;
  readonly owner: ProjectOwner;
  /** The cloud project's UUID, or null when the copy has none or it was not sent. */
  readonly identity: string | null;
  /**
   * Every repository's address, or null when the project has none or any
   * of its repositories has no usable one.
   */
  readonly repositoryKeys: readonly RepositoryKey[] | null;
  /**
   * What the copy's computer did not send that matching uses, set by an
   * adapter; see {@link NotSentProjectField}. Absent when nothing is
   * missing.
   */
  readonly notSent?: readonly NotSentProjectField[];
}

/**
 * What a paired computer did not send that matching uses. It is set
 * whenever a field is missing, even when the copy still matched by what
 * was sent (a Personal copy matched by its address, whose identity may yet
 * differ). A member with `notSent` alone in its group may be a project
 * that exists only on that computer, or one this computer could not match
 * (no address, or an address that leads to two or more identities); one
 * without it, alone, exists only there. So the sidebar can tell the two
 * apart, and the gap can be counted.
 *
 * - `owner`: an owner this module cannot compare.
 * - `identity`: a Personal project's cloud project identity.
 * - `repository-list`: every repository of a multi-repository project.
 * - `repository-address`: a single repository's address (sent only for a
 *   `github.com` origin, and only once that computer has read it).
 */
export type NotSentProjectField =
  | 'owner'
  | 'identity'
  | 'repository-list'
  | 'repository-address';

export interface PairedComputerProjects {
  /** The computer's relay device id. */
  readonly deviceId: string;
  readonly projects: readonly ProjectCopy[];
}

export interface ProjectGroupingInput {
  /** This computer's projects. */
  readonly local: readonly ProjectCopy[];
  /** Each paired computer's projects; a computer appears once. */
  readonly paired: readonly PairedComputerProjects[];
}

export type ProjectComputer =
  | { readonly kind: 'local' }
  | { readonly kind: 'paired-computer'; readonly deviceId: string };

export interface ProjectGroupMember {
  readonly computer: ProjectComputer;
  /**
   * The id to address the copy with: unqualified on this computer,
   * `computer-<deviceId>:<id>` on a paired one (CAN-7757).
   */
  readonly projectId: string;
  /** Copied from {@link ProjectCopy.notSent}; never part of a key. */
  readonly notSent?: readonly NotSentProjectField[];
}

export interface ProjectGroup {
  readonly key: string;
  /** From this computer's copy, else from the paired copy with the lowest device id. */
  readonly name: string;
  readonly color: string | null;
  readonly kind: ProjectKind;
  readonly owner: ProjectOwner;
  /** Whether this computer has a copy. */
  readonly setUpHere: boolean;
  /** This computer's copy first, then paired copies by device id. */
  readonly members: readonly ProjectGroupMember[];
}

export interface ProjectGrouping {
  /**
   * Groups with a copy here in the order of this computer's list, then
   * groups only on other computers by device id and that computer's list.
   */
  readonly groups: readonly ProjectGroup[];
  /** The group of each of this computer's projects, by its id. */
  readonly byLocalProject: ReadonlyMap<string, ProjectGroup>;
  /** The group of each paired computer's projects: by device id, then that computer's project id. */
  readonly byPairedProject: ReadonlyMap<
    string,
    ReadonlyMap<string, ProjectGroup>
  >;
}

export type ProjectGrouper = (input: ProjectGroupingInput) => ProjectGrouping;

/** One addressable copy. */
interface Entry {
  readonly copy: ProjectCopy;
  readonly computer: Computer;
  /** Position in its computer's list. */
  readonly index: number;
}

interface Computer {
  /** 0 for this computer; paired computers by device id from 1. */
  readonly rank: number;
  readonly computer: ProjectComputer;
  /** `computer-<deviceId>:` (`qualifyId`'s format), or '' for this computer. */
  readonly prefix: string;
  readonly byProject: Map<string, ProjectGroup>;
}

/** A match: the copies one key gathers, before copies on one computer split it. */
interface Match {
  readonly kind: 'identity' | 'repositories';
  readonly owner: ProjectOwner;
  /** The identity, or the sorted addresses joined with spaces. */
  readonly value: string;
  readonly projectKind: ProjectKind;
  readonly entries: Entry[];
}

/** One owner's matches, indexed by the input's own strings. */
interface OwnerIndex {
  readonly owner: ProjectOwner;
  readonly byIdentity: Map<string, Match>;
  /** Single-repository projects by their one address. */
  readonly bySingleAddress: Map<string, AddressSlot>;
  /** Multi-repository projects by their sorted, joined addresses. */
  readonly byMultiAddress: Map<string, AddressSlot>;
}

interface AddressSlot {
  /** The one identity match these addresses lead to; null for several. */
  identity: Match | null | undefined;
  /** Copies without an identity that join no identity match. */
  loose: Match | undefined;
}

const LOCAL_COMPUTER: ProjectComputer = { kind: 'local' };
const PERSONAL: ProjectOwner = { kind: 'personal' };

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ownerKeyOf(owner: ProjectOwner): string {
  return owner.kind === 'personal'
    ? 'personal'
    : `organization:${owner.organizationId}`;
}

/** Sorted, de-duplicated addresses joined with spaces; reused while the list is. */
const joinedAddresses = new WeakMap<readonly RepositoryKey[], string>();

function joinAddresses(keys: readonly RepositoryKey[]): string {
  const known = joinedAddresses.get(keys);
  if (known !== undefined) return known;
  const joined = [...new Set(keys)].sort(compareCodeUnits).join(' ');
  joinedAddresses.set(keys, joined);
  return joined;
}

/** The address index a copy belongs to and its address there, or null for none. */
function addressOf(
  index: OwnerIndex,
  copy: ProjectCopy,
): { map: Map<string, AddressSlot>; address: string } | null {
  const keys = copy.repositoryKeys;
  if (keys === null || keys.length === 0) return null;
  if (copy.kind === 'single-repo') {
    // A single-repository project's addresses are its one repository's.
    const [first] = keys;
    if (first === undefined) return null;
    for (const key of keys) if (key !== first) return null;
    return { map: index.bySingleAddress, address: first };
  }
  if (copy.kind === 'multi-repo') {
    return { map: index.byMultiAddress, address: joinAddresses(keys) };
  }
  return null;
}

/** The order of one computer's copies within a match. */
function compareWithinComputer(left: Entry, right: Entry): number {
  const a = left.copy.identity;
  const b = right.copy.identity;
  if (a !== b) {
    if (a === null) return 1;
    if (b === null) return -1;
    return compareCodeUnits(a, b);
  }
  return compareCodeUnits(left.copy.projectId, right.copy.projectId);
}

function sameKeys(
  left: readonly RepositoryKey[] | null,
  right: readonly RepositoryKey[] | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null || left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameOwner(left: ProjectOwner, right: ProjectOwner): boolean {
  return left.kind === 'personal'
    ? right.kind === 'personal'
    : right.kind === 'organization' &&
        left.organizationId === right.organizationId;
}

function sameCopy(left: ProjectCopy, right: ProjectCopy): boolean {
  return (
    left === right ||
    (left.projectId === right.projectId &&
      left.name === right.name &&
      left.color === right.color &&
      left.kind === right.kind &&
      left.identity === right.identity &&
      left.notSent === right.notSent &&
      sameOwner(left.owner, right.owner) &&
      sameKeys(left.repositoryKeys, right.repositoryKeys))
  );
}

function sameCopies(
  left: readonly ProjectCopy[],
  right: readonly ProjectCopy[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined || b === undefined || !sameCopy(a, b)) return false;
  }
  return true;
}

function sameInput(
  left: ProjectGroupingInput,
  right: ProjectGroupingInput,
): boolean {
  if (left === right) return true;
  if (
    left.paired.length !== right.paired.length ||
    !sameCopies(left.local, right.local)
  ) {
    return false;
  }
  for (let i = 0; i < left.paired.length; i += 1) {
    const a = left.paired[i];
    const b = right.paired[i];
    if (
      a === undefined ||
      b === undefined ||
      a.deviceId !== b.deviceId ||
      !sameCopies(a.projects, b.projects)
    ) {
      return false;
    }
  }
  return true;
}

/** Whether an id can be qualified (`qualifyId`): not empty, no `:` or `/`. */
function isQualifiableId(id: string): boolean {
  return id.length > 0 && !id.includes(':') && !id.includes('/');
}

/**
 * Every computer, ranked: this computer 0, then paired computers by device
 * id. A computer listed twice keeps its first list; one with a malformed
 * device id is left out.
 */
function rankComputers(
  input: ProjectGroupingInput,
): { computer: Computer; projects: readonly ProjectCopy[] }[] {
  const paired = new Map<string, readonly ProjectCopy[]>();
  for (const { deviceId, projects } of input.paired) {
    if (paired.has(deviceId)) continue;
    const authority = authorityOfId(
      authorityIdOf({ kind: 'paired-computer', deviceId }),
    );
    if (authority?.kind === 'paired-computer') paired.set(deviceId, projects);
  }
  const ranked = [
    {
      computer: {
        rank: 0,
        computer: LOCAL_COMPUTER,
        prefix: '',
        byProject: new Map<string, ProjectGroup>(),
      },
      projects: input.local,
    },
  ];
  const deviceIds = [...paired.keys()].sort(compareCodeUnits);
  for (let i = 0; i < deviceIds.length; i += 1) {
    const deviceId = deviceIds[i] ?? '';
    const computer: ProjectComputer = { kind: 'paired-computer', deviceId };
    ranked.push({
      computer: {
        rank: i + 1,
        computer,
        prefix: `${authorityIdOf(computer)}:`,
        byProject: new Map<string, ProjectGroup>(),
      },
      projects: paired.get(deviceId) ?? [],
    });
  }
  return ranked;
}

/** Gathers copies into matches: identity first, then addresses, then the copy alone. */
class Matcher {
  private readonly personal: OwnerIndex = Matcher.index(PERSONAL);
  private readonly organizations = new Map<string, OwnerIndex>();
  /** Every match, in creation order. */
  readonly matches: Match[] = [];
  /** Copies that match nothing. */
  readonly alone: Entry[] = [];
  private readonly withoutIdentity: Entry[] = [];

  private static index(owner: ProjectOwner): OwnerIndex {
    return {
      owner,
      byIdentity: new Map(),
      bySingleAddress: new Map(),
      byMultiAddress: new Map(),
    };
  }

  private indexOf(owner: ProjectOwner): OwnerIndex {
    if (owner.kind === 'personal') return this.personal;
    let index = this.organizations.get(owner.organizationId);
    if (index === undefined) {
      index = Matcher.index(owner);
      this.organizations.set(owner.organizationId, index);
    }
    return index;
  }

  /** First pass: copies with an identity. */
  add(entry: Entry): void {
    const identity = entry.copy.identity;
    if (identity === null) {
      this.withoutIdentity.push(entry);
      return;
    }
    const index = this.indexOf(entry.copy.owner);
    let match = index.byIdentity.get(identity);
    if (match === undefined) {
      match = {
        kind: 'identity',
        owner: index.owner,
        value: identity,
        projectKind: entry.copy.kind,
        entries: [entry],
      };
      index.byIdentity.set(identity, match);
      this.matches.push(match);
    } else {
      match.entries.push(entry);
    }
    const at = addressOf(index, entry.copy);
    if (at === null) return;
    const slot = at.map.get(at.address);
    if (slot === undefined) {
      at.map.set(at.address, { identity: match, loose: undefined });
    } else if (slot.identity !== match) {
      slot.identity = slot.identity === undefined ? match : null;
    }
  }

  /** Second pass: copies without an identity join by address. */
  finish(): void {
    for (const entry of this.withoutIdentity) {
      const index = this.indexOf(entry.copy.owner);
      const at = addressOf(index, entry.copy);
      if (at === null) {
        this.alone.push(entry);
        continue;
      }
      let slot = at.map.get(at.address);
      if (slot === undefined) {
        slot = { identity: undefined, loose: undefined };
        at.map.set(at.address, slot);
      }
      if (slot.identity !== undefined && slot.identity !== null) {
        slot.identity.entries.push(entry);
      } else if (slot.loose === undefined) {
        slot.loose = {
          kind: 'repositories',
          owner: index.owner,
          value: at.address,
          projectKind: entry.copy.kind,
          entries: [entry],
        };
        this.matches.push(slot.loose);
      } else {
        slot.loose.entries.push(entry);
      }
    }
  }
}

function memberOf(entry: Entry): ProjectGroupMember {
  const projectId = `${entry.computer.prefix}${entry.copy.projectId}`;
  const notSent = entry.copy.notSent;
  return notSent === undefined
    ? { computer: entry.computer.computer, projectId }
    : { computer: entry.computer.computer, projectId, notSent };
}

function matchKey(match: Match): string {
  const owner = ownerKeyOf(match.owner);
  return match.kind === 'identity'
    ? `project:${owner}:${match.value}`
    : `repos:${owner}:${match.projectKind}:${match.value}`;
}

/** A group of copies already in computer order; the first is the display source. */
function groupOf(key: string, members: readonly Entry[]): ProjectGroup {
  const [first] = members;
  if (first === undefined) throw new RangeError('A project group has no copy.');
  const list: ProjectGroupMember[] = [];
  for (const entry of members) list.push(memberOf(entry));
  const group: ProjectGroup = {
    key,
    name: first.copy.name,
    color: first.copy.color,
    kind: first.copy.kind,
    owner: first.copy.owner,
    setUpHere: first.computer.rank === 0,
    members: list,
  };
  for (const entry of members) {
    entry.computer.byProject.set(entry.copy.projectId, group);
  }
  return group;
}

/**
 * One match as groups: one group unless a computer has several copies in
 * it, when the n-th copy of every computer forms the n-th group.
 */
function splitMatch(
  match: Match,
  emit: (group: ProjectGroup, first: Entry) => void,
): void {
  const entries = match.entries;
  const key = matchKey(match);
  const [only] = entries;
  if (only === undefined) return;
  if (entries.length === 1) {
    emit(groupOf(key, entries), only);
    return;
  }
  entries.sort(
    (left, right): number =>
      left.computer.rank - right.computer.rank ||
      compareWithinComputer(left, right),
  );
  const lanes: Entry[][] = [];
  let lane = 0;
  let previousRank = -1;
  for (const entry of entries) {
    lane = entry.computer.rank === previousRank ? lane + 1 : 0;
    previousRank = entry.computer.rank;
    const members = lanes[lane];
    if (members === undefined) lanes[lane] = [entry];
    else members.push(entry);
  }
  for (let position = 0; position < lanes.length; position += 1) {
    const members = lanes[position] ?? [];
    const [first] = members;
    if (first === undefined) continue;
    const laneKey =
      position === 0
        ? key
        : `${key}#${first.computer.prefix}${first.copy.projectId}`;
    emit(groupOf(laneKey, members), first);
  }
}

/** Groups every computer's copies of each project (see the module comment). */
export function groupProjects(input: ProjectGroupingInput): ProjectGrouping {
  const ranked = rankComputers(input);
  const matcher = new Matcher();
  // Each group sits at its first member's place: computer, then list index.
  // Ids are unique per computer, so no two groups share a place.
  const offsets: number[] = [];
  let total = 0;
  for (const { computer, projects } of ranked) {
    offsets.push(total);
    total += projects.length;
    // Ids are unique per computer; a repeated or unqualifiable one is
    // dropped, since it cannot be addressed.
    const seen = new Set<string>();
    for (let index = 0; index < projects.length; index += 1) {
      const copy = projects[index];
      if (copy === undefined) continue;
      const id = copy.projectId;
      if (!isQualifiableId(id) || seen.has(id)) continue;
      seen.add(id);
      matcher.add({ copy, computer, index });
    }
  }
  matcher.finish();
  const places = new Array<ProjectGroup | undefined>(total);
  const emit = (group: ProjectGroup, first: Entry): void => {
    places[(offsets[first.computer.rank] ?? 0) + first.index] = group;
  };
  for (const match of matcher.matches) splitMatch(match, emit);
  for (const entry of matcher.alone) {
    emit(
      groupOf(`copy:${entry.computer.prefix}${entry.copy.projectId}`, [entry]),
      entry,
    );
  }
  const groups: ProjectGroup[] = [];
  for (const group of places) if (group !== undefined) groups.push(group);
  const byPairedProject = new Map<string, ReadonlyMap<string, ProjectGroup>>();
  for (const { computer } of ranked) {
    if (computer.computer.kind === 'paired-computer') {
      byPairedProject.set(computer.computer.deviceId, computer.byProject);
    }
  }
  return {
    groups,
    byLocalProject: ranked[0]?.computer.byProject ?? new Map(),
    byPairedProject,
  };
}

/**
 * A grouper that returns its previous result object while the input is
 * unchanged: the same lists, or lists whose copies have equal fields.
 */
export function createProjectGrouper(): ProjectGrouper {
  let previous: {
    input: ProjectGroupingInput;
    result: ProjectGrouping;
  } | null = null;
  return (input: ProjectGroupingInput): ProjectGrouping => {
    if (previous !== null && sameInput(previous.input, input)) {
      return previous.result;
    }
    const result = groupProjects(input);
    previous = { input, result };
    return result;
  };
}

/**
 * What this computer knows about a project beyond its sidebar row, read in
 * main: the binding from `workspace.json` (`readWorkspaceConfigDetailed`,
 * as the cloud project binding and project memory read it) and its
 * repositories' `origin` remotes (`getRemoteUrlStrict`, as the binding
 * host's workspace read does).
 */
export interface LocalProjectFacts {
  /** The stored `cloudBinding`, unchanged. */
  readonly cloudBinding: CloudProjectBinding | undefined;
  /**
   * The `origin` of every repository the project has: its one repository,
   * or a multi-repository project's root repository and each repository it
   * lists. Null for a repository without one. Leave out a root folder that
   * is not a repository.
   */
  readonly repositoryRemotes: readonly (string | null)[];
}

/** Whether this device's binding was detached or its project moved (project-bindings.ts). */
function bindingStopped(binding: CloudProjectBinding): boolean {
  const detachedAt: unknown = binding.detachedAt;
  const movedTo: unknown = binding.movedTo;
  return (
    (typeof detachedAt === 'string' && detachedAt.length > 0) ||
    (typeof movedTo === 'object' && movedTo !== null)
  );
}

function personalIdentity(
  binding: CloudProjectBinding | undefined,
  accountId: string | null,
): string | null {
  return binding !== undefined &&
    binding.ownerType === 'user' &&
    accountId !== null &&
    binding.accountId === accountId &&
    !bindingStopped(binding)
    ? binding.projectId
    : null;
}

function repositoryKeysOf(
  remotes: readonly (string | null)[],
): RepositoryKey[] | null {
  const keys: RepositoryKey[] = [];
  for (const remote of remotes) {
    const key = remote === null ? null : repositoryKeyOf(remote);
    if (key === null) return null;
    keys.push(key);
  }
  return keys.length === 0 ? null : keys;
}

/**
 * This computer's sidebar row as a {@link ProjectCopy}.
 *
 * - The identity of an organization project is its organization project id
 *   (`owner.projectId`), which the cloud binding mirrors
 *   (`CloudProjectBindingEngine.mirrorOrganization`), so it needs no binding.
 * - A Personal project's identity is its binding's project, only while that
 *   binding is Personal, belongs to the signed-in account (a binding is
 *   valid only under its account) and is neither detached nor moved.
 * - Addresses come from `facts`; without them, or when any repository has
 *   no usable remote, the copy has none. A cowork project and a temporary
 *   multi-repository workspace (a local-only combination) never have any.
 */
export function localProjectCopy(
  item: SidebarItem,
  facts: LocalProjectFacts | null,
  accountId: string | null,
): ProjectCopy {
  const owner: ProjectOwner =
    item.owner === undefined
      ? { kind: 'personal' }
      : { kind: 'organization', organizationId: item.owner.organizationId };
  const identity =
    item.owner === undefined
      ? personalIdentity(facts?.cloudBinding, accountId)
      : item.owner.projectId;
  const addressable =
    facts !== null &&
    item.type !== 'cowork' &&
    !(item.type === 'multi-repo' && item.temporary === true);
  return {
    projectId: item.id,
    name: item.name,
    color: item.color,
    kind: item.type,
    owner,
    identity,
    repositoryKeys: addressable
      ? repositoryKeysOf(facts.repositoryRemotes)
      : null,
  };
}

/** One project in a paired computer's `desktop:session-snapshot`. */
export type PairedSnapshotWorkspace =
  RemoteControlSessionShellState['workspaces'][number];

// Shared, so unchanged copies compare equal by reference.
const NOT_SENT_OWNER: readonly NotSentProjectField[] = ['owner'];
const NOT_SENT_IDENTITY: readonly NotSentProjectField[] = ['identity'];
const NOT_SENT_LIST: readonly NotSentProjectField[] = [
  'identity',
  'repository-list',
];
const NOT_SENT_ADDRESS: readonly NotSentProjectField[] = [
  'identity',
  'repository-address',
];

/** The address a snapshot's `repositoryIdentity` names: `github.com/<owner>/<repo>`. */
function snapshotRepositoryKey(
  workspace: PairedSnapshotWorkspace,
): RepositoryKey | null {
  const repository = workspace.repositoryIdentity;
  if (repository === undefined) return null;
  const key = `github.com/${repository.owner}/${repository.repo}`;
  return isRepositoryKey(key) ? key : null;
}

function readPairedCopy(
  workspace: PairedSnapshotWorkspace,
): ProjectCopy | null {
  // A catalog placeholder is not set up on that computer, and a shared-chat
  // group is not a project; neither is a copy.
  if (workspace.placeholder !== undefined || workspace.sharedFrom === true) {
    return null;
  }
  const base = {
    projectId: workspace.localId,
    name: workspace.name,
    color: workspace.color ?? null,
    kind: workspace.type,
  };
  const owner = workspace.owner;
  // `repositoryIdentity` names a multi-repository project's root only, so
  // it is an address only for a single-repository project.
  const key =
    workspace.type === 'single-repo' ? snapshotRepositoryKey(workspace) : null;
  if (owner?.type === 'organization') {
    const organization: ProjectOwner = {
      kind: 'organization',
      organizationId: owner.organizationId,
    };
    if (owner.organizationId.length === 0 || owner.projectId.length === 0) {
      return {
        ...base,
        owner: organization,
        identity: null,
        repositoryKeys: null,
        notSent: NOT_SENT_OWNER,
      };
    }
    // The organization project is the identity (see localProjectCopy).
    return {
      ...base,
      owner: organization,
      identity: owner.projectId,
      repositoryKeys: key === null ? null : [key],
    };
  }
  if (owner?.type === 'cloud-organization') {
    return {
      ...base,
      owner: { kind: 'organization', organizationId: owner.organizationId },
      identity: null,
      repositoryKeys: null,
      notSent: NOT_SENT_OWNER,
    };
  }
  // Absent means Personal on the wire. A Personal project's identity is
  // never sent, so it can match only by its address.
  const personal: ProjectOwner = { kind: 'personal' };
  if (key !== null) {
    return {
      ...base,
      owner: personal,
      identity: null,
      repositoryKeys: [key],
      notSent: NOT_SENT_IDENTITY,
    };
  }
  return {
    ...base,
    owner: personal,
    identity: null,
    repositoryKeys: null,
    notSent:
      workspace.type === 'multi-repo'
        ? NOT_SENT_LIST
        : workspace.type === 'single-repo'
          ? NOT_SENT_ADDRESS
          : NOT_SENT_IDENTITY,
  };
}

/** Each snapshot list's copies, kept while the list is, so unchanged input is cheap. */
const pairedCopies = new WeakMap<
  readonly PairedSnapshotWorkspace[],
  readonly ProjectCopy[]
>();

/**
 * A paired computer's projects, from the `workspaces` of the
 * `desktop:session-snapshot` it sends on the one-window list (CAN-7758),
 * read only from what a computer at the one-window floor (protocol 26)
 * sends. Nothing is guessed:
 *
 * - An organization project's identity is its organization project id,
 *   which the snapshot sends in `owner`, as on this computer.
 * - A Personal project's identity is never sent, so it matches only by
 *   address, and only a single-repository project has one: its
 *   `repositoryIdentity`, sent for a `github.com` origin once that
 *   computer has read it. A multi-repository project's repository list is
 *   not sent (`repos` holds paths, `repositoryIdentity` only the root), so
 *   a Personal one never matches.
 * - Every Personal copy records the identity it lacks, and a copy that
 *   cannot match records why, in {@link ProjectCopy.notSent}.
 * - Catalog placeholders and shared-chat groups are left out.
 */
export function pairedComputerProjects(
  deviceId: string,
  workspaces: readonly PairedSnapshotWorkspace[],
): PairedComputerProjects {
  let projects = pairedCopies.get(workspaces);
  if (projects === undefined) {
    const copies: ProjectCopy[] = [];
    for (const workspace of workspaces) {
      const copy = readPairedCopy(workspace);
      if (copy !== null) copies.push(copy);
    }
    projects = copies;
    pairedCopies.set(workspaces, projects);
  }
  return { deviceId, projects };
}
