# AiderDesk Agent Bus

Turns independent AiderDesk tasks into a coordinated multi-agent team.

AiderDesk runs agents and manages git worktrees. [agent-bus](https://github.com/MustaphaSteph/agent-bus)
owns messages, threads and the task board. This extension is the layer in
between: it creates the tasks, gives each one a bus identity, and wakes idle
workers when messages arrive.

```
AiderDesk tasks ──▶ extension ──▶ agent-bus (MCP tools for agents, CLI for the extension)
      ▲                                   │
      └────────── wake-up ◀───────────────┘
```

No new runtime, no second message store: it is an integration layer between two
systems that already exist.

## Status

Phase 1 (proof of concept). Covered by tests: spawning tasks with profile,
identity and worktree, identity mapping, inbox polling and wake-up, team
commands/tools, dashboard, config/state persistence, and a real-CLI integration
test. Not yet proven: loading inside AiderDesk, real worktree creation and a live
two-task conversation.

## Install

```bash
# 1. agent-bus CLI (no Homebrew formula exists)
npm install -g @agent-bus-connect/cli@latest

# 2. extension, globally
git clone https://github.com/HenryJobst/aider-agent-bus.git
mkdir -p ~/.aider-desk/extensions/aiderdesk-agent-bus
rsync -a --exclude node_modules --exclude .git \
  aider-agent-bus/.aider-desk/extensions/aiderdesk-agent-bus/ \
  ~/.aider-desk/extensions/aiderdesk-agent-bus/
cd ~/.aider-desk/extensions/aiderdesk-agent-bus && npm install --omit=dev
```

`agent-bus` ships `better-sqlite3`, which has no prebuild for very new Node
majors. Install it with a supported Node (e.g. `brew install node@22`) and point
both the extension (`agentBus.nodeBinary`) and the MCP server (`command`) at that
interpreter. Mismatch symptom: `NODE_MODULE_VERSION 127 ... requires 147`.

MCP server, in `.aider-desk/mcp-servers.json`:

```json
{
  "mcpServers": {
    "agent-bus": {
      "command": "/opt/homebrew/opt/node@22/bin/node",
      "args": ["/opt/homebrew/lib/node_modules/@agent-bus-connect/cli/dist/mcp/server.js"],
      "scope": "task"
    }
  }
}
```

Then reload extensions in AiderDesk.

## Use

```
/agent-bus-init                                            # config + register this task as master
/agent-bus-spawn backend developer Implement the users API  # worker task, own identity, own worktree
/agent-bus-team                                            # roster, status, unread counts
/agent-bus-stop backend                                    # interrupt
```

The master agent gets `agent_bus_spawn_worker`, `agent_bus_spawn_team`,
`agent_bus_get_team` and `agent_bus_stop_worker`; every other profile only sees
the team overview. Conversations stay on the agent-bus MCP tools (`register`,
`send`, `ask`, `reply`, `delegate`, `now`, `team_board`).

Config lives in the project: `.aider-desk/agent-bus.json`. Identity mapping and
wake counters live next to it in `.aider-desk/agent-bus-state.json`.

## Repository layout

This repository *is* the extension, installed project-locally the way AiderDesk
expects it:

```
AGENTS.md                                  instructions for agents (repo + team membership)
.aider-desk/agent-bus.json                 project config used by this checkout
.aider-desk/mcp-servers.json               MCP server entry (machine-specific Node path)
.aider-desk/extensions/aiderdesk-agent-bus/
  index.ts                                 Extension: tools, commands, events, UI
  src/{bus,core,orchestration}/            BusClient, config, state, spawn, wake-up
  src/{profiles,tools,commands}.ts         agent profiles and control plane
  src/ui/Dashboard.jsx                     project-floating dashboard
  tests/                                   node:test suite + fakes + real-CLI integration
  README.md                                extension reference
```

## Development

```bash
cd .aider-desk/extensions/aiderdesk-agent-bus
npm install
npm run check   # format:check + lint + typecheck + tests
```

44 tests, ESLint + Prettier configured. Design decisions and pitfalls (explicit
bus scope, no blocking inbox waits, worktree rules) are documented in
[`AGENTS.md`](AGENTS.md) and the [extension README](.aider-desk/extensions/aiderdesk-agent-bus/README.md).

## License

MIT — see [LICENSE](LICENSE). agent-bus itself is MIT as well.
