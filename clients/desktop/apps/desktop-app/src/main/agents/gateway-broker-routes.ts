// Hosted by core-runtime so the daemon broker accepts the same requests (CAN-6997).
export {
  CLAUDE_BROKER_ALLOWED_PATHS,
  CLAUDE_BROKER_ALLOWED_QUERIES,
  CLAUDE_BROKER_FORWARD_HEADERS,
  CODEX_BROKER_ALLOWED_PATHS,
  LOOPBACK_BROKER_AUTH_TOKEN,
} from '@canopy/core-runtime/node/model-broker/broker-routes';
