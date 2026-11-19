import { randomUUID } from 'node:crypto';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  BACKGROUND_HELPER_PRIORITIES,
  enqueueBackgroundHelperTask,
} from '../lib/background-helper-queue';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isHelperNoBillingSourceError } from '../agents/helper-no-billing-source';
import {
  findChainCandidates,
  findPromptCandidates,
  MIN_CHAIN_CHATS,
  meetsGroupThreshold,
  type ChainCandidate,
  type PromptCandidate,
} from './clustering';
import type {
  buildScanPrompt,
  chooseScanModel,
  InventorySkill,
  runSkillSuggestionScanModel,
  ScanModelRun,
  validateScanOutput,
  ValidatedSuggestion,
} from './clustering-generator';
import {
  chainMatchId,
  turnMatchId,
  type ChatChainFingerprint,
  type FingerprintRow,
  type FingerprintStore,
  type TurnFingerprint,
} from './fingerprint-store';
import { isOwnerAvailable, type MemberOrganizations } from './owners';
import { parsePartitionKey, type SkillSuggestionPartition } from './partition';
import {
  isOpenSuggestion,
  MAX_SUGGESTION_MEMBERS,
  resolveStoredSuggestion,
  type SkillSuggestionsRegistry,
  type StoredSkillSuggestion,
} from './registry';
import {
  expireStaleSuggestions,
  SUGGESTION_IDLE_EXPIRY_MS,
} from './surfacing-state';
import type { TimeSlicer } from './time-slicer';

/**
 * One idle scan pass over every partition (CAN-385). Each partition runs at
 * most once a day and only with ten new requests since its last scan (waived
 * until the first backfill finishes). Partitions are never combined.
 */
export const SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MIN_NEW_FINGERPRINTS = 10;

export type PartitionScanOutcome =
  | 'no_candidates'
  | 'confirmed'
  | 'none_confirmed'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface ScanGenerator {
  chooseScanModel: typeof chooseScanModel;
  buildScanPrompt: typeof buildScanPrompt;
  runSkillSuggestionScanModel: typeof runSkillSuggestionScanModel;
  validateScanOutput: typeof validateScanOutput;
  MAX_UNCLUSTERED_PROMPTS: number;
}

export interface ScanDeps {
  store: FingerprintStore;
  registry: SkillSuggestionsRegistry;
  slicer: TimeSlicer;
  now: () => number;
  /** The gate; re-checked before every write so a closed gate discards work. */
  isAllowed: () => boolean;
  readPreferences: () => Promise<PreferencesData>;
  readOrganizations: () => Promise<MemberOrganizations>;
  loadInventory: () => Promise<InventorySkill[]>;
  loadGenerator: () => Promise<ScanGenerator>;
  /** Workspaces that still exist, or `null` to keep every row. */
  liveProjectIds: () => Promise<ReadonlySet<string> | null>;
  /** Chats that still exist, or `null` to keep every row. */
  liveChatIds?: (now: number) => Promise<ReadonlySet<string> | null>;
  onPartitionScanned?: (
    outcome: PartitionScanOutcome,
    candidateCount: number,
  ) => void;
  notifyChanged: () => void;
}

export interface ScanPassOptions {
  /** The first pass after backfill skips the new-request minimum. */
  waiveMinimum: boolean;
}

/** A partition never scanned skips the minimum too, even after a cancel. */
function waivesMinimum(
  options: ScanPassOptions,
  lastScanAt: Readonly<Record<string, number>>,
  key: string,
): boolean {
  return options.waiveMinimum || lastScanAt[key] === undefined;
}

function newTurnCount(rows: readonly TurnFingerprint[], since: number): number {
  return rows.filter((row) => row.createdAt > since).length;
}

