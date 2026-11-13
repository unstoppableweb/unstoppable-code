import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';
import { DEFAULT_MOCK_BASE_URL } from './registerScenario.mjs';

export const SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID =
  '77777777-7777-4777-8777-777777777777';
export const SHARED_CONTAINER_RECIPIENT_CODE_ID =
  '55555555-5555-4555-8555-555555555551';
export const SHARED_CONTAINER_RECIPIENT_COWORK_ID =
  '55555555-5555-4555-8555-555555555552';
// A neutral image the e2e mock server serves, so the read-only share view
// shows a remote image loading as in any chat.
export const SHARED_CONTAINER_REMOTE_IMAGE_URL = `${DEFAULT_MOCK_BASE_URL}/org-logo/shared-chat-image.svg`;
// Chromium normalizes the backslashes to `https://attacker.invalid/...`, which
// never resolves, so the same view also shows the failed-image fallback.
export const SHARED_CONTAINER_UNREACHABLE_IMAGE_URL =
  'https://attacker.invalid/shared-container-backslash-token';
const SHARED_CONTAINER_UNREACHABLE_IMAGE_SOURCE =
  'https:\\\\attacker.invalid\\shared-container-backslash-token';

const OWNER_USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-09-01T14:00:00.000Z';
const CODE_REVISION_ID = 'code-revision-1';
const COWORK_REVISION_ID = 'cowork-revision-1';
/**
 * A second cowork revision, seeded but NOT referenced by `index.json`.
 *
 * It exists so a test can simulate the publisher typing: point the index at
 * this revision and broadcast the new replica state. `readIndex()` is
 * uncached, so main's real read guard then serves revision 2 through the
 * ordinary content path -- no stubbed reads.
 */
export const SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID =
  'cowork-revision-2';
/** The chat that sorts second in the cowork share's filename-ordered list. */
export const SHARED_CONTAINER_RECIPIENT_COWORK_SECOND_CHAT_ID =
  'cowork-followup';
/** Only present in revision 2, so its visibility proves the re-read landed. */
export const SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_MESSAGE =
  'Publisher added a scheduling detail at revision two.';
export const SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_FILE =
  'exports/revision-two.txt';
export const SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_NOTE =
  'Revision two follow-up';
const SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_FILE_CONTENT =
  'Revision two export.\n';
const COWORK_FILE_CONTENT = 'Customer follow-up details.\n';
const LARGE_ATTACHMENT_DISPLAY_NAME = 'large-preview.txt';
const LARGE_ATTACHMENT_CONTENT =
  'Bounded recipient attachment preview.\n' + 'x'.repeat(256 * 1024);
const CODE_CHAT_TEXT =
  'Please review the shared implementation. [Open the styled page](blog/index.html).';

function summary({ id, title, containerType, revisionId }) {
  return {
    id,
    organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
    ownerUserId: OWNER_USER_ID,
    worktreeId: `${id}-worktree`,
    containerType,
    title,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    capabilities: ['VIEW'],
    latestRevision: {
      id: revisionId,
      revision: 1,
      schemaVersion: 1,
      sourceDeviceId: 'e2e-device',
      artifactObjectKey: `e2e/${revisionId}`,
      artifactHash: `sha256:${'a'.repeat(64)}`,
      artifactSizeBytes: '1',
      createdAt: NOW,
    },
  };
}

const CODE_SUMMARY = summary({
  id: SHARED_CONTAINER_RECIPIENT_CODE_ID,
  title: 'Recipient feature branch',
  containerType: 'CODE_WORKTREE',
  revisionId: CODE_REVISION_ID,
});
const COWORK_SUMMARY = summary({
  id: SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  // The server list title is the publisher's own sidebar Work Entry name, and
  // matches the authenticated published title in container.json below, so a
  // recipient can tell what a share is before accepting it.
  title: 'Customer follow-up',
  containerType: 'COWORK_WORK_ENTRY',
  revisionId: COWORK_REVISION_ID,
});

