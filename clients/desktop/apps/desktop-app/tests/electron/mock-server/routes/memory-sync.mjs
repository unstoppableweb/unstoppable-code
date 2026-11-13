// Canopy Cloud memory sync surface (CAN-5188), for the Electron flows of the
// Memory settings and panel. It serves the routes the desktop engine calls
// (apps/desktop-app/src/main/memory/sync/transport.ts) with the contract in
// packages/protocol/src/memory-sync and the design's §7:
//
//   GET/PUT  /api/v1/memory-sync/settings
//   POST     /api/v1/memory-sync/devices/register
//   POST     /api/v1/memory-sync/scopes/resolve
//   GET      /api/v1/memory-sync/scopes/:id/snapshot
//   GET      /api/v1/memory-sync/scopes/:id/changes
//   POST     /api/v1/memory-sync/scopes/:id/notes
//   POST     /api/v1/memory-sync/scopes/:id/lease/{acquire,renew,release}
//   POST     /api/v1/memory-sync/scopes/:id/commits
//   GET      /api/v1/memory-sync/scopes/:id/revisions
//   POST     /api/v1/memory-sync/scopes/:id/restore
//   POST     /api/v1/memory-sync/scopes/:id/usage
//   POST     /api/v1/memory-sync/purge
//   GET      /api/v1/memory-sync/stream   → 404, so the desktop relies on pulls
//
// A key opts in with a `memorySync` slice in its registered scenario
// (`{ memorySync: { enabled } }`); any other key gets 404 on every route, as a
// server with the rollout off. State lives on the scenario object, so it is
// dropped with it. `GET /__mock/memory-sync/:key` returns the scope's
// documents, notes and revisions for assertions.
//
// Deliberate simplifications: one user scope per key, no retention, no
// quotas, no secret scan, and leases never expire (a test runs well inside
// the 90 s TTL).

import { createHash, randomUUID } from 'node:crypto';
import { getScenario, keyFromBearer } from '../control-plane.mjs';

const PREFIX = '/api/v1/memory-sync/';
const CONTROL_PATH = /^\/__mock\/memory-sync\/([^/]+)$/;
const LEASE_TTL_MS = 90_000;
const LEASE_MAX_MS = 40 * 60_000;

