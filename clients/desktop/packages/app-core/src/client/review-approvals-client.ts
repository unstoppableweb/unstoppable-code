import type {
  ReviewApprovalReadinessInput,
  ReviewApprovalReadinessResult,
} from '@canopy/protocol/settings';

/** How a "Link GitHub" click ended. */
export type ReviewApprovalLinkStart =
  /** Linked without leaving the page. */
  | 'linked'
  /** This tab is going to GitHub; the page's resume finishes the link. */
  | 'leaving'
  /** Linking continues elsewhere (desktop: Settings > Integrations in the browser). */
  | 'handoff';

/** A link whose GitHub round trip landed on this page. */
export type ReviewApprovalLinkResume = 'none' | 'linked' | 'failed';

/**
 * Review approval readiness and the GitHub identity link behind the "Link
 * GitHub" calls to action. Present only when the host reports
 * `capabilities.reviewApprovalReadiness`. Shared UI never asks which host it
 * is on: it reads the capability and these outcomes.
 */
export interface ReviewApprovalsClient {
  /**
   * The signed-in person's readiness for one run owner and repository. The
   * result is lenient: treat any state outside
   * `REVIEW_APPROVAL_READINESS_STATES` as "show nothing".
   */
  readiness(
    input: ReviewApprovalReadinessInput,
    signal?: AbortSignal,
  ): Promise<ReviewApprovalReadinessResult>;
  /**
   * Start linking GitHub, from a click. `returnTo` must be a same-origin
   * relative path; anything else is refused.
   */
  startLink(input: { returnTo: string }): Promise<ReviewApprovalLinkStart>;
  /** Finish a link whose round trip landed here. Single-flight per page load. */
  resumeLink(): Promise<ReviewApprovalLinkResume>;
  /**
   * Calls `listener` when the signed-in account behind this port changes, so
   * cached readiness answers are dropped. Optional: a host that builds a new
   * port for each signed-in user needn't provide it. Returns an unsubscribe.
   */
  subscribeAccountChange?(listener: () => void): () => void;
}