function message(chatId, text, extraText) {
  return {
    schemaVersion: 1,
    chatId,
    title:
      chatId === 'code-chat'
        ? 'Review implementation'
        : chatId === SHARED_CONTAINER_RECIPIENT_COWORK_SECOND_CHAT_ID
          ? 'Follow-up thread'
          : 'Customer notes',
    createdAt: NOW,
    messages: [
      {
        messageId: `${chatId}-message`,
        chatId,
        role: 'user',
        status: 'complete',
        text,
        createdAtMs: Date.parse(NOW),
      },
      ...(chatId === 'code-chat'
        ? [
            {
              messageId: `${chatId}-remote-images`,
              chatId,
              role: 'assistant',
              status: 'complete',
              text: [
                `![Checkout dashboard](${SHARED_CONTAINER_REMOTE_IMAGE_URL})`,
                `![Unreachable image](${SHARED_CONTAINER_UNREACHABLE_IMAGE_SOURCE})`,
              ].join('\n\n'),
              createdAtMs: Date.parse(NOW) + 1,
            },
          ]
        : []),
      ...(extraText === undefined
        ? []
        : [
            {
              messageId: `${chatId}-message-2`,
              chatId,
              role: 'assistant',
              status: 'complete',
              text: extraText,
              createdAtMs: Date.parse(NOW) + 2,
            },
          ]),
    ],
  };
}

function revisionRoot(userDataDir, containerId, revisionId) {
  return path.join(
    userDataDir,
    'shared-containers',
    containerId,
    'revisions',
    revisionId,
  );
}

/**
 * A real two-commit repository standing in for the recipient's own checkout
 * (CAN-2551).
 *
 * The committed half of a share is never published as artifacts — it resolves
 * from `mergeBaseSha..baseCommitSha` inside the replica's own clone. Exercising
 * that path end to end therefore needs actual git objects, not a plain
 * directory, so this seeds one and hands the real SHAs back for the manifest.
 *
 * Everything is pinned: fixed identity, fixed dates, `--no-gpg-sign`, and an
 * explicit initial branch, so the two commits are deterministic apart from
 * their SHAs, which the caller reads back rather than hard-coding.
 */
function seedCommittedHistory(repoRoot, files, remoteUrl, links = []) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(repoRoot, '.gitconfig-absent'),
    GIT_CONFIG_SYSTEM: path.join(repoRoot, '.gitconfig-absent'),
    GIT_AUTHOR_NAME: 'Recipient Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Recipient Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-09-01T14:00:00+00:00',
    GIT_COMMITTER_DATE: '2026-09-01T14:00:00+00:00',
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: repoRoot, env, encoding: 'utf8' }).trim();

  mkdirSync(repoRoot, { recursive: true });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Recipient Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', remoteUrl);

  // The merge base: every committed path exists here with its "before" body,
  // so the diff the recipient renders has a real left-hand side.
  for (const file of files) {
    mkdirSync(path.dirname(path.join(repoRoot, file.path)), {
      recursive: true,
    });
    writeFileSync(path.join(repoRoot, file.path), file.base, 'utf8');
  }
  // A committed symlink is ordinary repository content — Canopy's own tree has
  // `.claude/skills` — and it is git mode 120000, so checking the base commit
  // out materializes a real link the fork has to carry across (CAN-2552).
  for (const link of links) {
    mkdirSync(path.dirname(path.join(repoRoot, link.path)), {
      recursive: true,
    });
    symlinkSync(link.target, path.join(repoRoot, link.path));
  }
  git('add', '--all');
  git('commit', '--quiet', '--no-gpg-sign', '-m', 'base');
  const mergeBaseSha = git('rev-parse', 'HEAD');

  // The publisher's own commit on top of it.
  for (const file of files) {
    writeFileSync(path.join(repoRoot, file.path), file.head, 'utf8');
  }
  git('add', '--all');
  git('commit', '--quiet', '--no-gpg-sign', '-m', 'publisher commit');
  const baseCommitSha = git('rev-parse', 'HEAD');

  return { mergeBaseSha, baseCommitSha };
}

