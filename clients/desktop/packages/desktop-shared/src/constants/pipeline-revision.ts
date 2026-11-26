/**
 * Main's refusal of a workflow run whose definition is not the one it was
 * chosen with (CAN-7513). The renderer recognizes it to offer review, not a
 * Retry that would be refused again.
 */
export const PIPELINE_REVISION_CHANGED_MESSAGE =
  'This workflow changed after you attached it. Send again to review it.';
