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
import { configPath } from './src/core/config.js';
import { ProjectRuntime } from './src/core/runtime.js';
import { stopWorker } from './src/orchestration/team.js';
import { InboxWatcher } from './src/orchestration/wakeup.js';
import { ROLE_PROFILE_IDS } from './src/profiles.js';
import { createTeamTools } from './src/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DASHBOARD_ID = 'agent-bus-dashboard';
const TICK_MS = 10_000;

export default class AgentBusExtension implements Extension {
  static metadata: ExtensionMetadata = {
    name: 'aiderdesk-agent-bus',
    version: '0.1.0',
    description: 'Multi-agent teams on top of agent-bus: spawn workers, give them identities and keep them talking',
    author: 'local',
    capabilities: ['events', 'tools', 'commands', 'agents', 'ui'],
  };

  private readonly runtimes = new Map<string, ProjectRuntime>();
  private readonly watchers = new Map<string, InboxWatcher>();
  private readonly lastPollAt = new Map<string, number>();
  private readonly profileOverrides = new Map<string, AgentProfile>();
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
    } else if (!runtime.configError && existsSync(configPath(projectDir)) !== runtime.configExists) {
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
    const runtime = this.tryRuntime(context);
    if (!runtime) {
      return [];
    }
    return runtime.profiles().map((profile) => this.profileOverrides.get(profile.id) ?? profile);
  }

  async onAgentProfileUpdated(
    _context: ExtensionContext,
    agentId: string,
    updatedProfile: AgentProfile,
  ): Promise<AgentProfile> {
    if (agentId.startsWith('agent-bus-')) {
      this.profileOverrides.set(agentId, updatedProfile);
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
        placement: 'project-floating',
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
        unread: runtime.unreadByTask.get(worker.taskId) ?? 0,
        error: runtime.lastInboxError.get(worker.taskId) ?? null,
      })),
      modelDefaults: runtime.modelDefaults,
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

    switch (action) {
      case 'refresh': {
        await this.watchers.get(runtime.projectDir)?.pollOnce();
        context.triggerUIDataRefresh(DASHBOARD_ID);
        return { ok: true };
      }
      case 'stop-worker': {
        const target = String(args[0] ?? '');
        const result = stopWorker(runtime, target);
        context.triggerUIDataRefresh(DASHBOARD_ID);
        return result;
      }
      default:
        return { ok: false, error: `unknown action "${action}"` };
    }
  }
}
