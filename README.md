# agent-docker-mcp 🐳

> The project is a lightweight & refactored version of [Agent-sandbox-platform](https://github.com/fyerfyer/Agent-sandbox-platform).

> **Lightweight Docker sandbox CLI with Model Context Protocol (MCP) support.** Built for AI Agents (like Cursor), giving them a safe, isolated, and disposable environment to run code and commands.

[![npm version](https://img.shields.io/npm/v/agent-docker.svg)](https://www.npmjs.com/package/agent-docker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

When working with local AI coding assistants, you often want them to run tests, install dependencies, or execute shell commands without messing up your host machine. `agent-docker-mcp` seamlessly creates an ephemeral Docker container mapped to your project, exposing it as an MCP server for the AI to use safely.

> ⚠️ **Note:** This project is currently in early development and has **only been tested on Linux with the Cursor IDE**. macOS/Windows support and compatibility with other MCP clients may vary.

## ✨ Features

- **Instant Sandbox:** Spin up an isolated environment instantly, identity-mounted perfectly to your current working directory.
- **Native MCP Support:** Exposes standard Tools for agents to run bash commands securely.
- **Structured Outputs:** `exec_bash` returns machine-readable `stdout`/`stderr`/`exitCode`/`truncated` fields.
- **Background Jobs:** Run long-lived commands (dev servers, watchers) in the background and poll them via `get_job_output`.
- **Resource Limits:** Hardened defaults include memory/CPU/PID limits, dropped capabilities, and `no-new-privileges`.
- **Strict Mode:** One-flag opt-in to disable Docker-outside-of-Docker, isolate the network, and shadow sensitive files.
- **Auto-Scaffolding:** Automatically sets up `.cursor/mcp.json` or `.vscode/mcp.json` to integrate with your favorite IDE.
- **Session History & Replay:** Built-in SQLite tracking records every command and its output. You can even "replay" the session like an asciinema cast!

## 🚀 Quick Start

**Prerequisites**:

- Node.js >= 18.0.0
- Docker Desktop / Engine running (Docker >= 20.10 recommended for hardened defaults)

You can run our CLI directly using `npx` (no installation required):

```bash
# 1. Initialize the sandbox and setup agent configurations
npx agent-docker-mcp init

# 2. Start the sandbox for your project
npx agent-docker-mcp start
```

## 🛠 Integrating with AI IDEs

### Cursor

By running `npx agent-docker-mcp init` in your project root, the CLI does the heavy lifting:

1. Checks Docker health and pulls the default sandbox image.
2. Auto-creates `.cursor/mcp.json` (or `.vscode/mcp.json`) for MCP integration.
3. Auto-creates `.cursorrules` to instruct the AI to prefer the sandbox over the host shell.

Then you need to go to `Settings` -> `Tools & MCP` and enable `agent-docker` MCP.

Once initialized, the AI agent will automatically have access to the `agent-docker` MCP tools!

### Copilot

Just run `npx agent-docker-mcp init` in your project root, and once a project starts, the Agent will try starting MCP server itself!

## 📖 Basic Commands

```bash
# Initialize sandbox and scaffolding
npx agent-docker-mcp init

# Start a sandbox container for the current directory
npx agent-docker-mcp start

# Start in strict mode (no DooD, isolated network, .env shadowed)
npx agent-docker-mcp start --strict

# Execute a command inside the sandbox manually
# Quotes are handled safely, so `npx agent-docker-mcp exec echo "a b"` keeps "a b" as one argument.
npx agent-docker-mcp exec "npm run test"

# List active sandbox containers
npx agent-docker-mcp ps

# Stop the current sandbox
npx agent-docker-mcp stop

# List past sandbox sessions
npx agent-docker-mcp history

# Replay a specific session log (great for debugging agent actions)
npx agent-docker-mcp replay <session-id>

# Clean up orphaned sandbox containers
npx agent-docker-mcp cleanup
```

## 🔒 Security Model

The sandbox uses multiple layers of isolation:

- **Kernel-enforced boundaries** (real isolation): cgroups resource limits (memory, CPU, PIDs), capability bounding-set drop to a minimal set, `no-new-privileges`, non-root user execution, `.git` mounted read-only, and optional network isolation / DooD disablement in `--strict` mode.
- **Anti-foot-gun guard**: a regex blacklist blocks obviously dangerous commands like `rm -rf /` or fork bombs. This is a convenience guard, **not** a security boundary — determined adversaries can bypass string filtering.
- **Known residual risk in default mode**: the container has access to the host's `docker.sock` (DooD) and may use `host` networking on Linux. This is equivalent to giving the agent local root access. **Only use default mode for projects you trust.** For untrusted workloads or public code, use `--strict`.

## ⚙️ Configuration

Create `.agent-docker/config.json` in your project root to override defaults. CLI flags take precedence over the config file.

```json
{
  "image": "ubuntu:22.04",
  "strict": false,
  "network": "host",
  "allowDocker": true,
  "resources": {
    "memoryMb": 4096,
    "cpus": 2,
    "pidsLimit": 512
  },
  "env": ["KEY=VALUE"],
  "protectPaths": [".env.local"]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `image` | string | `agent-docker-base:latest` | Docker image used for the sandbox. |
| `strict` | boolean | `false` | When `true`, disables DooD, switches network to `bridge`, and adds `.env` to `protectPaths`. |
| `network` | `"host" \| "bridge" \| "none"` | Linux: `host`, other: `bridge` | Container network mode. Explicit value overrides `strict`. |
| `allowDocker` | boolean | `true` | Mount the host Docker socket into the container. `strict` forces this to `false`. |
| `resources` | object | `memoryMb: 4096, cpus: 2, pidsLimit: 512` | cgroups limits for the container. |
| `env` | string[] | `[]` | Extra environment variables passed to the container as `KEY=VALUE`. |
| `protectPaths` | string[] | `[]` | Files inside the project to mask with `/dev/null:ro`. Directories are ignored. |

## 🧠 How it Works

1. **Identity Mount**: `agent-docker` mounts your current directory into a container (`ubuntu`-based by default) using the exact same path. Any code generated or edited by the agent is instantly reflected on your host.
2. **MCP Server**: Once standard configurations are generated (`init`), the AI connects to `npx agent-docker serve`, picking up specialized tools (`exec_bash`, `get_job_output`, etc.) inside the container.
3. **Execution & Auditing**: Commands are sent to Docker via the `dockerode` library. The execution stream is parsed, logged securely into local SQLite (`~/.config/agent-docker/db.sqlite`), and safely returned to the AI.

## 🧪 Development

```bash
# Install dependencies
pnpm install

# Build TypeScript
pnpm build

# Run unit tests
pnpm test

# Run Docker-backed E2E tests
pnpm test:e2e
```

## 📄 License

MIT
