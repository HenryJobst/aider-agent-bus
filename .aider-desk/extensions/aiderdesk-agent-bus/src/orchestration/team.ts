/**
 * Worker lifecycle: create AiderDesk tasks, attach them to the bus identity and
 * hand them their first prompt.
 *
 * AiderDesk owns execution and worktrees; this module only wires both systems
 * together and never blocks on a worker run.
 */

import type { TaskContext } from '@aiderdesk/extensions';

import { masterRegistrationPrompt, registrationPrompt } from '../bus/prompts.js';
import type { ProjectRuntime } from '../core/runtime.js';
import type { WorkerRecord } from '../core/state.js';
import { ROLE_PROFILE_IDS, resolveRole } from '../profiles.js';
import type { TeamRole } from '../profiles.js';

export interface SpawnRequest {
  name: string;
  role: string;
  task: string;
  capabilities?: string[];
}

export interface SpawnOutcome {
  ok: boolean;
  agentName?: string;
  taskId?: string;
  error?: string;
}

export const DEFAULT_CAPABILITIES = ['typescript', 'code'];

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Default join identity: the task name without a role suffix, slugified. */
export function deriveJoinName(taskName: string | undefined, taskId: string): string {
  const base = (taskName ?? '').replace(/\((developer|reviewer|analyst|master)\)\s*$/i, '').trim();
  return slugify(base) || `task-${taskId.slice(0, 4)}`;
}

/**
 * Default join role: take it from an already assigned role profile, otherwise
 * infer from the task name. Explicit input always wins in the caller.
 */
export function inferRole(taskName: string | undefined, agentProfileId?: string): TeamRole {
  const fromProfile = (Object.entries(ROLE_PROFILE_IDS) as Array<[TeamRole, string]>).find(
    ([, id]) => id === agentProfileId,
  );
  if (fromProfile) {
    return fromProfile[0];
  }

  const name = (taskName ?? '').toLowerCase();
  if (/(review|qa|quality|test)/.test(name)) {
    return 'reviewer';
  }
  if (/(plan|analys|konzept|research|recherche)/.test(name)) {
    return 'analyst';
  }
  return 'developer';
}

const EXPLICIT_ROLES = new Set(['developer', 'reviewer', 'analyst', 'master', 'review', 'qa', 'plan', 'planner']);

export interface SpawnArgs {
  name: string;
  role: string;
  task: string;
}

/**
 * `/agent-bus-spawn <name> [role] <work package>` — the role is optional and
 * defaults to developer. The first token is always the worker name.
 */
export function parseSpawnArgs(args: string[]): { ok: true; value: SpawnArgs } | { ok: false; error: string } {
  if (args.length < 2) {
    return { ok: false, error: 'Usage: /agent-bus-spawn <name> [developer|reviewer|analyst] <work package>' };
  }

  const [name, second, ...rest] = args;
  if (EXPLICIT_ROLES.has(second.toLowerCase())) {
    const task = rest.join(' ').trim();
    if (!task) {
      return { ok: false, error: 'Work package missing after the role.' };
    }
    return { ok: true, value: { name, role: second, task } };
  }

  return { ok: true, value: { name, role: 'developer', task: args.slice(1).join(' ').trim() } };
}

/** `/agent-bus-stop` without an argument: stop the only running worker. */
export function pickStopTarget(workers: WorkerRecord[]): { name?: string; error?: string } {
  const running = workers.filter((worker) => worker.status === 'working' || worker.status === 'starting');
  if (running.length === 1) {
    return { name: running[0].agentName };
  }
  if (running.length === 0) {
    return { error: 'no worker is running' };
  }
  return { error: `several workers are running: ${running.map((worker) => worker.agentName).join(', ')}` };
}