/** Whether any partition is due, read before compaction or chat enumeration. */
async function hasDuePartition(
  deps: ScanDeps,
  now: number,
  options: ScanPassOptions,
  organizations: MemberOrganizations,
): Promise<boolean> {
  const [rows, state] = await Promise.all([
    deps.store.read(),
    deps.registry.read(),
  ]);
  const newTurns = new Map<string, number>();
  for (const row of rows) {
    const lastScan = state.lastScanAt[row.partition] ?? 0;
    if (now - lastScan < SCAN_INTERVAL_MS) continue;
    // The scan loop skips these partitions, so they never make a pass due.
    const partition = parsePartitionKey(row.partition);
    if (!partition || !isOwnerAvailable(partition.owner, organizations))
      continue;
    if (waivesMinimum(options, state.lastScanAt, row.partition)) return true;
    if (row.kind !== 'turn' || row.createdAt <= lastScan) continue;
    const count = (newTurns.get(row.partition) ?? 0) + 1;
    if (count >= MIN_NEW_FINGERPRINTS) return true;
    newTurns.set(row.partition, count);
  }
  return false;
}

/** Runs every due partition. Returns `cancelled` when the slicer stops. */
export async function runScanPass(
  deps: ScanDeps,
  options: ScanPassOptions,
): Promise<'done' | 'cancelled'> {
  const now = deps.now();
  if (!deps.isAllowed()) return 'cancelled';
  const organizations = await deps.readOrganizations();
  // Left organizations and stale suggestions expire before anything runs.
  const expired = await deps.registry.update((draft) => {
    const ids = expireStaleSuggestions(draft, now);
    for (const suggestion of draft.suggestions) {
      if (!isOpenSuggestion(suggestion)) continue;
      const owner = parsePartitionKey(suggestion.partition)?.owner;
      if (owner && isOwnerAvailable(owner, organizations)) continue;
      // An empty membership read is unknown (rollout off, signed out, still
      // loading), not a departure; list and getPending hide them meanwhile.
      if (owner?.kind === 'organization' && organizations.size === 0) continue;
      resolveStoredSuggestion(suggestion, 'expired', now);
      ids.push(suggestion.id);
    }
    return ids.length > 0 ? ids : false;
  });
  if (expired !== false) deps.notifyChanged();

  // Compaction and chat enumeration only run when a partition will scan.
  if (!(await hasDuePartition(deps, now, options, organizations)))
    return 'done';
  const rows = await deps.store.compact({
    now,
    liveProjectIds: await deps.liveProjectIds(),
    liveChatIds: (await deps.liveChatIds?.(now)) ?? null,
  });
  if (!deps.isAllowed()) return 'cancelled';

  const byPartition = new Map<string, FingerprintRow[]>();
  for (const row of rows) {
    const list = byPartition.get(row.partition);
    if (list) list.push(row);
    else byPartition.set(row.partition, [row]);
  }
  for (const [key, partitionRows] of Array.from(byPartition)) {
    const partition = parsePartitionKey(key);
    if (!partition || !isOwnerAvailable(partition.owner, organizations))
      continue;
    const state = await deps.registry.read();
    const lastScan = state.lastScanAt[key] ?? 0;
    if (now - lastScan < SCAN_INTERVAL_MS) continue;
    const turns = partitionRows.filter(
      (row): row is TurnFingerprint => row.kind === 'turn',
    );
    if (
      !waivesMinimum(options, state.lastScanAt, key) &&
      newTurnCount(turns, lastScan) < MIN_NEW_FINGERPRINTS
    )
      continue;
    const chains = partitionRows.filter(
      (row): row is ChatChainFingerprint => row.kind === 'chat_chain',
    );
    let outcome: PartitionScanOutcome;
    let candidateCount = 0;
    try {
      const result = await scanPartition(
        deps,
        partition,
        turns,
        chains,
        state.suggestions,
      );
      outcome = result.outcome;
      candidateCount = result.candidateCount;
    } catch (error) {
      logMainProcessWarn('[skill-suggestions] partition scan failed', error);
      outcome = 'failed';
    }
    if (outcome === 'cancelled') return 'cancelled';
    deps.onPartitionScanned?.(outcome, candidateCount);
    if (!deps.isAllowed()) return 'cancelled';
    // Finished, skipped and failed scans wait a day; cancelled ones do not.
    await deps.registry.update((draft) => {
      draft.lastScanAt[key] = now;
      return true;
    });
  }
  return 'done';
}

