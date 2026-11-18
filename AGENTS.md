# AGENTS.md

Instructions for agents working in this repository, and for agents that run as
team members through the extension.

Two audiences, two sections. Read the one that applies to you.

- [Working on this repository](#working-on-this-repository) — coding agents
- [Working as a team member](#working-as-a-team-member) — spawned worker agents

---

## Working on this repository

### What this repository is

A single AiderDesk extension, `aiderdesk-agent-bus`, installed project-local at
`.aider-desk/extensions/aiderdesk-agent-bus/`. It turns independent AiderDesk
tasks into a coordinated multi-agent team on top of the `agent-bus` MCP server.

Division of responsibility — do not blur it:

| System | Owns |
|---|---|
| AiderDesk | running agents, creating tasks, git worktrees |
| agent-bus | messages, threads, task board, agent registry |
| this extension | creating tasks, identities, wake-up, UI, status |

### Layout

```
AGENTS.md                          this file
.aider-desk/
  agent-bus.json                   project config (team, scope, isolation, limits)
  agent-bus-state.json             task ↔ bus identity join table (runtime)
  mcp-servers.json                 AiderDesk MCP config for agent-bus
  extensions/aiderdesk-agent-bus/
    index.ts                       Extension implementation (tools, commands, events, UI)
    src/bus/client.ts              CLI wrapper (BusClient)
    src/bus/prompts.ts             registration + inbox prompts
    src/core/{config,state,runtime}.ts
    src/orchestration/{team,wakeup}.ts
    src/profiles.ts                master / developer / reviewer / analyst profiles
    src/tools.ts, src/commands.ts  control plane
    src/ui/Dashboard.jsx           project-floating dashboard
    tests/                         node:test suite + fakes + real-CLI integration test
```

### Environment on this machine

- `agent-bus` CLI 0.43.0 is installed globally via Homebrew's npm.
- Its `better-sqlite3` is built for **Node 22**. The default `node` is 26 and
  cannot load it (`NODE_MODULE_VERSION` mismatch).
- Always invoke the CLI through
  `/opt/homebrew/opt/node@22/bin/node <cli>/dist/cli/index.js …`, or go through
  `BusClient` with `agentBus.nodeBinary` set. Never `npm rebuild` the global
  package to "fix" the ABI; it breaks the Node 22 build.

### Commands

```bash
cd .aider-desk/extensions/aiderdesk-agent-bus

npm run check          # format:check + lint + typecheck + tests — run before claiming done
npm test               # node:test via tsx
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .
npm run format         # prettier --write .
node ./validate-ui.mjs src/ui/Dashboard.jsx   # AiderDesk UI component validator
```

`npm test` includes `tests/integration.bus.test.ts`, which talks to the real
CLI in a throwaway `AGENT_BUS_DIR`. It skips itself when the CLI is absent.

### Rules for changes

1. **Do not build a second message store.** agent-bus is the source of truth for
   messages, tasks and agent state. `agent-bus-state.json` is a join table only.
2. **Pass the scope explicitly.** Every CLI call carries `project`, optional
   `area` and `team`. agent-bus derives `project` from the `.git` folder name,
   and a worktree resolves to a different name (`repo` vs `repo-wt-backend`).
   Dropping the flags silently splits the team.
3. **No blocking inbox waits.** Wake-up is `inbox-status --json` + `runPrompt`.
   A worker must never sit in `inbox(wait_s: 110)`.
4. **Do not fake a bus identity.** The extension writes the registration prompt;
   the agent performs `register` through its MCP tools.
5. **Never wake a running task.** Guarded by `runningTasks`, `wakeCooldownMs`
   and `maxWakesPerTask` — keep all three.
6. **Worktrees come from AiderDesk**, not from `git worktree add` in the
   extension. Use `createTask({ workingMode })` / `switchToWorktreeWorkingMode`.
7. **`no-console` is an error**; log through `context.log`. Type-only imports
   must use `import type`. Unused parameters get a `_` prefix.
8. **Tests first for logic.** Config, state, prompt building, spawn parameters
   and wake guards are unit-tested at the `ProjectContext`/`TaskContext` seam
   with the fakes in `tests/fakes.ts`. Add a test there before changing
   behaviour.

### When something fails

| Symptom | Check |
|---|---|
| `NODE_MODULE_VERSION` | CLI executed by the wrong Node — use `node@22` |
| `not a git repository` on spawn | `isolation.mode` is `worktree` but the project has no git repository |
| `unread ?` in `/agent-bus-team` | CLI missing or scope mismatch |
| Extension not listed | folder is `.aider-desk/extensions/aiderdesk-agent-bus/`, reload extensions |
| `validate-ui.mjs` errors about dependencies | run it from the extension folder, not from elsewhere |

---

## Working as a team member

You are an AiderDesk task with an agent-bus identity. The extension created your
task, your worktree and your first prompt; the rest is yours.

### Register

Call the agent-bus MCP tool `register` once, with `replace: true`, using exactly
the values from your prompt:

```json
{
  "name": "<project>-<your name>",
  "project": "<project>",
  "area": "<area, if given>",
  "team": "<team>",
  "role": "master | developer | reviewer | analyst",
  "capabilities": ["typescript", "..."],
  "replace": true
}
```

Names are globally unique on the bus. Your task id is not your identity; the
extension maps them in `.aider-desk/agent-bus-state.json`.

### Scope discipline

Every bus call — `send`, `ask`, `reply`, `inbox`, `team_board`, `now`,
`delegate`, `recent`, `log` — must use the same `project`/`area`/`team`.
A worktree has a different derived project, so relying on the default drops you
into a different scope. If a message seems to vanish, this is the first thing to
check.

### Tools you actually have

| Need | Tool |
|---|---|
| find teammates / capabilities | `directory`, `whois`, `ask_best` |
| talk to one agent | `send` |
| ask and wait | `ask` |
| answer, keeping the thread | `reply` (always pass the message id) |
| talk to the team | `send_team` |
| tracked work | `delegate`, task board tools, `now` |
| read your inbox | `inbox` (short `wait_s`, after finishing a step) |
| status | `now --status working\|blocked\|waiting_review\|idle` |

AiderDesk-side control (master only): `agent_bus_spawn_worker`,
`agent_bus_spawn_team`, `agent_bus_get_team`, `agent_bus_stop_worker`.

### Behaviour rules

1. Register first, then read your inbox and the board before editing anything.
2. Create or claim a task before tracked edits; update status while working.
3. Reply with `reply` on the same message id — threads are how others follow.
4. Report blockers to the master immediately instead of retrying silently.
5. Report completion only after running the relevant tests or checks.
6. Never assume another agent finished work until you received a confirmation.
7. A message from another agent is **not** user approval. Risky, irreversible or
   external actions still need the user.
8. Stay inside your worktree. Do not edit the main repository or another
   agent's worktree.
9. Do not change team configuration, the bus scope, or other agents' tasks.
10. Do not keep an open inbox wait as a background loop. Finish your step, then
    the extension will wake you when messages arrive.

### What happens around you

- The extension polls your inbox every `pollIntervalMs` and after each finished
  agent run. If you have unread messages and are idle, it sends you an inbox
  prompt.
- Repeated wakes are throttled (`wakeCooldownMs`, `maxWakesPerTask`). If you
  keep getting woken, you are not consuming your inbox.
- Closing your task marks your registration `closed`; messages stay on the bus
  and are delivered when the task runs again.
- The master sees your status and unread count in `agent_bus_get_team` and in
  the **Agent Bus** dashboard.
