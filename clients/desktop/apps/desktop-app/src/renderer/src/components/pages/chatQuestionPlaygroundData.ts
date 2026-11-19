import type {
  RemoteControlAskUserQuestion,
  RemoteControlAskUserQuestionAnswer,
} from '@canopy/protocol/remote-control/shell';

export const QUESTION_PRESETS: {
  id: string;
  title: string;
  description: string;
  prompt: string;
  questions: RemoteControlAskUserQuestion[];
}[] = [
  {
    id: 'reply',
    title: 'Free reply',
    description: 'A single open question',
    prompt: 'One detail before I continue.',
    questions: [
      {
        question:
          'I found that the preview mixes the original menu with a few intermediate versions under “Before.” Is that the mismatch you mean, or are the captured controls themselves different from the app you’re seeing?',
        options: [],
        control: 'text',
        required: true,
        placeholder: 'Reply…',
      },
    ],
  },
  {
    id: 'decision',
    title: 'Quick decision',
    description: 'One choice · buttons',
    prompt: 'The changes are ready. How would you like to proceed?',
    questions: [
      {
        question: 'What happens next?',
        control: 'buttons',
        options: ['Review changes', 'Run tests', 'Keep working'],
        required: true,
      },
    ],
  },
  {
    id: 'brief',
    title: 'Project brief',
    description: 'Text · long answer',
    prompt: 'Let’s give this project a little direction before we begin.',
    questions: [
      {
        question:
          'Before we start building, what should we call this project? I’ll use the name in the workspace, the first screen, and the notes we create along the way, so a working title is completely fine.',
        control: 'text',
        options: [],
        required: true,
        placeholder: 'e.g. Atlas',
      },
      {
        question:
          'What should the first version help people do, and who will use it most often? A short description of their main task, the problem they face today, and what a successful outcome looks like will help me choose the right scope.',
        control: 'textarea',
        options: [],
        required: true,
        placeholder: 'The idea, the audience, and what success looks like…',
      },
    ],
  },
  {
    id: 'multiple',
    title: 'Multiple choices',
    description: 'Select several · buttons',
    prompt: 'We can start small. Pick the features that matter most.',
    questions: [
      {
        question: 'What belongs in the first release?',
        control: 'buttons',
        options: ['Search', 'Analytics', 'Team spaces', 'Notifications'],
        multiSelect: true,
        required: true,
      },
    ],
  },
  {
    id: 'release',
    title: 'Release details',
    description: 'Select · number · date',
    prompt: 'A few final details will help me prepare the release plan.',
    questions: [
      {
        question: 'Environment',
        control: 'select',
        options: ['Staging', 'Production'],
        required: true,
      },
      {
        question: 'Rollout percentage',
        control: 'number',
        options: [],
        placeholder: '25',
        required: true,
      },
      { question: 'Launch date', control: 'date', options: [], required: true },
    ],
  },
  {
    id: 'secret',
    title: 'Private answer',
    description: 'Masked input · redacted history',
    prompt:
      'You can provide a private value here. It will be hidden in the answered transcript.',
    questions: [
      {
        question: 'Access token',
        control: 'text',
        options: [],
        secret: true,
        required: true,
        placeholder: 'Paste a sample token',
      },
    ],
  },
  {
    id: 'long-list',
    title: 'Long list',
    description: 'One choice · dropdown',
    prompt: 'Which region should host the new workspace?',
    questions: [
      {
        question: 'Region',
        control: 'select',
        options: [
          'US East',
          'US West',
          'EU West',
          'EU Central',
          'Asia South',
          'Asia East',
        ],
        required: true,
      },
    ],
  },
  {
    id: 'classic',
    title: 'Classic question',
    description: 'Radio options · Other',
    prompt: 'The original question format is available too.',
    questions: [
      {
        question: 'Which package manager do you prefer?',
        options: ['npm', 'pnpm', 'yarn'],
        allowOther: true,
      },
    ],
  },
];

export type PlaygroundPhase =
  | 'pending'
  | 'submitting'
  | 'dismissing'
  | 'answered'
  | 'dismissed'
  | 'error'
  | 'disconnected';
export interface PlaygroundMachine {
  presetId: string;
  generation: number;
  phase: PlaygroundPhase;
  answers: RemoteControlAskUserQuestionAnswer[];
  failedAction: 'submit' | 'dismiss' | null;
  events: string[];
}
export type PlaygroundEvent =
  | { type: 'preset'; id: string }
  | { type: 'submit'; answers: RemoteControlAskUserQuestionAnswer[] }
  | {
      type:
        | 'dismiss'
        | 'resolve'
        | 'fail'
        | 'disconnect'
        | 'reconnect'
        | 'reset';
    };
export const initialPlaygroundMachine: PlaygroundMachine = {
  presetId: 'decision',
  generation: 0,
  phase: 'pending',
  answers: [],
  failedAction: null,
  events: ['Question requested'],
};

/** Local deterministic simulation. No timers, provider sessions or transport. */
export function reduceQuestionPlayground(
  state: PlaygroundMachine,
  event: PlaygroundEvent,
): PlaygroundMachine {
  const move = (
    phase: PlaygroundPhase,
    label: string,
    patch: Partial<PlaygroundMachine> = {},
  ): PlaygroundMachine => ({
    ...state,
    ...patch,
    phase,
    events: [...state.events.slice(-7), label],
  });
  if (event.type === 'preset' || event.type === 'reset') {
    const presetId = event.type === 'preset' ? event.id : state.presetId;
    if (!QUESTION_PRESETS.some((p) => p.id === presetId)) return state;
    return {
      ...initialPlaygroundMachine,
      presetId,
      generation: state.generation + 1,
      events: ['Question requested'],
    };
  }
  switch (event.type) {
    case 'submit':
      return state.phase === 'pending' || state.phase === 'error'
        ? move('submitting', 'Answer submitted', {
            answers: event.answers,
            failedAction: null,
          })
        : state;
    case 'dismiss':
      return state.phase === 'pending' || state.phase === 'error'
        ? move('dismissing', 'Dismiss requested', { failedAction: null })
        : state;
    case 'resolve':
      return state.phase === 'submitting'
        ? move('answered', 'Answer accepted')
        : state.phase === 'dismissing'
          ? move('dismissed', 'Dismiss accepted')
          : state;
    case 'fail':
      return state.phase === 'submitting' || state.phase === 'dismissing'
        ? move('error', 'Request failed', {
            failedAction: state.phase === 'submitting' ? 'submit' : 'dismiss',
          })
        : state;
    case 'disconnect':
      return state.phase === 'pending' || state.phase === 'error'
        ? move('disconnected', 'Connection lost')
        : state;
    case 'reconnect':
      return state.phase === 'disconnected'
        ? move('pending', 'Connection restored', { failedAction: null })
        : state;
  }
}
