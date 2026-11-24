// The Linux dictation helper's staged and packaged payload (CAN-7230): the
// brand's dictation binary in bin/, with the two Moonshine Voice libraries it
// finds beside itself through its $ORIGIN RUNPATH. Linux arm64 is not a
// dictation target yet (CAN-4361), so it keeps excluding the helper.
export const LINUX_DICTATION_TARGETS = Object.freeze(['linux-x64']);
export const LINUX_DICTATION_LIBRARIES = Object.freeze([
  'libmoonshine.so',
  'libonnxruntime.so.1',
]);

export function isLinuxDictationTarget(target) {
  return LINUX_DICTATION_TARGETS.includes(target);
}
