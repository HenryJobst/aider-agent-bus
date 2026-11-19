/**
 * Event-driven wake-up instead of a blocking `inbox(wait_s)` call.
 *
 * A worker that sits in a long inbox wait occupies its agent loop and cannot be
 * interrupted cleanly. Polling the inbox state and re-prompting an idle task is
 * the mechanism AiderDesk can actually control.
 */

import { BusUnavailableError } from '../bus/client.js';
import { inboxWakePrompt } from '../bus/prompts.js';
import type { ProjectRuntime } from '../core/runtime.js';

export class InboxWatcher {
  constructor(private readonly runtime: ProjectRuntime) {}

  private canWake(taskId: string): boolean {
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
      await task.runPrompt(inboxWakePrompt(unread, this.runtime.identityFor(worker)), 'code');
      this.runtime.state.updateWorker(taskId, {
        wakes: worker.wakes + 1,
        lastWakeAt: new Date().toISOString(),
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
    for (const worker of this.runtime.state.workers) {
      if (worker.status === 'closed' || worker.status === 'starting') {
        continue;
      }
      await this.checkWorker(worker.taskId);
    }
  }

  async checkWorker(taskId: string): Promise<number> {
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

    if (unread > 0 && this.canWake(taskId)) {
      await this.wake(taskId, unread);
    }
    return unread;
  }
}
