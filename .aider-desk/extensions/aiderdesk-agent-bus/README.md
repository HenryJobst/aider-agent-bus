# AiderDesk Agent Bus

Native AiderDesk extension that turns separate tasks into a coordinated team.

AiderDesk stays responsible for running agents and managing git worktrees.
agent-bus stays responsible for messages, threads and the task board.
This extension is the glue: it creates the tasks, gives them identities and
wakes them when messages arrive.

```
AiderDesk tasks ──▶ extension ──▶ agent-bus (MCP tools for agents, CLI for the extension)
      ▲                                   │
      └────────── wake-up ◀───────────────┘
```

## Requirements

- AiderDesk with extension support
- `agent-bus` CLI: `npm install -g @agent-bus-connect/cli@latest`
- The `agent-bus` MCP server configured in AiderDesk (name must match
  `mcpServerName` in the config, default `agent-bus`), with `scope: "task"`
- A Node version that can load the CLI's `better-sqlite3` build — see
  [Troubleshooting](#troubleshooting)
- A git repository if you want worktree isolation (the default)

## Status

Implemented and covered by tests: spawning (task + profile + worktree + first
prompt), adopting existing tasks, identity mapping, inbox polling and wake-up,
team commands/tools, UI dashboard, config/state persistence, CLI integration
against a real bus.

Seen live: extension load, commands, joins, MCP registration, panel actions.
Not yet proven: `createTask` worktrees and a task that finishes a delegated work
package — see [Phase 1 acceptance run](#phase-1-acceptance-run).

## For agents

Agent-facing instructions — environment, conventions, runtime rules for team
members — live in [`AGENTS.md`](../../../AGENTS.md) at the repository root.

## What the extension does

| Layer | Responsibility |
|---|---|
| Extension tools | spawn workers, inspect the team, stop workers |
| Slash commands | init, team overview, spawn, stop |
| Agent profiles | master, developer, reviewer, analyst |
| Events | agent start/finish, task close, worktree created/merged |
| UI | dashboard docked at the bottom of the tasks sidebar (roster, unread, stop) |

Messaging itself is **not** reimplemented: agents use the agent-bus MCP tools
(`register`, `send`, `ask`, `reply`, `delegate`, `now`, `team_board`, …).

## Setup

1. Install the CLI: `npm install -g @agent-bus-connect/cli@latest`
   (there is no Homebrew formula; Homebrew's `npm` is used).

   `better-sqlite3` inside the CLI has no prebuild for very new Node majors.
   Install it with a supported Node (for example `brew install node@22`) and run
   the CLI through that interpreter. Both the extension config and the MCP
   server config accept an explicit Node path — see `agentBus.nodeBinary` and
   the MCP example below. Symptom of a mismatch:
   `NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 147`.

2. Configure the MCP server in `.aider-desk/mcp-servers.json` (project) or
   globally, using the same interpreter:

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

3. Reload extensions in AiderDesk.
4. In a task, run `/agent-bus-init`. This writes
   `.aider-desk/agent-bus.json` and registers the current task as master.
5. Spawn a worker: `/agent-bus-spawn backend developer Implement the users API`
   or let the master call `agent_bus_spawn_worker`.
6. Open the **Agent Bus** floating panel for the roster.

## Using the team

Commands (run in the master task):

| Command | Effect |
|---|---|
| `/agent-bus-init` | write the config, switch this task to the master profile (model preserved), register it as master, queue its bus registration and report `bus:`/`mcp:` health |
| `/agent-bus-team` | master, workers, roles, task ids, worktrees, unread counts |
| `/agent-bus-doctor` | whether each identity is actually registered on the bus, plus `mcp:` state |
| `/agent-bus-config [key] [value]` | show effective settings or change one validated key |
| `/agent-bus-spawn <name> [role] <work package>` | create and start a worker; role defaults to developer |
| `/agent-bus-join [name] [role]` | adopt **this** task; name and role default from the task |
| `/agent-bus-stop [name or task id]` | interrupt a worker; without an argument the only running one |
| `/agent-bus-remove <name or task id>` | remove a participant: bus registration and wake-ups go, the task keeps running |

Extension tools (master profile only; other profiles get `agent_bus_get_team`):

| Tool | Input | Effect |
|---|---|---|
| `agent_bus_spawn_worker` | `name`, `role`, `task`, `capabilities?` | create one task with profile, identity and worktree |
| `agent_bus_spawn_team` | `workers[]` | several workers in one call |
| `agent_bus_join_worker` | `name`, `role`, `taskId?`, `switchToWorktree?` | adopt an existing task (defaults to the calling task) |
| `agent_bus_get_team` | — | roster plus resolved config |
| `agent_bus_stop_worker` | `worker` | interrupt by agent name, display name or task id |
| `agent_bus_remove_worker` | `worker` | remove a participant from the team, task stays open |

Dashboard (`tasks-sidebar-bottom`): a compact strip at the bottom of the tasks
sidebar with status dots, unread badges, per-worker `stop` and `×` (remove), collapse
and a refresh action that reports how many identities are registered on the bus.
The expanded panel also toggles board vs. message-only coordination, peer-to-peer
messages and the isolation mode (the last one only while no worker runs). It is only registered for projects that already have a team
(master or workers); an uninitialised project does not get a floating panel.
It is docked, not a floating window, so it does not cover the chat.

Worker identity is `"<project>-<name>"`, e.g. `webshop-backend`. Each spawned
task is started with a registration prompt that contains the exact `register`
call, the scope (`project`, `area`, `team`), the worktree path and the team
rules. Registration is performed by the agent through its MCP tools — the
extension never fakes a bus identity.

**Adopting a running session.** `/agent-bus-join` without arguments (or
`agent_bus_join_worker` with a `taskId`) turns an existing task into a team
member. Defaults: the identity is the slugified task name (falling back to
`task-<id>`), the role comes from an already assigned role profile or, failing
that, from keywords in the task name (`review`/`qa` → reviewer,
`plan`/`research` → analyst, otherwise developer). Both can be overridden as
`/agent-bus-join <name> <role>`. It keeps its conversation and working directory, gets the bus identity
and a prompt that says "register, then continue your current work — do not
restart". The task is switched to the role profile so the agent-bus MCP server
is actually enabled for it (`agentProfileId`), while its provider/model stay
unchanged. Only a task without provider/model falls back to the learned pair.
Joining twice is idempotent (identity is reused), the master task cannot join as
a worker, and `maxWorkers` applies. Set `switchToWorktree: true` to move the
task into its own worktree first; that carries uncommitted changes along, so use
it only for tasks that have not started editing yet.

`/agent-bus-init` and `/agent-bus-join` print an `mcp:` line. If it says
`missing`, no `agent-bus` server is configured for the project and the agent
will not see `register`/`send`/`inbox` at all — fix `.aider-desk/mcp-servers.json`
before spawning or joining.

Prompts are started in the task's own mode (`currentMode`, usually `agent`).
Mode `code` is Aider mode: the prompt goes to the Python Aider connector, which
has no MCP tools and never registers — the log then shows
`Running Aider for project` / `Starting Aider...`.

Runs are started with the role profile passed explicitly
(`runPromptInAgent(profile, …)`), because that profile is what enables the
server for the run. Just switching `agentProfileId` is not enough: AiderDesk
builds MCP connectors when a run starts and a task whose connector was created
earlier keeps going without the tools — visible in the log as
`enabledServers=[]` even though the task settings look correct. `init` and
`join` are idempotent, so re-running them is safe.

## Configuration

`.aider-desk/agent-bus.json` (all keys optional). Copy it from
`.aider-desk/agent-bus.example.json`; the local file is gitignored because it
contains machine paths.

```json
{
  "enabled": true,
  "team": "webshop-development",
  "agentBus": {
    "project": "webshop",
    "area": "implementation",
    "binary": "agent-bus",
    "nodeBinary": "/opt/homebrew/opt/node@22/bin/node"
  },
  "mcpServerName": "agent-bus",
  "isolation": { "mode": "worktree", "mergeStrategy": "manual" },
  "orchestration": {
    "masterEnabled": true,
    "peerToPeerEnabled": true,
    "maxWorkers": 5,
    "requireReview": true,
    "pollIntervalMs": 20000,
    "wakeCooldownMs": 15000,
    "maxWakesPerTask": 20
  },
  "profiles": { "provider": "anthropic", "model": "claude-sonnet-4-5", "maxIterations": 100 }
}
```

`isolation.mode`: `worktree` (one worktree per worker), `shared` (same
directory, for analysis or non-git projects), `hybrid` (master local, developers
in worktrees — currently behaves like `worktree` for workers).

`worktree` needs a git repository: without one every spawn fails with
`not a git repository`. This checkout is configured with `shared` so the
extension can be exercised before git history exists; switch to `worktree` once
workers should be isolated.

`profiles.provider`/`model` is only a fallback. The extension learns the real
pair from the first agent run and applies it to spawned tasks, so normally you
do not need to set it.

### Files the extension owns

| Path | Content |
|---|---|
| `.aider-desk/agent-bus.json` | project config (read on load, reloaded when it appears) |
| `.aider-desk/agent-bus-state.json` | task ↔ bus identity join table, status, wake counters |
| `.aider-desk/mcp-servers.json` | AiderDesk MCP config, agent-bus entry with `scope: "task"` |

The join table is a mapping only. Messages, threads and the board stay in
`~/.agent-bus/bus.db`; deleting the join table loses no conversation, only the
task ↔ agent assignment.

## Why the extension passes the scope explicitly

agent-bus derives `project` by walking up to `.git` and using the folder name.
A git worktree has a `.git` **file** at its root, so its folder name differs
from the main repository. Measured with CLI 0.43.0:

```
main repo   → scoped: repo
worktree    → scoped: repo-wt-backend
```

Every CLI call therefore passes `--project`, `--area` and `--team` explicitly.
Keep that behaviour: removing it silently splits the team into separate bus
scopes.

## Wake-up

Blocking `inbox(wait_s: …)` keeps a worker inside a tool call and cannot be
interrupted cleanly, so the extension does not use it. Instead:

1. Every `pollIntervalMs`, unread counts are read with `agent-bus inbox-status --json`.
2. When a worker is idle, not running and outside the cooldown, the extension
   calls `runPrompt()` with an inbox prompt.
3. `onAgentFinished` performs the same check immediately, so a reply arrives
   without waiting for the next tick.

Guards: `wakeCooldownMs`, `maxWakesPerTask`, and never wake a running task.

## Code quality

ESLint (flat config, typescript-eslint) and Prettier are wired in:

```bash
npm run lint          # eslint .
npm run lint:fix      # eslint . --fix
npm run format        # prettier --write .
npm run format:check  # prettier --check .
npm run check         # format:check + lint + typecheck + test
```

Rules worth knowing: `no-console` is an error (use `context.log`), imports of
types must be `import type`, unused args must be prefixed with `_`.

## Tests

```bash
npm test          # 79 tests, node:test + tsx
npm run typecheck # tsc --noEmit
node "/Applications/aider-desk.app/Contents/Resources/skills/extension-creator/assets/scripts/validate-extension-ui.mjs" \
  src/ui/Dashboard.jsx   # ships with AiderDesk, not part of this repo
```

What is covered without AiderDesk:

- config merge, validation and clamping
- state join table, persistence and recovery
- inbox-status normalization across agent-bus output shapes
- CLI argument construction against a fake `agent-bus` binary, including the
  missing-binary error
- worker spawning at the `ProjectContext` seam: task params, profile id,
  worktree fallback, model adoption, worker limit, non-git error message
- wake-up guards: running task, cooldown, budget, empty inbox, broken CLI
- prompt content: identity, scope, isolation and safety rules
- tool exposure: full control plane for the master, read-only for other profiles

`tests/integration.bus.test.ts` runs against the real CLI in a throwaway
`AGENT_BUS_DIR`: two identities register, one sends, the other sees
`unread: 1`, and a third project scope stays at `unread: 0`. It skips itself
when the CLI is missing. Override the paths with `AGENT_BUS_BIN` and
`AGENT_BUS_NODE`.

What is **not** covered automatically: the real extension load, actual
`createTask` + worktree creation, MCP identity registration and a two-task
conversation inside AiderDesk. Those are the Phase 1 acceptance steps below.

## Phase 1 acceptance run

1. `/agent-bus-init` → master registered, config file created.
2. Spawn `backend` (developer) and `qa` (reviewer) in a git repository.
3. Both tasks run concurrently, each in its own worktree.
4. `backend` messages `qa` directly; `qa` answers on the same thread.
5. The master sees both in `agent_bus_get_team` and the dashboard.
6. Close `qa`, message it from `backend`, reopen the task: the message is
   picked up on the next start.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 147` | CLI installed with Node 22, executed by Node 26 (or vice versa) | run the CLI with the interpreter it was built for: set `agentBus.nodeBinary` and use the same path as the MCP `command` |
| `agent-bus binary "…" not found` | CLI missing or wrong path | `npm install -g @agent-bus-connect/cli@latest`, then set `agentBus.binary` to `dist/cli/index.js` when using `nodeBinary` |
| `no workers` but tasks exist | join table empty (`.aider-desk/agent-bus-state.json`) | spawn through the extension; the table is not reconstructed from existing tasks |
| Workers never receive messages | different bus scopes | every call must carry the same `project`/`area`/`team`; see [Why the extension passes the scope explicitly](#why-the-extension-passes-the-scope-explicitly) |
| Worktree spawn fails with `not a git repository` | project is not a git repo | `git init`, or set `isolation.mode` to `shared` |
| A worker is woken repeatedly | unread messages are never consumed | the worker must call `inbox`; check `wakeCooldownMs` and `maxWakesPerTask` |
| Profiles show `unset` as model | no agent has run yet | set `profiles.provider`/`profiles.model` or run any agent once |

## Known limitations

- The extension cannot call MCP tools; it uses the CLI. Anything that must look
  like agent conversation has to go through the agents themselves.
- Worktree paths are recorded from `onWorktreeCreated` and task data; a merge
  still has to be triggered in AiderDesk (`switchToLocalWorkingMode` /
  `mergeWorktreeToWorktree`), the extension only reports it to the master.
- Agent profiles registered by the extension need a valid provider/model pair;
  until the first agent run, they use `profiles.provider`/`profiles.model`.
- Adopted tasks are switched to the role profile, which replaces their previous
  profile. Their model is preserved; only a task without provider/model falls
  back to the learned pair, and if neither exists the switch is skipped — the
  task then lacks the bus tools.
- Tool use is only as good as the model. Observed: a run with 95 tools loaded
  stopped after three seconds claiming the bus tools were missing, after reading
  the empty *global* MCP config. The prompt now forbids that reasoning, but a
  strong model for team roles remains the safer choice.
- Chat and Kanban stay in agent-bus Cockpit (`agent-bus cockpit`); the extension
  dashboard shows roster, status and unread counts.
