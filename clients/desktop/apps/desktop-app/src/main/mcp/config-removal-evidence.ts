import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isAbsentError } from './config-repository-format';

const deviceId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-f0-9-]+$/);
const recoveryId = z.string().uuid();
const counter = z.string().min(1).max(64).regex(/^\d+$/);
const timestamp = z
  .string()
  .min(1)
  .max(64)
  .regex(/^-?\d+$/);
export const MCP_REMOVAL_RECEIPT_MAX_BYTES = 128 * 1024;
const leafIdentity = z
  .object({
    device: counter,
    inode: counter,
    birth: timestamp,
    modified: timestamp,
    size: counter,
  })
  .strict();

const receiptSchema = z
  .object({
    version: z.literal(1),
    serverId: deviceId,
    recoveryId,
    source: leafIdentity.nullable(),
    configIds: z.array(deviceId).max(1024).nullable(),
    custody: z.boolean(),
    credentials: z.boolean(),
    index: z.enum(['pending', 'unresolved', 'complete']),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      (!receipt.custody && receipt.credentials) ||
      (!receipt.credentials && receipt.index !== 'pending') ||
      (receipt.configIds &&
        new Set(receipt.configIds).size !== receipt.configIds.length)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid removal stage order.',
      });
    }
  });

export type McpRemovalLeafIdentity = z.infer<typeof leafIdentity>;
export type McpRemovalReceipt = z.infer<typeof receiptSchema>;
export type McpRemovalLeaf =
  | { kind: 'absent' }
  | { kind: 'file'; identity: McpRemovalLeafIdentity }
  | { kind: 'unexpected' };

/** Paths and all durability/permission decisions are supplied by the trusted host. */
export interface McpRemovalEvidenceHost {
  assertAdmission(): void;
  /** Exclusive, private operation directory, durably linked up to the data root. */
  createOperation(recoveryId: string): Promise<void>;
  /** Refuse symlinked/non-private operation directories; never chmod the source. */
  assertPrivateOperation(recoveryId: string): Promise<void>;
  source(serverId: string): Promise<McpRemovalLeaf>;
  evidence(recoveryId: string): Promise<McpRemovalLeaf>;
  /** Bounded UTF-8 read of the regular, non-symlinked receipt (at most 128 KiB). */
  readReceipt(recoveryId: string): Promise<string>;
  /** Durable private write; exclusive for prepare, atomic replacement thereafter. */
  writeReceipt(receipt: McpRemovalReceipt, exclusive: boolean): Promise<void>;
  /** Rename only. Never unlink, copy-and-delete or replace an evidence leaf. */
  moveToEvidence(serverId: string, recoveryId: string): Promise<void>;
  /** Flush the private directory, and the source directory when a leaf moved. */
  flushCustody(
    serverId: string,
    recoveryId: string,
    sourceExisted: boolean,
  ): Promise<void>;
  /** Bounded scan; fail rather than truncating if the bound is exceeded. */
  listOperations(limit: number): Promise<string[]>;
}

export type McpRemovalEvidenceCode =
  | 'receipt_unusable'
  | 'receipt_limit'
  | 'source_changed'
  | 'evidence_conflict'
  | 'evidence_missing'
  | 'unexpected_leaf'
  | 'leaf_unreadable'
  | 'stage_order';

/** Deliberately excludes paths, raw documents and underlying parser diagnostics. */
export class McpRemovalEvidenceError extends Error {
  constructor(readonly code: McpRemovalEvidenceCode) {
    super(
      'Device MCP removal could not continue. Inspect the removal recovery before retrying.',
    );
    this.name = 'McpRemovalEvidenceError';
  }
}

export class McpRemovalPreparationError extends Error {
  constructor(readonly recoveryId: string) {
    super(
      'Device MCP removal preparation was not confirmed. Inspect recovery before retrying.',
    );
    this.name = 'McpRemovalPreparationError';
  }
}

export function sameMcpRemovalLeaf(
  left: McpRemovalLeafIdentity | null,
  right: McpRemovalLeafIdentity | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.device === right.device &&
        left.inode === right.inode &&
        left.birth === right.birth &&
        left.modified === right.modified &&
        left.size === right.size;
}

