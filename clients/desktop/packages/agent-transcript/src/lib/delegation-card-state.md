# Stream delegation card state: A0 contract

Phase 12 revision 3, including root amendment 1. This is a dormant format-4
contract, not production promotion. S1 implements pure behavior; S2 storage
and readers; S3 renderer application; 12b publishes from the broker.

## Field classes and source writers

Paths below abbreviate `packages/desktop-shared/src/node/delegation/` as `D/`,
`packages/agent-transcript/src/lib/` as `T/`. Line anchors describe the audited
pre-S1 source. “None” means no same-generation writer; continuation creation
is a new generation. Every raw-row copy is immutable, including fallbacks.

| Field                    | Class                                                         | Post-creation source writer / rule                                                                                            |
| ------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `delegationId`           | creation                                                      | None; `D/broker.ts:8170` projects stable identity.                                                                            |
| `runGeneration`          | creation                                                      | None within a generation; new state at `D/broker.ts:4408`.                                                                    |
| `depth`                  | creation                                                      | None; retained at `D/broker.ts:5696`.                                                                                         |
| `parentDelegationId`     | creation                                                      | None; retained at `D/broker.ts:5697-5698`.                                                                                    |
| `parentDescription`      | creation                                                      | None; retained at `D/broker.ts:5701-5702`.                                                                                    |
| `permissions`            | creation                                                      | None within generation; control grants at `D/broker.ts:4016-4017` become next generation's task at `:4375-4380`.              |
| `status`                 | draft then canonical                                          | `D/lifecycle.ts:130,175`; terminal/settling snapshot projects `running` until settle writes canonical status.                 |
| `routeSnapshot`          | draft                                                         | Prepared at `D/broker.ts:5704`; capability metadata at `:7927-7939`; projection `:8215-8217`.                                 |
| `requestedModelId`       | draft                                                         | `D/broker.ts:8215-8217`: present until route exists, then absent.                                                             |
| `nativeSessionId`        | draft                                                         | `D/lifecycle.ts:112,133`.                                                                                                     |
| `nestedDelegation`       | draft                                                         | Recomputed using task and current depth limit at `D/broker.ts:8130-8137`.                                                     |
| `childDelegationIds`     | draft                                                         | Current child enumeration at `D/broker.ts:8020`.                                                                              |
| `capabilities`           | draft                                                         | Grant extension at `D/broker.ts:7933-7939`; projection `:8234-8236`.                                                          |
| `isolatedWorkspace`      | draft                                                         | Preparation callback `D/broker.ts:5640-5645`, isolation revision `:5713`; apply changes underlying isolation metadata.        |
| `workspaceDiscarded`     | draft                                                         | Discard at `D/broker.ts:4768`.                                                                                                |
| `control`                | draft if completed/failed, live-only if accepted              | Admission `D/broker.ts:4009-4021`, completion/failure `:4199-4222`, steering delivery `:4657`. Includes `applyFailure`.       |
| `cancelledByUser`        | draft                                                         | Stop attribution at `D/broker.ts:1250`; retained/frozen after settle.                                                         |
| `stoppedBy`              | draft                                                         | Stop attribution at `D/broker.ts:1157-1175,1251`; retained/frozen after settle.                                               |
| `outputTruncated`        | draft                                                         | Execution latch `D/lifecycle.ts:140,167,178`; frozen after settle.                                                            |
| `resultIndex`            | canonical                                                     | Accepted settle result; snapshot lookup `D/broker.ts:8161-8166`.                                                              |
| `error`                  | canonical                                                     | Terminal outcome `D/lifecycle.ts:184-189`; settle owns persisted card copy.                                                   |
| `usage`                  | canonical when terminal, live-only otherwise                  | `D/lifecycle.ts:171,191`; exactly five known fields.                                                                          |
| `stopReason`             | canonical                                                     | Stop outcome construction `D/broker.ts:1249-1251`; settle owns card copy.                                                     |
| `finalText`              | canonical                                                     | `D/lifecycle.ts:180`; derive only from accepted settle answer, not snapshot text.                                             |
| `partialText`            | live-only while running, canonical for settled partial answer | `D/lifecycle.ts:139`; settle derives partial role separately.                                                                 |
| `phase`                  | live-only                                                     | `D/broker.ts:8237` projects current phase.                                                                                    |
| `queue`                  | live-only                                                     | `D/broker.ts:8238` projects live admission queue.                                                                             |
| `approvalPending`        | live-only                                                     | `D/lifecycle.ts:126,176`.                                                                                                     |
| `stopRequested`          | live-only                                                     | `D/broker.ts:8167,8206-8213` projects active stop policy.                                                                     |
| `workspaceObservation`   | live-only                                                     | Observation at `D/broker.ts:5693`; projection `:8219`.                                                                        |
| `feed`                   | live-only                                                     | Feed summary read for the calling agent on Inspect and Get Delegate Output; never persisted.                                  |
| `feedAssignment`         | live-only                                                     | Delegate Task hand-off receipt for the calling agent; never persisted.                                                        |
| `requestedModelLabel`    | live-only                                                     | Cloud chats' model name from the web core; desktop never sets it.                                                             |
| `reportedRoute`          | live-only                                                     | Cloud chats' report of the child's route (harness, runtime model) from the web core; desktop never sets it. CAN-6787.         |
| `type`                   | creation                                                      | None; reducer stamps `T/delegation-transcript.ts:120`.                                                                        |
| `agentBlockId`           | creation                                                      | None; deterministic generation ID `T/delegation-transcript.ts:20-22`.                                                         |
| `sequence`               | creation fallback                                             | Source advances (`D/broker.ts:1731,7538`), but raw write-once row keeps its first sequence; descriptor has its own revisions. |
| `parentHarnessId`        | creation                                                      | None within generation; `D/broker.ts:1732`.                                                                                   |
| `parentTurnId`           | creation                                                      | None within generation; `D/broker.ts:1733`.                                                                                   |
| `parentToolCallId`       | creation                                                      | None within generation; `D/broker.ts:1734`.                                                                                   |
| `createdAt`              | creation                                                      | None; preparation preserves admission time `D/broker.ts:5506`.                                                                |
| `selectedModelId`        | creation fallback / derived alias                             | Prepared route can change it; derive from draft route then requested ID, `T/delegation-transcript.ts:130`.                    |
| `runtimeModelId`         | creation fallback / derived alias                             | Prepared route; derive `T/delegation-transcript.ts:131`.                                                                      |
| `targetHarnessId`        | creation fallback / derived alias                             | Prepared route; derive `T/delegation-transcript.ts:132`.                                                                      |
| `requestedThinkingLevel` | creation fallback / derived alias                             | Prepared route; derive `T/delegation-transcript.ts:133`.                                                                      |
| `effectiveThinkingLevel` | creation fallback / derived alias                             | Prepared route; derive `T/delegation-transcript.ts:134`.                                                                      |
| `description`            | creation                                                      | None within generation; task projection `D/broker.ts:1737`.                                                                   |
| `prompt`                 | creation fallback with draft override                         | Queued same-generation coalescing `D/broker.ts:2480-2509`; root amendment 1 below.                                            |
| `executionMode`          | creation                                                      | None within generation; next continuation starts background `D/broker.ts:4380`.                                               |
| `transcriptStore`        | creation                                                      | None; immutable trusted generation store, never inferred from card presence.                                                  |
| `partialTextRef`         | canonical                                                     | Backend artifact binding at first settle, same frame as result/receipt. Never caller input.                                   |
| `finalTextRef`           | canonical                                                     | Same; accepted answer reference is never fitted or changed.                                                                   |

