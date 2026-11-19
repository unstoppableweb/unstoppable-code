import type { SkillRiskInfo } from '@canopy/protocol/skills';

export interface MarketplaceSourceAddPlugin {
  readonly pluginKey: string;
  readonly name: string;
  readonly description: string;
  readonly syncError: string | null;
  readonly hooksStripped: boolean;
  readonly mcpOnly: boolean;
  readonly sourceUrl: string | null;
  readonly license: string | null;
  readonly securityAudit: SkillRiskInfo | null;
}

export interface MarketplaceSourceAddReview {
  readonly sourceId: string;
  readonly name: string;
  readonly revision: string;
  readonly pinnedRevision: string | null;
  readonly plugins: readonly MarketplaceSourceAddPlugin[];
  readonly pluginsReported: boolean;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly canConfirm: boolean;
  readonly syncError: string | null;
}

export interface MarketplaceSourceAddCompletion {
  readonly sourceId: string;
  readonly appliedRevision?: string;
}

export type MarketplaceSourceAddSnapshot =
  | {
      readonly phase: 'input';
      readonly error?: string;
      /** The host already recorded `error`, so its banner records nothing. */
      readonly recorded?: true;
    }
  | { readonly phase: 'registering' | 'cancelling' }
  | {
      readonly phase: 'previewing' | 'review' | 'confirming';
      readonly review: MarketplaceSourceAddReview;
      readonly error?: string;
    }
  | {
      readonly phase: 'reconciling' | 'uncertain';
      readonly error: string;
    }
  | {
      readonly phase: 'complete';
      readonly result: MarketplaceSourceAddCompletion;
    }
  | { readonly phase: 'closed' };

/** Trusted host binding; no credentials or account identifiers enter shared UI. */
export interface MarketplaceSourceAddContext {
  readonly isCurrent: () => boolean;
  readonly canCleanup: () => boolean;
}

/** One presentation session. Construction performs no reads or writes. */
export interface MarketplaceSourceAddSession {
  readonly mode: 'direct' | 'revision-review';
  readonly inputKind: 'github' | 'github-or-skills';
  getSnapshot(): MarketplaceSourceAddSnapshot;
  subscribe(listener: () => void): () => void;
  validate(input: string): string | null;
  submit(input: string): Promise<void>;
  retryPreview(): Promise<void>;
  retryReconciliation(): Promise<void>;
  confirm(): Promise<void>;
  cancel(): Promise<void>;
  dispose(): void;
}
