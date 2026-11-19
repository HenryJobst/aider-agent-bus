/* eslint-disable @typescript-eslint/no-unused-expressions -- AiderDesk evaluates this file as one component expression */
/**
 * Agent Bus dashboard, docked at the bottom of the tasks sidebar.
 *
 * The sidebar is narrow, so this renders as a compact status strip: one row
 * per agent, unread badges, and a refresh action. React is globally available.
 */
(props) => {
  const { data, ui, icons, executeExtensionAction, activateTask } = props;
  const { Button } = ui;
  const { FiRefreshCw, FiChevronDown, FiChevronRight, FiBell, FiBellOff } = icons.Fi;
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
  const settings = data.settings || null;

  const setConfig = async (key, value) => {
    setNote(`${key} → ${value}…`);
    const result = await executeExtensionAction('set-config', key, value);
    setNote(
      result && result.ok
        ? `${key} = ${JSON.stringify(result.value)}`
        : `${key}: ${(result && result.error) || 'failed'}`,
    );
  };
  const active = workers.filter((worker) => worker.status === 'working').length;
  const unread = workers.reduce((sum, worker) => sum + (worker.unread || 0), 0);

  const refresh = async () => {
    setNote('refreshing…');
    const result = await executeExtensionAction('refresh');
    setNote(result && result.ok ? `${result.registered}/${result.total} registered` : 'refresh failed');
  };

  const stopAll = async () => {
    if (!window.confirm('Stop all running agents (workers and master)?')) {
      return;
    }
    setNote('stopping all…');
    const result = await executeExtensionAction('stop-all');
    setNote(result && result.ok ? `stopped ${result.stopped.length} agent(s)` : 'stop all failed');
  };

  const toggleMute = async (agentName, muted) => {
    setNote(`${agentName}: ${muted ? 'unmuting' : 'muting'}…`);
    const result = await executeExtensionAction('toggle-mute', agentName);
    setNote(
      result && result.ok
        ? `${agentName}: ${result.muted ? 'wake-ups muted' : 'wake-ups on'}`
        : `${agentName}: ${(result && result.error) || 'failed'}`,
    );
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
        <Button
          size="xs"
          variant="outline"
          color="danger"
          onClick={stopAll}
          title="Interrupt every running agent, master included"
        >
          stop all
        </Button>
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
            <span
              className={
                'truncate ' + (activateTask ? 'cursor-pointer text-text-primary hover:underline' : 'text-text-primary')
              }
              title={activateTask ? 'Open this task' : undefined}
              onClick={() => data.master && activateTask && activateTask(data.master.taskId)}
            >
              {data.master ? data.master.agentName : 'no master'}
            </span>
          </div>

          {workers.map((worker) => (
            <div key={worker.taskId} className="flex items-center gap-1">
              <span className={'h-1.5 w-1.5 shrink-0 rounded-full ' + statusColor(worker.status)} />
              <span
                className={
                  'truncate ' +
                  (worker.muted ? 'text-text-secondary' : 'text-text-primary') +
                  (activateTask ? ' cursor-pointer hover:underline' : '')
                }
                title={activateTask ? 'Open this task' : undefined}
                onClick={() => activateTask && activateTask(worker.taskId)}
              >
                {worker.agentName}
              </span>
              {worker.unread > 0 ? <span className="text-primary">{worker.unread}</span> : null}
              <span className="flex-1" />
              <Button
                size="xs"
                variant="outline"
                title={worker.muted ? 'Wake-ups muted — click to resume' : 'Mute wake-ups'}
                onClick={() => toggleMute(worker.agentName, worker.muted)}
              >
                {worker.muted ? <FiBellOff className="w-3 h-3" /> : <FiBell className="w-3 h-3" />}
              </Button>
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

      {expanded && settings ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            title="Board tasks or message-only coordination"
            onClick={() => setConfig('orchestration.trackTasks', String(!settings.trackTasks))}
          >
            {settings.trackTasks ? 'board tasks' : 'messages only'}
          </Button>
          <Button
            size="xs"
            variant="outline"
            title="Allow direct worker-to-worker messages"
            onClick={() => setConfig('orchestration.peerToPeerEnabled', String(!settings.peerToPeer))}
          >
            p2p {settings.peerToPeer ? 'on' : 'off'}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={settings.anyRunning}
            title={settings.anyRunning ? 'Stop the workers first' : 'Isolation for new and adopted tasks'}
            onClick={() => setConfig('isolation.mode', settings.isolation === 'worktree' ? 'shared' : 'worktree')}
          >
            {settings.isolation}
          </Button>
        </div>
      ) : null}

      {data.configError ? <span className="truncate text-error">{data.configError}</span> : null}
      {!data.enabled ? <span className="text-warning">agent-bus disabled</span> : null}
      {note ? <span className="truncate text-text-secondary">{note}</span> : null}
    </div>
  );
};