`STREAM_CARD_KEY_CLASSES` checks this inventory against every block key at
compile time. Its single labels represent the default class; the status,
control, usage, partial-answer and derived-alias exceptions above are normative.
V2's additional `answerUnavailable` is canonical; `detailOmitted` is draft
display metadata; `cardRevision` is the durable publication fence.

## Frozen signatures

```ts
persistedDelegationSnapshot(snapshot: AgentDelegationSnapshot): AgentDelegationSnapshot;
cardStateDraftFromSnapshot(snapshot: AgentDelegationSnapshot, options?: CardStateDraftOptions): CardStateDraft;
fitCardStateDraft(draft: CardStateDraft, options?: Pick<CardStateDraftOptions, 'settled'>): CardStateDraft;
overlayStreamBackedDelegationCard(card: DelegatedAgentCallBlock, state: CardState | null): DelegatedAgentCallBlock;
// CardStateDraftOptions: readonly prompt?: string; readonly settled?: boolean
// CardState = CardStateV1 | CardStateV2
updateCardState(input: DelegationTranscriptCardStateRequest, signal?: AbortSignal): Promise<DelegationTranscriptPortResult<DelegationTranscriptStreamState>>;
// input = { target, cardRevision, cardDraft }; settle gains optional cardDraft/cardRevision.
```

