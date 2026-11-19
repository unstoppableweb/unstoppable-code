/**
 * Side-effect entry that installs the local-only egress guard. Main's entry
 * imports it right after the build-storage startup module, so the guard is
 * in place before any later module initializes and can open a connection.
 * A no-op unless the local-only build profile is on.
 */
import { installLocalOnlyEgressGuard } from './egress-guard';

installLocalOnlyEgressGuard();
