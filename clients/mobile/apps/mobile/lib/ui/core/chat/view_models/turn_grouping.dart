/// Categories of the collapsed steps card, in the desktop chip order
/// (`CollapsedTurnSummary` in `TurnGroupRenderer.tsx`). Enum declaration
/// order IS the display order.
enum TurnStepCategory {
  messages('messages'),
  thinking('thinking'),
  bash('bash'),
  read('read'),
  readLines('read lines'),
  writeEdit('write/edit'),
  plan('plan'),
  search('search'),
  grep('grep'),
  web('web'),
  agent('agents'),
  workflow('workflows'),
  tasks('tasks'),
  taskStop('stop'),
  skills('skills'),
  monitor('monitor'),
  claude('claude'),
  scheduleWakeup('wakeups'),
  askUser('questions'),
  scriptOutput('script output'),
  watcher('watcher'),
  canopy('app'),
  graph('code graph'),
  appAdvisor('orchestrator'),
  pipelineEditor('pipeline'),
  computerUse('computer use'),
  mcp('mcp'),
  other('other');

  const TurnStepCategory(this.label);

  /// Accessibility/aria label fragment, matching the desktop chip labels.
  final String label;
}

/// One chip of the collapsed steps card.
typedef TurnStepCount = ({TurnStepCategory category, int count});

String describeTurnStepCounts(List<TurnStepCount> counts) =>
    counts.map((e) => '${e.count} ${e.category.label}').join(', ');