**Import paths.** The package index (`@canopy/agent-transcript`) exports
`persistedDelegationSnapshot`, `STREAM_CARD_KEY_CLASSES` and
`overlayStreamBackedDelegationCard`, and stays free of runtime protocol schema
imports: the renderer evaluates it at startup, and the protocol schema barrel
costs about 23 MB of heap there. `cardStateDraftFromSnapshot` and
`fitCardStateDraft` validate with protocol schemas, so main-process callers
import them from `@canopy/agent-transcript/lib/delegation-card-state`.
`index-runtime-imports.test.ts` fails if the index loads a schema barrel.

The legacy projection is only declared here in A0. S1 copies its body, spread,
deletes, property order and old export name verbatim, and re-exports from the
old module. It is never routed through the stream fitter. A0's new functions
are dormant stubs; V1 overlay remains unchanged.

## Encoded-byte bounds and complete reservation

Caps count UTF-8 bytes of JSON **values including quotes/brackets/braces**,
not raw UTF-8 character bytes. ASCII JSON keys are counted separately below.
Every nested object is strict. Every list has both an item bound and its
containing encoded-byte budget. Numeric counters are nonnegative safe integers
(at most 16 JSON bytes); usage values are nonnegative finite JS numbers (at
most 24 bytes). Known enums have finite literal sizes, not open string keys.

| Value or subtree                                                                                                |                                                                          Individual cap |                                    Collection / enclosing cap |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------: | ------------------------------------------------------------: |
| All route IDs, versions, revisions, hashes, provider/model/source/billing strings; all optional overlay strings |                                                                              1,024 each |                                           Entire route 12,000 |
| Route labels, capability names                                                                                  |                                                                              1,024 each |       Route capabilities 64; thinking levels 16; route 12,000 |
| `requestedModelId`, `nativeSessionId`                                                                           |                                                                              1,024 each |                                                  Draft 60,000 |
| `childDelegationIds[]`                                                                                          |                                                                              1,024 each |                                 64 items, encoded array 6,000 |
| Capability `items[].name`, `skipped[].name`                                                                     |                                                                              1,024 each |                 128 items + 64 skipped, entire summary 18,000 |
| `isolatedWorkspace.revision` (including empty string)                                                           |                                                                                   1,024 |                                                  Draft 60,000 |
| `control.operationId`, steering `attemptId`, `providerTurnId`                                                   |                                                                              1,024 each |                                         Entire control 18,000 |
| `control.error`, steering `reason`                                                                              |                                                                              4,096 each |                                         Entire control 18,000 |
| Apply issue `path`, `parentDiff`, failure `guidance`                                                            |                                                                   1,024 / 4,096 / 4,096 |        64 issues; entire apply failure 14,000; control 18,000 |
| `stoppedBy.delegationId`, `description`                                                                         |                                                                              1,024 each |                                       Whole attribution 2,048 |
| Canonical `error.message`                                                                                       |                                                                                   4,096 |          Whole error (including optional apply failure) 8,192 |
| Canonical usage keys                                                                                            | Exactly inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens, costUsd |                                  5 fixed keys; 24 bytes/value |
| Canonical `detailOmitted`                                                                                       |                                                                Literal `true`, optional |                  Included in the 64,000-byte canonical budget |
| One canonical answer preview, either role                                                                       |                                                8,192 UTF-16 units; 49,154 encoded bytes |                                              Never both roles |
| One canonical answer reference                                                                                  |             Artifact ID 1,024; sha256 64 hex; encoding/mediaType fixed; safe byteLength |                                         Whole reference 2,048 |
| Status/operation/control status/nesting/stop reason, capability enums, booleans                                 |                                                                    Only schema literals |                      Counted inside containing object budgets |
| Entire draft excluding `prompt` property                                                                        |                                                                                  60,000 |               All keys, punctuation, optional fields included |
| Entire canonical block                                                                                          |                                                                                  64,000 | All keys, punctuation, optional fields and reference included |
| Optional amended `prompt` (root amendment 1)                                                                    |                                          32,768 UTF-16 units; **196,610** encoded bytes |                              Separate; not charged to 128 KiB |

