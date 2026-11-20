/** @jest-environment jsdom */
import { act } from 'react';
import { createDomHarness, type DomHarness } from '../../__tests__/domHarness';
import {
  SecretRequestPrompt,
  parseDotenvForSecrets,
  type SecretRequestPromptItem,
  type SecretRequestPromptProps,
  type SecretRequestPromptSubmission,
} from '../SecretRequestPrompt';
import {
  RequestSecretsRowLabel,
  isRequestSecretsToolName,
  parseRequestSecretsResult,
  requestSecretsStatusLabel,
} from '../request-secrets-display';
import { stepKindOfToolCall } from '../step-words';
import {
  ChatSecretsChip,
  ChatSecretsRestartNotice,
  chatSecretsAmbientLine,
} from '../ChatSecretsChip';

/*
 * The secret request form and its transcript row. Values exist only in the
 * form's own fields: they are cleared as they are sent, on Decline and on
 * unmount, and never show anywhere else on the page; the row shows names
 * and states only.
 */

const CANARY = 'canary-91d2-form-value';
const SHORT = 'cnr5x';

const ITEMS: SecretRequestPromptItem[] = [
  {
    name: 'STRIPE_SECRET_KEY',
    label: 'Stripe secret key',
    hint: { prefix: 'sk_test_' },
  },
  { name: 'DATABASE_URL', held: true },
  { name: 'SENTRY_DSN', required: false },
];

let harness: DomHarness;
let submitted: SecretRequestPromptSubmission[];
let declined: number;

function render(overrides: Partial<SecretRequestPromptProps> = {}): void {
  harness.render(
    <SecretRequestPrompt
      agentName="Claude"
      reason="Run the checkout integration tests."
      items={ITEMS}
      accessMode="ask"
      storage="encrypted"
      busy={null}
      errorKind={null}
      onSubmit={(submission): void => {
        submitted.push(submission);
      }}
      onDecline={(): void => {
        declined += 1;
      }}
      onClose={(): void => undefined}
      {...overrides}
    />,
  );
}

function input(name: string): HTMLInputElement {
  const element = harness.byTestId(`chat-secret-request-input-${name}`);
  if (!(element instanceof HTMLInputElement)) throw new Error('not an input');
  return element;
}