function json(response, status, body) {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function failure(response, status, code, retry, extra = {}) {
  json(response, status, {
    error: { code, message: code, retry, ...extra },
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function identity(path) {
  return path === 'MEMORY.md' ? path : path.toLowerCase();
}

function ulid() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = Date.now();
  let encoded = '';
  for (let index = 0; index < 10; index += 1) {
    encoded = alphabet[time % 32] + encoded;
    time = Math.floor(time / 32);
  }
  for (let index = 0; index < 16; index += 1) {
    encoded += alphabet[Math.floor(Math.random() * 32)];
  }
  return encoded;
}

/** The key's memory sync state, created on first use. */
function stateFor(key) {
  const scenario = getScenario(key);
  const slice = scenario.memorySync;
  if (slice === undefined || slice === null) return null;
  if (scenario.memorySyncState === undefined) {
    const now = new Date().toISOString();
    scenario.memorySyncState = {
      settings: {
        revision: 1,
        enabled: slice.enabled === true,
        enabledAt: slice.enabled === true ? now : null,
        userScope: 'sync',
        defaultProjectScope: 'sync',
        serverConsolidation: 'allowed',
      },
      policy: {
        blockedOriginOrganizationIds: [],
        serverConsolidationAvailable:
          slice.serverConsolidationAvailable === true,
      },
      sessions: new Map(),
      scope: null,
    };
  }
  return scenario.memorySyncState;
}

function newScope(accountId) {
  const now = new Date().toISOString();
  return {
    record: {
      scopeId: randomUUID(),
      accountId,
      kind: 'user',
      projectId: null,
      syncState: 'active',
      serverConsolidation: 'inherit',
      createdAt: now,
      updatedAt: now,
    },
    revision: 0,
    seq: 0,
    generation: 1,
    documents: new Map(),
    notes: new Map(),
    feed: [],
    commits: new Map(),
    lease: null,
    leaseEpoch: 0,
    deleted: false,
  };
}

function cursor(scope, seq = scope.seq) {
  return `mc1.${scope.record.scopeId}.${scope.generation}.${seq}`;
}

function scopeRecord(scope) {
  return { ...scope.record, revision: scope.revision, cursor: cursor(scope) };
}

function append(scope, entry) {
  scope.seq += 1;
  scope.feed.push({ ...entry, seq: scope.seq });
}

function applyRevision(scope, input) {
  const at = new Date().toISOString();
  const revision = scope.revision + 1;
  for (const change of input.changes) {
    if (change.op === 'put') {
      scope.documents.set(identity(change.path), {
        path: change.path,
        content: change.content,
        contentHash: change.contentHash,
        changedInRevision: revision,
      });
    } else scope.documents.delete(identity(change.path));
  }
  for (const noteId of input.consumedNoteIds) {
    const note = scope.notes.get(noteId);
    if (note !== undefined) {
      scope.notes.set(noteId, {
        ...note,
        state: 'consolidated',
        consumedInRevision: revision,
        closedAt: at,
      });
    }
  }
  const record = {
    revision,
    parentRevision: revision - 1,
    commitId: input.commitId,
    kind: input.kind,
    committedAt: at,
    holder: input.holder,
    model: input.model ?? null,
    promptVersion: input.promptVersion ?? null,
    consolidationPackageVersion: input.consolidationPackageVersion ?? null,
    inputHash: input.inputHash ?? null,
    changedPaths: input.changes.map((change) => change.path),
    consumedNoteCount: input.consumedNoteIds.length,
    restoredFromRevision: input.restoredFromRevision ?? null,
  };
  scope.revision = revision;
  scope.commits.set(record.commitId, record);
  append(scope, {
    kind: 'revision',
    revision: record,
    changes: input.changes,
    consumedNoteIds: input.consumedNoteIds,
  });
  return record;
}

function feedChange(scope, entry) {
  const seq = String(entry.seq);
  if (entry.kind === 'note_put') {
    const note = scope.notes.get(entry.noteId);
    return note === undefined ? null : { kind: 'note_put', seq, note };
  }
  if (entry.kind === 'note_removed') {
    return { kind: 'note_removed', seq, ...entry.removed };
  }
  return {
    kind: 'revision',
    seq,
    revision: entry.revision,
    changes: entry.changes,
    consumedNoteIds: entry.consumedNoteIds,
  };
}

function holder(state, request) {
  const sessionId = request.headers['x-canopy-memory-device-session'];
  const device =
    typeof sessionId === 'string' ? state.sessions.get(sessionId) : undefined;
  return device === undefined
    ? { kind: 'web' }
    : { kind: 'desktop', deviceId: device.deviceId, deviceLabel: device.label };
}

function liveLease(scope) {
  return scope.lease !== null &&
    scope.lease.state === 'active' &&
    Date.parse(scope.lease.lease.expiresAt) > Date.now()
    ? scope.lease
    : null;
}

function grant(scope, sessionId, reason, owner) {
  const now = Date.now();
  scope.leaseEpoch += 1;
  scope.lease = {
    sessionId,
    state: 'active',
    lease: {
      leaseId: randomUUID(),
      epoch: scope.leaseEpoch,
      holder: owner,
      reason,
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LEASE_TTL_MS).toISOString(),
      maxUntil: new Date(now + LEASE_MAX_MS).toISOString(),
      baseRevision: scope.revision,
    },
  };
  return scope.lease;
}

function documentsAt(scope, revision) {
  const documents = new Map();
  for (const entry of scope.feed) {
    if (entry.kind !== 'revision' || entry.revision.revision > revision)
      continue;
    for (const change of entry.changes) {
      if (change.op === 'put') {
        documents.set(identity(change.path), {
          path: change.path,
          content: change.content,
          contentHash: change.contentHash,
        });
      } else documents.delete(identity(change.path));
    }
  }
  return documents;
}

function scopeRoute(state, scope, rest, request, body, url, response) {
  const method = request.method;
  const step = rest[0];
  if (step === 'snapshot' && method === 'GET') {
    json(response, 200, {
      scopeId: scope.record.scopeId,
      revision: scope.revision,
      cursor: cursor(scope),
      documents: [...scope.documents.values()].map((document) => ({
        ...document,
        changedInRevision: document.changedInRevision ?? 1,
      })),
      pendingNotes: [...scope.notes.values()].filter(
        (note) => note.state === 'pending',
      ),
      nextPageToken: null,
    });
    return;
  }
  if (step === 'changes' && method === 'GET') {
    const parts = (url.searchParams.get('cursor') ?? '').split('.');
    const from = Number(parts[3]);
    if (
      parts[0] !== 'mc1' ||
      parts[1] !== scope.record.scopeId ||
      Number(parts[2]) !== scope.generation ||
      !Number.isInteger(from) ||
      from > scope.seq
    ) {
      failure(response, 410, 'memory_cursor_expired', 'after_snapshot');
      return;
    }
    const changes = scope.feed
      .filter((entry) => entry.seq > from)
      .map((entry) => feedChange(scope, entry))
      .filter((change) => change !== null);
    json(response, 200, {
      scopeId: scope.record.scopeId,
      changes,
      nextCursor: cursor(scope),
      hasMore: false,
      headRevision: scope.revision,
    });
    return;
  }
  if (step === 'notes' && method === 'POST') {
    const results = body.ops.map((op) => {
      if (op.op === 'tombstone') {
        const note = scope.notes.get(op.noteId);
        if (note?.state === 'pending') {
          const at = new Date().toISOString();
          scope.notes.set(op.noteId, {
            ...note,
            state: 'tombstoned',
            closedAt: at,
          });
          append(scope, {
            kind: 'note_removed',
            removed: { noteId: op.noteId, reason: 'tombstoned', at },
          });
        }
        return { noteId: op.noteId, outcome: 'applied' };
      }
      const known = scope.notes.get(op.note.noteId);
      if (known !== undefined)
        return { noteId: op.note.noteId, outcome: 'replayed' };
      scope.notes.set(op.note.noteId, {
        ...op.note,
        state: 'pending',
        receivedAt: new Date().toISOString(),
        consumedInRevision: null,
        closedAt: null,
      });
      append(scope, { kind: 'note_put', noteId: op.note.noteId });
      return { noteId: op.note.noteId, outcome: 'applied' };
    });
    json(response, 200, { results, cursor: cursor(scope) });
    return;
  }
  if (step === 'lease' && method === 'POST') {
    const sessionId = request.headers['x-canopy-memory-device-session'] ?? null;
    if (rest[1] === 'acquire') {
      const live = liveLease(scope);
      if (live !== null && live.sessionId !== sessionId) {
        failure(response, 409, 'memory_lease_held', 'later', {
          retryAfterMs: 1_000,
        });
        return;
      }
      const granted =
        live ?? grant(scope, sessionId, body.reason, holder(state, request));
      json(response, 200, {
        lease: granted.lease,
        pendingNoteCount: [...scope.notes.values()].filter(
          (note) => note.state === 'pending',
        ).length,
        usage: { trackingSince: null, entries: [] },
      });
      return;
    }
    if (rest[1] === 'renew') {
      if (scope.lease?.lease.epoch !== body.epoch) {
        failure(response, 409, 'memory_lease_lost', 'never');
        return;
      }
      json(response, 200, { lease: scope.lease.lease });
      return;
    }
    if (rest[1] === 'release') {
      if (scope.lease?.lease.epoch === body.epoch)
        scope.lease.state = 'released';
      json(response, 204);
      return;
    }
  }
  if (step === 'commits' && method === 'POST') {
    const replayed = scope.commits.get(body.commitId);
    if (replayed !== undefined) {
      json(response, 200, { revision: replayed, cursor: cursor(scope) });
      return;
    }
    if (
      body.lease !== null &&
      (scope.lease?.state !== 'active' ||
        scope.lease.lease.epoch !== body.lease.epoch)
    ) {
      failure(response, 409, 'memory_lease_lost', 'never');
      return;
    }
    if (body.baseRevision !== scope.revision) {
      failure(response, 409, 'memory_revision_conflict', 'after_pull', {
        headRevision: scope.revision,
      });
      return;
    }
    const revision = applyRevision(scope, {
      ...body.metadata,
      commitId: body.commitId,
      kind: body.kind,
      changes: body.changes,
      consumedNoteIds: body.consumedNoteIds,
      holder: holder(state, request),
    });
    json(response, 200, { revision, cursor: cursor(scope) });
    return;
  }
  if (step === 'revisions' && method === 'GET') {
    json(response, 200, {
      revisions: [...scope.commits.values()].sort(
        (left, right) => right.revision - left.revision,
      ),
      nextBefore: null,
    });
    return;
  }
  if (step === 'restore' && method === 'POST') {
    if (body.baseRevision !== scope.revision) {
      failure(response, 409, 'memory_revision_conflict', 'after_pull');
      return;
    }
    const target = documentsAt(scope, body.targetRevision);
    const changes = [];
    for (const [key, document] of scope.documents) {
      if (!target.has(key)) changes.push({ op: 'delete', path: document.path });
    }
    for (const [key, document] of target) {
      if (scope.documents.get(key)?.contentHash !== document.contentHash) {
        changes.push({ op: 'put', ...document });
      }
    }
    const revision = applyRevision(scope, {
      commitId: body.commitId,
      kind: 'restore',
      changes,
      consumedNoteIds: [],
      holder: holder(state, request),
      restoredFromRevision: body.targetRevision,
    });
    json(response, 200, { revision, cursor: cursor(scope) });
    return;
  }
  if (step === 'usage' && method === 'POST') {
    json(response, 204);
    return;
  }
  json(response, 404);
}

export async function handleMemorySyncRequest(request, response, url) {
  const control = CONTROL_PATH.exec(url.pathname);
  if (control !== null && request.method === 'GET') {
    const state = stateFor(decodeURIComponent(control[1]));
    const scope = state?.scope ?? null;
    json(response, 200, {
      settings: state?.settings ?? null,
      documents: scope === null ? [] : [...scope.documents.values()],
      notes: scope === null ? [] : [...scope.notes.values()],
      revisions: scope === null ? [] : [...scope.commits.values()],
    });
    return true;
  }
  if (!url.pathname.startsWith(PREFIX)) return false;
  const key = keyFromBearer(request);
  const state = key === null ? null : stateFor(key);
  if (state === null) {
    json(response, 404);
    return true;
  }
  const accountId = request.headers['x-canopy-memory-account'];
  const parts = url.pathname.slice(PREFIX.length).split('/');
  const body = request.method === 'GET' ? undefined : await readBody(request);
  if (parts[0] === 'stream') {
    json(response, 404);
    return true;
  }
  if (parts[0] === 'settings') {
    if (request.method === 'PUT') {
      if (body?.revision !== state.settings.revision) {
        failure(response, 409, 'memory_settings_conflict', 'after_pull');
        return true;
      }
      const { revision: _revision, ...changes } = body;
      state.settings = {
        ...state.settings,
        ...changes,
        revision: state.settings.revision + 1,
        enabledAt:
          changes.enabled === true && !state.settings.enabled
            ? new Date().toISOString()
            : state.settings.enabledAt,
      };
    }
    json(response, 200, { settings: state.settings, policy: state.policy });
    return true;
  }
  if (parts[0] === 'devices' && parts[1] === 'register') {
    const sessionId = randomUUID();
    state.sessions.set(sessionId, {
      deviceId: body.device.deviceId,
      label: body.device.label,
    });
    json(response, 200, {
      deviceSessionId: sessionId,
      minimumProtocolVersion: 1,
      serverTime: new Date().toISOString(),
      ingestEnabled: true,
      settings: state.settings,
      policy: state.policy,
    });
    return true;
  }
  if (parts[0] === 'purge') {
    if (state.scope !== null) state.scope.deleted = true;
    state.settings = {
      ...state.settings,
      enabled: false,
      revision: state.settings.revision + 1,
    };
    json(response, 204);
    return true;
  }
  if (!state.settings.enabled && request.method !== 'GET') {
    failure(response, 403, 'memory_sync_disabled', 'never');
    return true;
  }
  if (parts[0] === 'scopes' && parts[1] === 'resolve') {
    if (state.scope === null || state.scope.deleted) {
      if (body?.create !== true) {
        failure(response, 404, 'memory_scope_not_found', 'never');
        return true;
      }
      state.scope = newScope(accountId);
      json(response, 200, { scope: scopeRecord(state.scope), created: true });
      return true;
    }
    json(response, 200, { scope: scopeRecord(state.scope), created: false });
    return true;
  }
  if (
    parts[0] === 'scopes' &&
    state.scope !== null &&
    parts[1] === state.scope.record.scopeId
  ) {
    if (state.scope.deleted) {
      failure(response, 410, 'memory_scope_deleted', 'never');
      return true;
    }
    scopeRoute(
      state,
      state.scope,
      parts.slice(2),
      request,
      body,
      url,
      response,
    );
    return true;
  }
  failure(response, 404, 'memory_scope_not_found', 'never');
  return true;
}

/** The SHA-256 a document put carries, for tests that seed documents. */
export function memorySyncContentHash(content) {
  return sha256(content);
}
