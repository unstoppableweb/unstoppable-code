---
name: handle-pr-comments
description: >-
  {% if claude %}/builtin-gh:handle-pr-comments{% else %}$builtin-gh:handle-pr-comments{% endif %} only. Review and address PR comments
---

# Handle PR Comments

The user wants to review and address comments on the pull request for the current branch.

Parse the arguments from "the user request" to check for:

- **[comment pattern]**: Optional pattern to filter comments (must be first argument, before any flags). Only comments whose body matches this pattern will be processed.
- **--me**: Only review comments from the current user
- **--skip-copilot**: Ignore comments from GitHub Copilot
- **--auto**: Autonomous mode - skip the planned-changes table confirmation pause, use best judgment on ambiguous comments instead of asking for clarification, and proceed with large change requests using the most reasonable interpretation. Intended for orchestration by other automation commands.
- **--follow-up-pipeline="Pipeline Name Here"**: After handling the PR comments, replying on GitHub, resolving threads, and re-requesting reviews, conditionally start the named pipeline.
- **--follow-up-pipeline-if="..."**: Optional condition for `--follow-up-pipeline`. Supported structured values are `approved` and `not-approved`; any other value is free-form user intent that must be evaluated after the GitHub reply/resolve/rerequest workflow completes. If omitted, always run the follow-up pipeline when `--follow-up-pipeline` is provided. If this flag is provided without `--follow-up-pipeline`, ignore it and state that no follow-up pipeline target was provided.
- **--auto-archive**: Enable auto-archive for this chat at the very end of this workflow. If a follow-up pipeline is started, enable it only after the final watcher notification for that pipeline path.

## Instructions

### Step 1: Output Arguments Summary

Display the provided arguments and summarize how they will be handled:

**Arguments received**: `the user request`

