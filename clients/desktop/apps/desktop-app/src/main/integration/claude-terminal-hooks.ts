import { DESKTOP_INTEGRATION_TOKEN_ENV_VAR } from '@canopy/desktop-shared/lib/desktop-integration-transport';
import {
  TRUSTED_NODE_POSIX_SCRUB,
  TRUSTED_NODE_WINDOWS_SCRUB,
  quoteTrustedNodePosixArg,
} from '../lib/trusted-node-environment';

const APPROVAL_TRANSPORT_TIMEOUT_MS = 590_000;

export function buildClaudeTerminalHookCallbackScript(input: {
  hookUrl: string;
}): string {
  return `const http = require('node:http');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function postJson(url, body, token) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    let transportTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (transportTimer !== undefined) clearTimeout(transportTimer);
      resolve(value);
    };
    const deny = (reason) => finish(
      body.hookEventName === 'PreToolUse'
        ? {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
            },
          }
        : undefined
    );
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    req = http.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Bearer ' + token,
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          deny('Approval service rejected the request.');
          return;
        }
        try {
          if (!responseBody) {
            deny('Approval service returned an empty response.');
            return;
          }
          finish(JSON.parse(responseBody));
        } catch {
          deny('Approval service returned an invalid response.');
        }
      });
    });
    req.on('error', () => deny('Approval service request failed.'));
    transportTimer = setTimeout(() => {
      deny('Approval service request timed out.');
      req.destroy();
    }, ${APPROVAL_TRANSPORT_TIMEOUT_MS});
    req.end(payload);
  });
}

(async () => {
  const hookEventName = process.argv[2];
  const token = process.env[${JSON.stringify(DESKTOP_INTEGRATION_TOKEN_ENV_VAR)}] || '';
  let hookPayload = {};
  try {
    const raw = await readStdin();
    hookPayload = raw ? JSON.parse(raw) : {};
  } catch {
    hookPayload = {};
  }
  const result = await postJson(${JSON.stringify(input.hookUrl)}, { hookEventName, hookPayload }, token);
  if (result !== undefined) {
    process.stdout.write(JSON.stringify(result));
  }
})().catch(() => {
  if (process.argv[2] !== 'PreToolUse') {
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Approval hook failed.',
    },
  }));
});
`;
}

export function buildPosixNodeStub(
  jsFileName: string,
  nodePath: string,
): string {
  const command = `${quoteTrustedNodePosixArg(nodePath)} --disable-sigusr1 "$script_dir/${jsFileName}" "$@"`;
  // Claude treats ordinary nonzero hook exits as nonblocking errors, not denials.
  return `#!/bin/sh
${TRUSTED_NODE_POSIX_SCRUB}
script_dir=\${0%/*}
[ "$script_dir" != "$0" ] || script_dir=.
if [ "\${1-}" = PreToolUse ]; then
  ${command}
  status=$?
  if [ "$status" -ne 0 ]; then
    printf '%s\\n' 'Approval hook failed. Restart this session to try again.' >&2
    exit 2
  fi
  exit 0
fi
exec ${command}
`;
}

export function buildWindowsNodeStub(
  jsFileName: string,
  nodePath: string,
): string {
  return `@echo off
setlocal DisableDelayedExpansion
${TRUSTED_NODE_WINDOWS_SCRUB}
"${nodePath.replace(/%/g, '%%')}" --disable-sigusr1 "%~dp0${jsFileName}" %*
set "hook_status=%errorlevel%"
if "%~1"=="PreToolUse" if not "%hook_status%"=="0" (
  >&2 echo Approval hook failed. Restart this session to try again.
  exit /b 2
)
exit /b %hook_status%
`;
}
