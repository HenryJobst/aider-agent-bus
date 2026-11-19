/**
 * Per-project runtime: config, join table, bus client and the small amount of
 * volatile UI state (unread counters, wake bookkeeping).
 */

import type { AgentProfile, ExtensionContext, ProjectContext } from '@aiderdesk/extensions';

import { BusClient } from '../bus/client.js';
import type { IdentityContext } from '../bus/prompts.js';
import { ROLE_PROFILE_IDS, buildProfiles, resolveRole } from '../profiles.js';
import type { ProfileDefaults } from '../profiles.js';
import { AgentBusState } from './state.js';
import type { WorkerRecord } from './state.js';
import { configMtime, loadConfig } from './config.js';
import type { AgentBusConfig } from './config.js';

export interface RuntimeLog {
  (message: string, type?: 'info' | 'error' | 'warn' | 'debug'): void;
}

export class ProjectRuntime {
  readonly projectDir: string;
  readonly projectContext: ProjectContext;

  config: AgentBusConfig;
  configExists: boolean;
  configMtime?: number;
  configError?: string;
  state: AgentBusState;
  bus: BusClient;

  readonly runningTasks = new Set<string>();
  readonly unreadByTask = new Map<string, number>();
  readonly lastInboxError = new Map<string, string>();
  private learnedDefaults: ProfileDefaults | null = null;
  private pollStarted = false;

  constructor(private readonly context: ExtensionContext) {
    this.projectDir = context.getProjectDir();
    this.projectContext = context.getProjectContext();

    const loaded = loadConfig(this.projectDir);
    this.config = loaded.config;
    this.configExists = loaded.exists;
    this.configMtime = configMtime(this.projectDir);
    this.configError = loaded.error;

    this.state = new AgentBusState(this.projectDir, this.config.agentBus.project, this.config.team);
    this.bus = this.createBus();
  }

  log: RuntimeLog = (message, type = 'info') => this.context.log(`[agent-bus] ${message}`, type);

  /** True once the project has been initialised as a team (master or workers exist). */
  get hasTeam(): boolean {
    return !!this.state.master || this.state.workers.length > 0;
  }

  get pollStartedFlag(): boolean {
    return this.pollStarted;
  }

  markPollStarted(): void {
    this.pollStarted = true;
  }

  private createBus(): BusClient {
    return new BusClient({
      scope: { project: this.config.agentBus.project, area: this.config.agentBus.area, team: this.config.team },
      binary: this.config.agentBus.binary,
      nodeBinary: this.config.agentBus.nodeBinary,
      dataDir: this.config.agentBus.dataDir,
      cwd: this.projectDir,
    });
  }

  reload(): void {
    const loaded = loadConfig(this.projectDir);
    this.config = loaded.config;
    this.configExists = loaded.exists;
    this.configMtime = configMtime(this.projectDir);
    this.configError = loaded.error;
    this.bus = this.createBus();
    this.state.setScope(this.config.agentBus.project, this.config.team);
  }

  learnDefaults(provider: string | undefined, model: string | undefined): void {
    if (provider && model) {
      this.learnedDefaults = { provider, model };
    }
  }

  get modelDefaults(): ProfileDefaults | null {
    if (this.learnedDefaults) {
      return this.learnedDefaults;
    }
    const { provider, model } = this.config.profiles;
    if (provider && model) {
      return { provider, model };
    }
    return null;
  }

  profiles(): AgentProfile[] {
    const defaults = this.modelDefaults ?? { provider: 'unset', model: 'unset' };
    return buildProfiles({
      mcpServerName: this.config.mcpServerName,
      peerToPeer: this.config.orchestration.peerToPeerEnabled,
      maxIterations: this.config.profiles.maxIterations,
      defaults,
    });
  }

  profileForJob(role: string, fallback?: ProfileDefaults): AgentProfile | undefined {
    const defaults = fallback ?? this.modelDefaults;
    if (!defaults) {
      return undefined;
    }
    const resolved = resolveRole(role);
    return buildProfiles({
      mcpServerName: this.config.mcpServerName,
      peerToPeer: this.config.orchestration.peerToPeerEnabled,
      maxIterations: this.config.profiles.maxIterations,
      defaults,
    }).find((profile) => profile.id === ROLE_PROFILE_IDS[resolved]);
  }

  identityFor(record: WorkerRecord): IdentityContext {
    return {
      project: this.config.agentBus.project,
      area: this.config.agentBus.area,
      team: this.config.team,
      agentName: record.agentName,
      role: record.role,
      capabilities: record.capabilities,
      masterName: this.state.master?.agentName,
      peerToPeer: this.config.orchestration.peerToPeerEnabled,
      trackTasks: this.config.orchestration.trackTasks,
      // Reality, not intention: an adopted task may still work in the shared
      // directory even when the team default is worktree.
      isolationMode: record.worktree ? this.config.isolation.mode : 'shared',
      worktreePath: record.worktree ?? undefined,
    };
  }

  masterIdentity(): IdentityContext | null {
    const master = this.state.master;
    if (!master) {
      return null;
    }
    return {
      project: this.config.agentBus.project,
      area: this.config.agentBus.area,
      team: this.config.team,
      agentName: master.agentName,
      role: 'master',
      capabilities: ['orchestration', 'review', 'planning'],
      peerToPeer: this.config.orchestration.peerToPeerEnabled,
      trackTasks: this.config.orchestration.trackTasks,
      isolationMode: 'local',
    };
  }
}
