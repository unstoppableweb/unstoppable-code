import { randomUUID } from 'node:crypto';
import type { CopilotPilotState } from './repository/copilot-pilot-state';
import { canonicalCopilotJson as canonical } from './repository/copilot-authority-codec';
import type { MigrationFamilyPorts } from './migration-ports';
import type { VaultSecretPin } from '../../vault/contracts';

/** Structural trusted seam. No recipient dependency and no consumer wire capability. */
export interface CopilotUseBinding {
  readonly head: {
    readonly epoch: string;
    readonly account: { readonly host: string; readonly id: string };
    readonly pin: VaultSecretPin;
  };
  readonly authorityGeneration: number;
  readonly publicationGeneration: number;
  readonly purpose: string;
  readonly audience: { readonly kind: string; readonly operationId: string };
}
export interface CopilotUseCompletion {
  readonly handle: string;
  readonly binding: CopilotUseBinding;
  readonly presentations: readonly {
    readonly id: string;
    readonly handle: string;
    readonly binding: CopilotUseBinding;
    readonly committedPin: VaultSecretPin | null;
    readonly expiresAt: number;
  }[];
  readonly providerSuccess: true;
  readonly admittedCompletion: true;
}
/** A fresh supported model-discovery operation is required on each verification attempt. */
export function createCopilotMigrationUse(options: {
  state: CopilotPilotState;
  current(): boolean;
  /** Bind the fresh supported operation's existing audience to this request. */
  discoverModels(
    operationId: string,
    completed: (evidence: CopilotUseCompletion) => void,
  ): Promise<void>;
  wallNow?: () => number;
}): NonNullable<MigrationFamilyPorts['use']> {
  let busy = false;
  return {
    async use(context) {
      if (busy || !options.current()) return { kind: 'unavailable' };
      busy = true;
      let evidence: CopilotUseCompletion | undefined;
      let accepting = true;
      let repeated = false;
      try {
        const before = options.state.read();
        const b = before.binding;
        const head = before.authority.head;
        if (
          !b ||
          !head ||
          b.phase !== 'published' ||
          b.attemptId !== context.attemptId ||
          b.migrationEpoch !== context.epoch ||
          b.identity.generation !== context.generation ||
          head.epoch !== b.accountEpoch ||
          canonical(head.pin) !== canonical(context.pin)
        )
          return { kind: 'unavailable' };
        const operationId = randomUUID();
        await options.discoverModels(operationId, (completion) => {
          if (!accepting || evidence) {
            repeated = true;
            return;
          }
          evidence = structuredClone(completion);
        });
        accepting = false;
        const final = options.state.read();
        const resolved = options.state.migration.resolve(context.attemptId);
        const now = (options.wallNow ?? Date.now)();
        if (
          !evidence ||
          repeated ||
          !options.current() ||
          canonical(before) !== canonical(final) ||
          resolved.kind !== 'committed' ||
          canonical(resolved.pin) !== canonical(context.pin) ||
          canonical(resolved.successorKeys) !==
            canonical(context.successorKeys) ||
          !evidence.providerSuccess ||
          !evidence.admittedCompletion ||
          evidence.binding.purpose !== 'models' ||
          evidence.binding.audience.operationId !== operationId ||
          evidence.binding.head.epoch !== b.accountEpoch ||
          evidence.binding.head.account.id !== b.account.id ||
          evidence.binding.head.account.host !== b.account.host ||
          canonical(evidence.binding.head.pin) !== canonical(context.pin) ||
          !evidence.presentations.length ||
          evidence.presentations.length > 8 ||
          evidence.presentations.some(
            (p) =>
              p.handle !== evidence?.handle ||
              !p.committedPin ||
              p.expiresAt <= now ||
              canonical(p.committedPin) !== canonical(resolved.pin) ||
              p.binding.head.epoch !== evidence?.binding.head.epoch ||
              p.binding.authorityGeneration !==
                evidence?.binding.authorityGeneration ||
              p.binding.publicationGeneration !==
                evidence?.binding.publicationGeneration ||
              p.binding.purpose !== evidence?.binding.purpose ||
              canonical(p.binding.audience) !==
                canonical(evidence?.binding.audience) ||
              canonical(p.binding.head) !== canonical(evidence?.binding.head),
          )
        )
          return { kind: 'unavailable' };
        return {
          kind: 'used',
          receipt: {
            id: operationId,
            pin: resolved.pin,
            successorKeys: resolved.successorKeys,
            provenance: canonical(evidence),
          },
        };
      } catch {
        return { kind: 'unavailable' };
      } finally {
        accepting = false;
        busy = false;
      }
    },
  };
}
