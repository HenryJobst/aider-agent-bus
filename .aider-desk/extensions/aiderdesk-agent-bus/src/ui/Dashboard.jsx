/* eslint-disable @typescript-eslint/no-unused-expressions -- AiderDesk evaluates this file as one component expression */
/**
 * Agent Bus dashboard, docked at the bottom of the tasks sidebar.
 *
 * The sidebar is narrow, so this renders as a compact status strip: one row
 * per agent, unread badges, and a refresh action. React is globally available.
 */
(props) => {
  const { data, ui, icons, executeExtensionAction } = props;
  const { Button } = ui;
  const { FiRefreshCw, FiChevronDown, FiChevronRight } = icons.Fi;
  const [note, setNote] = React.useState(null);
  const [expanded, setExpanded] = React.useState(true);

  if (!data || data.available === false) {
    return null;
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

  const refresh = async () => {
    setNote('refreshing…');
    const result = await executeExtensionAction('refresh');
    setNote(result && result.ok ? `${result.registered}/${result.total} registered` : 'refresh failed');
  };

  const removeWorker = async (agentName) => {
    if (!window.confirm(`Remove ${agentName} from the team? The task keeps running.`)) {
      return;
    }
    setNote(`${agentName}: removing…`);
    const result = await executeExtensionAction('remove-worker', agentName);
    setNote(
      result && result.ok
        ? `${agentName}: removed`
        : `${agentName}: ${result && result.error ? result.error : 'remove failed'}`,
    );
  };

  const stopWorker = async (agentName) => {
    setNote(`${agentName}: stopping…`);
    const result = await executeExtensionAction('stop-worker', agentName);
    setNote(
      result && result.ok
        ? `${agentName}: stopped`
        : `${agentName}: ${result && result.error ? result.error : 'stop failed'}`,
    );
  };

  return (
    <div className="flex flex-col gap-1 border-t border-border bg-bg-secondary px-2 py-1 text-2xs">
      <div className="flex items-center gap-2">
        <span className="truncate font-medium text-text-primary">Agent Bus</span>
        <span className="text-text-secondary">
          {active}/{workers.length} active
        </span>
        {unread > 0 ? <span className="rounded bg-primary/20 px-1 text-primary">{unread}</span> : null}
        <span className="flex-1" />
        <Button size="xs" variant="outline" onClick={refresh} title="Read registration state from the bus">
          <FiRefreshCw className="w-3 h-3" />
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <FiChevronDown className="w-3 h-3" /> : <FiChevronRight className="w-3 h-3" />}
        </Button>
      </div>

      {expanded ? (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            <span className="truncate text-text-primary">{data.master ? data.master.agentName : 'no master'}</span>
          </div>

          {workers.map((worker) => (
            <div key={worker.taskId} className="flex items-center gap-1">
              <span className={'h-1.5 w-1.5 shrink-0 rounded-full ' + statusColor(worker.status)} />
              <span className="truncate text-text-primary">{worker.agentName}</span>
              {worker.unread > 0 ? <span className="text-primary">{worker.unread}</span> : null}
              <span className="flex-1" />
              <Button
                size="xs"
                variant="outline"
                disabled={worker.status !== 'working' && worker.status !== 'starting'}
                onClick={() => stopWorker(worker.agentName)}
              >
                stop
              </Button>
              <Button size="xs" variant="outline" color="danger" onClick={() => removeWorker(worker.agentName)}>
                ×
              </Button>
            </div>
          ))}

          {workers.length === 0 ? <span className="text-text-secondary">No workers</span> : null}
        </div>
      ) : null}

      {data.configError ? <span className="truncate text-error">{data.configError}</span> : null}
      {!data.enabled ? <span className="text-warning">agent-bus disabled</span> : null}
      {note ? <span className="truncate text-text-secondary">{note}</span> : null}
    </div>
  );
};
