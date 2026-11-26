const OSC_SEQUENCE = new RegExp(
  String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`,
  'g',
);
const CSI_SEQUENCE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, 'g');
// eslint-disable-next-line no-control-regex -- the pattern is for them.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

/** The longest reason shown; main already caps the CLI's own line. */
const MAX_DETAIL_LENGTH = 400;

/**
 * The reason a failed Antigravity sign-in printed: its last non-empty line,
 * without terminal styling. Main ends a failed sign-in with exactly one such
 * line (`antigravity/sign-in.ts`); the masked code echo is never it.
 */
export function findAntigravityLoginFailure(output: string): string | null {
  const lines = output
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .split(/\r?\n|\r/u)
    .map((line) => line.replace(CONTROLS, '').trim())
    // A line ending in `*` is the masked code the person typed.
    .filter((line) => line.length > 0 && !line.endsWith('*'));
  const last = lines[lines.length - 1];
  return last ? last.slice(0, MAX_DETAIL_LENGTH) : null;
}
