/**
 * AiderDesk Agent Bus
 *
 * Native AiderDesk extension that turns independent tasks into a coordinated
 * multi-agent team. AiderDesk owns execution and worktrees, agent-bus owns
 * messaging and task state; this extension is the glue in between.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AgentFinishedEvent,
  AgentProfile,
  AgentStartedEvent,
  CommandDefinition,
  Extension,
  ExtensionContext,
  ExtensionMetadata,
  TaskClosedEvent,
  ToolDefinition,
  UIComponentDefinition,
  WorktreeCreatedEvent,
  WorktreeMergedEvent,
} from '@aiderdesk/extensions';

import { createTeamCommands } from './src/commands.js';
import { DASHBOARD_ID } from './src/constants.js';
import { configMtime, configPath, setConfigValue } from './src/core/config.js';
import { ProjectRuntime } from './src/core/runtime.js';
import { removeWorker, setMuted, stopAll, stopWorker } from './src/orchestration/team.js';
import { checkRegistration, collectHealth } from './src/orchestration/doctor.js';
import { InboxWatcher } from './src/orchestration/wakeup.js';
import { ROLE_PROFILE_IDS, buildProfiles } from './src/profiles.js';
import type { ProfileDefaults } from './src/profiles.js';
import { createTeamTools } from './src/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TICK_MS = 10_000;

export default class AgentBusExtension implements Extension {
  static metadata: ExtensionMetadata = {
    name: 'aiderdesk-agent-bus',
    version: '0.2.0',
    description: 'Multi-agent teams on top of agent-bus: spawn workers, give them identities and keep them talking',
    author: 'local',
    capabilities: ['events', 'tools', 'commands', 'agents', 'ui'],
  };

  private readonly runtimes = new Map<string, ProjectRuntime>();
  private readonly watchers = new Map<string, InboxWatcher>();
  private readonly lastPollAt = new Map<string, number>();
  private readonly profileOverrides = new Map<string, AgentProfile>();
  private learnedDefaults: ProfileDefaults | null = null;
  private pollTimer?: NodeJS.Timeout;

  async onLoad(context: ExtensionContext): Promise<void> {
    context.log('[agent-bus] extension loaded', 'info');
    this.pollTimer = setInterval(() => void this.pollAll(), TICK_MS);
  }

  onUnload(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private getRuntime(context: ExtensionContext): ProjectRuntime {
    const projectDir = context.getProjectDir();
    if (!projectDir) {
      throw new Error('agent-bus needs an open project');
    }
    let runtime = this.runtimes.get(projectDir);
    if (!runtime) {
      runtime = new ProjectRuntime(context);
      this.runtimes.set(projectDir, runtime);
      this.watchers.set(projectDir, new InboxWatcher(runtime));
      if (runtime.configError) {
        runtime.log(runtime.configError, 'warn');
      }
    } else if (
      existsSync(configPath(projectDir)) !== runtime.configExists ||
      configMtime(projectDir) !== runtime.configMtime
    ) {
      // Editing .aider-desk/agent-bus.json applies on the next action instead of
      // requiring an extension reload.
      runtime.reload();
    }
    return runtime;
  }

  private tryRuntime(context: ExtensionContext): ProjectRuntime | null {
    try {
      return this.getRuntime(context);
    } catch (error) {
      context.log(`[agent-bus] ${error instanceof Error ? error.message : String(error)}`, 'debug');
      return null;
    }
  }

  private async pollAll(): Promise<void> {
    for (const [projectDir, runtime] of this.runtimes) {
      if (!runtime.config.enabled || runtime.state.workers.length === 0) {
        continue;
      }
      const now = Date.now();
      if (now - (this.lastPollAt.get(projectDir) ?? 0) < runtime.config.orchestration.pollIntervalMs) {
        continue;
      }
      this.lastPollAt.set(projectDir, now);
      try {
        await this.watchers.get(projectDir)?.pollOnce();
      } catch (error) {
        runtime.log(`inbox poll failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }
    }
  }

  // Registration

  getTools(_context: ExtensionContext, _mode: string, agentProfile: AgentProfile): ToolDefinition[] {
    const canSpawn = agentProfile?.id === ROLE_PROFILE_IDS.master;
    return createTeamTools((ctx) => this.getRuntime(ctx), { canSpawn });
  }

  getCommands(_context: ExtensionContext): CommandDefinition[] {
    return createTeamCommands((ctx) => this.getRuntime(ctx));
  }

  getAgents(context: ExtensionContext): AgentProfile[] {
    // AiderDesk asks for agents in a *global* context, so this must not depend on
    // an open project. Otherwise the profiles never exist and every task that
    // references them fails with "Agent profile ... not found".
    const runtime = this.tryRuntime(context);
    const defaults = this.learnedDefaults ?? runtime?.modelDefaults ?? { provider: 'unset', model: 'unset' };

    const profiles = buildProfiles({
      mcpServerName: runtime?.config.mcpServerName ?? 'agent-bus',
      peerToPeer: runtime?.config.orchestration.peerToPeerEnabled ?? true,
      maxIterations: runtime?.config.profiles.maxIterations ?? 100,
      defaults,
    });

    return profiles.map((profile) => this.profileOverrides.get(profile.id) ?? profile);
  }

  async onAgentProfileUpdated(
    _context: ExtensionContext,
    agentId: string,
    updatedProfile: AgentProfile,
  ): Promise<AgentProfile> {
    if (agentId.startsWith('agent-bus-')) {
      this.profileOverrides.set(agentId, updatedProfile);
    }
    if (updatedProfile.provider && updatedProfile.model) {
      this.learnedDefaults = { provider: updatedProfile.provider, model: updatedProfile.model };
    }
    return updatedProfile;
  }

  // Events

  async onAgentStarted(event: AgentStartedEvent, context: ExtensionContext): Promise<void> {
    const runtime = this.tryRuntime(context);
    const taskId = context.getTaskContext()?.data.id;
    if (!runtime || !taskId) {
      return;
    }
    runtime.runningTasks.add(taskId);
    runtime.learnDefaults(event.agentProfile?.provider, event.agentProfile?.model);
    if (event.agentProfile?.provider && event.agentProfile?.model) {
      this.learnedDefaults = { provider: event.agentProfile.provider, model: event.agentProfile.model };
    }
    if (runtime.state.findByTaskId(taskId)) {
      runtime.state.updateWorker(taskId, { status: 'working' });
    }
  }

  async onAgentFinished(_event: AgentFinishedEvent, context: ExtensionContext): Promise<void> {
    const runtime = this.tryRuntime(context);
    const taskId = context.getTaskContext()?.data.id;
    if (!runtime || !taskId) {
      return;
    }
    runtime.runningTasks.delete(taskId);

    const worker = runtime.state.findByTaskId(taskId);
    if (!worker) {
      return;
    }
    runtime.state.updateWorker(taskId, { status: 'idle' });

    const watcher = this.watchers.get(runtime.projectDir);
    if (watcher) {
      await watcher.checkWorker(taskId);
      context.triggerUIDataRefresh(DASHBOARD_ID);
    }

    // The run may have ended without the agent ever calling `register` — for
    // example because its session had no MCP tools. Make that visible instead
    // of leaving the worker in "starting" forever.
    const registered = await checkRegistration(runtime, worker.agentName);
    if (registered === false) {
      runtime.state.updateWorker(taskId, { status: 'blocked' });
      runtime.log(
        `${worker.agentName} finished without registering on the bus — check its MCP tools, then send one more prompt`,
        'warn',
      );
    }
  }

  async onTaskClosed(event: TaskClosedEvent, context: ExtensionContext): Promise<void> {
    const runtime = this.tryRuntime(context);
    if (!runtime) {
      return;
    }
    runtime.state.updateWorker(event.task.id, { status: 'closed' });
  }

  async onWorktreeCreated(event: WorktreeCreatedEvent, context: ExtensionContext): Promise<void> {
    const runtime = this.tryRuntime(context);
    const worker = runtime?.state.findByTaskId(event.task.id);
    if (!runtime || !worker) {
      return;
    }
    runtime.state.updateWorker(event.task.id, { worktree: event.worktree.path });
  }

  async onWorktreeMerged(event: WorktreeMergedEvent, context: ExtensionContext): Promise<void> {
    const runtime = this.tryRuntime(context);
    const worker = runtime?.state.findByTaskId(event.task.id);
    if (!runtime || !worker) {
      return;
    }
    runtime.log(`${worker.agentName} merged into ${event.targetBranch ?? event.targetPath}`, 'info');
    const note = `Your worktree was merged into ${event.targetBranch ?? event.targetPath}.`;
    void runtime.bus.send(runtime.state.master?.agentName ?? 'master', worker.agentName, note).catch(() => undefined);
  }

  // UI

  getUIComponents(context: ExtensionContext): UIComponentDefinition[] {
    // A project without a team gets no panel; otherwise every project would
    // pop the floating window as soon as it is opened.
    const runtime = this.tryRuntime(context);
    if (runtime && !runtime.hasTeam) {
      return [];
    }

    return [
      {
        id: DASHBOARD_ID,
        name: 'Agent Bus',
        placement: 'tasks-sidebar-bottom',
        jsx: readFileSync(join(__dirname, './src/ui/Dashboard.jsx'), 'utf-8'),
        loadData: true,
      },
    ];
  }

  async getUIExtensionData(componentId: string, context: ExtensionContext): Promise<unknown> {
    if (componentId !== DASHBOARD_ID) {
      return undefined;
    }
    const runtime = this.tryRuntime(context);
    if (!runtime) {
      return { available: false };
    }

    return {
      available: true,
      project: runtime.config.agentBus.project,
      team: runtime.config.team,
      isolation: runtime.config.isolation.mode,
      enabled: runtime.config.enabled,
      configError: runtime.configError ?? null,
      master: runtime.state.master ?? null,
      workers: runtime.state.workers.map((worker) => ({
        agentName: worker.agentName,
        name: worker.name,
        role: worker.role,
        status: worker.status,
        taskId: worker.taskId,
        worktree: worker.worktree,
        wakes: worker.wakes,
        muted: worker.muted ?? false,
        unread: runtime.unreadByTask.get(worker.taskId) ?? 0,
        error: runtime.lastInboxError.get(worker.taskId) ?? null,
      })),
      modelDefaults: runtime.modelDefaults,
      settings: {
        trackTasks: runtime.config.orchestration.trackTasks,
        peerToPeer: runtime.config.orchestration.peerToPeerEnabled,
        isolation: runtime.config.isolation.mode,
        anyRunning: runtime.state.workers.some((worker) => worker.status === 'working' || worker.status === 'starting'),
      },
    };
  }

  async executeUIExtensionAction(
    componentId: string,
    action: string,
    args: unknown[],
    context: ExtensionContext,
  ): Promise<unknown> {
    if (componentId !== DASHBOARD_ID) {
      return undefined;
    }
    const runtime = this.tryRuntime(context);
    if (!runtime) {
      return { ok: false, error: 'no project' };
    }

    runtime.log(`ui action "${action}" (${args.length} args)`, 'info');

    switch (action) {
      case 'refresh': {
        // Unread polling alone shows nothing for workers that never registered.
        // Refresh therefore reports bus-side registration truth as well.
        const health = await collectHealth(runtime);
        let registered = 0;
        for (const entry of health) {
          if (entry.registered) {
            registered += 1;
          }
          if (entry.role === 'master' || runtime.runningTasks.has(entry.taskId)) {
            continue;
          }
          if (entry.registered === true) {
            runtime.state.updateWorker(entry.taskId, { status: 'idle' });
          } else if (entry.registered === false) {
            runtime.state.updateWorker(entry.taskId, { status: 'blocked' });
          }
        }
        context.triggerUIDataRefresh(DASHBOARD_ID);
        return { ok: true, registered, total: health.length };
      }
      case 'stop-worker': {
        const target = String(args[0] ?? '');
        runtime.log(`dashboard stop requested for "${target}"`, 'info');
        const result = stopWorker(runtime, target);
        if (!result.ok) {
          runtime.log(`stop failed for "${target}": ${result.error ?? 'unknown error'}`, 'warn');
        }
        context.triggerUIDataRefresh(DASHBOARD_ID);
        return result;
      }
      case 'set-config': {
        const key = String(args[0] ?? '');
        const value = String(args[1] ?? '');
        const busy = runtime.state.workers.some(
          (worker) => worker.status === 'working' || worker.status === 'starting',
        );
        if (key === 'isolation.mode' && busy) {
          return { ok: false, error: 'stop the running workers before changing isolation' };
        }
        const result = setConfigValue(runtime.projectDir, key, value);
        if (!result.ok) {
          runtime.log(`config change rejected: ${result.error ?? 'unknown error'}`, 'warn');
          return result;
        }
        runtime.reload();
        context.triggerUIDataRefresh(DASHBOARD_ID);
        return result;
      }
      case 'toggle-mute': {
        const target = String(args[0] ?? '');
        const worker =
          runtime.state.findByName(target) ?? runtime.state.workers.find((entry) => entry.taskId === target);
        if (!worker) {
          return { ok: false, error: `unknown worker "${target}"` };
        }
        const result = setMuted(runtime, target, !worker.muted);
        context.triggerUIDataRefresh(DASHBOARD_ID);
        return result;
      }
      case 'stop-all': {
        const result = stopAll(runtime);
        context.triggerUIDataRefresh(DASHBOARD_ID);
        return { ok: true, ...result };
      }
      case 'remove-worker': {
        const target = String(args[0] ?? '');
        runtime.log(`dashboard remove requested for "${target}"`, 'info');
        const result = await removeWorker(runtime, target);
        if (!result.ok) {
          runtime.log(`remove failed for "${target}": ${result.error ?? 'unknown error'}`, 'warn');
        }
        context.triggerUIDataRefresh(DASHBOARD_ID);
        return result;
      }
      default:
        return { ok: false, error: `unknown action "${action}"` };
    }
  }
}
