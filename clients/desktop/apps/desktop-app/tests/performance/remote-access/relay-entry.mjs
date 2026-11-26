// The production device relay (apps/device-relay: configuration, logger and
// server) for the Remote Control runs, bound to loopback only. Production
// `main` listens on every interface; a harness relay on a developer's
// machine must not. Bundled and started by `startDeviceRelay` in
// desktops.mjs, which supplies PORT and DEVICE_RELAY_TOKEN_SECRET.
import { parseDeviceRelayEnvironment } from '../../../../device-relay/src/config.ts';
import { createLogger } from '../../../../device-relay/src/logger.ts';
import { createDeviceRelayServer } from '../../../../device-relay/src/server.ts';

const config = parseDeviceRelayEnvironment(process.env);
const logger = createLogger();
createDeviceRelayServer({
  host: '127.0.0.1',
  port: config.port,
  tokenSecret: config.tokenSecret,
  memoryBudgetBytes: config.memoryBudgetBytes,
  maxConnectionAgeMs: config.maxConnectionAgeMs,
  logger,
}).then(
  (server) => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => {
        server.close().catch(() => {
          process.exitCode = 1;
        });
      });
    }
  },
  (error) => {
    process.stderr.write(`device relay failed to start: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
