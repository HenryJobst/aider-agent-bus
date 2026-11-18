/**
 * Extension tools: the AiderDesk control plane the master agent uses.
 * Message exchange itself stays on the agent-bus MCP tools.
 */

import { z } from 'zod';
import type { ExtensionContext, ToolDefinition } from '@aiderdesk/extensions';

import type { ProjectRuntime } from './core/runtime.js';
import { ensureMaster, spawnWorkers, stopWorker } from './orchestration/team.js';

const workerSchema = z.object({
  name: z.string().min(1).describe('Short worker name, used in the agent-bus identity, e.g. "backend"'),
  role: z
    .enum(['developer', 'reviewer', 'analyst', 'master'])
    .describe('Team role; decides the agent profile and its instructions'),
  task: z.string().min(1).describe('The work package in plain language, including acceptance criteria'),
  capabilities: z.array(z.string()).optional().describe('Capability tags the worker advertises on the bus'),
});

function formatWorkers(runtime: ProjectRuntime): string {
  const master = runtime.state.master;
  const lines = [`Project: ${runtime.config.agentBus.project}`, `Team: ${runtime.config.team}`];
  if (master) {
    lines.push(`Master: ${master.agentName} (task ${master.taskId})`);
  }
  if (runtime.state.workers.length === 0) {
    lines.push('Workers: none');
    return lines.join('\n');
  }
  lines.push('Workers:');
  for (const worker of runtime.state.workers) {
    const unread = runtime.unreadByTask.get(worker.taskId);
    lines.push(
      `- ${worker.agentName} | ${worker.role} | ${worker.status}${unread !== undefined ? ` | unread ${unread}` : ''} | task ${worker.taskId}${worker.worktree ? ` | worktree ${worker.worktree}` : ''}`,
    );
  }
  return lines.join('\n');
}

export interface TeamToolOptions {
  /** Spawning and stopping tasks is reserved for the master profile. */
  canSpawn?: boolean;
}

export function createTeamTools(
  getRuntime: (context: ExtensionContext) => ProjectRuntime,
  options: TeamToolOptions = {},
): ToolDefinition[] {
  const canSpawn = options.canSpawn !== false;
  const spawnWorker: ToolDefinition<typeof workerSchema> = {
    name: 'agent_bus_spawn_worker',
    description:
      'Create a new AiderDesk task, give it an agent-bus identity and start it on the given work package. Runs in parallel (returns before the worker finishes).',
    inputSchema: workerSchema,
    async execute(input, _signal, context) {
      const runtime = getRuntime(context);
      if (!runtime.config.enabled) {
        return { ok: false, error: 'agent-bus is disabled in .aider-desk/agent-bus.json' };
      }
      ensureMaster(runtime, context.getTaskContext());
      const [outcome] = await spawnWorkers(runtime, [input]);
      if (!outcome?.ok) {
        return { ok: false, error: outcome?.error ?? 'spawn failed' };
      }
      context.triggerUIComponentsReload();
      return {
        ok: true,
        agentName: outcome.agentName,
        taskId: outcome.taskId,
        isolation: runtime.config.isolation.mode,
        next: `Message the worker through agent-bus as "${runtime.state.master?.agentName ?? 'master'}".`,
      };
    },
  };

  const spawnTeamSchema = z.object({
    workers: z.array(workerSchema).min(1).max(10).describe('Work packages to start in parallel'),
  });

  const spawnTeam: ToolDefinition<typeof spawnTeamSchema> = {
    name: 'agent_bus_spawn_team',
    description:
      'Create several worker tasks at once, each with its own agent-bus identity, role profile and (if configured) git worktree.',
    inputSchema: spawnTeamSchema,
    async execute(input, _signal, context) {
      const runtime = getRuntime(context);
      if (!runtime.config.enabled) {
        return { ok: false, error: 'agent-bus is disabled in .aider-desk/agent-bus.json' };
      }
      ensureMaster(runtime, context.getTaskContext());
      const outcomes = await spawnWorkers(runtime, input.workers);
      context.triggerUIComponentsReload();
      return {
        ok: outcomes.every((outcome) => outcome.ok),
        workers: outcomes,
        team: formatWorkers(runtime),
      };
    },
  };

  const getTeam: ToolDefinition = {
    name: 'agent_bus_get_team',
    description: 'Show the current agent-bus team: master, workers, roles, task ids, worktrees and unread counts.',
    inputSchema: z.object({}),
    async execute(_input, _signal, context) {
      const runtime = getRuntime(context);
      return { ok: true, team: formatWorkers(runtime), config: runtime.config };
    },
  };

  const stopSchema = z.object({
    worker: z.string().min(1).describe('Worker agent name, display name or task id'),
  });

  const stop: ToolDefinition<typeof stopSchema> = {
    name: 'agent_bus_stop_worker',
    description: 'Interrupt a running worker task. The bus registration is kept, the task stays available.',
    inputSchema: stopSchema,
    async execute(input, _signal, context) {
      const runtime = getRuntime(context);
      const result = stopWorker(runtime, input.worker);
      return { ...result, team: formatWorkers(runtime) };
    },
  };

  if (!canSpawn) {
    return [getTeam];
  }
  return [spawnWorker, spawnTeam, getTeam, stop];
}
