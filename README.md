# opencode-acpx-v2

[![CI](https://github.com/adolfo199/opencode-acpx-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/adolfo199/opencode-acpx-v2/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An experimental OpenCode 2 port of
[`intellectronica/opencode-acpx`](https://github.com/intellectronica/opencode-acpx).
It exposes Cursor and other ACP agents as first-class OpenCode providers while
keeping the ACP process and its credentials outside the repository.

This fork adds the OpenCode 2 `setup()` surface, in-memory provider
registration through `ctx.provider.transform`, and AI SDK hooks. The original
OpenCode 1 entrypoints remain available.

## OpenCode 2 status

The OpenCode 2 path supports configuration through OpenCode plugin `options`
(as well as `OPENCODE_ACPX_V2_CONFIG`), model discovery, provider registration,
stateful ACP sessions, text/reasoning streaming, ACP-owned activity, and
session cleanup on `session.deleted`. When the host exposes `ctx.tool`,
`ctx.permission` and `ctx.event`, interactive `"ask"` permission prompts are
routed through OpenCode 2's native permission system. When host permission UI
is unavailable, permissions fail closed by default. Set
`OPENCODE_ACPX_V2_PERMISSIONS=ask` to prompt through OpenCode 2 or `allow` only
when you trust the ACP agent to perform tool actions without confirmation.

## Supported agents

| Preset        | ACP command                                           | Notes                                           |
| ------------- | ----------------------------------------------------- | ----------------------------------------------- |
| `cursor`      | `cursor-agent acp`, falling back to `agent acp`       | Install and authenticate Cursor separately      |
| `claude`      | Bundled Claude Agent ACP adapter                      | Adapter version is pinned by this package       |
| `codex`       | Bundled Codex ACP adapter                             | Adapter version is pinned by this package       |
| `antigravity` | `agy acp`                                             | Install and authenticate Antigravity separately |
| `grok-build`  | `grok agent --no-leader stdio`                        | Install and authenticate Grok separately        |
| `hermes`      | `hermes acp`, falling back to `hermes-acp`            | Install and configure Hermes separately         |
| `custom`      | Any configured ACP v1 command using NDJSON over stdio | Capability-detected                             |

## Requirements

- OpenCode `2.0.0` or newer for the new entrypoint
- Node.js `>=22.13`
- Cursor Agent installed and already authenticated (`agent acp` must start)

## Install on OpenCode 2

Until the package is published, clone and build it:

```sh
git clone https://github.com/adolfo199/opencode-acpx-v2.git
cd opencode-acpx-v2
pnpm install --frozen-lockfile
pnpm build
```

Create a local plugin package under an isolated OpenCode configuration:

```sh
export OPENCODE_CONFIG_DIR="$HOME/.config/opencode-acpx-v2"
mkdir -p "$OPENCODE_CONFIG_DIR/plugins/acpx-v2"
printf '%s\n' '{"name":"acpx-v2-local","type":"module","main":"./index.js"}' > "$OPENCODE_CONFIG_DIR/plugins/acpx-v2/package.json"
printf 'export { default } from %s;\n' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$PWD/dist/plugin-opencode2.js")" > "$OPENCODE_CONFIG_DIR/plugins/acpx-v2/index.js"
printf '%s\n' '{"$schema":"https://opencode.ai/config.json","plugin":["./plugins/acpx-v2"]}' > "$OPENCODE_CONFIG_DIR/opencode.json"
```

Start OpenCode:

```sh
OPENCODE_CONFIG_DIR="$HOME/.config/opencode-acpx-v2" opencode
```

Cursor is not an OpenCode credential integration in this fork, so it does not
appear under `/connect`. Authentication is owned by Cursor Agent itself. Models
appear under provider **Cursor (ACP)** after `agent acp` discovery succeeds.

Tool permissions are denied by default. To enable trusted Cursor tool actions:

```sh
OPENCODE_ACPX_V2_PERMISSIONS=allow \
OPENCODE_CONFIG_DIR="$HOME/.config/opencode-acpx-v2" opencode
```

No Cursor token, API key, authentication file, or full environment is copied or
forwarded by the default configuration.

## OpenCode 1 compatibility

The original `./server` entrypoint and configuration format are retained for
OpenCode 1 users. See [configuration](docs/configuration.md).

## Configure

Several agents can run together:

```jsonc
{
  "plugin": [
    [
      "opencode-acpx",
      {
        "permissions": {
          "default": "ask",
          "fallback": "deny",
        },
        "servers": {
          "cursor": {
            "preset": "cursor",
            "mode": "agent",
          },
          "claude": {
            "preset": "claude",
            "forwardEnv": ["ANTHROPIC_API_KEY"],
          },
          "codex": {
            "preset": "codex",
            "forwardEnv": ["CODEX_API_KEY"],
          },
          "grok": {
            "preset": "grok-build",
            "forwardEnv": ["XAI_API_KEY"],
          },
          "hermes": {
            "preset": "hermes",
          },
        },
      },
    ],
  ],
}
```

Each agent's exact model IDs are discovered at startup. Standard ACP
`thought_level`, known model-scoped configuration, and supported Cursor/Grok
reasoning controls are exposed as OpenCode variants. Permission, workflow and
persona modes remain session controls rather than being mislabelled as
thinking effort.

Normal OpenCode model filters work with ACP providers:

```jsonc
{
  "provider": {
    "acp.cursor": {
      "whitelist": ["grok-4.6"],
    },
  },
}
```

The strict options schema also supports explicit model fallbacks, initial ACP
config values, MCP servers, custom commands, skill policies and per-server
process isolation. See the full [configuration guide](docs/configuration.md)
and [compatibility matrix](docs/compatibility.md).

### ACP over SSH

Override a preset's `command` and `args` to launch its ACP process differently.
ACP uses stdio, so the override can be an SSH command that carries the stream
to another machine. For example:

```jsonc
{
  "preset": "hermes",
  "command": "/usr/bin/ssh",
  "args": [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "mac-mini",
    "exec hermes acp",
  ],
  "cwd": "/Users/example",
  "authProfile": "mac-mini",
}
```

Use key-based authentication and a verified host key. The remote command must
keep stdout exclusively for ACP NDJSON and send logs to stderr. More defensive
SSH options and path requirements are documented in
[configuration](docs/configuration.md#acp-stdio-over-ssh).

## How it behaves

- One durable ACP conversation is kept for each OpenCode session, server and
  worktree.
- Assistant text and thought traces stream as OpenCode text and reasoning.
- ACP-owned tool calls are displayed without being executed a second time by
  OpenCode. Known shapes use native shell, read, search, edit, write, web, todo
  and task presentation; unknown shapes retain structured ACP metadata.
- Standard plans and known agent todo extensions populate OpenCode's native
  todo list. Cursor, Claude, Codex and Grok subagent events use native task
  activity where their protocol data permits it.
- Permissions and questions use OpenCode's normal UI and fail closed if a
  correlated response cannot be obtained.
- Agent-native rules, commands, skills, MCP servers, memory and hooks remain
  active inside the agent. ACP-advertised commands are added to OpenCode's
  startup catalogue when available.

ACP is a stateful agent protocol, so these providers are not stateless LLM
endpoints. Discovery is a startup snapshot; reload the plugin after changing
an agent's available models or commands.

## Security

ACP agents can read and modify files, run commands and access networks. The
default policy asks through OpenCode and falls back to denial. Presets never
enable force, yolo, full-access or always-approve modes. Only explicitly named
environment variables are forwarded to an agent.

Read the [security model](docs/security.md) before enabling broad permissions
or remote agents. Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/intellectronica/opencode-acpx/security/advisories/new).

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
```

The release gate runs formatting, lint, strict TypeScript, unit and real-process
ACP integration tests, the production build, and packed-export verification.
See [testing](docs/testing.md) and [architecture](docs/architecture.md) for more.

## Licence

MIT. The bundled Acpx compatibility code retains its MIT notice in
[`LICENSES/acpx-MIT.txt`](LICENSES/acpx-MIT.txt).
