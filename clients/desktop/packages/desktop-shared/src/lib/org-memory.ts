import type { MemorySearchFact } from '@canopy/protocol/memory';
import type { AppliedOrgMemoryTurn } from '../types';
import { normalizeOrganizationExternalId } from '@canopy/protocol/canopy-server/account-snapshot';

// Moved to protocol so other hosts parse the same way (CAN-6997).
export {
  normalizeMemorySearchOrganizationExternalIds,
  normalizeOrganizationExternalId,
} from '@canopy/protocol/canopy-server/account-snapshot';

const MAX_FACTS_PER_TURN = 8;
const MAX_FACT_TEXT_LENGTH = 500;
const MAX_VALID_AT_LENGTH = 64;
const MAX_SOURCE_TURN_IDS = 16;
const MAX_SOURCE_TURN_ID_LENGTH = 256;
const MAX_FACT_ID_LENGTH = 64;
const MAX_SEARCH_ID_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeOrgMemoryFacts(value: unknown): MemorySearchFact[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_FACTS_PER_TURN).flatMap((rawFact) => {
    if (
      !isRecord(rawFact) ||
      typeof rawFact.factText !== 'string' ||
      rawFact.factText.trim().length === 0 ||
      (rawFact.validAt !== null && typeof rawFact.validAt !== 'string') ||
      !Array.isArray(rawFact.sourceTurnIds)
    ) {
      return [];
    }
    const sourceTurnIds = rawFact.sourceTurnIds
      .filter((id): id is string => typeof id === 'string')
      .slice(0, MAX_SOURCE_TURN_IDS)
      .map((id) => id.slice(0, MAX_SOURCE_TURN_ID_LENGTH));
    return [
      {
        // factId and the turn-level searchId gate per-occurrence feedback;
        // facts persisted before ids were exposed stay read-only.
        ...(typeof rawFact.factId === 'string' &&
        rawFact.factId.trim().length > 0
          ? { factId: rawFact.factId.slice(0, MAX_FACT_ID_LENGTH) }
          : {}),
        factText: rawFact.factText.slice(0, MAX_FACT_TEXT_LENGTH),
        validAt:
          typeof rawFact.validAt === 'string'
            ? rawFact.validAt.slice(0, MAX_VALID_AT_LENGTH)
            : null,
        sourceTurnIds,
      },
    ];
  });
}

export function normalizeOrgMemoryTurn(
  value: unknown,
): AppliedOrgMemoryTurn | null {
  if (!isRecord(value)) return null;
  const facts = normalizeOrgMemoryFacts(value.facts);
  const organizationExternalId = normalizeOrganizationExternalId(
    value.organizationExternalId,
  );
  return facts.length > 0
    ? {
        // The org that was searched (CAN-3457). Turns persisted before it was
        // recorded keep their facts but lose feedback, which needs the org.
        ...(organizationExternalId === null ? {} : { organizationExternalId }),
        ...(typeof value.searchId === 'string' &&
        value.searchId.trim().length > 0
          ? { searchId: value.searchId.trim().slice(0, MAX_SEARCH_ID_LENGTH) }
          : {}),
        facts,
      }
    : null;
}

export function normalizeMemoryByMessageId(
  value: unknown,
  userMessageIds?: ReadonlySet<string>,
): Record<string, AppliedOrgMemoryTurn> | undefined {
  if (!isRecord(value)) return undefined;
  const normalized: Record<string, AppliedOrgMemoryTurn> = {};
  for (const [messageId, rawTurn] of Object.entries(value)) {
    if (userMessageIds && !userMessageIds.has(messageId)) continue;
    const turn = normalizeOrgMemoryTurn(rawTurn);
    if (turn) {
      normalized[messageId] = turn;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