function identity(leaf: McpRemovalLeaf): McpRemovalLeafIdentity | null {
  if (leaf.kind === 'unexpected')
    throw new McpRemovalEvidenceError('unexpected_leaf');
  return leaf.kind === 'file' ? leaf.identity : null;
}

/**
 * Bounded removal-only custody, not general config/index publication recovery.
 * The repository must hold its server lease and a short disk-queue turn for
 * each call. Token cleanup and reference rewriting happen between calls.
 */
export class McpConfigRemovalEvidence {
  constructor(private readonly host: McpRemovalEvidenceHost) {}

  async read(serverId: string, id: string): Promise<McpRemovalReceipt> {
    deviceId.parse(serverId);
    recoveryId.parse(id);
    await this.host.assertPrivateOperation(id);
    let receipt: McpRemovalReceipt;
    try {
      const text = await this.host.readReceipt(id);
      if (Buffer.byteLength(text, 'utf8') > MCP_REMOVAL_RECEIPT_MAX_BYTES)
        throw new McpRemovalEvidenceError('receipt_unusable');
      receipt = receiptSchema.parse(JSON.parse(text));
    } catch {
      throw new McpRemovalEvidenceError('receipt_unusable');
    }
    if (receipt.serverId !== serverId || receipt.recoveryId !== id)
      throw new McpRemovalEvidenceError('receipt_unusable');
    return receipt;
  }

  async find(serverId: string): Promise<McpRemovalReceipt[]> {
    deviceId.parse(serverId);
    return (await this.listReceipts()).filter(
      (receipt) => receipt.serverId === serverId,
    );
  }

  async listReceipts(): Promise<McpRemovalReceipt[]> {
    const ids = await this.host.listOperations(128);
    if (ids.length > 128) throw new McpRemovalEvidenceError('receipt_limit');
    const receipts: McpRemovalReceipt[] = [];
    for (const id of ids) {
      // A damaged receipt cannot be treated as proof that no recovery exists.
      recoveryId.parse(id);
      await this.host.assertPrivateOperation(id);
      let parsed: McpRemovalReceipt;
      try {
        const text = await this.host.readReceipt(id);
        if (Buffer.byteLength(text, 'utf8') > MCP_REMOVAL_RECEIPT_MAX_BYTES)
          throw new McpRemovalEvidenceError('receipt_unusable');
        parsed = receiptSchema.parse(JSON.parse(text));
      } catch (error) {
        // A crash before the prepared receipt can leave an empty directory.
        // It is not a recovery and is never deleted automatically.
        if (
          isAbsentError(error) &&
          (await this.host.evidence(id)).kind === 'absent'
        )
          continue;
        throw new McpRemovalEvidenceError('receipt_unusable');
      }
      if (parsed.recoveryId !== id)
        throw new McpRemovalEvidenceError('receipt_unusable');
      receipts.push(parsed);
    }
    return receipts;
  }

  async prepare(options: {
    serverId: string;
    source: McpRemovalLeafIdentity | null;
    /** Null requires exact server-scoped cleanup by the OAuth owner. */
    configIds: string[] | null;
  }): Promise<McpRemovalReceipt> {
    this.host.assertAdmission();
    const receipt = receiptSchema.parse({
      version: 1,
      serverId: options.serverId,
      recoveryId: randomUUID(),
      source: options.source,
      configIds: options.configIds,
      custody: false,
      credentials: false,
      index: 'pending',
    });
    // Schema-valid config IDs can still exceed the bounded receipt reader.
    // Server-scoped OAuth cleanup does not require these optional identities.
    if (
      Buffer.byteLength(JSON.stringify(receipt), 'utf8') >
      MCP_REMOVAL_RECEIPT_MAX_BYTES
    )
      receipt.configIds = null;
    if (
      !sameMcpRemovalLeaf(
        receipt.source,
        identity(await this.host.source(receipt.serverId)),
      )
    )
      throw new McpRemovalEvidenceError('source_changed');
    try {
      await this.host.createOperation(receipt.recoveryId);
      await this.host.assertPrivateOperation(receipt.recoveryId);
      await this.host.writeReceipt(receipt, true);
    } catch {
      throw new McpRemovalPreparationError(receipt.recoveryId);
    }
    return receipt;
  }

