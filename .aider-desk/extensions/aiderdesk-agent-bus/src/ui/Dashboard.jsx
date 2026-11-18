/* eslint-disable @typescript-eslint/no-unused-expressions -- AiderDesk evaluates this file as one component expression */
/**
 * Agent Bus dashboard (project-floating placement).
 *
 * React is globally available; props come from getUIExtensionData().
 */
(props) => {
  const { data, ui, icons, executeExtensionAction } = props;
  const { Button } = ui;
  const { FiRefreshCw, FiGitBranch } = icons.Fi;

  if (!data || data.available === false) {
    return <div className="p-3 text-xs text-text-secondary">Open a project to use the agent-bus team dashboard.</div>;
  }

  const statusColor = (status) => {
    if (status === 'working') return 'bg-success';
    if (status === 'blocked') return 'bg-error';
    if (status === 'closed') return 'bg-bg-tertiary';
    return 'bg-warning';
  };

  const workers = data.workers || [];
  const active = workers.filter((worker) => worker.status === 'working').length;
  const unread = workers.reduce((sum, worker) => sum + (worker.unread || 0), 0);

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-text-primary">{data.project}</div>
          <div className="text-text-secondary">
            {data.team} · {data.isolation}
          </div>
        </div>
        <Button size="xs" variant="outline" onClick={() => executeExtensionAction('refresh')}>
          <FiRefreshCw className="w-3 h-3" />
        </Button>
      </div>

      {data.configError ? <div className="rounded bg-error/10 p-2 text-error">{data.configError}</div> : null}

      {!data.enabled ? (
        <div className="rounded bg-warning/10 p-2 text-warning">
          agent-bus is disabled in .aider-desk/agent-bus.json
        </div>
      ) : null}

      <div className="flex gap-3 text-text-secondary">
        <span>agents {workers.length + (data.master ? 1 : 0)}</span>
        <span>active {active}</span>
        <span>unread {unread}</span>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary" />
          <span className="font-medium text-text-primary">{data.master ? data.master.agentName : 'no master'}</span>
          <span className="text-text-secondary">master</span>
        </div>

        {workers.map((worker) => (
          <div key={worker.taskId} className="flex items-center justify-between gap-2 rounded p-1 hover:bg-bg-tertiary">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className={'h-2 w-2 rounded-full ' + statusColor(worker.status)} />
              <span className="truncate font-medium text-text-primary">{worker.agentName}</span>
              <span className="text-text-secondary">{worker.role}</span>
              {worker.worktree ? <FiGitBranch className="h-3 w-3 text-text-secondary" /> : null}
              {worker.unread > 0 ? (
                <span className="rounded bg-primary/20 px-1 text-primary">{worker.unread}</span>
              ) : null}
              {worker.error ? <span className="truncate text-error">{worker.error}</span> : null}
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={worker.status !== 'working' && worker.status !== 'starting'}
              onClick={() => executeExtensionAction('stop-worker', worker.agentName)}
            >
              stop
            </Button>
          </div>
        ))}

        {workers.length === 0 ? <div className="text-text-secondary">No workers yet. Use /agent-bus-spawn.</div> : null}
      </div>
    </div>
  );
};
