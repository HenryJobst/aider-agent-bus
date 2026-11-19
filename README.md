# AiderDesk Agent Bus

[English](README.md) · [Deutsch](README.de.md)

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

Phase 1 (proof of concept). Covered by 79 tests: spawning tasks with profile,
identity and worktree, adopting running tasks, identity mapping, inbox polling
and wake-up, team commands/tools, dashboard, config/state persistence, and a
real-CLI integration test. Verified on the live app: extension load, command
execution, config/state writes, agents registering on the bus and the panel
actions. Not yet proven end-to-end: worktree creation through `createTask` and a
task that finishes a delegated work package.

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

Copy the config templates and adjust the paths for your machine — the real
files are gitignored because they contain local Node paths:

```bash
cp .aider-desk/agent-bus.example.json .aider-desk/agent-bus.json
cp .aider-desk/mcp-servers.example.json .aider-desk/mcp-servers.json
```

Then reload extensions in AiderDesk.

## Use

```
/agent-bus-init                     # config + register this task as master
/agent-bus-spawn <name> [role]      # new worker; role defaults to developer
/agent-bus-join                     # adopt THIS task (name and role derived)
/agent-bus-team                     # roster, status, unread counts
/agent-bus-say backend <message>    # message as the human
/agent-bus-log 20                   # recent bus traffic
/agent-bus-doctor                   # is each identity really on the bus?
/agent-bus-config                   # show/change project settings
/agent-bus-pause backend            # mute wake-ups, resume with /agent-bus-resume
/agent-bus-stop                     # interrupt the only running worker
/agent-bus-remove <name>            # remove a participant from the team
/agent-bus-leave                    # this task leaves the team, keeps running
/agent-bus-reset confirm            # remove every identity, clear the join table
```

Two ways to get a team member:

- **spawn** creates a fresh task, assigns the role profile, puts it in its own
  worktree and starts it with the work package.
- **join** adopts a task that is already running. It keeps its conversation and
  working directory, gains a bus identity and is told to register and then
  *continue* — never to restart. The task is switched to the role profile so the
  agent-bus MCP server is enabled for it, while its provider/model stay
  unchanged. Joining twice is idempotent; the master cannot join as a worker;
  `maxWorkers` applies. `switchToWorktree: true` moves
  the task into its own worktree first (carries uncommitted changes, so only for
  tasks that have not started editing).

Both commands print an `mcp:` line. If it says `missing`, no `agent-bus` server
is configured for the project and agents will not see `register`/`send`/`inbox`
— configure `.aider-desk/mcp-servers.json` first.

The master agent gets `agent_bus_spawn_worker`, `agent_bus_spawn_team`,
`agent_bus_join_worker`, `agent_bus_get_team`, `agent_bus_stop_worker` and
`agent_bus_remove_worker`; every other profile only sees the team overview. Conversations stay on the
agent-bus MCP tools (`register`, `send`, `ask`, `reply`, `delegate`, `now`,
`team_board`).

The panel at the bottom of the tasks sidebar mirrors the three settings you flip
per project — board tasks vs. message-only, peer-to-peer on/off, and worktree vs.
shared isolation (the last one only while no worker is running). The header has
`stop all`, which interrupts every running agent including the master, after a
confirmation. Clicking a name in the roster activates that task in AiderDesk.
Everything else goes through `/agent-bus-config <key> <value>`, which validates
the key, writes the project file and applies it immediately.

Config lives in the project: `.aider-desk/agent-bus.json`. Identity mapping and
wake counters live next to it in `.aider-desk/agent-bus-state.json` — a join
table only, deleting it loses no messages.

## How the team stays alive

agent-bus stores messages; it cannot wake an idle AiderDesk task. The extension
does that:

1. every `pollIntervalMs` it reads unread counts via `agent-bus inbox-status --json`;
2. idle workers outside the cooldown get `runPrompt()` with an inbox prompt;
3. `onAgentFinished` runs the same check immediately, so replies land without
   waiting for the next tick.

No worker blocks in `inbox(wait_s: 110)` — that would occupy its agent loop and
could not be interrupted. Guards: `wakeCooldownMs`, `maxWakesPerTask`, and a
running task is never woken.

