import { useEffect, useMemo, useState } from 'react'
import './App.css'

const DEFAULT_REPOS = [
  {
    id: 'backend',
    name: 'backend',
    path: 'C:\\Users\\t-jewookpark\\gallery-soma\\GallerySoma-API',
    testCommand: '.\\gradlew.bat test',
    enabled: true,
  },
  {
    id: 'frontend',
    name: 'frontend',
    path: 'C:\\Users\\t-jewookpark\\gallery-soma\\gallerysoma-frontend',
    testCommand: 'npm run lint',
    enabled: true,
  },
]

const INITIAL_FORM = {
  mission: 'Run multi-repo delivery until tests pass and push successful branches.',
  branchPrefix: 'night-agent-ui',
  maxRetries: 4,
  runOrchestratorFirst: true,
  remediationCommand: 'node orchestrator.js',
  runRemediationOnFailure: true,
  autoPush: true,
  commitMessageTemplate: 'chore: automated night-agent run',
  swe3RepoName: 'backend',
}

function newRepo() {
  return {
    id: crypto.randomUUID(),
    name: '',
    path: '',
    testCommand: '',
    enabled: true,
  }
}

function App() {
  const [form, setForm] = useState(INITIAL_FORM)
  const [repos, setRepos] = useState(DEFAULT_REPOS)
  const [runId, setRunId] = useState('')
  const [runData, setRunData] = useState(null)
  const [requestError, setRequestError] = useState('')
  const [pollError, setPollError] = useState('')

  const enabledRepos = useMemo(() => repos.filter((repo) => repo.enabled), [repos])
  const isRunning = runData?.status === 'queued' || runData?.status === 'running'
  const canStop = Boolean(runId) && isRunning

  const canStart = useMemo(() => {
    if (!enabledRepos.length) return false
    return enabledRepos.every(
      (repo) => repo.name.trim() && repo.path.trim() && repo.testCommand.trim(),
    )
  }, [enabledRepos])

  useEffect(() => {
    if (!runId) return undefined

    let timer = null
    const poll = async () => {
      try {
        const response = await fetch(`/api/runs/${runId}`)
        if (!response.ok) throw new Error('Failed to fetch run status.')
        const data = await response.json()
        setRunData(data)
        setPollError('')

        if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') return
        timer = setTimeout(poll, 1200)
      } catch (error) {
        setPollError(error.message || 'Polling failed.')
      }
    }

    poll()
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [runId])

  const updateForm = (event) => {
    const { name, type, value, checked } = event.target
    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  const updateRepo = (repoId, field, value) => {
    setRepos((prev) =>
      prev.map((repo) => (repo.id === repoId ? { ...repo, [field]: value } : repo)),
    )
  }

  const addRepo = () => {
    setRepos((prev) => [...prev, newRepo()])
  }

  const removeRepo = (repoId) => {
    setRepos((prev) => prev.filter((repo) => repo.id !== repoId))
  }

  const startBuilding = async () => {
    if (!canStart || isRunning) return
    setRequestError('')
    setPollError('')
    setRunData(null)

    const payload = {
      ...form,
      maxRetries: Number(form.maxRetries),
      repos,
    }

    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error('Failed to start run.')
      const data = await response.json()
      setRunId(data.runId)
    } catch (error) {
      setRequestError(error.message || 'Unable to start.')
    }
  }

  const stopBuilding = async () => {
    if (!runId || !isRunning) return
    setRequestError('')
    try {
      const response = await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' })
      if (!response.ok) throw new Error('Failed to stop run.')
      const latest = await fetch(`/api/runs/${runId}`)
      if (latest.ok) {
        const data = await latest.json()
        setRunData(data)
      }
    } catch (error) {
      setRequestError(error.message || 'Unable to stop run.')
    }
  }

  return (
    <main className="app">
      <header className="header card">
        <h1>Night Agent Multi-Repo Harness</h1>
        <p>
          Create branches, run agent remediation, retry swe3-critical tests, and push only after all
          configured repos pass.
        </p>
      </header>

      <section className="card">
        <h2>Run Configuration</h2>
        <div className="form-grid">
          <label className="full">
            Mission
            <textarea name="mission" rows={2} value={form.mission} onChange={updateForm} />
          </label>
          <label>
            Branch prefix
            <input name="branchPrefix" value={form.branchPrefix} onChange={updateForm} />
          </label>
          <label>
            Max retries per repo
            <input
              name="maxRetries"
              type="number"
              min="1"
              max="20"
              value={form.maxRetries}
              onChange={updateForm}
            />
          </label>
          <label>
            Swe3 validation repo name
            <input name="swe3RepoName" value={form.swe3RepoName} onChange={updateForm} />
          </label>
          <label>
            Commit message template
            <input
              name="commitMessageTemplate"
              value={form.commitMessageTemplate}
              onChange={updateForm}
            />
          </label>
          <label className="full">
            Remediation command (from night-agent root)
            <input
              name="remediationCommand"
              value={form.remediationCommand}
              onChange={updateForm}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="runOrchestratorFirst"
              checked={form.runOrchestratorFirst}
              onChange={updateForm}
            />
            Run remediation command before test loop
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="runRemediationOnFailure"
              checked={form.runRemediationOnFailure}
              onChange={updateForm}
            />
            Re-run remediation command whenever tests fail
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="autoPush"
              checked={form.autoPush}
              onChange={updateForm}
            />
            Push branch when tests pass
          </label>
        </div>
      </section>

      <section className="card">
        <div className="repos-header">
          <h2>Repositories</h2>
          <button type="button" className="secondary-btn" onClick={addRepo}>
            Add Repo
          </button>
        </div>
        <div className="repos">
          {repos.map((repo) => (
            <div className="repo-row" key={repo.id}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={repo.enabled}
                  onChange={(e) => updateRepo(repo.id, 'enabled', e.target.checked)}
                />
                Enabled
              </label>
              <label>
                Name
                <input
                  value={repo.name}
                  onChange={(e) => updateRepo(repo.id, 'name', e.target.value)}
                />
              </label>
              <label>
                Path
                <input
                  value={repo.path}
                  onChange={(e) => updateRepo(repo.id, 'path', e.target.value)}
                />
              </label>
              <label>
                Test command
                <input
                  value={repo.testCommand}
                  onChange={(e) => updateRepo(repo.id, 'testCommand', e.target.value)}
                />
              </label>
              <button
                type="button"
                className="danger-btn"
                onClick={() => removeRepo(repo.id)}
                disabled={repos.length <= 1}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="card run-controls">
        <button className="primary-btn" disabled={!canStart || isRunning} onClick={startBuilding}>
          {isRunning ? 'Building...' : 'Start Building'}
        </button>
        <button className="danger-btn" disabled={!canStop} onClick={stopBuilding}>
          Stop Run
        </button>
        {requestError && <p className="error-text">{requestError}</p>}
        {pollError && <p className="error-text">{pollError}</p>}
        {runData && (
          <p className="status-line">
            Status: <strong>{runData.status}</strong>
          </p>
        )}
      </section>

      <section className="card">
        <h2>Repository Results</h2>
        {!runData?.results?.length ? (
          <p className="muted">No run results yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Repo</th>
                <th>Branch</th>
                <th>Tests</th>
                <th>Committed</th>
                <th>Pushed</th>
              </tr>
            </thead>
            <tbody>
              {runData.results.map((result) => (
                <tr key={`${result.name}-${result.path}`}>
                  <td>{result.name}</td>
                  <td>{result.branch || '-'}</td>
                  <td>{result.testsPassed ? 'Passed' : 'Pending/Failed'}</td>
                  <td>{result.committed ? 'Yes' : 'No'}</td>
                  <td>{result.pushed ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Live Logs</h2>
        <div className="logs">
          {!runData?.logs?.length ? (
            <p className="empty">No logs yet. Press Start Building.</p>
          ) : (
            runData.logs.map((log, index) => (
              <div className={`log ${log.level || 'info'}`} key={`${log.time}-${index}`}>
                <span className="time">{new Date(log.time).toLocaleTimeString()}</span>
                <span className="repo">{log.repo || 'system'}</span>
                <span>{log.message}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  )
}

export default App
