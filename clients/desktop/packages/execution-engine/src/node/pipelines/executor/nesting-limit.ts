/**
 * The nesting depth at which the executor fails a step instead of running
 * it: a step inside nested workflows and composite actions runs only below
 * this depth. Top-level steps are depth 0. The daemon classifier refuses a
 * step at this depth as `too_deep`, so no host admits what the executor
 * refuses (CAN-6316 G5).
 */
export const MAX_NESTED_STEP_DEPTH = 10;
