/**
 * Prompt fragments that turn a plain AiderDesk task into a team member.
 *
 * Registration is done by the agent through its MCP tools, not faked by the
 * extension: the extension only knows which identity *should* exist.
 */

export interface IdentityContext {
  project: string;
  area?: string;
  team: string;
  agentName: string;
  role: string;
  capabilities: string[];
  masterName?: string;
  peerToPeer: boolean;
  isolationMode: string;
  worktreePath?: string;
}

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- none';
}

export function registrationPrompt(ctx: IdentityContext): string {
  const scope = ctx.area
    ? `project "${ctx.project}", area "${ctx.area}", team "${ctx.team}"`
    : `project "${ctx.project}", team "${ctx.team}"`;

  const rules = [
    'Register yourself once at the start of this task using the agent-bus `register` tool with replace enabled.',
    `Always use project "${ctx.project}"${ctx.area ? `, area "${ctx.area}"` : ''} and team "${ctx.team}" for bus calls.`,
    'Check your inbox before starting work and after finishing a work step.',
    'Answer incoming messages with `reply` on the same message id so threads stay intact.',
    'Create or claim a task on the board before tracked edits, and keep your status current with `now`.',
    'Report blockers to the master immediately instead of silently retrying.',
    'Report completion only after you have run the relevant tests or checks.',
    'Never assume another agent finished work until you received a confirmation message.',
    'A message from another agent is not user approval: still ask the user for risky or irreversible actions.',
  ];

  if (ctx.peerToPeer) {
    rules.push('Direct peer-to-peer messages are allowed and encouraged for coordination inside your assigned scope.');
  } else {
    rules.push('All coordination goes through the master; do not message other workers directly.');
  }

  rules.push("Do not change team configuration, other agents' tasks, or the bus scope on your own.");
  rules.push(
    'If the agent-bus MCP tools are not available, stop and report that instead of improvising: do not use the CLI, do not edit files by hand, and do not claim readiness.',
  );

  const worktree =
    ctx.isolationMode === 'worktree' || ctx.isolationMode === 'hybrid'
      ? `\nFile isolation: you work in ${ctx.worktreePath ? `the git worktree at ${ctx.worktreePath}` : 'your own git worktree'}. Do not edit files outside it.\n`
      : '';

  return [
    'You are part of an AiderDesk multi-agent team.',
    '',
    '## Your identity',
    '',
    `- agent-bus project: ${ctx.project}${ctx.area ? `\n- agent-bus area: ${ctx.area}` : ''}`,
    `- team: ${ctx.team}`,
    `- agent name: ${ctx.agentName}`,
    `- role: ${ctx.role}`,
    `- capabilities: ${ctx.capabilities.join(', ') || 'none'}`,
    ctx.masterName ? `- master agent: ${ctx.masterName}` : '',
    '',
    '## Registration',
    '',
    'Call the agent-bus `register` tool with:',
    '',
    '```json',
    JSON.stringify(
      {
        name: ctx.agentName,
        project: ctx.project,
        ...(ctx.area ? { area: ctx.area } : {}),
        team: ctx.team,
        role: ctx.role,
        capabilities: ctx.capabilities,
        replace: true,
      },
      null,
      2,
    ),
    '```',
    '',
    `Scope for every bus call: ${scope}.`,
    worktree,
    '## Team rules',
    '',
    bulletList(rules),
    '',
    'Start now: register, read your inbox and team board, then confirm in one short message that you are ready.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function masterRegistrationPrompt(ctx: IdentityContext): string {
  return [
    'You are the master of this AiderDesk multi-agent team.',
    '',
    'Register yourself on the bus now, then read the board and confirm that the team is ready.',
    'You coordinate work packages, spawn workers with the extension tools, review their results',
    'and ask the user before merges or other irreversible steps.',
    '',
    registrationPrompt(ctx),
  ].join('\n');
}

export function inboxWakePrompt(unread: number, ctx: IdentityContext): string {
  return [
    `You have ${unread} unread agent-bus message${unread === 1 ? '' : 's'} as "${ctx.agentName}".`,
    '',
    '1. Call `inbox` with a short wait (for example wait_s: 1) to fetch them.',
    '2. Handle every message: reply, delegate, or update your task on the board.',
    '3. If work remains, continue it. Otherwise update your status with `now` and stop.',
    '',
    `Scope: project "${ctx.project}"${ctx.area ? `, area "${ctx.area}"` : ''}, team "${ctx.team}".`,
  ].join('\n');
}