The conservative complete maximum is **60,000 + 32 + 13 + 64,000 = 124,045
bytes**, below **131,072** by **7,027**. The 32 bytes are
`,"cardRevision":9007199254740991`; the 13 bytes are `,"canonical":`.
The draft already includes outer braces and `version`; each subtree cap
includes all its own keys, commas, arrays, optional members and maximum
numbers. This reservation does not pretend that every per-field maximum can
coexist: the fitter enforces subtree caps and then the 60,000 draft cap.
Canonical fitting enforces 64,000 without borrowing draft space. Aggregate
refinement is an independent backstop. A canonical-only state is legal.

The prompt's separate maximum is 196,610 bytes (32,768 escaped code units at
6 bytes plus quotes), plus 10 bytes for `,"prompt":`. Thus the maximum full
encoded object with the override is **320,665 bytes**, while its non-prompt
aggregate stays at 124,045. This is an explicit exception, not a claim that
the total persisted object remains below 128 KiB.

### Deterministic fitter

S1 must fit encoded strings at code-unit boundaries, longest prefix satisfying
the byte cap. Preserve exact retained IDs/references where semantically
required; overlong optional display details can be omitted. Fit nested strings
first, lists in source order retaining the longest fitting prefix, then whole
subtrees. Increase omitted counters; mark diff truncation for shortened diffs.
Remove optional details in this fixed order to satisfy enclosing budgets:
apply diffs, apply issues, skipped capabilities, capability items, child IDs,
optional route labels/overlay, steering reason/error display details. If still
over budget omit optional route/control/capability subtrees in that order.
Never invent an execution outcome or modify accepted result/digest/body/ref.
Keep required minimal enum/discriminant members if retaining an object.

Before settle any omitted/shortened display detail sets `outputTruncated: true`.
After settle draft fitting sets draft `detailOmitted: true` and preserves the frozen execution
`outputTruncated` exactly. At first settle, fitting the canonical preview or error
message sets **canonical** `detailOmitted: true`; it never changes any chosen draft
field, including execution `outputTruncated`. This canonical signal is backend-owned,
inside the canonical subtree budget, and exists even on a canonical-only state.
Prompt is never truncated: it is already bounded
by admission and uses its separate budget. Reject an invalid prompt before
admission rather than silently changing the task.

## Canonical answer derivation

| Accepted answer       | Canonical answer fields                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `none`                | Neither preview nor reference; no unavailable flag                      |
| `empty`, role final   | `finalText: ''`; no ref; partial fields absent                          |
| `empty`, role partial | `partialText: ''`; no ref; final fields absent                          |
| `body`, role final    | Fitted `finalText`, exact bound `finalTextRef`; partial fields absent   |
| `body`, role partial  | Fitted `partialText`, exact bound `partialTextRef`; final fields absent |
| `lost`                | No preview or reference; `answerUnavailable: true`                      |

Terminal status, resultIndex, safe error, strict usage and stopReason come
only from the accepted settlement. First settle always writes canonical V2,
including with no draft. A0 does not alter the settlement digest.

## Publication fence, prompt and settled freeze