function newStoredSuggestion(
  validated: ValidatedSuggestion,
  partition: SkillSuggestionPartition,
  now: number,
): StoredSkillSuggestion {
  const lastMatchedAt = Math.max(
    0,
    ...validated.members.map((row) => row.createdAt),
    ...validated.chainChats.map((row) => row.lastActivityAt),
  );
  return {
    id: validated.reuseId ?? randomUUID(),
    kind: validated.kind,
    state: 'confirmed',
    partition: partition.key,
    title: validated.title,
    summary: validated.summary,
    proposedSkillName: validated.proposedSkillName,
    proposedDescription: validated.proposedDescription,
    parameters: validated.parameters,
    chainSkills: validated.chainSkills,
    exemplars: partition.privateWorkspaceId === null ? validated.exemplars : [],
    members: [...validated.members]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_SUGGESTION_MEMBERS)
      .map((row) => ({ tokens: [...row.tokens], tools: [...row.tools] })),
    matchedTurnIds: Array.from(new Set(validated.matchedTurnIds)),
    showCount: 0,
    createdAt: now,
    lastMatchedAt: lastMatchedAt || now,
  };
}

/**
 * Drops requests from workspaces deleted since the scan read its rows, and
 * the whole suggestion when it no longer meets its group rules or belongs to
 * a deleted private workspace. Examples carry no workspace, so any loss
 * drops them too.
 */
function withoutDeletedWorkspaces(
  entry: ValidatedSuggestion,
  partition: SkillSuggestionPartition,
  liveProjects: ReadonlySet<string> | null,
): ValidatedSuggestion | null {
  if (liveProjects === null) return entry;
  if (
    partition.privateWorkspaceId !== null &&
    !liveProjects.has(partition.privateWorkspaceId)
  )
    return null;
  const members = entry.members.filter((row) =>
    liveProjects.has(row.projectId),
  );
  const chainChats = entry.chainChats.filter((row) =>
    liveProjects.has(row.projectId),
  );
  if (
    members.length === entry.members.length &&
    chainChats.length === entry.chainChats.length
  )
    return entry;
  if (entry.kind === 'prompt' && !meetsGroupThreshold(members)) return null;
  if (entry.kind === 'chain' && chainChats.length < MIN_CHAIN_CHATS)
    return null;
  return {
    ...entry,
    members,
    chainChats,
    exemplars: [],
    matchedTurnIds:
      entry.kind === 'prompt'
        ? members.map((row) => turnMatchId(row))
        : chainChats.map((row) => chainMatchId(row)),
  };
}

