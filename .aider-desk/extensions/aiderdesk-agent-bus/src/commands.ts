/**
 * Slash commands: the human control plane for the team.
 */

import type { CommandDefinition, ExtensionContext } from '@aiderdesk/extensions';

import { BusUnavailableError } from './bus/client.js';
import { SETTABLE_KEYS, configPath, flattenConfig, setConfigValue, writeDefaultConfig } from './core/config.js';
import type { ProjectRuntime } from './core/runtime.js';
import { collectHealth } from './orchestration/doctor.js';
import {
  deriveJoinName,
  ensureMaster,
  inferRole,
  joinWorker,
  parseSpawnArgs,
  pickStopTarget,
  registerMaster,
  removeWorker,
  resetTeam,
  spawnWorkers,
  stopWorker,
} from './orchestration/team.js';
import { resolveRole } from './profiles.js';

async function mcpHealth(context: ExtensionContext, runtime: ProjectRuntime): Promise<string> {
  try {
    const servers = await context.getMcpServers();
    const entry = servers[runtime.config.mcpServerName];
    if (!entry) {
      return `missing — no "${runtime.config.mcpServerName}" server in the AiderDesk MCP config, agents get no bus tools`;
    }
    return `configured${entry.scope ? ` (scope: ${entry.scope})` : ''}`;
  } catch {
    return 'unknown';
  }
}

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
      const mcp = await mcpHealth(context, runtime);
      if (runtime.hasTeam) {
        context.triggerUIComponentsReload();
      }
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
          `mcp: ${mcp}`,
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

  const doctor: CommandDefinition = {
    name: 'agent-bus-doctor',
    description: 'Check whether the master and workers are really registered on the bus',
    execute: async (_args, context) => {
      const runtime = getRuntime(context);
      const mcp = await mcpHealth(context, runtime);
      const health = await collectHealth(runtime);

      const lines = [`project ${runtime.config.agentBus.project} · team ${runtime.config.team}`, `mcp: ${mcp}`];
      for (const entry of health) {
        const registration =
          entry.registered === true ? 'registered' : entry.registered === false ? 'NOT registered' : 'unknown';
        const detail = entry.error ? `  ${entry.error}` : '';
        lines.push(
          `${entry.agentName}  ${entry.role}  ${registration}  unread ${entry.unread}  task ${entry.taskId}${detail}`,
        );
      }
      if (health.some((entry) => entry.registered === false)) {
        lines.push(
          'A "NOT registered" agent needs a fresh prompt in its task (send any message there). ' +
            'If the log shows `Running prompt with` many tools for that run, the tools were present and the agent ignored them — use a stronger model for that role.',
        );
      }

      report(context, lines.join('\n'));
    },
  };

  const spawn: CommandDefinition = {
    name: 'agent-bus-spawn',
    description: 'Spawn a worker: /agent-bus-spawn <name> <developer|reviewer|analyst> <work package>',
    execute: async (args, context) => {
      const parsed = parseSpawnArgs(args);
      if (!parsed.ok) {
        reportError(context, parsed.error);
        return;
      }
      const { name, role, task } = parsed.value;
      const runtime = getRuntime(context);
      ensureMaster(runtime, context.getTaskContext());
      const [outcome] = await spawnWorkers(runtime, [{ name, role, task }]);
      if (!outcome?.ok) {
        reportError(context, `spawn failed: ${outcome?.error ?? 'unknown error'}`);
        return;
      }
      context.triggerUIComponentsReload();
      report(context, `spawned ${outcome.agentName} as task ${outcome.taskId} (${runtime.config.isolation.mode})`);
    },
  };

  const join: CommandDefinition = {
    name: 'agent-bus-join',
    description: 'Adopt this task into the team: /agent-bus-join [name] [role] — defaults from the task',
    execute: async (args, context) => {
      const task = context.getTaskContext();
      if (!task) {
        reportError(context, 'Open the task you want to adopt and run the command inside it.');
        return;
      }

      const name = args[0] ?? deriveJoinName(task.data.name, task.data.id);
      const role = resolveRole(args[1] ?? inferRole(task.data.name, task.data.agentProfileId));

      const runtime = getRuntime(context);
      const outcome = await joinWorker(runtime, task, { name, role });
      if (!outcome.ok) {
        reportError(context, `join failed: ${outcome.error ?? 'unknown error'}`);
        return;
      }
      context.triggerUIComponentsReload();
      const mcp = await mcpHealth(context, runtime);
      report(
        context,
        `task ${outcome.taskId} joined the team as ${outcome.agentName} (${role}, name "${name}")\nmcp: ${mcp}`,
      );
    },
  };

  const stop: CommandDefinition = {
    name: 'agent-bus-stop',
    description: 'Interrupt a worker: /agent-bus-stop <worker name or task id>',
    execute: async (args, context) => {
      const runtime = getRuntime(context);
      const choice = args[0] ? { name: args[0] } : pickStopTarget(runtime.state.workers);
      if (!choice.name) {
        reportError(context, choice.error ?? 'nothing to stop');
        return;
      }
      const result = stopWorker(runtime, choice.name);
      if (!result.ok) {
        reportError(context, result.error ?? 'stop failed');
        return;
      }
      report(context, `interrupted ${choice.name}`);
    },
  };

  const remove: CommandDefinition = {
    name: 'agent-bus-remove',
    description: 'Remove a participant from the team: /agent-bus-remove <worker name or task id>',
    execute: async (args, context) => {
      const runtime = getRuntime(context);
      const target = args[0];
      if (!target) {
        const names = runtime.state.workers.map((worker) => worker.agentName);
        reportError(
          context,
          names.length > 0
            ? `Usage: /agent-bus-remove <name>. Participants: ${names.join(', ')}`
            : 'No participants to remove.',
        );
        return;
      }
      const result = await removeWorker(runtime, target);
      if (!result.ok) {
        reportError(context, result.error ?? 'remove failed');
        return;
      }
      context.triggerUIComponentsReload();
      report(context, `removed ${result.agentName} from the team (the task keeps running)`);
    },
  };

  const config: CommandDefinition = {
    name: 'agent-bus-config',
    description: 'Show or change project settings: /agent-bus-config [key] [value]',
    execute: async (args, context) => {
      const runtime = getRuntime(context);
      const [key, raw] = args;

      if (!key) {
        const rows = flattenConfig(runtime.config).map(([configKey, value]) => `${configKey} = ${value}`);
        report(context, [...rows, '', 'Change: /agent-bus-config <key> <value>'].join('\n'));
        return;
      }

      if (raw === undefined) {
        const row = flattenConfig(runtime.config).find(([configKey]) => configKey === key);
        if (!row) {
          reportError(context, `unknown key "${key}". Known: ${Object.keys(SETTABLE_KEYS).join(', ')}`);
          return;
        }
        report(context, `${row[0]} = ${row[1]}`);
        return;
      }

      const result = setConfigValue(runtime.projectDir, key, raw);
      if (!result.ok) {
        reportError(context, result.error ?? 'could not set the value');
        return;
      }
      runtime.reload();
      report(context, `${result.key} = ${JSON.stringify(result.value)} (applied)`);
    },
  };

  const reset: CommandDefinition = {
    name: 'agent-bus-reset',
    description: 'Remove every team identity and clear the join table: /agent-bus-reset confirm',
    execute: async (args, context) => {
      const runtime = getRuntime(context);
      const names = [
        runtime.state.master?.agentName,
        ...runtime.state.workers.map((worker) => worker.agentName),
      ].filter((name): name is string => !!name);

      if (names.length === 0) {
        report(context, 'No team identities to remove.');
        return;
      }

      if (args[0] !== 'confirm') {
        reportError(
          context,
          [
            `This removes ${names.length} identity(ies) from the bus and clears the join table:`,
            ...names.map((name) => `- ${name}`),
            '',
            'The AiderDesk tasks keep running. Run `/agent-bus-reset confirm` to proceed.',
          ].join('\n'),
        );
        return;
      }

      const result = await resetTeam(runtime);
      context.triggerUIComponentsReload();
      const lines = [`removed ${result.removed.length} identities`];
      if (result.failed.length > 0) {
        lines.push('bus-side failures (clean up manually):');
        for (const failure of result.failed) {
          lines.push(`- ${failure.agentName}: ${failure.error}`);
        }
      }
      lines.push('Master cleared — run `/agent-bus-init` to start over.');
      report(context, lines.join('\n'));
    },
  };

  return [init, team, config, doctor, spawn, join, stop, remove, reset];
}