`cardRevision` is not execution sequence. 12b allocates a durable safe counter
for every changed fitted draft (including metadata-only changes), preserves it
on reopen, retries identical pairs, and refuses exhaustion. Updates compare
against stored publication revision: lower → `stale_identity`; equal identical
→ replay (no revision/event); equal different → `conflict`; higher → apply.
Unknown/deleted target → `not_found`; unauthorized → `unauthorized`; format 3
→ `unsupported_format`. Publication uses zero parent writes/no forced checkpoint.

First settle chooses the higher-revision stored/supplied V2 draft; stored wins
ties. A stale supplied draft never rejects settle. A missing draft still writes
canonical, using counter 0 if neither stored nor supplied revision exists.
Known-key settle replay returns the original index/receipt before mutable draft
comparison; changed digest still conflicts. Generic journal integrity remains.

Prompt is included only when the broker amended the queued prompt (12b records
that fact). While pending it may change. From the first non-pending draft it is
frozen, including presence/absence: equal passes, different → `stale_identity`.
V2 overlay applies prompt when present, otherwise retains raw row prompt.
Root's K3 refinement makes absent-means-absent apply to **optional** fields
only: required block/snapshot fields keep their creation fallback when the
state supplies no value. Thus canonical-only V2 shows canonical status and
the row's outputTruncated (false at creation). No storage default, type
widening or cast is introduced.

The complete required-key inventory is: `type`, `delegationId`, `status`,
`outputTruncated`, `agentBlockId`, `runGeneration`, `sequence`,
`parentHarnessId`, `parentTurnId`, `parentToolCallId`, `createdAt`,
`selectedModelId`, `runtimeModelId`, `targetHarnessId`, `description`, `prompt`,
`executionMode`. State fields override when present; creation-only keys stay
on the row. Route aliases use the supplied route/requested-model derivation
when available and retain the required raw alias otherwise. Optional thinking
aliases and all other optional draft/canonical keys are removed when absent.

| After settle     | Fields                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mutable draft    | isolatedWorkspace, workspaceDiscarded, completed/failed control, childDelegationIds, capabilities, nestedDelegation; detailOmitted may latch on fitting |
| Frozen draft     | status, prompt, routeSnapshot, requestedModelId, nativeSessionId, cancelledByUser, stoppedBy, outputTruncated                                           |
| Frozen canonical | Every canonical field and its reference                                                                                                                 |
| Never admitted   | Accepted control, in-flight partial text, phase/queue/approval/stop-request/workspace observation                                                       |

Post-settle controls explicitly include failed follow_up/resume/steer on the
old generation before allocation, and apply/discard and applyFailure. This
does not authorize capability extension the broker already forbids. Settled
content revision remains readable after metadata revisions.

## R2-B1 raw-row literals

These are complete ordinary first-appearance blocks, not partial pseudo-cards.
Both validators accept them unchanged; no validator hunk is needed. Undefined
thinking aliases from the reducer disappear under JSON serialization.

Absent route:

```json
{
  "delegationId": "d",
  "status": "pending",
  "requestedModelId": "requested",
  "outputTruncated": false,
  "type": "delegated_agent_call",
  "agentBlockId": "delegated-agent-d",
  "runGeneration": 1,
  "sequence": 0,
  "parentHarnessId": "codex",
  "parentTurnId": "turn",
  "parentToolCallId": "tool",
  "createdAt": 1,
  "selectedModelId": "requested",
  "runtimeModelId": "",
  "targetHarnessId": "",
  "description": "Task",
  "prompt": "Original",
  "executionMode": "background",
  "transcriptStore": "chat-stream-v2"
}
```

Prepared route:

