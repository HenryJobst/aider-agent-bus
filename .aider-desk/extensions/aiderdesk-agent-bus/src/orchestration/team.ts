/**
 * Worker lifecycle: create AiderDesk tasks, attach them to the bus identity and
 * hand them their first prompt.
 *
 * AiderDesk owns execution and worktrees; this module only wires both systems
 * together and never blocks on a worker run.
 */

import type { TaskContext } from '@aiderdesk/extensions';

import { registrationPrompt } from '../bus/prompts.js';
import type { ProjectRuntime } from '../core/runtime.js';
import type { WorkerRecord } from '../core/state.js';
import { resolveRole } from '../profiles.js';

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
        mode: 'code',
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
      await task.runPrompt(prompt, 'code');
      runtime.log(`spawned ${agentName} as task ${taskData.id} (${role}, ${runtime.config.isolation.mode})`, 'info');
      outcomes.push({ ok: true, agentName, taskId: taskData.id });
    } catch (error) {
      runtime.state.updateWorker(taskData.id, { status: 'blocked' });
      outcomes.push({ ok: false, agentName, taskId: taskData.id, error: describe(error, false) });
    }
  }

  return outcomes;
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
