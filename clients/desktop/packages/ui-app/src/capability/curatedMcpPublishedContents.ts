/** Publisher-documented content, available without installing a connection.
 * Human-facing capability names are not guessed MCP wire identifiers.
 * Source: https://docs.slack.dev/ai/slack-mcp-server/ (2026-11-26).
 */
export interface PublishedMcpContent {
  readonly sourceUrl: string;
  readonly publisher: string;
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
  }[];
}

const PUBLISHED_CONTENTS: Readonly<Record<string, PublishedMcpContent>> = {
  'https://mcp.slack.com/mcp': {
    sourceUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
    publisher: 'Slack',
    tools: [
      {
        name: 'Search messages and files',
        description: 'Find content across your workspace.',
      },
      { name: 'Read files', description: 'Retrieve shared file content.' },
      { name: 'Search emoji', description: 'Find workspace emoji.' },
      { name: 'Search users', description: 'Find people and profiles.' },
      {
        name: 'Search channels',
        description: 'Find conversations and their details.',
      },
      { name: 'Send messages', description: 'Post to a conversation.' },
      { name: 'Schedule messages', description: 'Arrange a future message.' },
      { name: 'Read channels', description: 'Retrieve conversation history.' },
      { name: 'Read threads', description: 'Retrieve replies to a message.' },
      {
        name: 'Create conversations',
        description: 'Start channels or direct conversations.',
      },
      { name: 'Add reactions', description: 'React to a message.' },
      { name: 'Get reactions', description: 'Read a message’s reactions.' },
      { name: 'Create canvases', description: 'Create rich documents.' },
      { name: 'Update canvases', description: 'Edit existing documents.' },
      { name: 'Read canvases', description: 'Retrieve canvas content.' },
      { name: 'Read user profiles', description: 'Retrieve profile details.' },
      {
        name: 'List channel members',
        description: 'Find conversation participants.',
      },
      {
        name: 'List user channels',
        description: 'List a person’s conversations.',
      },
      { name: 'Upload files', description: 'Upload and finalize files.' },
      {
        name: 'Create, read and update lists',
        description: 'Work with structured records.',
      },
    ],
  },
};

export function curatedMcpPublishedContents(
  url: string | undefined,
): PublishedMcpContent | undefined {
  return url === undefined
    ? undefined
    : PUBLISHED_CONTENTS[url.replace(/\/$/, '')];
}