function seedCodeRevision(
  userDataDir,
  {
    includeRun = false,
    includeLayout = false,
    includeStartPage = false,
    layoutWebPageUrl,
    codeSource = 'github',
  } = {},
) {
  const root = revisionRoot(
    userDataDir,
    SHARED_CONTAINER_RECIPIENT_CODE_ID,
    CODE_REVISION_ID,
  );
  // Seed the checkout before the manifest: the committed group is addressed by
  // real commit SHAs, so the manifest has to be written from what git actually
  // produced rather than from placeholders.
  const repoRoot = path.join(root, 'repos', 'repo-1');
  const { mergeBaseSha, baseCommitSha } = seedCommittedHistory(
    repoRoot,
    [
      {
        path: 'src/committed-change.ts',
        base: 'export const committed = false;\n',
        head: 'export const committed = true;\n',
      },
      // A tracked file the publisher never changed. It is in the checkout but
      // in no published file list, like most files a publisher has open.
      ...(includeLayout
        ? [
            {
              path: 'docs/unchanged-guide.md',
              base: '# Unchanged guide\n',
              head: '# Unchanged guide\n',
            },
          ]
        : []),
    ],
    'https://github.com/acme/recipient-fixture.git',
    [
      // The exact shape that broke a real fork: a link that climbs out of its
      // own directory and lands back inside the repository.
      { path: 'skills/committed-link', target: '../src/committed-change.ts' },
    ],
  );
  const secondaryRepoRoot = path.join(root, 'repos', 'repo-2');
  const { baseCommitSha: secondaryBaseCommitSha } = seedCommittedHistory(
    secondaryRepoRoot,
    [
      {
        path: 'README.md',
        base: '# Recipient secondary\n',
        head: '# Recipient secondary repository\n',
      },
    ],
    'https://github.com/acme/recipient-secondary.git',
  );
  if (includeRun) {
    // Mirrors a publisher-side `.env.example`: only names become run hints;
    // these sample values are never adopted as recipient values.
    writeFileSync(
      path.join(repoRoot, '.env.example'),
      'DATABASE_URL=postgres://localhost/example\nSHARED_GREETING=hello\n',
      'utf8',
    );
  }
  writeJson(path.join(root, 'artifacts', 'container.json'), {
    // A web page in the layout needs schema v5.
    schemaVersion: layoutWebPageUrl
      ? 5
      : includeStartPage
        ? 4
        : codeSource === 'snapshot'
          ? 2
          : includeLayout
            ? 3
            : 1,
    containerType: 'CODE_WORKTREE',
    title: CODE_SUMMARY.title,
    repositories: [
      ...(codeSource === 'snapshot'
        ? [
            {
              repoId: 'repo-1',
              repoName: 'recipient-fixture',
              source: 'snapshot',
              baseCommitSha,
              snapshot: {
                bundleArtifactIds: ['snapshot-bundle'],
                treeFileCount: 2,
                treeBytes: '64',
              },
              files: [
                {
                  path: 'src/recipient.ts',
                  status: 'added',
                  artifactId: 'recipient-file',
                  mode: '100644',
                },
                {
                  path: 'blog/index.html',
                  status: 'added',
                  artifactId: 'recipient-html',
                  mode: '100644',
                },
                {
                  path: 'blog/style.css',
                  status: 'added',
                  artifactId: 'recipient-css',
                  mode: '100644',
                },
              ],
            },
          ]
        : [
            {
              repoId: 'repo-1',
              repoName: 'recipient-fixture',
              remoteUrl: 'https://github.com/acme/recipient-fixture.git',
              owner: 'acme',
              repository: 'recipient-fixture',
              baseCommitSha,
              files: [
                {
                  path: 'src/recipient.ts',
                  status: 'added',
                  artifactId: 'recipient-file',
                  mode: '100644',
                },
                {
                  path: 'blog/index.html',
                  status: 'added',
                  artifactId: 'recipient-html',
                  mode: '100644',
                },
                {
                  path: 'blog/style.css',
                  status: 'added',
                  artifactId: 'recipient-css',
                  mode: '100644',
                },
              ],
              // CAN-2551: the publisher's own commits travel as metadata only. The
              // blobs are already in the checkout above, so nothing here is uploaded.
              baseBranch: 'main',
              mergeBaseSha,
              committedFiles: [
                {
                  path: 'src/committed-change.ts',
                  status: 'modified',
                  insertions: 1,
                  deletions: 1,
                },
              ],
            },
          ]),
      {
        repoId: 'repo-2',
        repoName: 'recipient-secondary',
        remoteUrl: 'https://github.com/acme/recipient-secondary.git',
        owner: 'acme',
        repository: 'recipient-secondary',
        baseCommitSha: secondaryBaseCommitSha,
        files: [
          {
            path: 'src/secondary.ts',
            status: 'added',
            artifactId: 'secondary-file',
            mode: '100644',
          },
        ],
      },
    ],
    files: [],
    notes: [{ itemId: 'code-note', title: 'Release note' }],
    prompts: [{ itemId: 'code-prompt', title: 'Review prompt' }],
    attachmentPaths: {
      'large-attachment': {
        artifactId: `attachments/${'c'.repeat(64)}`,
        displayName: LARGE_ATTACHMENT_DISPLAY_NAME,
      },
    },
    withheldFileCount: 2,
    withheldFileReasons: ['credential-shaped', 'oversized'],
    ...(includeStartPage
      ? {
          startPage: {
            kind: 'file',
            repoId: 'repo-1',
            relativePath: 'blog/index.html',
          },
        }
      : {}),
    ...(includeLayout
      ? {
          layout: {
            orientation: 0,
            root: {
              type: 'leaf',
              size: 1,
              tabs: [
                { kind: 'chat', chatId: 'code-chat' },
                {
                  kind: 'file',
                  repoId: 'repo-1',
                  relativePath: 'blog/index.html',
                  viewMode: 'rich',
                },
                {
                  kind: 'file',
                  repoId: 'repo-1',
                  relativePath: 'docs/unchanged-guide.md',
                  viewMode: 'raw',
                },
                ...(layoutWebPageUrl
                  ? [{ kind: 'browser', url: layoutWebPageUrl }]
                  : []),
                // Missing references prove the recipient projection drops
                // stale publisher tabs instead of escaping the inventory.
                { kind: 'chat', chatId: 'missing-chat' },
                {
                  kind: 'file',
                  repoId: 'repo-1',
                  relativePath: 'private/not-published.txt',
                },
              ],
              activeTabIndex: 0,
            },
          },
        }
      : {}),
    ...(includeRun
      ? {
          run: {
            commands: [
              {
                name: 'launch',
                // Stays alive like a real dev server: the terminal session is
                // deleted when its command exits, and the reload check must
                // still find it. Revoking consent stops it; the bound only
                // caps an orphan if the app is torn down without reaping.
                command:
                  'printf "shared-container-run:%s:%s\\n" "$SHARED_GREETING" "$DATABASE_URL"; sleep 600',
                repoId: 'repo-1',
              },
            ],
            requiredEnv: ['DATABASE_URL', 'SHARED_GREETING'],
          },
        }
      : {}),
  });
  writeJson(
    path.join(root, 'artifacts', 'chats', 'code-chat.json'),
    message('code-chat', CODE_CHAT_TEXT),
  );
  writeJson(path.join(root, 'artifacts', 'plans', 'recipient-plan.json'), {
    schemaVersion: 1,
    planId: 'recipient-plan',
    title: 'Recipient rollout plan',
    content: '# Recipient rollout plan\n\nVerify the shared read-only surface.',
    source: 'claude',
    reviewStatus: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    latestRevisionNumber: 1,
    commentThreads: [],
  });
  // The committed-range marker materialization writes once the merge-base
  // fetch AND the blob warm have both succeeded. The reader gates the
  // committed group on it, because a local merge-base commit does not imply
  // its blobs landed (CAN-2551).
  mkdirSync(path.join(root, 'committed-ranges'), { recursive: true });
  writeFileSync(
    path.join(root, 'committed-ranges', 'repo-1'),
    mergeBaseSha,
    'utf8',
  );
  // The published overlay is written on top of the checkout, exactly as
  // materialization would lay it down.
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'src', 'recipient.ts'),
    'export const recipient = true;\n',
    'utf8',
  );
  mkdirSync(path.join(repoRoot, 'blog'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'blog', 'index.html'),
    '<!doctype html><html><head><title>Recipient styled page</title><link rel="stylesheet" href="style.css"></head><body><h1 id="recipient-style-proof">Styled recipient page</h1></body></html>',
    'utf8',
  );
  writeFileSync(
    path.join(repoRoot, 'blog', 'style.css'),
    '#recipient-style-proof { color: rgb(12, 110, 74); font-weight: 700; }\n',
    'utf8',
  );
  mkdirSync(path.join(secondaryRepoRoot, 'src'), { recursive: true });
  writeFileSync(
    path.join(secondaryRepoRoot, 'src', 'secondary.ts'),
    'export const secondary = true;\n',
    'utf8',
  );
  mkdirSync(path.join(root, 'content', 'notes'), { recursive: true });
  mkdirSync(path.join(root, 'content', 'prompts'), { recursive: true });
  mkdirSync(path.join(root, 'content', 'attachments'), { recursive: true });
  writeFileSync(
    path.join(root, 'content', 'notes', 'code-note.md'),
    '# Release note\n\nRecipient content is read only.\n',
    'utf8',
  );
  writeFileSync(
    path.join(root, 'content', 'prompts', 'code-prompt.md'),
    '# Review prompt\n\nCheck the published overlay.\n',
    'utf8',
  );
  writeFileSync(
    path.join(root, 'content', 'attachments', LARGE_ATTACHMENT_DISPLAY_NAME),
    LARGE_ATTACHMENT_CONTENT,
    'utf8',
  );
}

