/**
 * Remote Control workload scenarios (CAN-7754): what the controlled computer
 * (host) and the controlling computer (controller) send each other, and the
 * deterministic payloads they send. Shared by the runner, which reads the
 * names and durations, and by the computer worker, which drives the traffic.
 *
 * Payload shapes follow the tunnelled IPC channels the separate remote window
 * uses today: `chat:event` pushes carrying Claude stream events, the
 * `chat:get-transcript-page` invoke and its page of messages, and
 * `terminal:output` pushes that the host merges per 16 ms or 64 KiB.
 */

/** One keystroke probe: a `terminal:write` invoke answered by an echo push. */
export const ECHO_PROBE_INTERVAL_MS = 100;

/**
 * Bump when the payloads change without a change to `SCENARIOS`, so a saved
 * artifact recorded with other payloads is not compared with this workload.
 */
export const WORKLOAD_VERSION = 2;

export const SCENARIOS = Object.freeze({
  'streaming-chat': {
    description:
      'four chats stream assistant text at once while the controller types into a terminal',
    durationMs: 10_000,
    chats: 4,
    deltasPerSecondPerChat: 40,
    echoProbes: true,
  },
  'large-transcript': {
    description:
      'the controller opens a long chat and pages back through its transcript',
    pages: 4,
    /**
     * Turns per `view: 'turns'` page: the host's page size (the turn pager
     * in `chat-transcript-log.ts` selects the last 100 turns before the
     * cursor).
     */
    turnsPerPage: 100,
    /**
     * Rows per turn, composed like the suite's stress transcript: prompt,
     * turn timer, intro, then batches of a progress note and three tool
     * exchanges, then the final report.
     */
    rowsPerTurn: 122,
    /**
     * Rows the turn view sends from the end of each completed turn
     * (`COMPLETED_TURN_TAIL_SIZE`); the newest turn is sent whole.
     */
    completedTurnTailRows: 16,
    /** The stress transcript's 26 KB Markdown final report. */
    finalReportWords: 3_600,
    /** The person reads each page before scrolling back to the next. */
    pageIntervalMs: 400,
    echoProbes: true,
  },
  'busy-terminal': {
    description:
      'two terminals print build output at 1 MiB/s each while the controller types into a third',
    durationMs: 10_000,
    terminals: 2,
    bytesPerSecondPerTerminal: 1024 * 1024,
    mergeIntervalMs: 16,
    echoProbes: true,
  },
});

export const SCENARIO_NAMES = Object.freeze(Object.keys(SCENARIOS));

/** Mulberry32: a small deterministic PRNG, so every run sends the same bytes. */
export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SYLLABLES = [
  'ka',
  'ro',
  'mi',
  'tes',
  'lan',
  'dor',
  'vi',
  'sul',
  'pre',
  'quo',
  'ent',
  'ber',
  'nax',
  'tol',
  'fi',
  'gra',
  'shu',
  'op',
  'wen',
  'cyl',
  'dro',
  'ix',
  'mar',
  'ple',
];

/**
 * A fixed vocabulary of 4,096 made-up words plus identifiers, so text
 * deflates about as much as English prose and code output do (2 to 4
 * times), not as much as a small repeated word list would.
 */
const VOCABULARY = (() => {
  const random = createRandom(0x7754);
  const list = [];
  for (let index = 0; index < 4_096; index += 1) {
    const length = 1 + Math.floor(random() * 4);
    let word = '';
    for (let part = 0; part < length; part += 1) {
      word += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
    }
    list.push(word);
  }
  return list;
})();

export function words(random, count) {
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const roll = random();
    if (roll < 0.06) {
      parts.push(Math.floor(random() * 0xffffffff).toString(16));
    } else if (roll < 0.1) {
      parts.push(String(Math.floor(random() * 10_000)));
    } else {
      parts.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)]);
    }
  }
  return parts.join(' ');
}

/** A `chat:event` push carrying one Claude text delta. */
export function chatDeltaPush(random, { chatIndex, seq, sentAtMs }) {
  return {
    projectId: 'perf-project',
    worktreeId: 'perf-worktree',
    chatId: `perf-chat-${String(chatIndex)}`,
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: `${words(random, 1 + Math.floor(random() * 5))} `,
        },
      },
      session_id: `perf-session-${String(chatIndex)}`,
      parent_tool_use_id: null,
      uuid: `perf-${String(chatIndex)}-${String(seq)}`,
      canopy_turn_user_message_id: `perf-turn-${String(chatIndex)}`,
      canopy_perf_sent_at_ms: sentAtMs,
    },
  };
}

/** A Markdown final report of about `count` words. */
function finalReport(random, count) {
  const sections = [];
  let written = 0;
  while (written < count) {
    const items = [];
    for (let item = 0; item < 6; item += 1) {
      items.push(`- ${words(random, 14)}`);
    }
    sections.push(
      `## ${words(random, 4)}\n\n${words(random, 90)}\n\n${items.join('\n')}`,
    );
    written += 4 + 90 + 6 * 14;
  }
  return sections.join('\n\n');
}

/** Rows of a turn that its frame always carries: the prompt and turn timer. */
const TURN_FRAME_ROWS = 2;

const TOOL_NAMES = ['Read', 'Grep', 'Bash', 'Edit'];