function type(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  act(() => {
    // React tracks the native setter; set through it so onChange fires.
    Reflect.set(prototype, 'value', value, element);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pageTextWithoutFields(): string {
  return document.body.textContent ?? '';
}

function fieldValues(): string[] {
  return Array.from(document.querySelectorAll('input, textarea')).map(
    (element) =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
        ? element.value
        : '',
  );
}

beforeEach(() => {
  harness = createDomHarness();
  submitted = [];
  declined = 0;
});

afterEach(() => {
  harness.cleanup();
});

describe('SecretRequestPrompt', () => {
  it('shows masked fields with names, the reason and the Ask footer', () => {
    render();
    expect(
      harness.byTestId('chat-secret-request-prompt').textContent,
    ).toContain('Claude needs 3 secrets');
    expect(input('STRIPE_SECRET_KEY').type).toBe('password');
    expect(input('STRIPE_SECRET_KEY').autocomplete).toBe('off');
    expect(pageTextWithoutFields()).toContain('STRIPE_SECRET_KEY');
    expect(pageTextWithoutFields()).toContain('Optional');
    expect(harness.byTestId('chat-secret-request-footer').textContent).toBe(
      'Hidden from the agent. It can use the value in commands; output is redacted.',
    );
    // A held name defaults to the chat's value, so it has no field.
    expect(
      harness.queryTestId('chat-secret-request-input-DATABASE_URL'),
    ).toBeNull();
    // One required field is empty; the held one counts.
    expect(harness.byTestId('chat-secret-request-provide').textContent).toBe(
      'Provide',
    );
  });

  it('submits entered values and kept names, then clears every field', () => {
    render();
    type(input('STRIPE_SECRET_KEY'), `sk_test_${CANARY}`);
    expect(pageTextWithoutFields()).toContain('Starts with sk_test_');
    expect(harness.byTestId('chat-secret-request-provide').textContent).toBe(
      'Provide 2',
    );
    expect(pageTextWithoutFields()).not.toContain(CANARY);
    harness.click(harness.byTestId('chat-secret-request-provide'));
    expect(submitted).toEqual([
      {
        values: { STRIPE_SECRET_KEY: `sk_test_${CANARY}` },
        useHeld: ['DATABASE_URL'],
      },
    ]);
    expect(fieldValues().some((value) => value.includes(CANARY))).toBe(false);
  });

  it('blocks a missing required value and warns about short values', () => {
    render();
    harness.click(harness.byTestId('chat-secret-request-provide'));
    expect(submitted).toEqual([]);
    expect(pageTextWithoutFields()).toContain('Enter Stripe secret key.');
    type(input('STRIPE_SECRET_KEY'), SHORT);
    expect(
      harness.byTestId('chat-secret-request-field-STRIPE_SECRET_KEY-error')
        .textContent,
    ).toBe(
      "This doesn't look like the value asked for. It usually starts with sk_test_. Never enter an account sign-in password here.",
    );
    type(input('SENTRY_DSN'), SHORT);
    expect(pageTextWithoutFields()).toContain(
      'Short values may not be redacted',
    );
    expect(pageTextWithoutFields()).not.toContain(SHORT);
  });

  it('asks before sending a value that misses its prefix, and sends once on Send anyway', () => {
    render();
    const wrong = `not-a-stripe-key-${CANARY}`;
    type(input('STRIPE_SECRET_KEY'), wrong);
    const provide = harness.byTestId('chat-secret-request-provide');
    expect(provide.textContent).toBe('Send anyway…');
    harness.click(provide);
    expect(submitted).toEqual([]);
    expect(
      harness.byTestId('chat-secret-request-mismatch-dialog').textContent,
    ).not.toContain(CANARY);
    harness.click(harness.byTestId('chat-secret-request-mismatch-cancel'));
    expect(harness.queryTestId('chat-secret-request-mismatch-dialog')).toBe(
      null,
    );
    expect(input('STRIPE_SECRET_KEY').value).toBe(wrong);
    harness.click(harness.byTestId('chat-secret-request-provide'));
    harness.click(harness.byTestId('chat-secret-request-mismatch-confirm'));
    expect(submitted).toEqual([
      { values: { STRIPE_SECRET_KEY: wrong }, useHeld: ['DATABASE_URL'] },
    ]);
    expect(fieldValues().some((value) => value.includes(CANARY))).toBe(false);
  });

  it('enforces the hint minimum length', () => {
    harness.render(
      <SecretRequestPrompt
        agentName="Codex"
        reason="Sign the build."
        items={[{ name: 'SIGNING_KEY', hint: { minLength: 12 } }]}
        accessMode="full"
        storage="session"
        busy={null}
        errorKind={null}
        onSubmit={(submission): void => {
          submitted.push(submission);
        }}
        onDecline={(): void => undefined}
        onClose={(): void => undefined}
      />,
    );
    expect(pageTextWithoutFields()).toContain('Codex needs a secret');
    expect(harness.byTestId('chat-secret-request-footer').textContent).toBe(
      "Available to the agent's commands. The agent could print it, so redaction is best effort.",
    );
    expect(
      harness.queryTestId('chat-secret-request-session-storage'),
    ).not.toBeNull();
    type(input('SIGNING_KEY'), 'too-short');
    harness.click(harness.byTestId('chat-secret-request-provide'));
    expect(submitted).toEqual([]);
    expect(pageTextWithoutFields()).toContain('Use at least 12 characters.');
  });

  it('clears values on Decline and fills fields from pasted .env text', () => {
    render();
    harness.click(harness.byTestId('chat-secret-request-paste-toggle'));
    const paste = harness.byTestId('chat-secret-request-paste');
    if (!(paste instanceof HTMLTextAreaElement)) throw new Error('no textarea');
    type(paste, `STRIPE_SECRET_KEY="sk_test_${CANARY}"\nUNKNOWN=${CANARY}`);
    harness.click(harness.byTestId('chat-secret-request-paste-apply'));
    expect(input('STRIPE_SECRET_KEY').value).toBe(`sk_test_${CANARY}`);
    expect(pageTextWithoutFields()).toContain('Filled 1 of 3.');
    harness.click(harness.byTestId('chat-secret-request-decline'));
    expect(declined).toBe(1);
    expect(fieldValues().some((value) => value.includes(CANARY))).toBe(false);
  });

  it('clears unapplied pasted text when the form submits', () => {
    render();
    harness.click(harness.byTestId('chat-secret-request-paste-toggle'));
    const paste = harness.byTestId('chat-secret-request-paste');
    if (!(paste instanceof HTMLTextAreaElement)) throw new Error('no textarea');
    type(paste, `OTHER_KEY=${CANARY}`);
    type(input('STRIPE_SECRET_KEY'), 'sk_test_fake_value');
    harness.click(harness.byTestId('chat-secret-request-provide'));
    expect(submitted).toHaveLength(1);
    expect(fieldValues().some((value) => value.includes(CANARY))).toBe(false);
    harness.click(harness.byTestId('chat-secret-request-paste-toggle'));
    const reopened = harness.byTestId('chat-secret-request-paste');
    if (!(reopened instanceof HTMLTextAreaElement))
      throw new Error('no textarea');
    expect(reopened.value).toBe('');
  });

  it('locks while sending or disconnected and explains a failed send', () => {
    render({ busy: 'submit' });
    expect(input('STRIPE_SECRET_KEY').disabled).toBe(true);
    render({
      busy: null,
      errorKind: 'submit',
      errorMessage: 'This request is no longer waiting.',
    });
    expect(
      harness.byTestId('chat-secret-request-notice').textContent,
    ).toContain('This request is no longer waiting. Enter the values again.');
    render({ errorKind: null, disconnected: true });
    expect(
      harness.byTestId('chat-secret-request-notice').textContent,
    ).toContain('Reconnect to provide secrets.');
  });

  // U7: a paired browser or phone never queues values for an offline
  // computer, so the form locks and says why.
  it('locks while the paired computer is offline and says values are never queued', () => {
    render({ computerOffline: true });
    expect(input('STRIPE_SECRET_KEY').disabled).toBe(true);
    expect(input('STRIPE_SECRET_KEY').placeholder).toBe(
      'Unavailable while offline',
    );
    expect(
      harness.byTestId('chat-secret-request-notice').textContent,
    ).toContain(
      "Your computer is offline. Secrets go straight to it and are never queued, so you can provide them once it's back online.",
    );
    harness.click(harness.byTestId('chat-secret-request-provide'));
    expect(submitted).toEqual([]);
  });

  it('locking forgets what was revealed and the Paste .env text, also after it unlocks', () => {
    render({});
    harness.click(harness.byTestId('chat-secret-request-paste-toggle'));
    const paste = harness.byTestId('chat-secret-request-paste');
    if (!(paste instanceof HTMLTextAreaElement)) throw new Error('no paste');
    type(paste, `STRIPE_SECRET_KEY=${'sk_test_canary'}`);
    harness.click(
      harness.byTestId('chat-secret-request-toggle-STRIPE_SECRET_KEY'),
    );
    expect(input('STRIPE_SECRET_KEY').type).toBe('text');
    render({ computerOffline: true });
    expect(input('STRIPE_SECRET_KEY').type).toBe('password');
    expect(
      document.querySelector('[data-testid="chat-secret-request-paste"]'),
    ).toBeNull();
    // Back online: nothing shows in the clear until revealed or pasted again.
    render({ computerOffline: false });
    expect(input('STRIPE_SECRET_KEY').type).toBe('password');
    expect(
      document.querySelector('[data-testid="chat-secret-request-paste"]'),
    ).toBeNull();
    harness.click(harness.byTestId('chat-secret-request-paste-toggle'));
    const reopened = harness.byTestId('chat-secret-request-paste');
    if (!(reopened instanceof HTMLTextAreaElement)) throw new Error('no paste');
    expect(reopened.value).toBe('');
  });

  it("says a cloud chat's values go to its cloud workspace", () => {
    render({ accessMode: 'cloud', agentName: 'Agent' });
    expect(harness.byTestId('chat-secret-request-footer').textContent).toBe(
      "Sent to this chat's cloud workspace and stored encrypted.",
    );
  });

  it('locks for a viewer who cannot answer and says why', () => {
    render({ readOnlyHint: 'Sign in to provide secrets.' });
    expect(input('STRIPE_SECRET_KEY').disabled).toBe(true);
    expect(
      harness.byTestId('chat-secret-request-notice').textContent,
    ).toContain('Sign in to provide secrets.');
    harness.click(harness.byTestId('chat-secret-request-provide'));
    expect(submitted).toEqual([]);
  });
});

describe('ChatSecretsChip', () => {
  it('shows nothing without secrets, then lists names with Revoke', () => {
    const revoked: string[] = [];
    harness.render(
      <ChatSecretsChip
        secrets={[]}
        onRevoke={(name): void => void revoked.push(name)}
      />,
    );
    expect(harness.queryTestId('chat-secrets-chip')).toBeNull();
    harness.render(
      <ChatSecretsChip
        secrets={[
          { name: 'API_KEY', lastUsedAt: null },
          {
            name: 'DATABASE_URL',
            lastUsedAt: '2026-11-16T05:00:00.000Z',
          },
        ]}
        now={Date.parse('2026-11-16T05:02:00.000Z')}
        onRevoke={(name): void => void revoked.push(name)}
      />,
    );
    expect(harness.byTestId('chat-secrets-chip').textContent).toContain(
      '2 secrets',
    );
    harness.click(harness.byTestId('chat-secrets-chip'));
    expect(harness.byTestId('chat-secrets-row-API_KEY').textContent).toContain(
      'Chat · not used yet',
    );
    expect(
      harness.byTestId('chat-secrets-row-DATABASE_URL').textContent,
    ).toContain('Chat · used 2m ago');
    harness.click(harness.byTestId('chat-secrets-revoke-API_KEY'));
    expect(revoked).toEqual(['API_KEY']);
  });
});

describe('multiline secrets', () => {
  it('keeps line breaks while masked', () => {
    harness.render(
      <SecretRequestPrompt
        agentName="Claude"
        reason="Sign the release."
        items={[{ name: 'SIGNING_KEY', kind: 'multiline' }]}
        accessMode="ask"
        storage="encrypted"
        busy={null}
        errorKind={null}
        onSubmit={(submission): void => {
          submitted.push(submission);
        }}
        onDecline={(): void => undefined}
        onClose={(): void => undefined}
      />,
    );
    const field = harness.byTestId('chat-secret-request-input-SIGNING_KEY');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('no textarea');
    expect(field.parentElement?.className).toContain('secret-text-mask');
    const pem = '-----BEGIN KEY-----\nfake\n-----END KEY-----';
    type(field, pem);
    harness.click(harness.byTestId('chat-secret-request-provide'));
    expect(submitted).toEqual([{ values: { SIGNING_KEY: pem }, useHeld: [] }]);
  });
});

describe('parseDotenvForSecrets', () => {
  it('reads requested names only, with quotes, export and comments', () => {
    expect(
      parseDotenvForSecrets(
        [
          '# a comment',
          'export A_KEY=plain # trailing',
          "B_KEY='single quoted'",
          'C_KEY="double \\"quoted\\"\\nline"',
          'E_KEY="quoted" # say "hi"',
          "F_KEY='single' # it's 'here'",
          'UNKNOWN=ignored',
          'D_KEY=',
          '\r',
        ].join('\r\n'),
        ['A_KEY', 'B_KEY', 'C_KEY', 'D_KEY', 'E_KEY', 'F_KEY'],
      ),
    ).toEqual({
      A_KEY: 'plain',
      B_KEY: 'single quoted',
      C_KEY: 'double "quoted"\nline',
      E_KEY: 'quoted',
      F_KEY: 'single',
    });
  });
});

describe('RequestSecrets transcript row', () => {
  it('recognizes every provider name and counts as requested secrets', () => {
    for (const name of [
      'RequestSecrets',
      'mcp__canopy_ui__RequestSecrets',
      'canopy_request_secrets',
      'canopy_ui: RequestSecrets',
      // A cloud Claude chat's host tool.
      'mcp__harness-tools__RequestSecrets',
    ])
      expect(isRequestSecretsToolName(name)).toBe(true);
    expect(isRequestSecretsToolName('mcp__other__AskUserQuestion')).toBe(false);
    expect(
      stepKindOfToolCall({
        toolName: 'mcp__canopy_ui__RequestSecrets',
        family: 'canopy',
        input: '{}',
      }),
    ).toBe('secrets');
  });

  it('reads Provided N of M with name chips from the result metadata', () => {
    const resultText = JSON.stringify({
      status: 'partial',
      secrets: [
        {
          name: 'DATABASE_URL',
          state: 'provided',
          source: 'chat',
          scope: 'chat',
        },
        {
          name: 'AWS_ACCESS_KEY_ID',
          state: 'provided',
          source: 'entered',
          scope: 'chat',
        },
        { name: 'SENTRY_DSN', state: 'skipped' },
      ],
      usage: 'x',
    });
    const parsed = parseRequestSecretsResult(resultText);
    expect(parsed && requestSecretsStatusLabel(parsed)).toBe('Provided 2 of 3');
    harness.render(
      <RequestSecretsRowLabel input="{}" resultText={resultText} />,
    );
    const row = harness.byTestId('request-secrets-row').textContent ?? '';
    expect(row).toContain('Provided 2 of 3');
    expect(row).toContain('DATABASE_URL');
    expect(row).toContain('already held');
    expect(row).toContain('skipped');
    expect(parseRequestSecretsResult('not json')).toBeNull();
    expect(
      parseRequestSecretsResult(
        JSON.stringify({ status: 'declined', secrets: [] }),
      ),
    ).toEqual({ status: 'declined', secrets: [] });
  });
  it("says what the agent's own commands get and offers Codex's Restart to apply", () => {
    let restarts = 0;
    harness.render(
      <ChatSecretsChip
        secrets={[{ name: 'API_KEY', lastUsedAt: null }]}
        ambient="restart"
        agentName="Codex"
        placement="top-right"
        onRevoke={(): void => undefined}
        onRestart={(): void => {
          restarts += 1;
        }}
      />,
    );
    expect(harness.byTestId('chat-secrets').getAttribute('data-ambient')).toBe(
      'restart',
    );
    harness.click(harness.byTestId('chat-secrets-chip'));
    expect(harness.byTestId('chat-secrets-ambient').textContent).toBe(
      'Codex started before some of these. Restart to apply them to its own commands.',
    );
    harness.click(harness.byTestId('chat-secrets-restart'));
    expect(restarts).toBe(1);
    expect(chatSecretsAmbientLine('live', 'Claude')).toContain(
      "also set in the agent's own commands",
    );
    expect(chatSecretsAmbientLine('none', 'Claude')).toBe(
      'The agent uses these by name in commands. It never sees the values.',
    );
    expect(chatSecretsAmbientLine('restart-pending', 'Codex')).toBe(
      "Codex restarts when it's idle, or at your next message.",
    );
  });

  it('shows Restart to apply above the composer, then what happens once asked', () => {
    let restarts = 0;
    harness.render(
      <ChatSecretsRestartNotice
        agentName="Codex"
        pending={false}
        onRestart={(): void => {
          restarts += 1;
        }}
      />,
    );
    expect(
      harness.byTestId('chat-secrets-restart-notice').textContent,
    ).toContain(
      "Codex's own commands get them after a restart. The conversation is kept.",
    );
    harness.click(harness.byTestId('chat-secrets-restart-notice-button'));
    expect(restarts).toBe(1);
    harness.render(
      <ChatSecretsRestartNotice
        agentName="Codex"
        pending
        onRestart={(): void => undefined}
      />,
    );
    expect(
      harness.queryTestId('chat-secrets-restart-notice-button'),
    ).toBeNull();
    expect(
      harness.byTestId('chat-secrets-restart-notice').textContent,
    ).toContain('Codex will restart');
  });
});