/**
 * @param {string} userDataDir
 * @param {{ revisionId?: string, secondChatExtraMessage?: string, includeRevisionTwoContent?: boolean }} [options]
 *   `secondChatExtraMessage` appends a uniquely worded message to the SECOND
 *   chat only, so a test can tell revision 2's content apart from revision 1's
 *   without depending on ordering or timestamps.
 */
export function seedSharedContainerRecipientCoworkRevision(
  userDataDir,
  options = {},
) {
  const {
    revisionId = COWORK_REVISION_ID,
    secondChatExtraMessage = undefined,
    includeRevisionTwoContent = false,
    includeLayout = false,
  } = options;
  const root = revisionRoot(
    userDataDir,
    SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    revisionId,
  );
  writeJson(path.join(root, 'artifacts', 'container.json'), {
    schemaVersion: includeLayout ? 3 : 1,
    containerType: 'COWORK_WORK_ENTRY',
    title: 'Customer follow-up',
    repositories: [],
    files: [
      {
        path: 'exports/customer-summary.txt',
        status: 'added',
        artifactId: 'cowork-file',
        sizeBytes: String(Buffer.byteLength(COWORK_FILE_CONTENT)),
      },
      ...(includeRevisionTwoContent
        ? [
            {
              path: SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_FILE,
              status: 'added',
              artifactId: 'cowork-revision-two-file',
              sizeBytes: String(
                Buffer.byteLength(
                  SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_FILE_CONTENT,
                ),
              ),
            },
          ]
        : []),
    ],
    notes: [
      {
        itemId: 'cowork-note',
        title: includeRevisionTwoContent
          ? SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_NOTE
          : 'Follow-up note',
      },
    ],
    prompts: [{ itemId: 'cowork-prompt', title: 'Response prompt' }],
    attachmentPaths: {},
    ...(includeLayout
      ? {
          layout: {
            orientation: 0,
            root: {
              type: 'branch',
              size: 1,
              children: [
                {
                  type: 'leaf',
                  size: 600,
                  tabs: [{ kind: 'chat', chatId: 'cowork-chat' }],
                  activeTabIndex: 0,
                },
                {
                  type: 'leaf',
                  size: 600,
                  tabs: [
                    {
                      kind: 'browser',
                      repoId: 'workspace',
                      relativePath: 'exports/customer-summary.txt',
                    },
                    // A publisher Cowork file tab opened from its changes
                    // carries a diff context, so it arrives as a diff of the
                    // Cowork file root.
                    {
                      kind: 'file-diff',
                      repoId: 'workspace',
                      relativePath: 'exports/customer-summary.txt',
                      viewMode: 'diff',
                    },
                    // Publishers can hold two browser tabs on the same file;
                    // the one they left active must still open first.
                    {
                      kind: 'browser',
                      repoId: 'workspace',
                      relativePath: 'exports/customer-summary.txt',
                    },
                  ],
                  activeTabIndex: 2,
                },
              ],
            },
          },
        }
      : {}),
  });
  writeJson(
    path.join(root, 'artifacts', 'chats', 'cowork-chat.json'),
    message('cowork-chat', 'Summarize the customer follow-up.'),
  );
  // `cowork-f...` sorts after `cowork-c...`, and the reader lists chats by
  // artifact filename -- so this is reliably the second row, the one a
  // recipient has to deliberately select.
  writeJson(
    path.join(
      root,
      'artifacts',
      'chats',
      `${SHARED_CONTAINER_RECIPIENT_COWORK_SECOND_CHAT_ID}.json`,
    ),
    message(
      SHARED_CONTAINER_RECIPIENT_COWORK_SECOND_CHAT_ID,
      'Track the follow-up thread.',
      secondChatExtraMessage,
    ),
  );
  mkdirSync(path.join(root, 'content', 'notes'), { recursive: true });
  mkdirSync(path.join(root, 'content', 'prompts'), { recursive: true });
  writeFileSync(
    path.join(root, 'content', 'notes', 'cowork-note.md'),
    includeRevisionTwoContent
      ? '# Revision two follow-up\n\nCall the customer on Friday. Ada added a scheduling detail.\n'
      : '# Follow-up note\n\nCall the customer on Friday.\n',
    'utf8',
  );
  writeFileSync(
    path.join(root, 'content', 'prompts', 'cowork-prompt.md'),
    '# Response prompt\n\nUse a concise and friendly tone.\n',
    'utf8',
  );
  mkdirSync(path.join(root, 'content', 'exports'), { recursive: true });
  writeFileSync(
    path.join(root, 'content', 'exports', 'customer-summary.txt'),
    COWORK_FILE_CONTENT,
    'utf8',
  );
  if (includeRevisionTwoContent) {
    writeFileSync(
      path.join(
        root,
        'content',
        SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_FILE,
      ),
      SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_FILE_CONTENT,
      'utf8',
    );
  }
}