export function agentNameFor(runtime: ProjectRuntime, name: string): string {
  const base = `${slugify(runtime.config.agentBus.project) || 'project'}-${slugify(name) || 'worker'}`;
  const taken = new Set(runtime.state.workers.map((worker) => worker.agentName));
  if (!taken.has(base)) {
    return base;
  }
  let counter = 2;
  while (taken.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

function worktreePathOf(task: TaskContext | null): string | null {
  return task?.data.worktree?.path ?? null;
}

/**
 * Switches a task to the role profile, which is what enables the agent-bus MCP
 * server for it. The conversation and the provider/model stay untouched.
 */
async function applyRoleProfile(runtime: ProjectRuntime, task: TaskContext, role: string): Promise<void> {
  const resolved = resolveRole(role);
  const model =
    task.data.provider && task.data.model
      ? { provider: task.data.provider, model: task.data.model }
      : runtime.modelDefaults;

  if (!model || task.data.agentProfileId === ROLE_PROFILE_IDS[resolved]) {
    return;
  }

  try {
    await task.updateTask({
      agentProfileId: ROLE_PROFILE_IDS[resolved],
      provider: model.provider,
      model: model.model,
    });
  } catch (error) {
    runtime.log(
      `could not switch task ${task.data.id} to the ${resolved} profile: ${error instanceof Error ? error.message : String(error)}`,
      'warn',
    );
  }
}

/**
 * Registers the calling task as team master if the team does not have one yet.
 */
export function ensureMaster(runtime: ProjectRuntime, task: TaskContext | null): void {
  if (!task || runtime.state.master) {
    return;
  }
  const agentName = `${slugify(runtime.config.agentBus.project) || 'project'}-master`;
  runtime.state.setMaster({ agentName, taskId: task.data.id });
  runtime.log(`registered task ${task.data.id} as master "${agentName}"`, 'info');
}

/**
 * Starts a prompt with the role profile passed explicitly.
 *
 * Switching `agentProfileId` alone is not enough: AiderDesk builds the MCP
 * connectors from the profile that is active when the run starts, and a task
 * whose profile was switched mid-session keeps running without the enabled
 * servers (observed as `enabledServers=[]` even though the settings were right).
 */
async function startWithRoleProfile(
  runtime: ProjectRuntime,
  task: TaskContext,
  role: string,
  prompt: string,
): Promise<void> {
  const model =
    task.data.provider && task.data.model ? { provider: task.data.provider, model: task.data.model } : undefined;
  const profile = runtime.profileForJob(role, model);
  // 'code' selects Aider mode, which has no MCP tools. Use the task's own mode
  // (normally 'agent') so the prompt reaches the agent, not the Aider connector.
  const mode = task.data.currentMode ?? 'agent';

  if (!profile) {
    await task.runPrompt(prompt, mode);
    return;
  }

  void task.runPromptInAgent(profile, mode, prompt).catch((error: unknown) => {
    runtime.log(
      `agent run failed for task ${task.data.id}: ${error instanceof Error ? error.message : String(error)}`,
      'warn',
    );
  });
}

/**
 * Registers the calling task as master and asks it to register on the bus.
 *
 * The local join table alone gives the master no bus identity; registration
 * has to happen through the agent's MCP tools.
 */
export async function registerMaster(
  runtime: ProjectRuntime,
  task: TaskContext | null,
): Promise<{ ok: boolean; prompted: boolean; error?: string }> {
  ensureMaster(runtime, task);
  const identity = runtime.masterIdentity();
  if (!task || !identity) {
    return { ok: false, prompted: false, error: 'no task context to register as master' };
  }
  if (!runtime.state.master) {
    return { ok: false, prompted: false, error: 'master registration was not persisted' };
  }

  await applyRoleProfile(runtime, task, 'master');

  try {
    await startWithRoleProfile(runtime, task, 'master', masterRegistrationPrompt(identity));
    runtime.log(`prompted task ${task.data.id} to register as "${identity.agentName}"`, 'info');
    return { ok: true, prompted: true };
  } catch (error) {
    return { ok: false, prompted: false, error: describe(error, false) };
  }
}

export async function spawnWorkers(runtime: ProjectRuntime, requests: SpawnRequest[]): Promise<SpawnOutcome[]> {
  const outcomes: SpawnOutcome[] = [];
  const { maxWorkers } = runtime.config.orchestration;
  const needsWorktree = runtime.config.isolation.mode !== 'shared';

  for (const request of requests) {
    if (runtime.state.workers.length >= maxWorkers) {
      outcomes.push({
        ok: false,
        error: `maxWorkers (${maxWorkers}) reached. Stop a worker or raise orchestration.maxWorkers.`,
      });
      continue;
    }

    const role = resolveRole(request.role);
    const agentName = agentNameFor(runtime, request.name);
    const capabilities = request.capabilities?.length ? request.capabilities : DEFAULT_CAPABILITIES;
    const profile = runtime.profileForJob(role);

    let taskData;
    try {
      taskData = await runtime.projectContext.createTask({
        name: `${request.name} (${role})`,
        parentId: runtime.state.master?.taskId ?? null,
        mode: 'agent',
        activate: false,
        agentProfileId: profile?.id,
        workingMode: needsWorktree ? 'worktree' : 'local',
      });
    } catch (error) {
      outcomes.push({ ok: false, error: describe(error, needsWorktree) });
      continue;
    }

    const task = runtime.projectContext.getTask(taskData.id);
    if (!task) {
      outcomes.push({ ok: false, error: `task ${taskData.id} was created but is not available in memory` });
      continue;
    }

    if (needsWorktree && task.data.workingMode !== 'worktree') {
      try {
        await task.switchToWorktreeWorkingMode({ carryOverUncommittedChanges: false, dropSourceChanges: false });
      } catch (error) {
        outcomes.push({ ok: false, taskId: taskData.id, error: describe(error, true) });
        continue;
      }
    }

    const defaults = runtime.modelDefaults;
    if (profile && defaults && (task.data.provider !== defaults.provider || task.data.model !== defaults.model)) {
      await task.updateTask({ provider: defaults.provider, model: defaults.model });
    }

    const record = runtime.state.upsertWorker({
      agentName,
      taskId: taskData.id,
      role,
      name: request.name,
      capabilities,
      worktree: worktreePathOf(task),
      status: 'starting',
    });

    const prompt = `${registrationPrompt(runtime.identityFor(record))}\n\n## Assigned work package\n\n${request.task}`;
    try {
      await startWithRoleProfile(runtime, task, role, prompt);
      runtime.log(`spawned ${agentName} as task ${taskData.id} (${role}, ${runtime.config.isolation.mode})`, 'info');
      outcomes.push({ ok: true, agentName, taskId: taskData.id });
    } catch (error) {
      runtime.state.updateWorker(taskData.id, { status: 'blocked' });
      outcomes.push({ ok: false, agentName, taskId: taskData.id, error: describe(error, false) });
    }
  }

  return outcomes;
}

export interface JoinRequest {
  name: string;
  role: string;
  capabilities?: string[];
  /** Move an existing local task into its own worktree before joining. */
  switchToWorktree?: boolean;
}

/**
 * Adopts an existing AiderDesk task into the team.
 *
 * The task keeps its conversation and working directory; it only gains a bus
 * identity and the team rules.
 */
export async function joinWorker(
  runtime: ProjectRuntime,
  task: TaskContext,
  request: JoinRequest,
): Promise<SpawnOutcome> {
  const taskId = task.data.id;
  if (runtime.state.master?.taskId === taskId) {
    return { ok: false, taskId, error: 'this task is already the team master' };
  }

  const existing = runtime.state.findByTaskId(taskId);
  const { maxWorkers } = runtime.config.orchestration;
  if (!existing && runtime.state.workers.length >= maxWorkers) {
    return {
      ok: false,
      taskId,
      error: `maxWorkers (${maxWorkers}) reached. Stop a worker or raise orchestration.maxWorkers.`,
    };
  }

  const role = resolveRole(request.role);
  const agentName = existing?.agentName ?? agentNameFor(runtime, request.name);
  const capabilities = request.capabilities?.length
    ? request.capabilities
    : (existing?.capabilities ?? DEFAULT_CAPABILITIES);

  // Honour the configured isolation by default: a joined task that silently
  // stays in the shared directory defeats the whole point of worktree mode.
  const wantsWorktree = request.switchToWorktree ?? runtime.config.isolation.mode !== 'shared';
  if (wantsWorktree && task.data.workingMode !== 'worktree') {
    if (runtime.runningTasks.has(taskId)) {
      runtime.log(`not moving task ${taskId} into a worktree while it runs — stop it first, then re-run join`, 'warn');
    } else {
      try {
        await task.switchToWorktreeWorkingMode({ carryOverUncommittedChanges: true, dropSourceChanges: false });
      } catch (error) {
        return { ok: false, taskId, error: describe(error, true) };
      }
    }
  }

  await applyRoleProfile(runtime, task, role);

  const record = runtime.state.upsertWorker({
    agentName,
    taskId,
    role,
    name: request.name,
    capabilities,
    worktree: worktreePathOf(task),
    status: 'starting',
  });

  const prompt = [
    '## Existing task',
    '',
    'You are joining the team with a task that is already in progress.',
    'Register on the bus first, then read your inbox and the team board, and continue your current work.',
    'Do not restart the task from scratch.',
    '',
    registrationPrompt(runtime.identityFor(record), {
      closing:
        'Start now: register, read your inbox and the board, then continue your current work — do not restart it.',
    }),
  ].join('\n');

  try {
    await startWithRoleProfile(runtime, task, role, prompt);
    runtime.log(`adopted task ${taskId} as ${agentName} (${role})`, 'info');
    return { ok: true, agentName, taskId };
  } catch (error) {
    runtime.state.updateWorker(taskId, { status: 'blocked' });
    return { ok: false, agentName, taskId, error: describe(error, false) };
  }
}

export function stopWorker(runtime: ProjectRuntime, nameOrTaskId: string): { ok: boolean; error?: string } {
  const worker =
    runtime.state.findByName(nameOrTaskId) ??
    runtime.state.findByTaskId(nameOrTaskId) ??
    runtime.state.workers.find((entry) => entry.name === nameOrTaskId);

  if (!worker) {
    return { ok: false, error: `unknown worker "${nameOrTaskId}"` };
  }

  const task = runtime.projectContext.getTask(worker.taskId);
  if (!task) {
    runtime.state.updateWorker(worker.taskId, { status: 'closed' });
    return { ok: false, error: `task ${worker.taskId} is not loaded in this AiderDesk session` };
  }

  void task.interruptResponse();
  runtime.state.updateWorker(worker.taskId, { status: 'idle' });
  return { ok: true };
}

/**
 * Removes a participant from the team: the bus registration is deleted, the
 * join table entry is dropped. The AiderDesk task itself keeps running and is
 * not closed — only its bus identity and wake-ups go away.
 */
export async function removeWorker(
  runtime: ProjectRuntime,
  nameOrTaskId: string,
): Promise<{ ok: boolean; agentName?: string; error?: string }> {
  const worker =
    runtime.state.findByName(nameOrTaskId) ??
    runtime.state.findByTaskId(nameOrTaskId) ??
    runtime.state.workers.find((entry) => entry.name === nameOrTaskId);

  if (!worker) {
    return { ok: false, error: `unknown worker "${nameOrTaskId}"` };
  }

  try {
    await runtime.bus.removeMember(worker.agentName);
  } catch (error) {
    // A registration that never existed must not block the local cleanup.
    runtime.log(
      `bus registration of ${worker.agentName} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      'warn',
    );
  }

  runtime.unreadByTask.delete(worker.taskId);
  runtime.lastInboxError.delete(worker.taskId);
  runtime.state.removeWorker(worker.taskId);
  runtime.log(`removed ${worker.agentName} from the team`, 'info');

  return { ok: true, agentName: worker.agentName };
}

/**
 * Interrupts every agent that is currently running, master included.
 * Registrations, board tasks and the join table stay untouched.
 */
export function stopAll(runtime: ProjectRuntime): { stopped: string[]; skipped: string[] } {
  const targets = [
    ...(runtime.state.master
      ? [{ agentName: runtime.state.master.agentName, taskId: runtime.state.master.taskId, role: 'master' }]
      : []),
    ...runtime.state.workers.map((worker) => ({
      agentName: worker.agentName,
      taskId: worker.taskId,
      role: worker.role,
    })),
  ];

  const stopped: string[] = [];
  const skipped: string[] = [];

  for (const target of targets) {
    if (!runtime.runningTasks.has(target.taskId)) {
      skipped.push(target.agentName);
      continue;
    }

    const task = runtime.projectContext.getTask(target.taskId);
    if (!task) {
      skipped.push(target.agentName);
      continue;
    }

    void task.interruptResponse();
    if (target.role !== 'master') {
      runtime.state.updateWorker(target.taskId, { status: 'idle' });
    }
    stopped.push(target.agentName);
  }

  if (stopped.length > 0) {
    runtime.log(`stopped ${stopped.join(', ')}`, 'info');
  }
  return { stopped, skipped };
}

/**
 * Removes every identity of the project's team, the master included, and clears
 * the join table. Bus-side failures do not stop the local cleanup; they are
 * reported so a stale registration can be removed by hand.
 */
export async function resetTeam(runtime: ProjectRuntime): Promise<{
  removed: string[];
  failed: Array<{ agentName: string; error: string }>;
}> {
  const targets = [
    ...(runtime.state.master
      ? [{ agentName: runtime.state.master.agentName, taskId: runtime.state.master.taskId, role: 'master' }]
      : []),
    ...runtime.state.workers.map((worker) => ({
      agentName: worker.agentName,
      taskId: worker.taskId,
      role: worker.role,
    })),
  ];

  const removed: string[] = [];
  const failed: Array<{ agentName: string; error: string }> = [];

  for (const target of targets) {
    try {
      await runtime.bus.removeMember(target.agentName);
    } catch (error) {
      failed.push({
        agentName: target.agentName,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (target.role === 'master') {
      runtime.state.clearMaster();
    } else {
      runtime.state.removeWorker(target.taskId);
    }
    runtime.unreadByTask.delete(target.taskId);
    runtime.lastInboxError.delete(target.taskId);
    removed.push(target.agentName);
  }

  runtime.log(`reset team: removed ${removed.length} identities`, 'info');
  return { removed, failed };
}

export function describeWorkers(
  runtime: ProjectRuntime,
): Array<Pick<WorkerRecord, 'agentName' | 'role' | 'status' | 'worktree' | 'taskId'>> {
  return runtime.state.workers.map(({ agentName, role, status, worktree, taskId }) => ({
    agentName,
    role,
    status,
    worktree,
    taskId,
  }));
}

function describe(error: unknown, worktreeRelated: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (worktreeRelated && /not a git repository|worktree/i.test(message)) {
    return `${message} — worktree isolation needs a git repository; set isolation.mode to "shared" or initialise git.`;
  }
  return message;
}