  private async readCustodyState(
    serverId: string,
    id: string,
  ): Promise<{
    receipt: McpRemovalReceipt;
    evidence: McpRemovalLeafIdentity | null;
  }> {
    const receipt = await this.read(serverId, id);
    const source = identity(await this.host.source(serverId));
    const evidence = identity(await this.host.evidence(id));
    if (evidence !== null) {
      if (
        receipt.source === null ||
        !sameMcpRemovalLeaf(receipt.source, evidence)
      )
        throw new McpRemovalEvidenceError('evidence_conflict');
      // Includes a same-ID replacement after the original rename. Never adopt it.
      if (source !== null) throw new McpRemovalEvidenceError('source_changed');
    } else if (receipt.source !== null) {
      if (receipt.custody || source === null)
        throw new McpRemovalEvidenceError('evidence_missing');
      if (!sameMcpRemovalLeaf(receipt.source, source))
        throw new McpRemovalEvidenceError('source_changed');
    } else if (source !== null) {
      throw new McpRemovalEvidenceError('source_changed');
    }
    return { receipt, evidence };
  }

  /** Read-only incarnation fence before binding a pending uninstall pointer. */
  async validateCustody(
    serverId: string,
    id: string,
  ): Promise<McpRemovalReceipt> {
    return (await this.readCustodyState(serverId, id)).receipt;
  }

  async takeCustody(serverId: string, id: string): Promise<McpRemovalReceipt> {
    this.host.assertAdmission();
    const { receipt, evidence } = await this.readCustodyState(serverId, id);
    if (evidence === null && receipt.source !== null) {
      // The private exclusive directory and the repository lease exclude owned
      // races. This does not establish exclusion against another OS process.
      await this.host.moveToEvidence(serverId, id);
      if (
        !sameMcpRemovalLeaf(
          receipt.source,
          identity(await this.host.evidence(id)),
        )
      )
        throw new McpRemovalEvidenceError('evidence_conflict');
      if (identity(await this.host.source(serverId)) !== null)
        throw new McpRemovalEvidenceError('source_changed');
    }
    // Also re-flush on prepared-receipt replay after a crash just after rename.
    await this.host.flushCustody(serverId, id, receipt.source !== null);
    if (receipt.custody) return receipt;
    const next = { ...receipt, custody: true };
    await this.host.writeReceipt(next, false);
    return next;
  }

  /** The source must remain absent before later cleanup/reconciliation. */
  async assertRemoved(
    serverId: string,
    id: string,
  ): Promise<McpRemovalReceipt> {
    const receipt = await this.read(serverId, id);
    if (!receipt.custody) throw new McpRemovalEvidenceError('stage_order');
    if (identity(await this.host.source(serverId)) !== null)
      throw new McpRemovalEvidenceError('source_changed');
    const evidence = identity(await this.host.evidence(id));
    if (!sameMcpRemovalLeaf(receipt.source, evidence))
      throw new McpRemovalEvidenceError('evidence_missing');
    return receipt;
  }

  async confirmCredentials(
    serverId: string,
    id: string,
  ): Promise<McpRemovalReceipt> {
    this.host.assertAdmission();
    const receipt = await this.assertRemoved(serverId, id);
    const next = receiptSchema.parse({ ...receipt, credentials: true });
    await this.host.writeReceipt(next, false);
    return next;
  }

  async confirmIndex(
    serverId: string,
    id: string,
    state: 'unresolved' | 'complete',
  ): Promise<McpRemovalReceipt> {
    this.host.assertAdmission();
    const receipt = await this.assertRemoved(serverId, id);
    if (!receipt.credentials) throw new McpRemovalEvidenceError('stage_order');
    const next = receiptSchema.parse({ ...receipt, index: state });
    await this.host.writeReceipt(next, false);
    return next;
  }
}