async function scanPartition(
  deps: ScanDeps,
  partition: SkillSuggestionPartition,
  turns: readonly TurnFingerprint[],
  chains: readonly ChatChainFingerprint[],
  suggestions: readonly StoredSkillSuggestion[],
): Promise<{ outcome: PartitionScanOutcome; candidateCount: number }> {
  const existing = suggestions.filter(
    (entry) => entry.partition === partition.key,
  );
  // Open, accepted and dismissed suggestions keep their requests out of new
  // candidates; only expired ones may be proposed again.
  const active = existing.filter((entry) => entry.state !== 'expired');
  const excludeTurnIds = new Set(
    active.flatMap((entry) => entry.matchedTurnIds),
  );
  const allPromptCandidates: PromptCandidate[] | null =
    await findPromptCandidates(turns, {
      excludeTurnIds,
      slicer: deps.slicer,
    });
  if (allPromptCandidates === null)
    return { outcome: 'cancelled', candidateCount: 0 };
  // A group whose newest request is past the idle expiry would expire before
  // it could surface, so it never reaches the model.
  const freshSince = deps.now() - SUGGESTION_IDLE_EXPIRY_MS;
  const promptCandidates = allPromptCandidates.filter(
    (candidate) =>
      Math.max(0, ...candidate.members.map((row) => row.createdAt)) >
      freshSince,
  );
  const chainCandidates: ChainCandidate[] = findChainCandidates(chains, {
    existingChains: active
      .filter((entry) => entry.kind === 'chain')
      .map((entry) => entry.chainSkills),
  }).filter(
    (candidate) =>
      Math.max(0, ...candidate.chats.map((row) => row.lastActivityAt)) >
      freshSince,
  );
  const candidateCount = promptCandidates.length + chainCandidates.length;
  // No candidates: the model is never called.
  if (candidateCount === 0) return { outcome: 'no_candidates', candidateCount };
  if (!deps.isAllowed() || deps.slicer.stopped)
    return { outcome: 'cancelled', candidateCount };

  const generator = await deps.loadGenerator();
  const choice = await generator.chooseScanModel(
    await deps.readPreferences(),
    partition,
  );
  // A signed-out provider with no billing source (CAN-7062) counts as not
  // run, like a cancelled scan: `lastScanAt` does not advance, so these turns
  // still count once the user signs in, and no warning is logged per pass.
  if (choice.kind === 'skip' && choice.noBillingSource === true) {
    return { outcome: 'cancelled', candidateCount };
  }
  if (choice.kind === 'skip') {
    logMainProcessWarn('[skill-suggestions] partition scan skipped', {
      reason: choice.reason,
    });
    return { outcome: 'skipped', candidateCount };
  }
  const clustered = new Set(
    promptCandidates.flatMap((candidate) =>
      candidate.members.map((row) => turnMatchId(row)),
    ),
  );
  const unclustered = [...turns]
    .filter(
      (row) =>
        !clustered.has(turnMatchId(row)) &&
        !excludeTurnIds.has(turnMatchId(row)),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, generator.MAX_UNCLUSTERED_PROMPTS);
  const prepared = generator.buildScanPrompt({
    partition,
    promptCandidates,
    chainCandidates,
    unclustered,
    inventory: await deps.loadInventory(),
    priorSuggestions: existing.filter((entry) => !isOpenSuggestion(entry)),
  });
  let run: ScanModelRun;
  try {
    run = await enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.skillSuggestions,
      task: () =>
        generator.runSkillSuggestionScanModel(prepared, choice, partition),
    });
  } catch (error) {
    // Refused before any spawn on a cold auth cache (CAN-7062): not run.
    if (isHelperNoBillingSourceError(error)) {
      return { outcome: 'cancelled', candidateCount };
    }
    throw error;
  }
  // A gate closed mid-run throws the result away before anything is written.
  if (!deps.isAllowed()) {
    run.finalize(
      'failure',
      'Skill suggestions were turned off during the scan',
    );
    return { outcome: 'cancelled', candidateCount };
  }
  const inventoryNames = new Set(
    (await deps.loadInventory()).map((skill) => skill.name),
  );
  // Read after the model call: a workspace deleted meanwhile is left out.
  const liveProjects = await deps.liveProjectIds();
  const now = deps.now();
  let confirmed = 0;
  let gateClosed = false;
  try {
    await deps.registry.update((draft) => {
      // Checked again here: the inventory load above can span a gate change.
      if (!deps.isAllowed()) {
        gateClosed = true;
        return false;
      }
      const validated = generator.validateScanOutput(run.output, {
        partition,
        prepared,
        inventoryNames,
        existing: draft.suggestions.filter(
          (entry) => entry.partition === partition.key,
        ),
      });
      const kept = validated.flatMap((entry) => {
        const live = withoutDeletedWorkspaces(entry, partition, liveProjects);
        return live ? [live] : [];
      });
      confirmed = kept.length;
      if (kept.length === 0) return false;
      for (const entry of kept) {
        const stored = newStoredSuggestion(entry, partition, now);
        const index = draft.suggestions.findIndex(
          (candidate) => candidate.id === stored.id,
        );
        if (index === -1) draft.suggestions.push(stored);
        else draft.suggestions[index] = stored;
      }
      return true;
    });
  } catch (error) {
    run.finalize(
      'failure',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
  if (gateClosed) {
    run.finalize(
      'failure',
      'Skill suggestions were turned off during the scan',
    );
    return { outcome: 'cancelled', candidateCount };
  }
  run.finalize('success');
  if (confirmed > 0) deps.notifyChanged();
  return {
    outcome: confirmed > 0 ? 'confirmed' : 'none_confirmed',
    candidateCount,
  };
}