```json
{
  "delegationId": "d",
  "status": "pending",
  "routeSnapshot": {
    "selectedModelId": "selected",
    "runtimeModelId": "runtime",
    "harnessId": "claude",
    "runtimeKind": "sdk",
    "runnerRegistrationId": "runner",
    "runtimeVersion": "1",
    "adapterVersion": "1",
    "modelSource": "agent",
    "providerType": "claude",
    "assignmentRevision": "1",
    "billingAuthority": "local",
    "aiCreditsRouted": false,
    "requestedThinkingLevel": "high",
    "effectiveThinkingLevel": "medium",
    "capabilities": [],
    "supportedThinkingLevels": [],
    "capabilitySnapshotHash": "hash",
    "capabilityGeneration": 1,
    "policyRevision": "1"
  },
  "outputTruncated": false,
  "type": "delegated_agent_call",
  "agentBlockId": "delegated-agent-d",
  "runGeneration": 1,
  "sequence": 0,
  "parentHarnessId": "codex",
  "parentTurnId": "turn",
  "parentToolCallId": "tool",
  "createdAt": 1,
  "selectedModelId": "selected",
  "runtimeModelId": "runtime",
  "targetHarnessId": "claude",
  "requestedThinkingLevel": "high",
  "effectiveThinkingLevel": "medium",
  "description": "Task",
  "prompt": "Original",
  "executionMode": "background",
  "transcriptStore": "chat-stream-v2"
}
```

## K8 consumer inventory

Search included desktop main/preload/renderer, desktop-shared, protocol,
web, app-core/app-state and both shared UI packages. Portal/web use their own
projections, not this TypeScript union; their live marker carry stays phase 16.

| Consumer                                                                                                                | New member handling                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| renderer `stores/chat/canonical-changes.ts`                                                                             | Explicit A0 ignore TODO(12a S3); S3 overlays matching loaded card only                                                     |
| renderer `stores/chat/slices/revisioned.ts`                                                                             | Explicit ignore TODO(12a S3) in commit-chat-ID inventory; normal revision envelope retained                                |
| renderer `stores/chat/revisioned-sync.ts`, state/revisioned store, render-cadence, `hooks/useChatEventSubscriptions.ts` | Generic envelope/revision routing, no exhaustive per-change switch; gap reload supersedes missing/old events               |
| renderer `lib/panels/test-api.ts`                                                                                       | Transports typed store events; no member-specific projection                                                               |
| desktop-shared `lib/chat-state-cadence.ts`                                                                              | Explicit non-token metadata (`false`); batches keep changes in order                                                       |
| desktop-shared `__tests__/chat-state-contract.test.ts`                                                                  | Exhaustive helper explicitly recognizes new member                                                                         |
| main `canopy-runtime/core-chat-events-adapter.ts`                                                                       | Explicit portable pass-through; no host paths or synthetic message                                                         |
| main `canopy-runtime/desktop-runtime.ts`, renderer-relay binding                                                        | Generic event capture/relay, no filtering by this member                                                                   |
| main `ipc/chat-state.ts`, `ipc/chat-state-delivery.ts`                                                                  | Envelope validation/revision delivery; runtime/tab side effects do not apply to new member; forwarded unchanged            |
| preload `api/chat-state-api.ts`                                                                                         | Typed subscription forwarding, no per-member switch                                                                        |
| main `services/chat-state-projection.ts`                                                                                | Maps journal mutations, not ChatStateChange input; S2 appends cardChanges separately                                       |
| main delegation service (frozen) / observability subscribers                                                            | Existing selected tab/message projections ignore unrecognized changes; no new ingress or stream-child expansion (phase 15) |
| Portal seed                                                                                                             | Uses backend merged snapshot (Integration); no direct ChatStateChange consumer                                             |
| Portal live/web projections                                                                                             | Distinct Portal event DTO; new chat-state member is not mapped; phase 16 owns marker carry                                 |
| transport/store/relay test doubles                                                                                      | Generic typed event arrays; exhaustive helper updated; new event fixture stays dormant                                     |

### ChatStateCommit DTO

The portable `core/chat/events.ts` discriminated union is also a consumer:
it explicitly validates the exact K8 member with `CardStateV2Schema`. The
core events adapter passes that portable member through. A protocol round-trip
test guards this boundary (no host-facing imports in the core schema).

The complete typed test-double inventory (all generic carriers unless noted):

- main tests: `chat-delta-journal-group-commit-repository`, `chat-state-delivery`,
  `chat-state-ipc`, `delegation-service`, `terminal-output-delivery`;
- runtime tests: `core-chat-events-adapter`, `w4-parity-harness`,
  `renderer-relay/__tests__/interim-in-memory-binding`;
