/** One recovery state owns the credit-card slot on every host. */
export function creditNoticeVisibility({
  creditHeld,
  aiCreditsBannerVisible,
}: {
  readonly creditHeld: boolean;
  readonly aiCreditsBannerVisible: boolean;
}): {
  readonly queuedCreditNoticeVisible: boolean;
  readonly aiCreditsBannerVisible: boolean;
} {
  return {
    queuedCreditNoticeVisible: creditHeld,
    aiCreditsBannerVisible: aiCreditsBannerVisible && !creditHeld,
  };
}