## Use cases

**How to read the snippets here.** Each JSON block is a *partial*
`.aider-desk/agent-bus.json`, not a complete file. You do not have to edit it by
hand — set the keys from the master task instead:

```
/agent-bus-config                                  # show all effective values
/agent-bus-config orchestration.trackTasks false   # change one value
```

`/agent-bus-config` validates the key and value, writes the project file and
applies it immediately. Editing the file manually works too: omitted keys keep
their defaults, and changes are picked up on the next action. Start from
`.aider-desk/agent-bus.example.json` if the file does not exist yet.

### 1. Sessions only need to coordinate

No board, no task ownership — just messages. This is the lightest setup.

In `.aider-desk/agent-bus.json`:

```json
{ "orchestration": { "trackTasks": false, "peerToPeerEnabled": true } }
```

1. In the session that should lead: `/agent-bus-init` (master identity, MCP check).
2. In every other session: `/agent-bus-join` (no arguments).
3. Agents use `send` for information, `ask` when they need an answer, `reply` on the
   message id. The extension wakes an idle session when its inbox has unread
   messages.

Verify: `/agent-bus-doctor` shows all identities `registered`; the sidebar shows
`unread` counts.

### 2. A work package needs its own worker

Use when work should happen in an isolated copy of the repo.

In `.aider-desk/agent-bus.json`:

```json
{ "isolation": { "mode": "worktree" } }
```

1. Git repository required — otherwise switch to `shared`.
2. `/agent-bus-spawn backend developer Implement the users API, acceptance: npm test`
3. The worker gets its own worktree, the developer profile and the registration
   prompt. The master keeps the main directory.

Verify: `git worktree list` shows the new worktree, `/agent-bus-team` shows the
worker with an unread count.

### 3. Bring running sessions into the team

Existing tasks keep their conversation — nothing is restarted.

1. Stop the task you want to adopt (joins do not interrupt on purpose).
2. `/agent-bus-join` for defaults, or `/agent-bus-join backend reviewer`.
3. If the session should be isolated: `agent_bus_join_worker` with
   `switchToWorktree: true` **before** it starts editing.

Verify: `agent_bus_join_worker` output or `/agent-bus-doctor`, then `whois` on the
bus.

### 4. Tracked work with review

Only worth it when several work items run in parallel and you want a board.

In `.aider-desk/agent-bus.json`:

```json
{ "orchestration": { "trackTasks": true, "requireReview": true } }
```

1. Master creates a task with `delegate` (holder = worker, title, description,
   acceptance criteria).
2. Worker claims it, sets `now --status working`, reports with `reply`.
3. Reviewer checks and reports; master closes with `done` after the user approves
   the merge.

Verify: `agent-bus tasks --project <p> --team <t>`, board status in the panel.

### 5. Shrink or end the team

| Goal | Action |
|---|---|
| Current run of one agent stops | `/agent-bus-stop <name>` |
| Participant leaves the team, task keeps running | `/agent-bus-remove <name>` or `×` in the panel |
| Whole team done | `/agent-bus-reset confirm`, then close the tasks in AiderDesk |

### 6. No git repository (analysis, docs, someone else's project)

In `.aider-desk/agent-bus.json`:

```json
{ "isolation": { "mode": "shared" } }
```

Worktree spawns fail with `not a git repository`. In `shared` mode all agents
share the directory — give them disjoint files or run them one after another.

### 7. An agent sees no bus tools

1. `/agent-bus-doctor` — `mcp:` line must say `configured`.
2. If `missing`: add the `agent-bus` entry to `.aider-desk/mcp-servers.json`.
3. Reload extensions, start a fresh prompt, check the log for
   `Initializing MCP connectors enabledServers=['agent-bus']`.
4. Still nothing? The run had the tools and the model ignored them — use a
   stronger model for that role.

## Configuration

`.aider-desk/agent-bus.json`, all keys optional:

