/**
 * Slash commands: the human control plane for the team.
 */

import type { CommandDefinition, ExtensionContext } from '@aiderdesk/extensions';

import { BusUnavailableError } from './bus/client.js';
import { configPath, writeDefaultConfig } from './core/config.js';
import type { ProjectRuntime } from './core/runtime.js';
import { ensureMaster, registerMaster, spawnWorkers, stopWorker } from './orchestration/team.js';

async function busHealth(runtime: ProjectRuntime): Promise<string> {
  const masterName = runtime.state.master?.agentName;
  if (!masterName) {
    return 'unknown (no master)';
  }
  try {
    await runtime.bus.inboxStatus(masterName);
    return 'reachable';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('is not registered')) {
      return 'reachable, master not yet registered on the bus';
    }
    if (message.includes('NODE_MODULE_VERSION')) {
      return 'unreachable: CLI ran under the wrong Node, set agentBus.nodeBinary';
    }
    if (error instanceof BusUnavailableError) {
      return `unreachable: ${message}`;
    }
    return `unreachable: ${message}`;
  }
}

function report(context: ExtensionContext, message: string): void {
  context.getTaskContext()?.addLogMessage('info', message);
  context.log(`[agent-bus] ${message}`, 'info');
}

function reportError(context: ExtensionContext, message: string): void {
  context.getTaskContext()?.addLogMessage('error', message);
  context.log(`[agent-bus] ${message}`, 'error');
}

export function createTeamCommands(getRuntime: (context: ExtensionContext) => ProjectRuntime): CommandDefinition[] {
  const init: CommandDefinition = {
    name: 'agent-bus-init',
    description: 'Create .aider-desk/agent-bus.json, reload the config and register this task as team master',
    execute: async (_args, context) => {
      const runtime = getRuntime(context);
      let path = configPath(runtime.projectDir);
      if (!runtime.configExists) {
        path = writeDefaultConfig(runtime.projectDir, runtime.config);
        runtime.reload();
      }
      const registration = await registerMaster(runtime, context.getTaskContext());
      const health = await busHealth(runtime);
      report(
        context,
        [
          `agent-bus ${runtime.config.enabled ? 'enabled' : 'disabled'}`,
          `config: ${path}${runtime.configError ? ` (error: ${runtime.configError})` : ''}`,
          `project: ${runtime.config.agentBus.project}`,
          `team: ${runtime.config.team}`,
          `isolation: ${runtime.config.isolation.mode}`,
          `master: ${runtime.state.master?.agentName ?? 'not registered'}`,
          `bus: ${health}`,
          registration.prompted
            ? 'registration: prompt queued, the agent will register through its MCP tools'
            : `registration: ${registration.error ?? 'not queued'}`,
        ].join('\n'),
      );
    },
  };

  const team: CommandDefinition = {
    name: 'agent-bus-team',
    description: 'Show the agent-bus team with roles, task ids, worktrees and unread counts',
    execute: async (_args, context) => {
      const runtime = getRuntime(context);
      const lines = [`project ${runtime.config.agentBus.project} · team ${runtime.config.team}`];
      lines.push(runtime.state.master ? `master  ${runtime.state.master.agentName}` : 'master  not registered');

      if (runtime.state.workers.length === 0) {
        lines.push('workers none');
      }

      for (const worker of runtime.state.workers) {
        let unread: string;
        try {
          const status = await runtime.bus.inboxStatus(worker.agentName);
          unread = String(status.unread);
          runtime.unreadByTask.set(worker.taskId, status.unread);
        } catch (error) {
          unread = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
        lines.push(
          `${worker.agentName}  ${worker.role}  ${worker.status}  unread ${unread}  task ${worker.taskId}${worker.worktree ? `  worktree ${worker.worktree}` : ''}`,
        );
      }

      report(context, lines.join('\n'));
    },
  };

  const spawn: CommandDefinition = {
    name: 'agent-bus-spawn',
    description: 'Spawn a worker: /agent-bus-spawn <name> <developer|reviewer|analyst> <work package>',
    execute: async (args, context) => {
      const [name, role, ...taskWords] = args;
      if (!name || !role || taskWords.length === 0) {
        reportError(context, 'Usage: /agent-bus-spawn <name> <developer|reviewer|analyst> <work package>');
        return;
      }
      const runtime = getRuntime(context);
      ensureMaster(runtime, context.getTaskContext());
      const [outcome] = await spawnWorkers(runtime, [{ name, role, task: taskWords.join(' ') }]);
      if (!outcome?.ok) {
        reportError(context, `spawn failed: ${outcome?.error ?? 'unknown error'}`);
        return;
      }
      report(context, `spawned ${outcome.agentName} as task ${outcome.taskId} (${runtime.config.isolation.mode})`);
    },
  };

  const stop: CommandDefinition = {
    name: 'agent-bus-stop',
    description: 'Interrupt a worker: /agent-bus-stop <worker name or task id>',
    execute: async (args, context) => {
      const target = args[0];
      if (!target) {
        reportError(context, 'Usage: /agent-bus-stop <worker name or task id>');
        return;
      }
      const runtime = getRuntime(context);
      const result = stopWorker(runtime, target);
      if (!result.ok) {
        reportError(context, result.error ?? 'stop failed');
        return;
      }
      report(context, `interrupted ${target}`);
    },
  };

  return [init, team, spawn, stop];
}
