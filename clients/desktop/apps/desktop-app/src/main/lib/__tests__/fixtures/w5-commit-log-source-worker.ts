// The CJS tsx worker shim cannot enter core-daemon's ESM package directly.
// Load the exact production entry through this test-only CJS-package module.
import '../../../../../../core-daemon/src/w5-commit-log-worker';