| Key | Default | Meaning |
|---|---|---|
| `team` | `<project>-team` | bus team scope, must match for every call |
| `agentBus.project` / `.area` | folder name / none | bus scope; worktrees derive a different name, so it is always passed explicitly |
| `agentBus.binary` / `.nodeBinary` | `agent-bus` / none | CLI entry point and, if set, the interpreter that runs it |
| `mcpServerName` | `agent-bus` | name of the MCP server to enable in the agent profiles; must match `mcp-servers.json` |
| `isolation.mode` | `worktree` | `worktree`, `shared`, or `hybrid` (workers as worktree) |
| `orchestration.maxWorkers` | `5` | cap for spawned **and** adopted workers |
| `orchestration.peerToPeerEnabled` | `true` | allow direct worker-to-worker messages |
| `orchestration.trackTasks` | `true` | `false` = coordinate by messages only, no board rules |
| `orchestration.pollIntervalMs` / `wakeCooldownMs` / `maxWakesPerTask` | `20000` / `15000` / `20` | wake-up pacing and budget |
| `profiles.provider` / `.model` | learned | fallback only; the real model is learned from the first agent run |

## Repository layout

This repository *is* the extension, installed project-locally the way AiderDesk
expects it:

```
README.md                                  this file
README.de.md                               German version
LICENSE                                    MIT
AGENTS.md                                  instructions for agents (repo + team membership)
.aider-desk/agent-bus.example.json         project config template
.aider-desk/mcp-servers.example.json       MCP server entry template
.aider-desk/extensions/aiderdesk-agent-bus/
  index.ts                                 Extension: tools, commands, events, UI
  src/{bus,core,orchestration}/            BusClient, config, state, spawn, wake-up
  src/{profiles,tools,commands}.ts         agent profiles and control plane
  src/ui/Dashboard.jsx                     dashboard docked in the tasks sidebar
  tests/                                   node:test suite + fakes + real-CLI integration
  README.md                                extension reference
```

## Development

```bash
cd .aider-desk/extensions/aiderdesk-agent-bus
npm install
npm run check   # format:check + lint + typecheck + tests
```

79 tests, ESLint + Prettier configured:

| Suite | Covers |
|---|---|
| unit | config merge/clamping, state join table, prompt content, inbox-status normalization |
| seam | spawning and adopting tasks against fake `ProjectContext`/`TaskContext`, worktree fallback, master-only tools |
| wake-up | running task, cooldown, budget, empty inbox, broken CLI |
| integration | real CLI in a throwaway `AGENT_BUS_DIR`: two identities register, message, unread counts, scope isolation; skips when the CLI is absent |

Design decisions and pitfalls (explicit bus scope, no blocking inbox waits,
worktree rules) are documented in [`AGENTS.md`](AGENTS.md) and the
[extension README](.aider-desk/extensions/aiderdesk-agent-bus/README.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `NODE_MODULE_VERSION 127 … requires 147` | CLI installed with Node 22, executed by Node 26 | set `agentBus.nodeBinary` and the MCP `command` to the same interpreter |
| `not a git repository` on spawn | `isolation.mode: worktree` without a git repo | `git init` or switch to `shared` |
| `unread ?` in `/agent-bus-team` | CLI missing or a different bus scope | check `agentBus.binary`/`nodeBinary`, then the `project`/`team` values |
| workers never receive messages | each call used a different scope | pass `project`/`area`/`team` explicitly, including in worktrees |
| log says `Agent profile with id agent-bus-… not found` | the extension registered no profiles (global context) | reload extensions; profiles must be listed even without an open project |
| agent says it has no agent-bus tools | no MCP server configured, or the task's connector was created before the server/profile existed | add the `agent-bus` entry to `.aider-desk/mcp-servers.json`, re-run init/join, then start a fresh prompt or restart the app — existing connectors are not rebuilt |
| `Exception in connector … scipy … _spropack` in AiderDesk | the app's Python venv ships a scipy build the OS loader rejects (not this extension) | pin a working scipy in `~/Library/Application Support/aider-desk/python-venv`, or disable the repo map |
| panel does not appear | project has no team yet | run `/agent-bus-init`, the panel is registered once a master or worker exists |

## License

MIT — see [LICENSE](LICENSE). agent-bus itself is MIT as well.
