# Unstoppable Code desktop app

This folder is the source for the Unstoppable Code desktop app at one exported
revision, either a release or a development snapshot from main. Releases have a
`source-desktop/vX.Y.Z` tag; snapshots have no tag. The `version` field in
`package.json` doesn't track app releases. It builds on its own: you don't need
any other part of this repository, an account, or any
credentials.

Just want the app? [Download it](https://unstoppable.ai/download) instead.

## Before you start

A build from this source is for reading, auditing, and changing the app. It
differs from the app you download:

- **No installers:** the commands below compile and launch the app from this
  folder. Packaging installers isn't supported from this source yet.
- **Hosted services:** `build:public` is configured for the same sign-in,
  cloud, and feature-flag services as the released app. It sends the same
  PostHog analytics events, without session replays, and the unpackaged app
  doesn't check for updates. To turn analytics off, set
  `CANOPY_POSTHOG_ENABLED` to `false` before `build:public`. To build with
  every hosted service off, use the
  [local-only build](#build-without-our-services) instead. To connect to
  your own server, use the [self-host build](#build-for-your-own-server).
- **Some helpers aren't included:** the bundled command-line tool and the
  native dictation helper are left out of this source.
- **macOS and Linux only:** building from source on Windows isn't supported
  yet. Our CI builds and launches this source on macOS and Ubuntu 24.04, and
  runs the local-only smoke test on both.

## Requirements

On every platform:

- Node.js 24
- pnpm, at the version pinned in `package.json`. Run `corepack enable pnpm`
  once to use it.

On macOS, install the Xcode command-line tools for the native modules:

```sh
xcode-select --install
```

On Linux, install a C/C++ toolchain and Python 3 for the native modules. On
Ubuntu, that's `sudo apt-get install build-essential python3`. Ubuntu 24.04 is
the version our CI uses.

## Run the app

Run these from this folder (the one with this README):

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:public
pnpm run setup:public
pnpm run start:public
```

- The install applies the reviewed dependency patches without running
  lifecycle scripts.
- `build:public` compiles the app into `out/` and its local core daemon into
  `dist/core-daemon/`. The daemon owns workspace records and local execution.
- `setup:public` installs Electron, compiles the native file broker, and
  rebuilds `node-pty` for Electron.
- `start:public` launches the compiled app with the Unstoppable Code brand.
  Arguments after it go to Electron.

## Build without our services

The local-only build turns every hosted service off when it compiles, so the
app never contacts our servers, whatever your environment says:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:local
pnpm run setup:local
pnpm run start:local
```

- `build:local` compiles the app and its core daemon with the local-only
  profile, and marks the build as local-only. `build:public` removes that mark.
- `setup:local` does what `setup:public` does, and also downloads the pinned
  Claude Code CLI into `.cache/bin/`, checking its checksum. The smoke test
  uses it. Use `setup:public` instead if you don't want the download.
- `start:local` launches the local-only build. It refuses to start a build
  made by `build:public`.
- `pnpm run smoke:local` checks the local-only build without a display of its
  own: it starts a local mock model server, creates a workspace and a
  worktree, sends one Claude chat turn, and opens Settings and the model picker.
  It tests an installation without Codex and does not use a Codex on PATH. It
  fails if the app tried to reach any host it shouldn't, and it never retries.
  On Linux, run it under `xvfb-run --auto-servernum`; extra Electron switches,
  such as `--no-sandbox`, go in `CANOPY_LOCAL_SMOKE_ELECTRON_ARGS`.

If `package.json` has no `build:local` script, this source is from before the
local-only build existed.

What's off:

- Sign-in, accounts, and everything that needs them: AI credits, hosted
  models, Remote Control, cloud chats, sharing, and the marketplace
- Update checks, PostHog analytics, and hosted feature flags. The app uses
  each feature flag's built-in local-only value.
- Automatic calls to other services: the skill safety check and skill update
  check, marketplace refreshes, runtime downloads (the app uses the staged
  binary or the one on your `PATH`), GitHub avatars, and background pull
  request polling. Plan usage meters refresh only when you open them.

What still works, because you start or configure it:

- Your own model provider, with your plan or a custom base URL
- [Your own AI gateway](../../docs/ai-gateway.md) and Ollama
- MCP servers you connect, and their sign-in (OAuth) providers
- GitHub actions you start while GitHub is connected
- Browsing in the app's built-in browser

Anything else is blocked and logged to `local-only-egress.jsonl` in the app's
data folder. To allow another host, add its exact name to the `allowedHosts`
list in `local-only.json` in the same folder.

Known limits:

- The block covers the app itself. Programs it starts, such as agent CLIs,
  `git`, and MCP servers, connect wherever their own settings say. That
  includes automatic `git fetch` from your repository's remote.
- Agent visuals that load a library from the internet don't render.
- The smoke test waits a few seconds for startup tasks. Tasks the app delays
  by up to a minute aren't covered by it.
- Installers and Windows builds aren't supported from this source.

## Build for your own server

Apps you download from us always connect to our service and can't connect
to your server. To use the desktop app with a server you host, build it from
this source with your server's address:

1. Run `pnpm install --frozen-lockfile --ignore-scripts`.
2. Run `pnpm run setup:selfhost`.
3. Run `CANOPY_CLOUD_BASE_URL=https://canopy.example.com pnpm run build:selfhost`,
   with your server's address.
4. Run `pnpm run start:selfhost`.

The address must use `https`, with a certificate your operating system
trusts. Plain `http` works only for a server on the same computer
(`localhost`). The address can't have a path, query, or user name. If you
don't have TLS yet, put the server behind a reverse proxy that provides it.
`build:selfhost` stops with a message saying what to change.

- `build:selfhost` builds the app for that server and records it. Build
  again to switch servers.
- `start:selfhost` launches the self-host build and prints its server. It
  refuses to start a build made by another command.

If `package.json` has no `build:selfhost` script, this source is from before
the self-host build existed.

What's off: PostHog analytics, hosted feature flags (the app uses each flag's
built-in value), update checks, the skill safety check, remote images, and the
other automatic calls listed under
[Build without our services](#build-without-our-services). Sign-in, Remote
Control, and cloud features use your server and the relay it hands out.

Anything else is blocked and logged to `local-only-egress.jsonl` in the app's
data folder, as in the local-only build. To allow another host, add its
exact name to the `allowedHosts` list in `local-only.json` in the same
folder.

Known limits:

- Storage your server hands out on another host, or on another port of the
  same host, is blocked. Add its host to `allowedHosts` to use it.
- Cloud features that reach a host other than your server or its relay are
  blocked, such as an organization's model gateway.
- Cloud chats and the Remote Control web preview are off, because their
  built-in flag values are off.
- Behind an HTTP or system proxy, connections go to the proxy, which is
  blocked unless its host is in `allowedHosts`.
- Programs the app starts, such as agent CLIs, `git`, and MCP servers, connect
  wherever their own settings say.
- Installers and Windows builds aren't supported from this source.

## Build and test everything

Run these in this order:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck:public
pnpm run build:public
pnpm run test:public
pnpm run setup:public
pnpm run start:public
```

On an Apple Silicon Mac, `typecheck:public` takes about a minute and a half
and `build:public` about two and a half minutes. `test:public` runs the whole
unit suite and takes much longer.

Our CI runs every step except `test:public` on this source. The same desktop
unit tests run in our main repository's CI before a release.

## What the public test suite covers

`test:public` runs the desktop unit tests that build from this source. Tests
that need private configuration or hosted services are left out; the full list
is in [`PUBLIC_BUILD_SCOPE.json`](PUBLIC_BUILD_SCOPE.json).

## What's in this folder

- `apps/desktop-app/`: the Electron app, with its main process, preload
  scripts, and renderer
- `packages/`: shared code the app is built from, like the UI components, app
  state, and runtime
- `brands/`: the app's name, icons, and logos
- `patches/`: the reviewed dependency patches the install applies
- `scripts/public-build/`: the scripts behind the `*:public`, `*:local`, and
  `*:selfhost` commands
- `PUBLIC_BUILD_SCOPE.json`: what this export includes, leaves out, and tests

## Troubleshooting

- **The app fails to start with a `NODE_MODULE_VERSION` error.** `test:public`
  rebuilds `node-pty` for Node.js. Run `pnpm run setup:public` again, then
  `pnpm run start:public`.
- **Tests run out of memory.** Each Jest worker has a 4 GB heap limit, and two
  workers run at once. Close other apps and run `pnpm run test:public` again.
  Results are saved in `.cache/public-jest-results.json`.

## Reporting issues

See [CONTRIBUTING.md](../../CONTRIBUTING.md). Please say that you built from
source and which public commit or `source-desktop/*` tag you used.

## License

See `LICENSE`. Third-party code and assets keep their own licenses, listed in
`THIRD_PARTY_NOTICES.txt`.