/**
 * Seed already-materialized plaintext plus the authoritative replica index.
 * The mock latest-revision response matches the index, so opening takes the
 * manager's verified same-revision fast path and never downloads/decrypts.
 */
/**
 * The viewer's read-only chat scope, as main's `projectSharedContainerViewerChats`
 * writes it on the verified same-revision open path. Specs that stub
 * `shared-containers:open` (the replica store cannot observe an index written
 * after the account transition) bypass that path, so the projection it would
 * have produced is seeded here as the legacy aggregate chat file, which main
 * migrates into canonical V2 storage on first load.
 */
function seedViewerChatScope(userDataDir, containerId, chats) {
  writeJson(
    path.join(
      userDataDir,
      'app-workspaces',
      'shared-container-viewer',
      'chats',
      `${containerId}.json`,
    ),
    {
      version: 1,
      tabs: chats.map((chat) => ({
        id: chat.chatId,
        title: chat.title,
        createdAt: chat.createdAt,
        readOnly: true,
        messages: chat.messages.map((entry) => ({
          id: entry.messageId,
          role: entry.role,
          blocks: [{ type: 'text', text: entry.text }],
          timestamp: entry.createdAtMs,
        })),
      })),
      activeTabId: chats[0]?.chatId ?? '',
    },
  );
}

