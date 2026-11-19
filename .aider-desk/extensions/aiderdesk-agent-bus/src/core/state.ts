/**
 * Mapping table between AiderDesk tasks and agent-bus identities.
 *
 * This is a join table, not a second message store: agent-bus stays the source
 * of truth for messages, tasks and agent state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type WorkerStatus = 'starting' | 'idle' | 'working' | 'blocked' | 'closed';

export interface WorkerRecord {
  agentName: string;
  taskId: string;
  role: string;
  name: string;
  capabilities: string[];
  worktree: string | null;
  status: WorkerStatus;
  /** true = no wake-ups; messages keep queuing on the bus. */
  muted?: boolean;
  createdAt: string;
  lastWakeAt?: string;
  /** Unread count at the last wake; used to stop waking an agent that ignores its inbox. */
  lastWakeUnread?: number;
  wakes: number;
}

export interface MasterRecord {
  agentName: string;
  taskId: string;
}

export interface StateSnapshot {
  version: 1;
  project: string;
  team: string;
  master?: MasterRecord;
  workers: WorkerRecord[];
  updatedAt: string;
}

export function statePath(projectDir: string): string {
  return join(projectDir, '.aider-desk', 'agent-bus-state.json');
}

export class AgentBusState {
  private snapshot: StateSnapshot;
  private readonly path: string;

  constructor(projectDir: string, project: string, team: string) {
    this.path = statePath(projectDir);
    this.snapshot = { version: 1, project, team, workers: [], updatedAt: new Date().toISOString() };
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<StateSnapshot>;
      if (parsed.version === 1 && Array.isArray(parsed.workers)) {
        this.snapshot = {
          ...this.snapshot,
          ...parsed,
          workers: parsed.workers.filter((worker): worker is WorkerRecord => typeof worker?.taskId === 'string'),
        } as StateSnapshot;
      }
    } catch {
      // A corrupted join table is not fatal: it is rebuilt from live tasks.
    }
  }

  private persist(): void {
    this.snapshot.updatedAt = new Date().toISOString();
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.snapshot, null, 2)}\n`, 'utf-8');
    renameSync(tmp, this.path);
  }

  get project(): string {
    return this.snapshot.project;
  }

  get team(): string {
    return this.snapshot.team;
  }

  setScope(project: string, team: string): void {
    this.snapshot.project = project;
    this.snapshot.team = team;
    this.persist();
  }

  get workers(): WorkerRecord[] {
    return this.snapshot.workers;
  }

  get master(): MasterRecord | undefined {
    return this.snapshot.master;
  }

  setMaster(record: MasterRecord): void {
    this.snapshot.master = record;
    this.persist();
  }

  clearMaster(): void {
    delete this.snapshot.master;
    this.persist();
  }

  upsertWorker(
    record: Omit<WorkerRecord, 'createdAt' | 'wakes'> & { createdAt?: string; wakes?: number },
  ): WorkerRecord {
    const existing = this.snapshot.workers.find((worker) => worker.taskId === record.taskId);
    if (existing) {
      Object.assign(existing, record, { createdAt: existing.createdAt });
      this.persist();
      return existing;
    }
    const created: WorkerRecord = {
      ...record,
      createdAt: record.createdAt ?? new Date().toISOString(),
      wakes: record.wakes ?? 0,
    };
    this.snapshot.workers.push(created);
    this.persist();
    return created;
  }

  updateWorker(taskId: string, patch: Partial<WorkerRecord>): WorkerRecord | undefined {
    const worker = this.snapshot.workers.find((entry) => entry.taskId === taskId);
    if (!worker) {
      return undefined;
    }
    Object.assign(worker, patch);
    this.persist();
    return worker;
  }

  findByTaskId(taskId: string): WorkerRecord | undefined {
    return this.snapshot.workers.find((worker) => worker.taskId === taskId);
  }

  findByName(agentName: string): WorkerRecord | undefined {
    return this.snapshot.workers.find((worker) => worker.agentName === agentName);
  }

  removeWorker(taskId: string): void {
    this.snapshot.workers = this.snapshot.workers.filter((worker) => worker.taskId !== taskId);
    this.persist();
  }

  /** Marks workers whose task no longer exists as closed instead of dropping history. */
  reconcile(liveTaskIds: Set<string>): void {
    let changed = false;
    for (const worker of this.snapshot.workers) {
      if (!liveTaskIds.has(worker.taskId) && worker.status !== 'closed') {
        worker.status = 'closed';
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }
}
