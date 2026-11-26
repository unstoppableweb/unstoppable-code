import { extractIpcErrorMessage } from '@/lib/errors';

// Translate known service errors at the renderer boundary so the service's
// error strings remain compatible with existing callers.
const LEGACY_MODEL_PRESET_MESSAGES: ReadonlyArray<
  readonly [RegExp, (match: RegExpExecArray) => string]
> = [
  [
    /^The imported Agent is locally changed or its original content is unknown\. Delete it from the Agents page instead\.$/,
    () =>
      "Couldn't remove this model preset because it has local changes or its original content couldn't be verified. Delete it from Customize → Model presets instead.",
  ],
  [/^Agent not found\.?$/, () => "Couldn't find this model preset."],
  [
    /^Agent model override must be a concrete model id\.$/,
    () => 'Choose a specific model to override this preset.',
  ],
  [
    /^Agent model override requires a valid Agent id\.$/,
    () => 'Choose a valid model preset before overriding its model.',
  ],
  [
    /^The shared Agent changed\. Refresh and review it before importing\.$/,
    () =>
      'This model preset changed while you were reviewing it. Refresh and review it again.',
  ],
  [
    /^Shared Agent references unavailable plugin "(.+)"\. Install it before importing this Agent\.$/,
    (match) =>
      `This model preset uses the plugin "${match[1]}", which isn't available. Install it, then try again.`,
  ],
  [
    /^An Agent named "(.+)" already exists\.$/,
    (match) => `A model preset named "${match[1]}" already exists.`,
  ],
  [
    /^The Agent is not an installed copy of this (public )?share\.$/,
    (match) =>
      `This model preset isn't an installed copy of this ${match[1] ?? ''}share.`,
  ],
  // An automation that runs on a shared model preset, as its share and
  // install review check it.
  [
    /^The shared Agent is unavailable or has changed\. Refresh it before sharing or installing this automation\.$/,
    () =>
      'The shared model preset is unavailable or has changed. Refresh it before sharing or installing this automation.',
  ],
  [
    /^Couldn't (share|install) this automation because packaged Agent "(.+)" can't be verified here\. Choose an Agent without packaged resources\.$/,
    (match) =>
      `Couldn't ${match[1] ?? 'share'} this automation because packaged model preset "${match[2] ?? ''}" can't be verified here. Choose a model preset without packaged resources.`,
  ],
  [
    /^The Agent has local changes or its shared snapshot could not be verified\. Share or refresh the Agent from Agents before sharing this automation\.$/,
    () =>
      "This model preset has local changes or its shared snapshot couldn't be verified. Share or refresh it in Model presets before sharing this automation.",
  ],
  [
    /^Couldn't install this automation\. Install or refresh Agent "(.+)" from Agents first, then try again\.$/,
    (match) =>
      `Couldn't install this automation. Install or refresh model preset "${match[1] ?? ''}" in Model presets first, then try again.`,
  ],
];

export function modelPresetErrorMessage(message: string): string {
  const reason = extractIpcErrorMessage(message);
  for (const [pattern, reword] of LEGACY_MODEL_PRESET_MESSAGES) {
    const match = pattern.exec(reason);
    if (match) return reword(match);
  }
  return message;
}
