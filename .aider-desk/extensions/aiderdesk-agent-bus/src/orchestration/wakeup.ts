/**
 * Event-driven wake-up instead of a blocking `inbox(wait_s)` call.
 *
 * A worker that sits in a long inbox wait occupies its agent loop and cannot be
 * interrupted cleanly. Polling the inbox state and re-prompting an idle task is
 * the mechanism AiderDesk can actually control.
 */

import { BusUnavailableError } from '../bus/client.js';
import { startWithRoleProfile } from './team.js';
import { inboxWakePrompt } from '../bus/prompts.js';
import type { ProjectRuntime } from '../core/runtime.js';

export class InboxWatcher {
  constructor(private readonly runtime: ProjectRuntime) {}

  private canWake(taskId: string, unread: number): boolean {
    if (this.runtime.runningTasks.has(taskId)) {
      return false;
    }
    const worker = this.runtime.state.findByTaskId(taskId);
    if (!worker || worker.status === 'closed' || worker.muted) {
      return false;
    }
    if (worker.wakes >= this.runtime.config.orchestration.maxWakesPerTask) {
      return false;
    }
    // An agent that ignored its inbox after the last wake must not be woken
    // again for the same backlog; only progress (unread dropping) re-enables it.
    if (typeof worker.lastWakeUnread === 'number' && unread >= worker.lastWakeUnread) {
      return false;
    }
    const cooldown = this.runtime.config.orchestration.wakeCooldownMs;
    const last = worker.lastWakeAt ? Date.parse(worker.lastWakeAt) : 0;
    return Number.isFinite(last) ? Date.now() - last >= cooldown : true;
  }

  private async wake(taskId: string, unread: number): Promise<void> {
    const worker = this.runtime.state.findByTaskId(taskId);
    if (!worker) {
      return;
    }
    const task = this.runtime.projectContext.getTask(taskId);
    if (!task) {
      this.runtime.log(`cannot wake ${worker.agentName}: task ${taskId} is not loaded`, 'warn');
      return;
    }

    try {
      // Same rule as spawn/join: run with the role profile and the task's mode.
      // 'code' would hand the prompt to the Aider connector, which never reads
      // the inbox — that caused a wake loop until the budget ran out.
      await startWithRoleProfile(
        this.runtime,
        task,
        worker.role,
        inboxWakePrompt(unread, this.runtime.identityFor(worker)),
      );
      this.runtime.state.updateWorker(taskId, {
        wakes: worker.wakes + 1,
        lastWakeAt: new Date().toISOString(),
        lastWakeUnread: unread,
        status: 'working',
      });
      this.runtime.log(`woke ${worker.agentName} for ${unread} unread message(s)`, 'info');
    } catch (error) {
      this.runtime.log(
        `wake failed for ${worker.agentName}: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }
  }

  async pollOnce(): Promise<void> {
    // One wake per tick: several simultaneous agent runs are what makes the
    // app feel hung.
    for (const worker of this.runtime.state.workers) {
      if (worker.status === 'closed' || worker.status === 'starting') {
        continue;
      }
      // Parked workers are still checked. Their budget only resets when the
      // backlog changes, and skipping them entirely meant new work from the
      // master was never noticed.
      const lastWakeAt = worker.lastWakeAt;
      await this.checkWorker(worker.taskId);
      if (this.runtime.state.findByTaskId(worker.taskId)?.lastWakeAt !== lastWakeAt) {
        return;
      }
    }
  }

  /** Fresh budget for a new or emptied backlog; unblocks a parked worker. */
  private resetWakeBudget(taskId: string): void {
    const worker = this.runtime.state.findByTaskId(taskId);
    if (!worker) {
      return;
    }
    if (
      worker.wakes === 0 &&
      !worker.wakeBudgetLogged &&
      worker.lastWakeUnread === undefined &&
      worker.status !== 'blocked'
    ) {
      return;
    }
    this.runtime.state.updateWorker(taskId, {
      wakes: 0,
      lastWakeUnread: undefined,
      wakeBudgetLogged: false,
      ...(worker.status === 'blocked' ? { status: 'idle' } : {}),
    });
  }

  async checkWorker(taskId: string, options: { wake?: boolean } = {}): Promise<number> {
    const worker = this.runtime.state.findByTaskId(taskId);
    if (!worker) {
      return 0;
    }

    let unread: number;
    try {
      const status = await this.runtime.bus.inboxStatus(worker.agentName);
      unread = status.unread;
      this.runtime.unreadByTask.set(taskId, unread);
      this.runtime.lastInboxError.delete(taskId);
      if (worker.wakeBudgetLogged && typeof worker.lastWakeUnread === 'number' && unread < worker.lastWakeUnread) {
        this.runtime.state.updateWorker(taskId, { wakeBudgetLogged: false });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BusUnavailableError) {
        this.runtime.lastInboxError.set(taskId, message);
        return 0;
      }
      // An agent that has not registered yet is not an error, it is a state.
      if (message.includes('is not registered')) {
        this.runtime.unreadByTask.set(taskId, 0);
        this.runtime.lastInboxError.delete(taskId);
        return 0;
      }
      this.runtime.lastInboxError.set(taskId, message);
      return 0;
    }

    // The budget belongs to one backlog, not to the worker's lifetime. An
    // untouched backlog stays parked; a new or emptied one gets a fresh budget.
    // Otherwise a worker that once hit the budget was parked forever and new
    // work from the master was never delivered.
    const knownBacklog = typeof worker.lastWakeUnread === 'number';
    if (unread === 0 || !knownBacklog || unread !== worker.lastWakeUnread) {
      this.resetWakeBudget(taskId);
    }

    if (worker.wakes >= this.runtime.config.orchestration.maxWakesPerTask) {
      if (!worker.wakeBudgetLogged) {
        this.runtime.state.updateWorker(taskId, { status: 'blocked', wakeBudgetLogged: true });
        this.runtime.log(
          `${worker.agentName} reached maxWakesPerTask (${worker.wakes}) for the same backlog — parked until it changes`,
          'warn',
        );
      }
      return unread;
    }

    if (options.wake === false) {
      return unread;
    }

    if (unread > 0) {
      if (this.canWake(taskId, unread)) {
        await this.wake(taskId, unread);
      }
    }
    return unread;
  }
}