- service tests: `chat-state-repository`, `chat-state-service`;
- preload tests: `chat-state-api`;
- renderer hook test: `useChatEventSubscriptions.render-cadence`;
- renderer store tests: `chatStore.render-cadence`, `chatStore.revisioned`,
  `chatStore.revisionedDeltas`, `chatStore.revisionedCommandPort`,
  `chatStore.revisionedTabLifecycle`, the shared `chatStoreRevisionedHarness`,
  `chatStoreSplit.equivalence`, `chatStoreSplit.render-count`;
- renderer chat tests: `canonical-changes`, `canonical-changes.todos`,
  `render-cadence`, `revisioned-sync`;
- desktop-shared `chat-state-contract` has the explicit exhaustive helper hunk.

These files use their existing `.test.ts`/`.test.tsx` extensions, except the
named parity harness and `chatStoreRevisionedHarness.ts`. No existing expected
value changes.

`cardChanges?: Extract<ChatStateChange, {type: 'delegation.card_state_updated'}>[]`
is additive and optional in A0. `chat-state-v2-repository.ts` ordered publisher
and listeners carry it; `chat-state-service.ts` publishCommit consumes it in
S2 (A0 does not emit). `chat-state-repository.ts` legacy implementation creates
no such changes. `chat-state-contracts.ts` command-port listeners and repository
test doubles transport the DTO without per-member exhaustive dispatch. No
new journal mutation, IPC channel, writer or action is introduced.

## Amendment 3: merges compose (A0 review B1)

The renderer applies an event to a card that is already merged, never to the raw row. A later merge must therefore
equal a fresh merge of the raw row: `overlay(overlay(raw, s1), s2)` deep-equals `overlay(raw, s2)` for every admitted
sequence `s1` then `s2` of one generation. Four presence rules make that hold without a display-only field:

- **Whole drafts.** Every `CardStateDraft` carries `status` and `outputTruncated`. A stored V2 state is either
  canonical-only or has both. Settle without a supplied draft keeps the stored draft, so a draft never disappears.
- **Monotonic status.** Once a stored draft's status is `running`, a later draft with `pending` is `stale_identity`.
  The prompt lock is therefore derived from the stored status alone, after reopen and after settle too.
- **Monotonic fallback sources.** `prompt`, `routeSnapshot` and `requestedModelId` feed required card keys. Once one
  is present in the stored state, a later draft without it is `stale_identity`. Values may still change while the
  rules above allow it (the prompt only while pending; the route and requested model until settle).
- **The fitter never removes a fallback source.** It may shorten route collections (`capabilities`,
  `supportedThinkingLevels`) and drop optional route members, but it never omits `routeSnapshot`, its alias members
  (`selectedModelId`, `runtimeModelId`, `harnessId`, the thinking levels), `requestedModelId` or the prompt override.

Both ports enforce these rules. The renderer only ever applies V2 events. Cards with V1 states are outside
convergence (they exist only in format 4 test scopes from before 12a).

**Canonical-only settled baseline (root clarification during S1).** If first settle
stored no draft, the first later whole draft at a higher publication counter is
admitted as the baseline, including its frozen fields. Nothing earlier is being
undone. Canonical fields remain unchanged and win for display. Subsequent drafts
compare against that baseline under the exact settled freeze and the presence
rules above. A missed pre-settle publication must not permanently block later
apply or discard metadata.

**First-settle inadmissible drafts (root clarification during S1).** A supplied
draft that drops a stored fallback source, returns running to pending, or changes
a locked prompt is ignored exactly like a stale draft. Settle keeps the stored
draft and its counter and still writes canonical state. An admissible higher
draft wins; equal or lower retains the stored draft. The draft cannot make an
otherwise valid settle fail.

This rule covers **well-formed** stale/inadmissible drafts only. A schema
violation, negative/non-safe counter, or an unpaired draft/counter is
`invalid_request` at the trust boundary, even with a stale counter. Rejection
consumes no result index. A known-key replay still short-circuits before all
card handling, including malformed optional display metadata.
