/** @jest-environment jsdom */
/**
 * The reach-back prompt (CAN-6176 Q3): before a cloud chat runs a tool on
 * this computer the person sees the chat approval card with Allow once and
 * Deny only. It offers no rule to save, no reason and no stop, and closing
 * it denies, once.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ApprovalPromptDecision } from '@canopy/protocol/approvals';
import { ReachBackApprovalDialog } from '../ReachBackApprovalDialog';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('reach-back approval prompt (CAN-6176 Q3)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let answers: [string, ApprovalPromptDecision][];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    answers = [];
    act(() => {
      root.render(
        <ReachBackApprovalDialog
          pending={{
            requestId: 'req-1',
            title: 'Plan the launch wants to run create_issue on this computer',
            description:
              'From the Tracker server. It runs here and its result goes to the cloud chat.',
            details: {
              kind: 'tool',
              toolName: 'create_issue',
              inputSummary: '{"title":"Launch"}',
            },
            suggestedTarget: { kind: 'tool', toolName: 'create_issue' },
          }}
          onRespond={(requestId, decision): Promise<void> => {
            answers.push([requestId, decision]);
            return Promise.resolve();
          }}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const buttons = (): string[] =>
    Array.from(document.body.querySelectorAll('button')).map(
      (button) => button.textContent?.trim() ?? '',
    );

  it('offers Allow once and Deny only, never a rule', () => {
    const labels = buttons();
    expect(labels).toEqual(expect.arrayContaining(['Allow once', 'Deny']));
    expect(labels.join(' ')).not.toMatch(/Always|reason|stop/i);
    expect(document.body.textContent).toContain('create_issue');
    expect(document.body.textContent).toContain('Plan the launch');
    // It opens unasked: focus starts on the card, so Enter allows nothing.
    expect(document.activeElement?.textContent?.trim()).not.toBe('Allow once');
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
  });

  it('answers once: Allow once allows, and Escape denies', () => {
    const press = (label: string): void => {
      const button = Array.from(document.body.querySelectorAll('button')).find(
        (item) => item.textContent?.trim() === label,
      );
      if (button === undefined) throw new Error(`No ${label} button.`);
      act(() => button.click());
    };
    press('Allow once');
    // Escape closes the dialog.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(answers).toEqual([
      ['req-1', expect.objectContaining({ behavior: 'allow', scope: 'once' })],
      ['req-1', { behavior: 'deny', scope: 'once' }],
    ]);
  });
});
