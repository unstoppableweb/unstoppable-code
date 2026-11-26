import { capabilitySetupItemName } from '../../../capability/project-setup/project-setup-model';
import {
  capabilitySetupItemKey,
  type CapabilitySetupConnectorItem,
  type CapabilitySetupConnectorRef,
  type CapabilitySetupItem,
  type CapabilitySetupItemRef,
} from '@canopy/protocol/canopy-core';

/**
 * The kinds the Project defaults page lists (CAN-6237). Agents (phase 10a)
 * and pipelines (phase 10b) are listed only while organization projects are
 * on; otherwise the page keeps any of theirs in the stored defaults
 * untouched.
 */
export type ProjectDefaultKind = 'skill' | 'plugin' | 'agent' | 'pipeline';

export interface ProjectDefaultRef {
  readonly kind: ProjectDefaultKind;
  readonly id: string;
}

/** One row of the page: an organization item and whether it is a default. */
export interface ProjectDefaultRow {
  readonly key: string;
  readonly ref: ProjectDefaultRef;
  readonly name: string;
  readonly description: string | null;
  /** False for a default whose item was deleted or is no longer shared. */
  readonly available: boolean;
  readonly isDefault: boolean;
}

/** What the page holds from a read or a save. */
export interface ProjectDefaultsState {
  readonly revision: number;
  /** The stored defaults, every kind, in their order. */
  readonly items: readonly CapabilitySetupItem[];
  /** The organization's own items an owner or admin can mark. */
  readonly candidates: readonly CapabilitySetupItem[];
  readonly canEdit: boolean;
  /** The default connections (CAN-6246); null from a server before them. */
  readonly connectors: ProjectDefaultConnectors | null;
}

function listedRef(
  ref: CapabilitySetupItemRef,
  kind: ProjectDefaultKind,
): ProjectDefaultRef | null {
  return ref.kind === kind ? { kind, id: ref.id } : null;
}

/**
 * The rows of one kind: the organization's items in the read's order, then
 * any default the candidates no longer list (deleted or no longer shared),
 * so an admin can still turn it off.
 */
export function projectDefaultRows(
  state: ProjectDefaultsState,
  kind: ProjectDefaultKind,
): ProjectDefaultRow[] {
  const defaults = new Set(
    state.items.map((item) => capabilitySetupItemKey(item.ref)),
  );
  const rows: ProjectDefaultRow[] = [];
  const listed = new Set<string>();
  const add = (item: CapabilitySetupItem, isDefault: boolean): void => {
    const ref = listedRef(item.ref, kind);
    if (ref === null) return;
    const key = capabilitySetupItemKey(item.ref);
    if (listed.has(key)) return;
    listed.add(key);
    rows.push({
      key,
      ref,
      name: capabilitySetupItemName(item),
      description: item.description,
      available: item.available,
      isDefault,
    });
  };
  for (const item of state.candidates)
    add(item, defaults.has(capabilitySetupItemKey(item.ref)));
  for (const item of state.items) add(item, true);
  return rows;
}

/**
 * Lowercases `text` for search, folding the Greek final sigma (ς) into σ:
 * lowercasing gives a word-final Σ the final form, so `Σ` would otherwise
 * miss a name such as `ΕΛΕΓΧΟΣ`.
 */
export function searchFold(text: string): string {
  return text.toLocaleLowerCase().replace(/ς/gu, 'σ');
}

/**
 * The page's search rule: a case-insensitive substring of a row's name or
 * description. A blank query matches every row.
 */
export function matchesProjectDefaultSearch(
  row: ProjectDefaultRow,
  query: string,
): boolean {
  const needle = searchFold(query.trim());
  if (needle === '') return true;
  return [row.name, row.description].some(
    (text): boolean => text !== null && searchFold(text).includes(needle),
  );
}

/**
 * The defaults to save after switching `ref` on or off: every stored ref
 * that is still available kept in order (other kinds included), `ref`
 * appended or removed. A stored default whose item is gone, or no longer the
 * organization's, is left out: the service refuses to store one, so
 * resending it would block every save.
 */
export function projectDefaultsWith(
  items: readonly CapabilitySetupItem[],
  ref: ProjectDefaultRef,
  on: boolean,
): CapabilitySetupItemRef[] {
  const key = capabilitySetupItemKey(ref);
  const kept = items
    .filter((item) => item.available)
    .map((item) => item.ref)
    .filter((stored) => capabilitySetupItemKey(stored) !== key);
  return on ? [...kept, ref] : kept;
}

// --- Default connections (CAN-6246, phase 07) --------------------------------

/** The organization's default connections and the ones it could mark. */
export interface ProjectDefaultConnectors {
  readonly items: readonly CapabilitySetupConnectorItem[];
  readonly candidates: readonly CapabilitySetupConnectorItem[];
}

/** One connection row: an organization connection and whether it is a default. */
export interface ProjectDefaultConnectorRow {
  readonly key: string;
  readonly ref: CapabilitySetupConnectorRef;
  readonly name: string;
  /** False for a default whose connection was deleted. */
  readonly available: boolean;
  /** True when it must be signed in again before projects can use it. */
  readonly needsSignIn: boolean;
  readonly isDefault: boolean;
}

/**
 * The connection rows: the organization's connections in the read's order,
 * then any default the candidates no longer list, so an admin can still
 * turn it off.
 */
export function projectDefaultConnectorRows(
  connectors: ProjectDefaultConnectors,
): ProjectDefaultConnectorRow[] {
  const defaults = new Set(connectors.items.map((item) => item.ref.id));
  const rows: ProjectDefaultConnectorRow[] = [];
  const listed = new Set<string>();
  const add = (
    item: CapabilitySetupConnectorItem,
    isDefault: boolean,
  ): void => {
    if (listed.has(item.ref.id)) return;
    listed.add(item.ref.id);
    rows.push({
      key: `connector-${item.ref.id}`,
      ref: item.ref,
      name: item.available ? item.name : 'Removed connection',
      available: item.available,
      needsSignIn:
        item.available &&
        (item.status === 'needsSignIn' || item.status === 'disconnected'),
      isDefault,
    });
  };
  for (const item of connectors.candidates)
    add(item, defaults.has(item.ref.id));
  for (const item of connectors.items) add(item, true);
  return rows;
}

/**
 * The default connections to save after switching `ref` on or off: the
 * available stored defaults in order, `ref` appended or removed. A default
 * whose connection is gone is left out, as the service refuses to store it.
 */
export function defaultConnectorsWith(
  items: readonly CapabilitySetupConnectorItem[],
  ref: CapabilitySetupConnectorRef,
  on: boolean,
): CapabilitySetupConnectorRef[] {
  const kept = items
    .filter((item) => item.available && item.ref.id !== ref.id)
    .map((item) => item.ref);
  return on ? [...kept, ref] : kept;
}

/** The stored defaults of every other kind, unchanged, for a connection save. */
export function availableDefaultRefs(
  items: readonly CapabilitySetupItem[],
): CapabilitySetupItemRef[] {
  return items.filter((item) => item.available).map((item) => item.ref);
}