export function seedSharedContainerRecipientReplicas(
  userDataDir,
  {
    preferences = true,
    includeRun = false,
    includeLayout = false,
    includeStartPage = false,
    includeCoworkLayout = false,
    layoutWebPageUrl,
    codeSource = 'github',
  } = {},
) {
  seedCodeRevision(userDataDir, {
    includeRun,
    includeLayout,
    includeStartPage,
    layoutWebPageUrl,
    codeSource,
  });
  seedSharedContainerRecipientCoworkRevision(userDataDir, {
    includeLayout: includeCoworkLayout,
  });
  seedViewerChatScope(userDataDir, SHARED_CONTAINER_RECIPIENT_CODE_ID, [
    message('code-chat', CODE_CHAT_TEXT),
  ]);
  seedViewerChatScope(userDataDir, SHARED_CONTAINER_RECIPIENT_COWORK_ID, [
    message('cowork-chat', 'Summarize the customer follow-up.'),
    message(
      SHARED_CONTAINER_RECIPIENT_COWORK_SECOND_CHAT_ID,
      'Track the follow-up thread.',
    ),
  ]);
  // Seeded on disk but deliberately absent from `index.json` below: a test
  // promotes it by rewriting the index, which is how a publisher revision
  // reaches this device.
  seedSharedContainerRecipientCoworkRevision(userDataDir, {
    revisionId: SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID,
    secondChatExtraMessage:
      SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_MESSAGE,
    includeRevisionTwoContent: true,
  });
  writeJson(path.join(userDataDir, 'shared-containers', 'index.json'), {
    version: 1,
    containers: {
      [SHARED_CONTAINER_RECIPIENT_CODE_ID]: {
        status: 'available',
        containerId: SHARED_CONTAINER_RECIPIENT_CODE_ID,
        organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
        containerType: 'CODE_WORKTREE',
        updatedAt: NOW,
        revisionId: CODE_REVISION_ID,
        revision: 1,
        revisionCreatedAt: NOW,
        withheldFileCount: 2,
        withheldFileReasons: ['credential-shaped', 'oversized'],
      },
      [SHARED_CONTAINER_RECIPIENT_COWORK_ID]: {
        status: 'available',
        containerId: SHARED_CONTAINER_RECIPIENT_COWORK_ID,
        organizationId: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
        containerType: 'COWORK_WORK_ENTRY',
        updatedAt: NOW,
        revisionId: COWORK_REVISION_ID,
        revision: 1,
        revisionCreatedAt: NOW,
        // Singular verb agreement, and `symlink-escaping` — the reason the
        // renderer's old switch had no case for, so it rendered a colon
        // introducing nothing (CAN-2551).
        withheldFileCount: 1,
        withheldFileReasons: ['symlink-escaping'],
      },
    },
    artifacts: {},
    promotionCommits: {},
  });
  const replicaRoot = path.join(userDataDir, 'shared-containers');
  const identity = statSync(replicaRoot, { bigint: true });
  writeJson(path.join(userDataDir, '.shared-containers.identity.json'), {
    version: 1,
    state: 'active',
    dev: String(identity.dev),
    ino: String(identity.ino),
  });
  if (preferences) {
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: { onboardingCompleted: ['v1'] },
    });
  }
}

