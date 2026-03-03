// Base image Dockerfile
// 包含 Node.js 20, Python 3.11, Go 1.22, Rust, Docker CLI, Git, curl, jq, 和常用编译工具
export const BASE_DOCKERFILE = `# agent-docker-base: Batteries-included sandbox image
FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

# ── Core system utilities ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates \\
    curl \\
    wget \\
    git \\
    gnupg \\
    lsb-release \\
    jq \\
    make \\
    build-essential \\
    pkg-config \\
    libssl-dev \\
    unzip \\
    zip \\
    xz-utils \\
    sudo \\
    openssh-client \\
    && rm -rf /var/lib/apt/lists/*

# ── Docker CLI (for DooD — Docker-outside-of-Docker) ────────────────────────
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \\
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu jammy stable" \\
       > /etc/apt/sources.list.d/docker.list \\
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \\
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 (via NodeSource) ─────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \\
    && apt-get install -y nodejs \\
    && npm install -g pnpm yarn \\
    && rm -rf /var/lib/apt/lists/*

# ── Python 3.11 ─────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3.11 python3.11-venv python3-pip \\
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \\
    && update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1 \\
    && rm -rf /var/lib/apt/lists/*

# ── Go 1.22 ─────────────────────────────────────────────────────────────────
RUN curl -fsSL https://go.dev/dl/go1.22.5.linux-amd64.tar.gz | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:\${PATH}"

# ── Rust (rustup, stable) ───────────────────────────────────────────────────
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --no-modify-path
ENV PATH="/usr/local/cargo/bin:\${PATH}"

# ── Default working directory ────────────────────────────────────────────────
# Will be overridden by identity-mount at runtime
WORKDIR /tmp

CMD ["sleep", "infinity"]
`;

export const COPILOT_INSTRUCTIONS = `# Agent Docker - Copilot Instructions

You have access to a Docker sandbox via the \`agent-docker\` MCP server. **Always use the sandbox tools for code execution instead of running commands directly on the host.**

## Core Principle

All code execution, builds, tests, and file operations should happen **inside the Docker sandbox**, not on the host machine. The sandbox uses **identity-mount** — the project directory is mounted at the SAME absolute path inside the container, so all file changes are instantly reflected on the host.

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| \`exec_bash\` | Execute shell commands inside the sandbox container |
| \`fs_read\` | Read file contents from the sandbox |
| \`fs_write\` | Write/create files in the sandbox |
| \`fs_list\` | List directory structure in the sandbox |
| \`install_system_dependency\` | Install system packages (apt) with root privileges |
| \`rebuild_sandbox\` | Rebuild sandbox from \`.agent-docker/Dockerfile\` |
| \`get_env\` | Read environment variables from the sandbox |

## Workflow

1. **Read files** using \`fs_read\` or \`fs_list\` to understand the project structure.
2. **Make changes** using \`fs_write\` to create or modify files.
3. **Run commands** using \`exec_bash\` for builds, tests, installs, linting, etc.
4. **Verify** results using \`exec_bash\` (e.g., \`npm test\`, \`npm run build\`).
5. **Report** the outcome to the user.

## Important Rules

- Files written inside the sandbox are **automatically visible on the host** (identity-mount). No copy step is ever needed.
- The \`.git\` directory is mounted as **read-only**. You can read git history but cannot modify it.
- The sandbox runs as a **non-root user**. For system packages, use \`install_system_dependency\`.
- For services like databases, Redis, or message queues, use **Docker Compose** (you have Docker CLI access), do NOT install them via apt-get.
- If you need a completely different runtime, write a Dockerfile to \`.agent-docker/Dockerfile\` and call \`rebuild_sandbox\`.
`;

export const CURSOR_RULES = `# Agent Docker - Cursor Rules

You have access to a Docker sandbox via the \`agent-docker\` MCP server.

## Core Rules

* All file modifications can be done via IDE native tools (e.g. apply_patch, write_file).
* **CRITICAL**: For ANY script execution, building, linting, running tests, or other shell commands, you MUST ONLY use the \`exec_bash\` tool from the MCP server. DO NOT run any commands using the native IDE Terminal tool.
* For system packages (jq, make, curl, etc.), use \`install_system_dependency\` — the sandbox is non-root.
* For databases/services, orchestrate with Docker Compose. Do NOT install them into the sandbox.
* The .git directory is read-only. Use git for reading (status, diff, log) only.
`;

export const MCP_SERVER_ENTRY = {
  command: "agent-docker",
  args: ["serve"],
  cwd: "${workspaceFolder}",
  env: {},
} as const;
