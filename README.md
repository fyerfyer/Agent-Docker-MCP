# agent-docker-mcp 🐳

> The project is a lightweight & refactored version of [Agent-sandbox-platform](https://github.com/fyerfyer/Agent-sandbox-platform).

> **Lightweight Docker sandbox CLI with Model Context Protocol (MCP) support.** Built for AI Agents (like Cursor), giving them a safe, isolated, and disposable environment to run code and commands.

[![npm version](https://img.shields.io/npm/v/agent-docker.svg)](https://www.npmjs.com/package/agent-docker)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

When working with local AI coding assistants, you often want them to run tests, install dependencies, or execute shell commands without messing up your host machine. `agent-docker-mcp` seamlessly creates an ephemeral Docker container mapped to your project, exposing it as an MCP server for the AI to use safely.

> ⚠️ **Note:** This project is currently in early development and has **only been tested on Linux with the Cursor IDE**. macOS/Windows support and compatibility with other MCP clients may vary.

## ✨ Features

- **Instant Sandbox:** Spin up an isolated environment instantly, identity-mounted perfectly to your current working directory.
- **Native MCP Support:** Exposes standard Tools for agents to run bash commands securely.
- **Auto-Scaffolding:** Automatically sets up `.cursor/mcp.json` or `.vscode/mcp.json` to integrate with your favorite IDE.
- **Session History & Replay:** Built-in SQLite tracking records every command and its output. You can even "replay" the session like an asciinema cast!

## 🚀 Quick Start

**Prerequisites**:

- Node.js >= 18.0.0
- Docker Desktop / Engine running

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

# Execute a command inside the sandbox manually
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

## 🧠 How it Works

1. **Identity Mount**: `agent-docker` mounts your current directory into a container (`ubuntu`-based by default) using the exact same path. Any code generated or edited by the agent is instantly reflected on your host.
2. **MCP Server**: Once standard configurations are generated (`init`), the AI connects to `npx agent-docker serve`, picking up specialized tools (`exec_bash`, etc) inside the container.
3. **Execution & Auditing**: Commands are sent to Docker via the `dockerode` library. The execution stream is parsed, logged securely into local SQLite (`~/.agent-docker/db.sqlite`), and safely returned to the AI.

## 📄 License

Apache License.
