/**
 * Ground truth about a team: is each identity really on the bus?
 *
 * The local join table only says a task *should* have an identity. An agent
 * that never called `register` — for example because its session had no
 * agent-bus tools — leaves that table lying. This module checks the bus.
 */

import { BusUnavailableError } from '../bus/client.js';
import type { ProjectRuntime } from '../core/runtime.js';

export interface AgentHealth {
  agentName: string;
  taskId: string;
  role: string;
  status: string;
  /** true = registered, false = explicitly not registered, null = could not tell */
  registered: boolean | null;
  unread: number;
  error?: string;
}

function registrationOf(error: unknown): boolean | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('is not registered')) {
    return false;
  }
  return null;
}

async function inspect(
  runtime: ProjectRuntime,
  agentName: string,
): Promise<{ registered: boolean | null; unread: number; error?: string }> {
  try {
    const status = await runtime.bus.inboxStatus(agentName);
    return { registered: true, unread: status.unread };
  } catch (error) {
    if (error instanceof BusUnavailableError) {
      return { registered: null, unread: 0, error: error.message };
    }
    const registered = registrationOf(error);
    return {
      registered,
      unread: 0,
      error: registered === false ? undefined : error instanceof Error ? error.message : String(error),
    };
  }
}

export async function collectHealth(runtime: ProjectRuntime): Promise<AgentHealth[]> {
  const entries: Array<{ agentName: string; taskId: string; role: string; status: string }> = [];

  if (runtime.state.master) {
    const master = runtime.state.master;
    entries.push({ agentName: master.agentName, taskId: master.taskId, role: 'master', status: 'master' });
  }
  for (const worker of runtime.state.workers) {
    entries.push({
      agentName: worker.agentName,
      taskId: worker.taskId,
      role: worker.role,
      status: worker.status,
    });
  }

  const result: AgentHealth[] = [];
  for (const entry of entries) {
    const state = await inspect(runtime, entry.agentName);
    result.push({ ...entry, ...state });
  }
  return result;
}

export async function checkRegistration(runtime: ProjectRuntime, agentName: string): Promise<boolean | null> {
  return (await inspect(runtime, agentName)).registered;
}
