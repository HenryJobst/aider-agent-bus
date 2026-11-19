/**
 * Test doubles for the AiderDesk side of the extension.
 *
 * The extension API is only available inside AiderDesk, so orchestration logic
 * is tested at the seam: fake ProjectContext / TaskContext objects record what
 * the extension asks AiderDesk to do.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionContext, TaskContext, TaskData } from '@aiderdesk/extensions';

import { ProjectRuntime } from '../src/core/runtime.js';

export interface FakeCalls {
  createTask: Array<Record<string, unknown>>;
  updateTask: Array<{ id: string; updates: Record<string, unknown> }>;
  prompts: Array<{ id: string; prompt: string; mode?: string; profileId?: string }>;
  switches: Array<{ id: string; options: Record<string, unknown> }>;
  interrupts: string[];
}

export interface FakeTaskOptions {
  workingMode?: 'local' | 'worktree';
  worktreePath?: string | null;
  provider?: string;
  model?: string;
  currentMode?: string;
  failSwitch?: string;
  failRunPrompt?: string;
}

export interface FakeContext {
  context: ExtensionContext;
  calls: FakeCalls;
  tasks: Map<string, TaskContext>;
  taskData: Map<string, TaskData>;
  createFailure?: string;
}

function baseTaskData(id: string, projectDir: string, options: FakeTaskOptions): TaskData {
  const workingMode = options.workingMode ?? 'worktree';
  return {
    id,
    baseDir: projectDir,
    name: `task ${id}`,
    mainModel: 'test/model',
    aiderTotalCost: 0,
    agentTotalCost: 0,
    workingMode,
    provider: options.provider,
    model: options.model,
    currentMode: options.currentMode,
    worktree:
      workingMode === 'worktree' && options.worktreePath !== null
        ? { path: options.worktreePath ?? `/tmp/worktrees/${id}`, branch: `wt-${id}` }
        : undefined,
  } as TaskData;
}

export function makeTask(id: string, projectDir: string, calls: FakeCalls, options: FakeTaskOptions = {}): TaskContext {
  const data = baseTaskData(id, projectDir, options);
  const task = {
    data,
    runPrompt: async (prompt: string, mode?: string) => {
      if (options.failRunPrompt) {
        throw new Error(options.failRunPrompt);
      }
      calls.prompts.push({ id, prompt, mode });
    },
    runPromptInAgent: async (profile: { id: string }, mode: string, prompt: string | null) => {
      calls.prompts.push({ id, prompt: prompt ?? '', mode, profileId: profile.id });
      return [];
    },
    updateTask: async (updates: Record<string, unknown>) => {
      Object.assign(data, updates);
      calls.updateTask.push({ id, updates });
      return data;
    },
    switchToWorktreeWorkingMode: async (switchOptions: Record<string, unknown>) => {
      if (options.failSwitch) {
        throw new Error(options.failSwitch);
      }
      data.workingMode = 'worktree';
      data.worktree = { path: `/tmp/worktrees/${id}`, branch: `wt-${id}` } as TaskData['worktree'];
      calls.switches.push({ id, options: switchOptions });
    },
    interruptResponse: async () => {
      calls.interrupts.push(id);
    },
  };
  return task as unknown as TaskContext;
}

export interface RuntimeHarness {
  runtime: ProjectRuntime;
  fake: FakeContext;
  projectDir: string;
}

export function writeProjectConfig(projectDir: string, patch: Record<string, unknown>): void {
  mkdirSync(join(projectDir, '.aider-desk'), { recursive: true });
  writeFileSync(join(projectDir, '.aider-desk', 'agent-bus.json'), JSON.stringify(patch, null, 2), 'utf-8');
}

export function makeRuntime(patch: Record<string, unknown> = {}, options: FakeTaskOptions = {}): RuntimeHarness {
  const projectDir = mkdtempSync(join(tmpdir(), 'agent-bus-test-'));
  writeProjectConfig(projectDir, {
    team: 'test-team',
    agentBus: { project: 'test-project' },
    profiles: { provider: 'test', model: 'test-model' },
    ...patch,
  });

  const calls: FakeCalls = { createTask: [], updateTask: [], prompts: [], switches: [], interrupts: [] };
  const tasks = new Map<string, TaskContext>();
  const taskData = new Map<string, TaskData>();
  const fake: FakeContext = { calls, tasks, taskData } as FakeContext;

  const projectContext = {
    baseDir: projectDir,
    createTask: async (params: Record<string, unknown>) => {
      if (fake.createFailure) {
        throw new Error(fake.createFailure);
      }
      calls.createTask.push(params);
      const id = `task-${tasks.size + 1}`;
      const task = makeTask(id, projectDir, calls, options);
      tasks.set(id, task);
      taskData.set(id, task.data);
      return task.data;
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    getTasks: async () => [...taskData.values()],
  };

  const context = {
    getProjectDir: () => projectDir,
    getProjectContext: () => projectContext,
    getTaskContext: () => null,
    log: () => undefined,
    useFakeTaskContext: (task: TaskContext | null) => {
      context.getTaskContext = () => task;
    },
  } as unknown as ExtensionContext;

  fake.context = context;
  return { runtime: new ProjectRuntime(context), fake, projectDir };
}
