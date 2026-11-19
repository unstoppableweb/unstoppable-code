/** @jest-environment jsdom */
import { act } from 'react';
import {
  findSecretSpans,
  redactSecrets,
} from '@canopy/protocol/secret-redaction';
import { createDomHarness, type DomHarness } from '../../__tests__/domHarness';
import {
  PastedSecretNotice,
  maskPastedSecret,
  splitPastedSecret,
  suggestedSecretName,
} from '../PastedSecretNotice';

/*
 * The composer's paste guard (agent secret requests U6): text that looks
 * like a secret, by the same vocabulary `redactSecrets` masks, is held
 * apart and shown masked; "Send as secret" turns it into a name the
 * message mentions, never the value.
 */

const CANARY = 'sk_live_canary51Hq8RkLmZx2TfV';
// Built at run time: a literal AWS key shape would trip the public-export
// credential check.
const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

let harness: DomHarness;

beforeEach(() => {
  harness = createDomHarness();
});

afterEach(() => {
  harness.cleanup();
});

function type(element: HTMLInputElement, value: string): void {
  act(() => {
    Reflect.set(HTMLInputElement.prototype, 'value', value, element);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('findSecretSpans', () => {
  it('finds what redactSecrets masks, and only secrets', () => {
    const text = `here's the key: ${CANARY}`;
    const spans = findSecretSpans(text);
    expect(spans.map(({ start, end }) => text.slice(start, end))).toEqual([
      CANARY,
    ]);
    expect(redactSecrets(text)).not.toContain(CANARY);
    expect(findSecretSpans('export API_KEY=canary-value-1234')).toHaveLength(1);
    expect(
      findSecretSpans('Authorization: Bearer canaryTokenValue123'),
    ).toHaveLength(1);
    // Ordinary text, emails and paths are not secrets here.
    expect(
      findSecretSpans('Run pnpm test in /home/someone for a@b.co please'),
    ).toEqual([]);
  });
});

describe('pasted secret helpers', () => {
  it('never leaves any part of the paste in the message', () => {
    for (const text of [
      `here's the key: ${CANARY}`,
      '{"password": "correct horse battery staple"}',
      String.raw`{"password": "p@ss\"word", "token": "x"}`,
      'password: "multi\nline value"',
      `AWS_KEY=${FAKE_AWS_KEY}\npassword=${CANARY}`,
      `PASSWORD="correct horse battery staple" ${CANARY}`,
    ]) {
      const split = splitPastedSecret(text, 'MY_SECRET');
      expect(split.message).toBe('[secret:MY_SECRET]');
      expect(split.value).toBe(text.trim());
      const preview = maskPastedSecret(text);
      for (const word of text.split(/\W+/).filter((w) => w.length > 6))
        expect(preview).not.toContain(word);
    }
  });

  it('keeps just the value of a single KEY=value line', () => {
    for (const [text, value] of [
      ['API_KEY=canary-value-1234', 'canary-value-1234'],
      ['export DB_PASSWORD="correct horse"', 'correct horse'],
      ["TOKEN='a&b c'", 'a&b c'],
    ] as const) {
      expect(splitPastedSecret(text, 'NAME')).toEqual({
        value,
        message: '[secret:NAME]',
      });
    }
    expect(
      suggestedSecretName(
        'export DB_PASSWORD="correct horse"',
        findSecretSpans('export DB_PASSWORD="correct horse"'),
      ),
    ).toBe('DB_PASSWORD');
    expect(
      suggestedSecretName(
        'api_key: canary-value-1234',
        findSecretSpans('api_key: canary-value-1234'),
      ),
    ).toBe('API_KEY');
  });
});

describe('PastedSecretNotice', () => {
  it('shows the warning masked, then sends as a secret under a valid name', () => {
    const text = `here's the key: ${CANARY}`;
    const sentAs: string[] = [];
    let anyway = 0;
    harness.render(
      <PastedSecretNotice
        text={text}
        spans={findSecretSpans(text)}
        onSendAnyway={(): void => {
          anyway += 1;
        }}
        onSendAsSecret={(name): void => {
          sentAs.push(name);
        }}
        onDismiss={(): void => undefined}
      />,
    );
    const page = (): string => document.body.textContent ?? '';
    expect(page()).toContain(
      'This looks like a secret. If you send it as a message, the agent and its provider will see it.',
    );
    expect(page()).not.toContain(CANARY);
    expect(harness.byTestId('chat-pasted-secret-send-anyway').textContent).toBe(
      'Send anyway',
    );
    harness.click(harness.byTestId('chat-pasted-secret-send-as-secret'));
    const name = harness.byTestId('chat-pasted-secret-name');
    if (!(name instanceof HTMLInputElement)) throw new Error('not an input');
    type(name, 'bad-name');
    harness.click(harness.byTestId('chat-pasted-secret-save'));
    expect(sentAs).toEqual([]);
    type(name, 'stripe_secret_key');
    harness.click(harness.byTestId('chat-pasted-secret-save'));
    expect(sentAs).toEqual(['STRIPE_SECRET_KEY']);
    expect(anyway).toBe(0);
    expect(page()).not.toContain(CANARY);
  });
});