- **If a comment pattern is provided** (first argument, not starting with `--`): Only comments whose body matches the pattern will be processed
  - If the pattern is wrapped with backslashes (`\...\`), treat the inner content as a regex (e.g., `\^(TODO|FIXME):\`)
  - If the pattern contains wildcards (`*` or `?`), treat it as a glob pattern
  - Otherwise, perform a case-insensitive "contains" check with the provided text
- **If `--me` is provided**: Only comments from your GitHub user will be reviewed
- **If `--skip-copilot` is provided**: Comments from GitHub Copilot will be ignored
- **If `--auto` is provided**: All confirmation pauses will be skipped — the planned changes table will be displayed but execution will proceed immediately without waiting for approval. Ambiguous comments will be handled using best judgment. Large change requests will be implemented with the most reasonable interpretation.
- **If `--follow-up-pipeline="Pipeline Name Here"` is provided**: After all GitHub replies/resolutions and review rerequests are complete, evaluate whether to start the named pipeline.
- **If `--follow-up-pipeline-if="..."` is provided**: Use it as the post-comment condition for starting the follow-up pipeline:
  - `approved`: Start only when the PR review decision is `APPROVED`
  - `not-approved`: Start only when the PR review decision is anything other than `APPROVED`
  - Any other text: Treat it as free-form user intent and decide from the completed workflow state whether the pipeline should run
  - If `--follow-up-pipeline` was not also provided, ignore this condition and explicitly note that no follow-up pipeline target was provided
- **If `--auto-archive` is provided**: Enable auto-archive for this chat only after the entire workflow is complete. If a follow-up pipeline is started, carry the requirement into the watcher follow-up instruction and enable auto-archive only after the final watcher for that pipeline path has fired.
- **If no arguments are provided**: All unresolved PR comments will be reviewed and addressed, including AI-generated comments, with changes committed and pushed to the current branch

Example output:

> **Arguments**: `"TODO*" --me`
>
> - Comment pattern: `TODO*` (glob)
> - Filter to my comments: Yes
> - Will review and address your comments matching "TODO\*" on the current PR

Example output with follow-up automation:

> **Arguments**: `--auto --follow-up-pipeline="Implementation Autopilot" --follow-up-pipeline-if="not-approved" --auto-archive`
>
> - Autonomous mode: Yes
> - Follow-up pipeline: `Implementation Autopilot`
> - Follow-up condition: run only if the PR is not approved after comments are handled
> - Auto-archive: Yes, after the follow-up pipeline watcher completes

### Step 2: Get PR Comments

> **Important**: GitHub uses different ID formats for REST vs GraphQL APIs. See [GitHub PR Comment IDs](../../references/github-pr-comment-ids.md) for details.

1. Get the current branch name
2. Fetch the PR for this branch using explicit, supported `gh pr view` JSON fields:
   ```bash
   PR_INFO=$(gh pr view --json number,url --jq '{number: .number, url: .url}')
   PR_NUMBER=$(echo "$PR_INFO" | jq -r .number)
   OWNER_REPO=$(echo "$PR_INFO" | jq -r .url | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/.*|\1|')
   OWNER="${OWNER_REPO%/*}"
   REPO="${OWNER_REPO#*/}"
   ```
   Do not include `repository` in the `--json` field list. This GitHub CLI version does not expose a bare `repository` field for `gh pr view`. Derive `OWNER` and `REPO` from the PR URL rather than `headRepository` so fork PRs target the base repository that owns the PR number.
3. Fetch data from **both APIs** (they provide different information):

   **a) REST API** - Get comments with **database IDs** (needed for replying):

   ```bash
   gh api --paginate "repos/$OWNER/$REPO/pulls/$PR_NUMBER/comments" \
     --jq '.[] | {id, path, line, body, user: .user.login, userType: .user.type}'
   ```

   The `id` field here is the **numeric database ID** (e.g., `2737789739`) required for the reply endpoint.

   **b) GraphQL API** - Get threads with **resolution status, thread IDs, and review metadata** (needed for resolving and AI review detection):

   GraphQL pagination is required at two independent levels: the pull request's
   `reviewThreads` connection and each thread's `comments` connection. Do not
   stop after the first 100 threads or the first 100 comments in a thread.

   Fetch a page of review threads with variables and request pagination metadata
   for both connections:

   ```bash
   gh api graphql \
     -F owner="$OWNER" \
     -F repo="$REPO" \
     -F pr="$PR_NUMBER" \
     -F threadCursor=null \
     -f query='
       query(
         $owner: String!
         $repo: String!
         $pr: Int!
         $threadCursor: String
       ) {
         repository(owner: $owner, name: $repo) {
           pullRequest(number: $pr) {
             reviewThreads(first: 100, after: $threadCursor) {
               totalCount
               pageInfo {
                 hasNextPage
                 endCursor
               }
               nodes {
                 id
                 isResolved
                 comments(first: 100) {
                   totalCount
                   pageInfo {
                     hasNextPage
                     endCursor
                   }
                   nodes {
                     id
                     path
                     line
                     body
                     author {
                       __typename
                       login
                     }
                     pullRequestReview {
                       state
                       body
                     }
                   }
                 }
               }
             }
           }
         }
       }'
   ```

   Accumulate every returned thread and its comments. If
   `reviewThreads.pageInfo.hasNextPage` is `true`, call the same query again
   with `-F threadCursor="<endCursor>"`. Repeat until it is `false`. `null` is
   the typed initial cursor; do not pass an empty string.

   A thread's comments paginate separately from the containing
   `reviewThreads` connection. For every thread whose
   `comments.pageInfo.hasNextPage` is `true`, continue from that thread's
   comment cursor:

   ```bash
   gh api graphql \
     -F threadId="$THREAD_ID" \
     -F commentCursor="$COMMENT_END_CURSOR" \
     -f query='
       query($threadId: ID!, $commentCursor: String) {
         node(id: $threadId) {
           ... on PullRequestReviewThread {
             id
             isResolved
             comments(first: 100, after: $commentCursor) {
               totalCount
               pageInfo {
                 hasNextPage
                 endCursor
               }
               nodes {
                 id
                 path
                 line
                 body
                 author {
                   __typename
                   login
                 }
                 pullRequestReview {
                   state
                   body
                 }
               }
             }
           }
         }
       }'
   ```

   Append each returned comment page to that thread, replace
   `COMMENT_END_CURSOR` with the new `endCursor`, and repeat until the thread's
   `comments.pageInfo.hasNextPage` is `false`.

   Do not rely on `gh api graphql --paginate` for the combined nested query.
   The response contains two `pageInfo` objects, so automatic pagination can
   follow the wrong connection and stop while review threads remain. Control
   both cursors explicitly. Before continuing, verify that:
   - The number of accumulated threads equals `reviewThreads.totalCount`
   - The number of accumulated comments in each thread equals that thread's
     `comments.totalCount`
   - The final `hasNextPage` value is `false` for every connection

   The thread `id` field here is the **GraphQL node ID** (e.g., `PRRT_kwDOQ82ISc5rfaZ6`) required for resolving.
   The `pullRequestReview.body` field contains the parent review's summary comment (submitted when the reviewer clicked "Submit review"). This is used to detect AI-generated reviews — only the summary comment will contain markers like "AI Code Review", not the individual inline comments.
   `author.__typename` is `Bot` for a GitHub App. GraphQL returns an App's login **without** the `[bot]` suffix (REST `user.login` keeps it, and REST `user.type` is `Bot`), so check the type rather than the suffix in GraphQL results.

4. **Correlate the two responses** by matching `path` + `line` + `body` to link database IDs with thread IDs
5. **Skip comments from dismissed review threads**: Exclude any comments where `pullRequestReview.state` is `DISMISSED`
6. **Detect AI-generated reviews**: An inline comment is considered AI-generated if **either** of the following is true:
   - The comment's author is `copilot-pull-request-reviewer[bot]` (Copilot bot account)
   - The comment's **parent review summary** (`pullRequestReview.body`) contains the substring "AI Code Review" (case-insensitive) or the `[//]: # (ud-ai-review)` marker, whoever wrote it. This catches AI code review tools that post through human user accounts and packaged code reviews posted as the code review GitHub App — the marker appears only in the overall review summary, not in individual inline comments, so all inline comments belonging to that review are tagged as AI-generated.
   - The comment's author is a Bot: `author.__typename` is `Bot` in GraphQL, or the login has a `[bot]` suffix (or `user.type` is `Bot`) in REST. Packaged code reviews post as a GitHub App, so their comments arrive from a Bot author.

   Tag each comment with an `aiReview` flag (true/false) based on these rules. This flag is used for display in the Step 3 Author column and for evaluating AI-generated review comments later: append `" (AI)"` to the author name only when `aiReview` is true **and** the author is **not** `copilot-pull-request-reviewer[bot]` (Copilot bot reviews are already identified by their author name).

7. Filter remaining comments based on arguments:
   - If a comment pattern is provided, only include comments whose body matches the pattern:
     - **Regex pattern** (wrapped with `\...\`): Match using regex (e.g., `\^(TODO|FIXME):\` matches comments starting with "TODO:" or "FIXME:")
     - **Glob pattern** (contains `*` or `?`): Match using glob-style matching (e.g., `TODO*` matches "TODO: fix this")
     - **Plain text** (no special characters): Case-insensitive substring match (e.g., `refactor` matches "Please refactor this function")
   - If `--me` is provided, only include comments from the current GitHub user (get username via `gh api user`)
   - If `--skip-copilot` is provided, exclude comments from `copilot-pull-request-reviewer[bot]`

### Step 3: Present Planned Changes

Before taking any action, output a table summarizing how each comment will be handled.

**Sequencing requirement**: The triage table MUST be presented before asking for user confirmation. Do not ask "should I proceed?", ask clarifying questions, request approval, or otherwise pause for user input until after the table is visible to the user. This requirement applies even when one or more comments are unclear, large, or likely to be rejected.

| Comment              | Author     | Acceptance | Plan         |
| -------------------- | ---------- | ---------- | ------------ |
| _Summary of comment_ | _username_ | _icon_     | _Brief plan_ |

**Acceptance icons:**

- ✅ Will handle the change as requested
- 💬 Will research and answer the question (no code changes)
- ⚠️ Will partially handle the change (explain deviation in Plan column)
- ❓ Unclear how to proceed (will ask for clarification)
- ❌ Rejecting the request (explain reason in Plan column)

**Guidelines:**

- The **Comment** column should be a brief summary of the comment (not the full text)
- The **Author** column shows the GitHub username of the commenter. If the comment is from an AI-generated review posted through a human account (detected via "AI Code Review" in the parent review summary), append " (AI)" to the username (e.g., `alice (AI)`)
- The **Plan** column should briefly describe the intended action; if rejecting, explain why
- If additional context is needed for any comment, include it after the table

**Example output:**

| Comment                                | Author                             | Acceptance | Plan                                                                  |
| -------------------------------------- | ---------------------------------- | ---------- | --------------------------------------------------------------------- |
| Rename variable to be more descriptive | alice                              | ✅         | Rename `x` to `userCount`                                             |
| Consider using a Map instead of object | copilot-pull-request-reviewer[bot] | ❌         | Performance difference negligible for this use case                   |
| Add error handling for null input      | dave (AI)                          | ❌         | Function already has null guard on line 42                            |
| Refactor this entire module            | bob                                | ⚠️         | Will extract helper functions but keep overall structure              |
| What does this function do?            | charlie                            | 💬         | Will investigate and reply with explanation of the function's purpose |
| This seems wrong                       | eve                                | ❓         | Unclear what specific change is requested; will ask for clarification |

> **Note on "Refactor this entire module"**: The module has external dependencies that expect the current interface. Will improve internal structure while maintaining the public API.

**If `--auto` is NOT enabled**: After presenting the table, pause and wait for user confirmation before proceeding to handle the comments. If the user wants to adjust any of the planned actions, incorporate their feedback before continuing.

**If `--auto` IS enabled**: After presenting the table, proceed immediately to handling comments without waiting for confirmation.

### Step 4: Handle Each Comment

For each unresolved comment, categorize and handle it:

**Important**: Do not blindly accept code suggestions. Consider the desired outcome of each comment and determine the most appropriate change to accomplish it. The suggested code may not always be the best solution.

**Clearly actionable comments** (e.g., "rename this variable", "add a null check", "fix typo"):

- Make the necessary code changes immediately
- Track the comment for later resolution

**Question comments** (e.g., "Why did you choose this approach?", "What does this function do?", "Is this thread-safe?"):

- Investigate the codebase, git history (`git log`, `git blame`), and surrounding context to find the answer
- Compose a clear, informative reply that directly answers the question
- Do NOT make any code changes for this comment
- Track the comment for later reply and resolution in Step 7.

**Ambiguous or unclear comments**:

- **If `--auto` is NOT enabled**: Present the comment to the user, ask for clarification on what changes are needed, and wait for user input before proceeding
- **If `--auto` IS enabled**: Use best judgment to determine the most reasonable interpretation. Note your reasoning in the reply when resolving the thread.

**Large sweeping change requests** (e.g., "refactor this entire module", "change the architecture"):

- **If `--auto` is NOT enabled**: Create a detailed plan for the requested changes, present the plan to the user for confirmation, and only proceed after user approval
- **If `--auto` IS enabled**: Implement the most reasonable interpretation of the request. Focus on the highest-impact changes that align with the comment's intent.

**AI-generated review comments** (Copilot and human-account AI reviews): It is acceptable to reject an AI-generated comment if both of the following are true:

1. No human user has added a comment to agree with the AI's suggestion
2. The comment falls into one of these categories:
   - A minor style/formatting preference that doesn't affect functionality
   - A suggestion that is factually incorrect or doesn't apply to the codebase
   - A nitpick about wording that doesn't meaningfully improve clarity
   - An overly verbose suggestion that adds unnecessary complexity

When rejecting an AI-generated comment, reply with a brief explanation of why it was rejected before resolving the thread.

### Step 5: Verify Changes

**Skip this step entirely if no code changes were made** (e.g., all processed comments were questions answered with 💬). When this step is skipped due to no code changes, continue to the reply and resolve step (Step 7) as usual.

When code changes are made and this step is not skipped, run relevant checks on the affected files:

1. **Discover project configuration**:
   - Check CLAUDE.md and README.md for documented lint/test/build commands
   - Check for project configuration files (`package.json`, `pyproject.toml`, `Makefile`, etc.)
   - Identify available lint, type-check, and test scripts defined by the project

2. **Run linting** on modified files using the project's configured linter:
   - Use the project's lint script if available
   - Target only the modified files when possible

3. **Run language-specific compile/transpile checks**:
   - TypeScript: Run type checking (e.g., `tsc --noEmit` or project's typecheck script)
   - Go: Run `go build` or `go vet`
   - Rust: Run `cargo check`
   - Other compiled languages: Run the appropriate compile/check command
   - Skip if the project doesn't use a compiled/transpiled language

4. **Run tests** related to the modified files:
   - Look for test files that correspond to the modified files
   - Use the project's test script, targeting specific files when supported
   - If targeted tests aren't feasible, run the full test suite

5. **If any checks fail**:
   - Attempt to fix linting and type errors automatically if possible
   - For test failures, analyze the failure and fix the code
   - If fixes require significant changes, ask the user how to proceed

6. **Re-stage any additional fixes**:
   ```bash
   git add <fixed-files>
   ```

### Step 6: Commit and Push

**Note**: If no code changes were made (e.g., all comments were questions answered with 💬), skip this step entirely — do not create an empty commit.

After handling all comments:

1. Stage all changes: `git add -A`
2. Create a commit with a message summarizing the changes made:
   - Keep the subject line within 83 characters (e.g., "fix: Address PR review comments")
   - Include additional details in the commit body if needed (separated by a blank line)
3. Push to the remote branch

If no code changes were made, skip this step.

### Step 7: Reply and Resolve All Comment Threads

**IMPORTANT**: After handling comments, you MUST reply to AND resolve EVERY comment thread that was processed. This applies even when Step 6 was skipped because no code changes were needed and no commit was pushed. Do not leave any threads open or without a reply.

> **Critical**: Use the correct ID type for each operation. See [GitHub PR Comment IDs](../../references/github-pr-comment-ids.md).

For each comment, perform these two actions in sequence:

#### Action 1: Reply to the comment thread (REST API with Database ID)

Use the REST API with the **numeric database ID** (e.g., `2737789739`) from Step 2a:

**For addressed comments:**

```
Addressed in <commit-sha>
```

**For rejected comments** (e.g., invalid Copilot suggestions):

```
Rejecting this suggestion because <brief explanation>.
```

**For answered questions (💬):**
Post the researched answer directly as the reply. Do NOT use the "Addressed in <commit-sha>" format since no code changes were made. The reply should be a clear, informative answer to the question.

Example reply command:

```bash
# Use the NUMERIC database ID from the REST API response
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{database_id}/replies -f body="Addressed in abc1234"
```

**Common mistake**: Using a GraphQL node ID (`PRRC_*`) here will return 404. You MUST use the numeric database ID.

#### Action 2: Immediately mark the thread as resolved (GraphQL with Thread ID)

Use the GraphQL API with the **thread node ID** (e.g., `PRRT_kwDOQ82ISc5rfaZ6`) from Step 2b:

```bash
# Use the PRRT_* thread ID from the GraphQL response
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "PRRT_xyz..."}) { thread { isResolved } } }'
```

Note: If the thread is already resolved, this mutation will succeed without error.

**Process each comment fully (reply + resolve) before moving to the next comment.** This ensures all threads are properly closed and the PR review is complete.

### Step 8: Re-request Reviews

After all comment threads have been replied to and resolved, re-request a review from each human reviewer whose comments were processed:

1. **Collect reviewers**: Gather the unique `author.login` values from all comments that were handled in Step 4.
2. **Exclude bot accounts and PR author**: Remove every Bot account: any login with a `[bot]` suffix (e.g., `copilot-pull-request-reviewer[bot]`) and any author whose GraphQL `author.__typename` is `Bot`, including the code review GitHub App (its GraphQL login has no `[bot]` suffix). Never re-request a review from a Bot. Also remove the PR author (obtainable via `gh pr view --json author`), since GitHub's API will fail if you try to request a review from the PR author.
3. **Skip if no human reviewers remain**: If the list is empty after exclusions, skip the API call and output:
   > No human reviewers to re-request.
4. **Re-request reviews** (only if at least one human reviewer remains):
   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr}/requested_reviewers -f 'reviewers[]=user1' -f 'reviewers[]=user2'
   ```
5. **Display confirmation**: Output the list of reviewers who were re-requested, e.g.:
   > Re-requested review from: **alice**, **bob**

### Step 9: Optional Follow-up Pipeline

Run this step only when `--follow-up-pipeline="Pipeline Name Here"` was provided. If only `--follow-up-pipeline-if` was provided, skip this step after stating that no follow-up pipeline target was provided. This step happens after all PR comments have been handled, all GitHub replies have been posted, all processed threads have been resolved, and review rerequests have been completed.

1. **Evaluate the follow-up condition**:
   - If `--follow-up-pipeline-if` was not provided, the condition is satisfied.
   - If `--follow-up-pipeline-if="approved"`, fetch the current PR review decision and continue only when it is `APPROVED`:
     ```bash
     gh pr view --json reviewDecision --jq .reviewDecision
     ```
   - If `--follow-up-pipeline-if="not-approved"`, fetch the current PR review decision and continue only when it is not `APPROVED`.
   - If `--follow-up-pipeline-if` is any other text, treat it as free-form user intent. Evaluate it against the completed workflow state, including handled comments, verification results, pushed commits, GitHub replies, thread resolution, and the current PR state. State the interpretation briefly before deciding whether to start the pipeline.
2. **If the condition is not satisfied**:
   - State that the follow-up pipeline was skipped.
   - Continue to Step 10 if `--auto-archive` was provided; otherwise finish.
3. **If the condition is satisfied**:
   - Use the pipeline management tools to find and start the named pipeline in this worktree.
   - Start the pipeline and set up a watcher for the pipeline execution. Prefer starting the run with a watcher in the same tool call when the available tool supports it; otherwise start the pipeline first, then create the watcher. Do not keep the current turn open solely to wait for an asynchronous pipeline; the watcher notification will resume this chat when action is needed.
   - The watcher follow-up instruction must include:
     > Watch the pipeline to ensure it completes successfully (either retrying it in-place or starting a new one, depending on the failure) but do NOT triage the results.
   - If `--auto-archive` was provided, append this requirement to the watcher follow-up instruction:
     > After the final watcher for the successful run or retry/restart path fires, call the Set Auto Archive tool with `enabled: true`.
   - If the pipeline fails to start because the name cannot be found or is ambiguous, report that clearly and do not guess.
   - If `--auto-archive` was not provided, finish after confirming the watcher is set.

### Step 10: Optional Auto-archive

Run this step only when `--auto-archive` was provided.

- If no follow-up pipeline was started, call the **Set Auto Archive** tool with `enabled: true` after completing Step 8 and, when applicable, recording that Step 9 skipped the pipeline.
- If a follow-up pipeline was started, do not enable auto-archive in the pipeline-starting turn. The watcher follow-up instruction must tell the resumed watcher turn to enable it after the final watcher fires. If the pipeline must be retried in-place or restarted with a new execution, wait for the final watcher for that retry/restart path. After that final watcher fires, call the **Set Auto Archive** tool with `enabled: true`.
- Do not enable auto-archive before all required GitHub replies, thread resolutions, review rerequests, follow-up pipeline decisions, and required watcher setup/watcher completion steps are done.

## Notes

- **Two API families are needed in Step 2**: paginated REST calls for database IDs (replying), paginated GraphQL calls for thread IDs (resolving)
- Review comments have a `path`, `line`, and `body` that can be used to correlate REST and GraphQL responses
- Thread IDs (`PRRT_*` prefix) are different from comment node IDs (`PRRC_*` prefix)
- Always preserve the original intent of the code when making changes
- See [GitHub PR Comment IDs](../../references/github-pr-comment-ids.md) for detailed ID type documentation
