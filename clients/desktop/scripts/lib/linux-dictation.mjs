// Linux x64 and arm64 release builds ship the brand's dictation helper and
// its two libraries side by side in bin/ (CAN-7230, CAN-7659). Arm64 VM
// development builds omit them.
export const LINUX_DICTATION_TARGETS = Object.freeze([
  'linux-x64',
  'linux-arm64',
]);
export const LINUX_DICTATION_LIBRARIES = Object.freeze([
  'libmoonshine.so',
  'libonnxruntime.so.1',
]);

export function isLinuxDictationTarget(target) {
  return LINUX_DICTATION_TARGETS.includes(target);
}