export function sharedContainerRecipientScenario({
  includeCode = true,
  includeCowork = true,
  includeRun = false,
  includeLayout = false,
  includeStartPage = false,
  includeCoworkLayout = false,
  includeLayoutWebPage = false,
  codeSource = 'github',
} = {}) {
  return {
    cloud: {
      organizations: [
        {
          id: SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
          name: 'Recipient E2E Organization',
          role: 'MEMBER',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      teams: [],
    },
    sharedContainers: {},
    sharedContainersState: {
      containers: [
        ...(includeCode
          ? [
              codeSource === 'snapshot'
                ? {
                    ...CODE_SUMMARY,
                    latestRevision: {
                      ...CODE_SUMMARY.latestRevision,
                      schemaVersion: 2,
                    },
                  }
                : includeLayoutWebPage
                  ? {
                      ...CODE_SUMMARY,
                      latestRevision: {
                        ...CODE_SUMMARY.latestRevision,
                        schemaVersion: 5,
                      },
                    }
                  : includeStartPage
                    ? {
                        ...CODE_SUMMARY,
                        latestRevision: {
                          ...CODE_SUMMARY.latestRevision,
                          schemaVersion: 4,
                        },
                      }
                    : includeLayout
                      ? {
                          ...CODE_SUMMARY,
                          latestRevision: {
                            ...CODE_SUMMARY.latestRevision,
                            schemaVersion: 3,
                          },
                        }
                      : CODE_SUMMARY,
            ]
          : []),
        ...(includeCowork
          ? [
              includeCoworkLayout
                ? {
                    ...COWORK_SUMMARY,
                    latestRevision: {
                      ...COWORK_SUMMARY.latestRevision,
                      schemaVersion: 3,
                    },
                  }
                : COWORK_SUMMARY,
            ]
          : []),
      ],
      grants: [],
      nextContainer: 3,
      nextGrant: 1,
    },
    // The local server does not transport the sealed artifact body, but
    // callers use this alongside the matching replica seeder so the scenario
    // declares whether its code revision includes recipient run metadata.
    includeRun,
    includeLayout,
    includeStartPage,
  };
}
