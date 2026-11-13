import type { ApprovalMode } from '@canopy/desktop-shared/types';

/**
 * Mode names shown on the composer's approval trigger and, when the toolbar
 * has compressed that trigger away, on its "+" menu entry. The middle mode is
 * named for what it does unasked (it edits files in the project), which also
 * keeps it apart from the model picker's Auto.
 *
 * Kept out of `ApprovalModePicker.tsx` so that file exports only components —
 * mixing constants in breaks React Fast Refresh for the whole module.
 */
export const APPROVAL_MODE_MENU_LABELS: Record<ApprovalMode, string> = {
  ask: 'Ask',
  auto: 'Accept edits',
  'full-access': 'Full access',
};

/**
 * Mode names for prose surfaces — transcript receipts and anywhere the label
 * sits inside a sentence rather than on a control. The same names today;
 * kept separate so a sentence can diverge from a tight trigger again.
 */
export const APPROVAL_MODE_PROSE_LABELS: Record<ApprovalMode, string> = {
  ask: 'Ask',
  auto: 'Accept edits',
  'full-access': 'Full access',
};

/**
 * One-line subtitles under each mode in the approval picker. They leave out
 * that saved rules still answer in both prompting modes and that safety rules
 * block risky commands there; only Full access skips those safety rules.
 */
export const APPROVAL_MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  ask: 'Ask before running tools',
  auto: 'Read and edit project files without asking',
  'full-access': 'Skip approvals and safety rules',
};
