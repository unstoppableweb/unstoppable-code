import type {
  OrganizationConnection,
  SharedConnectionCatalogEntry,
} from '@canopy/protocol/canopy-core';
import { searchFold } from './project-defaults-model';

function matchesAny(texts: readonly string[], query: string): boolean {
  const needle = searchFold(query.trim());
  if (needle === '') return true;
  return texts.some((text): boolean => searchFold(text).includes(needle));
}

/**
 * The connectors page's search rule: a case-insensitive substring of a
 * connection's name (its label, else its service) or its service. A blank
 * query matches every row.
 */
export function matchesConnectionSearch(
  connection: OrganizationConnection,
  query: string,
): boolean {
  return matchesAny([connection.name, connection.serviceName], query);
}

/** The same rule for a tool the organization can connect: its name. */
export function matchesCatalogSearch(
  entry: SharedConnectionCatalogEntry,
  query: string,
): boolean {
  return matchesAny([entry.name], query);
}
