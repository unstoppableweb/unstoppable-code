/**
 * One recovery state owns the credit-card slot on every host. Precedence: a
 * held message wins, then "no billing source", then the "Using AI Credits"
 * card, so the composer never shows the card ("paid with AI Credits") beside
 * a notice that says nothing can pay.
 */
export function creditNoticeVisibility({
  creditHeld,
  noBillingSource = false,
  aiCreditsBannerVisible,
}: {
  readonly creditHeld: boolean;
  /**
   * The host shows its no-billing-source notice for this chat. A host that
   * renders no such notice passes `false` (the default).
   */
  readonly noBillingSource?: boolean;
  readonly aiCreditsBannerVisible: boolean;
}): {
  readonly queuedCreditNoticeVisible: boolean;
  readonly aiCreditsBannerVisible: boolean;
} {
  return {
    queuedCreditNoticeVisible: creditHeld,
    aiCreditsBannerVisible:
      aiCreditsBannerVisible && !creditHeld && !noBillingSource,
  };
}