/** Row `offset` of a turn starting at `start`, in the persisted shape. */
function transcriptRow(random, scenario, turn, start, offset) {
  const ordinal = start + offset;
  const id = `perf-message-${String(ordinal)}`;
  const timestamp = 1_790_000_000_000 + ordinal * 7_000;
  const text = (role, value) => ({
    id,
    role,
    timestamp,
    blocks: [{ type: 'text', text: value }],
  });
  if (offset === 0) {
    return { ...text('user', words(random, 60)), userMessageSource: 'human' };
  }
  if (offset === 1) {
    return {
      id,
      role: 'system',
      timestamp,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: timestamp,
          completedAt: timestamp + 2_000_000,
        },
      ],
    };
  }
  if (offset === 2) return text('assistant', words(random, 30));
  if (offset === scenario.rowsPerTurn - 1) {
    return text('assistant', finalReport(random, scenario.finalReportWords));
  }
  // Batches of a progress note followed by three tool exchanges.
  const position = (offset - 3) % 4;
  if (position === 0) return text('assistant', words(random, 36));
  const toolUseId = `perf-tool-${String(ordinal)}`;
  const toolName = TOOL_NAMES[ordinal % TOOL_NAMES.length];
  const file = `src/transcript/recovery-${String(ordinal % 12)}.ts`;
  const output = Array.from(
    { length: 18 },
    (_, line) => `${file}:${String(line + 1)}: ${words(random, 16)}`,
  ).join('\n');
  return {
    id,
    role: 'system',
    timestamp,
    blocks: [
      {
        type: 'tool_use',
        toolUseId,
        toolName,
        input: JSON.stringify({ file_path: file, offset: 1, limit: 40 }),
      },
      { type: 'tool_result', toolUseId, toolName, output, isError: false },
    ],
  };
}

/** Rows a turn-view page carries for one turn: its frame and its tail. */
function turnPageOffsets(scenario, newest) {
  const tail = newest
    ? scenario.rowsPerTurn
    : Math.min(scenario.rowsPerTurn, scenario.completedTurnTailRows);
  const offsets = new Set();
  for (let offset = 0; offset < TURN_FRAME_ROWS; offset += 1)
    offsets.add(offset);
  for (
    let offset = scenario.rowsPerTurn - tail;
    offset < scenario.rowsPerTurn;
    offset += 1
  ) {
    offsets.add(offset);
  }
  return [...offsets].sort((left, right) => left - right);
}

/** How many messages page `page` carries, for the controller's check. */
export function transcriptPageMessageCount(scenario, page) {
  const completed = turnPageOffsets(scenario, false).length;
  const newest =
    page === 0 ? turnPageOffsets(scenario, true).length : completed;
  return completed * (scenario.turnsPerPage - 1) + newest;
}

/**
 * One `chat:get-transcript-page` result in the turn view the chat pages its
 * history with (`view: 'turns'`), shaped as the host's turn pager builds it:
 * `turnsPerPage` turns, each with its frame (prompt, turn timer) and its
 * last `completedTurnTailRows` rows (the newest turn whole), in the
 * persisted message shape (`PersistedChatMessage`: blocks, numeric
 * timestamps), with a summary per turn and the gap cursor of each
 * compacted turn. Page 0 is the newest.
 */
export function transcriptPage(random, scenario) {
  const { page, pages, turnsPerPage, rowsPerTurn } = scenario;
  const turnCount = pages * turnsPerPage;
  const totalMessages = turnCount * rowsPerTurn;
  const firstTurn = turnCount - (page + 1) * turnsPerPage;
  const messages = [];
  const turns = [];
  const messageOrdinals = {};
  for (let turn = firstTurn; turn < firstTurn + turnsPerPage; turn += 1) {
    const start = turn * rowsPerTurn;
    const end = start + rowsPerTurn;
    const offsets = turnPageOffsets(scenario, turn === turnCount - 1);
    for (const offset of offsets) {
      const row = transcriptRow(random, scenario, turn, start, offset);
      messages.push(row);
      messageOrdinals[row.id] = start + offset;
    }
    const tailStart = start + offsets[TURN_FRAME_ROWS];
    turns.push({
      id: `perf-turn-${String(turn)}`,
      start,
      end,
      complete: true,
      summary: {
        messages: 2 + Math.floor((rowsPerTurn - 4) / 4),
        thinking: 0,
        bash: Math.floor((rowsPerTurn - 4) / 4),
        read: Math.floor((rowsPerTurn - 4) / 4),
        readLines: 40 * Math.floor((rowsPerTurn - 4) / 4),
        writeEdit: 0,
        plan: 0,
        fileEdit: Math.floor((rowsPerTurn - 4) / 4),
        fileAdd: 0,
        fileDelete: 0,
        search: 0,
        grep: Math.floor((rowsPerTurn - 4) / 4),
        web: 0,
        agent: 0,
      },
      finalMessageIds: [`perf-message-${String(end - 1)}`],
      ...(tailStart > start + TURN_FRAME_ROWS ? { before: tailStart } : {}),
    });
  }
  const before = firstTurn * rowsPerTurn;
  return {
    messages,
    view: 'turns',
    turns,
    messageOrdinals,
    totalMessages,
    transcriptRevision: totalMessages,
    ...(before > 0 ? { before } : {}),
  };
}

/** One merged `terminal:output` frame of build-log text. */
export function terminalOutputPush(
  random,
  { terminalIndex, seq, bytes, sentAtMs },
) {
  let text = '';
  while (text.length < bytes) {
    const percent = Math.floor(random() * 100);
    text += `\u001b[32m✓\u001b[0m [${String(percent).padStart(3)}%] ${words(random, 8)}\r\n`;
  }
  return {
    projectId: 'perf-project',
    worktreeId: 'perf-worktree',
    terminalId: `perf-terminal-${String(terminalIndex)}`,
    data: new TextEncoder().encode(text.slice(0, bytes)),
    seq,
    canopyPerfSentAtMs: sentAtMs,
  };
}
