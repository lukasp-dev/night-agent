import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { execProcessCommand, execShellCommand } from './server/command-executor.mjs'
import { createServerConfig } from './server/config.mjs'
import { RunStore, ScheduleStore } from './server/run-store.mjs'

const app = express()
app.use(express.json())

const config = createServerConfig()
const runStore = new RunStore({
  stateDir: config.stateDir,
  maxLogsPerRun: config.maxLogsPerRun,
})
const scheduleStore = new ScheduleStore({ stateDir: config.stateDir })

const runChildren = new Map()
const activeRepoLocks = new Set()
const scheduleTimers = new Map()

class RunCancelledError extends Error {
  constructor(message = 'Run cancelled by user.') {
    super(message)
    this.name = 'RunCancelledError'
  }
}

class RepoBusyError extends Error {
  constructor(message = 'One or more repositories are already being processed.') {
    super(message)
    this.name = 'RepoBusyError'
  }
}

function nowIso() {
  return new Date().toISOString()
}

function slug(value) {
  return String(value || 'repo')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/(^-|-$)/g, '')
}

function validateBranchPrefix(value) {
  const clean = slug(value || 'night-agent-ui')
  return clean || 'night-agent-ui'
}

function toAbsPath(inputPath) {
  const resolved = path.resolve(String(inputPath || ''))
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Repository path does not exist: ${resolved}`)
  }
  return resolved
}

function isRunCancelable(run) {
  return run && (run.status === 'queued' || run.status === 'running')
}

function getChildSet(runId) {
  if (!runChildren.has(runId)) runChildren.set(runId, new Set())
  return runChildren.get(runId)
}

function detachChild(runId, child) {
  const children = runChildren.get(runId)
  if (!children) return
  children.delete(child)
}

function trackChild(runId, child) {
  getChildSet(runId).add(child)
}

function terminateRunChildren(run) {
  const children = runChildren.get(run.id)
  if (!children?.size) return
  for (const child of children) {
    try {
      if (child && !child.killed) child.kill('SIGTERM')
    } catch {
      // Best effort.
    }
  }
}

function appendLog(run, message, level = 'info', repo = null) {
  runStore.appendLog(run, message, level, repo)
}

function saveRun(run) {
  runStore.saveRun(run)
}

function assertNotCancelled(run, repoName = null) {
  if (run.cancelRequested) {
    appendLog(run, 'Run cancellation requested. Stopping execution.', 'warn', repoName)
    throw new RunCancelledError()
  }
}

function buildGradleRescueCommand(testCommand) {
  const match = testCommand.match(/^(.*gradlew(?:\.bat)?)(.*)$/i)
  if (!match) return null
  const gradleExec = match[1].trim()
  const originalTasks = (match[2] || '').trim() || 'test'
  const tasks = /\bclean\b/i.test(originalTasks) ? originalTasks : `clean ${originalTasks}`
  return `${gradleExec} --no-daemon --no-build-cache --rerun-tasks -Dkotlin.incremental=false -Dkotlin.incremental.useClasspathSnapshot=false -Pkapt.incremental.apt=false -Pkapt.use.worker.api=false ${tasks}`
}

function buildGradleStateResetCommand(testCommand) {
  const match = testCommand.match(/^(.*gradlew(?:\.bat)?)(.*)$/i)
  if (!match) return null
  const gradleExec = match[1].trim()
  return `${gradleExec} --stop && if exist ".gradle" rmdir /s /q ".gradle" && if exist "build" rmdir /s /q "build"`
}

function isGradleIncrementalTrackingError(output) {
  return /Changes are not tracked, unable determine incremental changes/i.test(output || '')
}

function hasRepoPathConflict(repoPaths) {
  for (const repoPath of repoPaths) {
    if (activeRepoLocks.has(repoPath)) return true
  }
  return false
}

function lockRepos(repoPaths) {
  if (hasRepoPathConflict(repoPaths)) {
    throw new RepoBusyError()
  }
  for (const repoPath of repoPaths) activeRepoLocks.add(repoPath)
}

function releaseRepos(repoPaths) {
  for (const repoPath of repoPaths) activeRepoLocks.delete(repoPath)
}

async function execCommand(command, cwd, run, repoName = null, envOverrides = {}) {
  if (run.cancelRequested) {
    return { code: 130, output: 'Run cancelled before command start.', timedOut: false }
  }
  appendLog(run, `$ ${command}`, 'info', repoName)
  const result = await execShellCommand({
    command,
    cwd,
    timeoutMs: config.commandTimeoutMs,
    env: envOverrides,
    onSpawn: (child) => trackChild(run.id, child),
    onStdoutLine: (line) => appendLog(run, line, 'info', repoName),
    onStderrLine: (line) => appendLog(run, line, 'warn', repoName),
  })
  if (result.timedOut) {
    run.cancelRequested = true
    saveRun(run)
    appendLog(
      run,
      `Command exceeded timeout (${Math.floor(config.commandTimeoutMs / 1000)}s).`,
      'error',
      repoName,
    )
  }
  for (const child of getChildSet(run.id)) {
    if (child.exitCode !== null) detachChild(run.id, child)
  }
  return result
}

async function execGit(repoPath, args, run, repoName = null) {
  appendLog(run, `$ git -C "${repoPath}" ${args.join(' ')}`, 'info', repoName)
  const result = await execProcessCommand({
    file: 'git',
    args: ['-C', repoPath, ...args],
    cwd: repoPath,
    timeoutMs: config.commandTimeoutMs,
    onSpawn: (child) => trackChild(run.id, child),
    onStdoutLine: (line) => appendLog(run, line, 'info', repoName),
    onStderrLine: (line) => appendLog(run, line, 'warn', repoName),
  })
  if (result.timedOut) {
    run.cancelRequested = true
    saveRun(run)
    appendLog(run, 'Git command timed out.', 'error', repoName)
  }
  return result
}

async function hasWorkingChanges(repoPath, run, repoName) {
  const status = await execGit(repoPath, ['status', '--porcelain'], run, repoName)
  if (status.code !== 0) return false
  return Boolean(status.output.trim())
}

async function ensureGitRepo(repo, run) {
  const check = await execGit(repo.path, ['rev-parse', '--is-inside-work-tree'], run, repo.name)
  if (check.code !== 0) {
    throw new Error(`[${repo.name}] Not a git repository: ${repo.path}`)
  }
}

async function createBranch(repo, run, branchPrefix) {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const branchName = `${branchPrefix}/${slug(repo.name)}-${timestamp}`
  const checkout = await execGit(repo.path, ['checkout', '-b', branchName], run, repo.name)
  if (checkout.code !== 0) {
    throw new Error(`[${repo.name}] Failed to create branch ${branchName}`)
  }
  return branchName
}

async function commitAndPush(repo, run, branchName, commitMessage, autoPush) {
  await execGit(repo.path, ['add', '.'], run, repo.name)
  const changed = await hasWorkingChanges(repo.path, run, repo.name)
  if (!changed) {
    appendLog(run, 'No local changes to commit in this repo.', 'info', repo.name)
    return { committed: false, pushed: false }
  }

  const commit = await execGit(repo.path, ['commit', '-m', commitMessage], run, repo.name)
  if (commit.code !== 0) {
    throw new Error(`[${repo.name}] Commit failed.`)
  }

  if (!autoPush) return { committed: true, pushed: false }

  const push = await execGit(repo.path, ['push', '-u', 'origin', branchName], run, repo.name)
  if (push.code !== 0) {
    throw new Error(`[${repo.name}] Push failed.`)
  }
  return { committed: true, pushed: true }
}

async function runTestLoop(repo, run, options) {
  const {
    maxRetries,
    remediationCommand,
    runRemediationOnFailure,
    workspaceRoot,
    swe3RepoName,
    remediationEnv,
  } = options

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    assertNotCancelled(run, repo.name)
    appendLog(
      run,
      `Running tests (attempt ${attempt}/${maxRetries}) with: ${repo.testCommand}`,
      'info',
      repo.name,
    )
    const testResult = await execCommand(repo.testCommand, repo.path, run, repo.name)
    if (testResult.code === 0) {
      appendLog(run, 'Tests passed.', 'success', repo.name)
      return true
    }

    if (isGradleIncrementalTrackingError(testResult.output) && /gradlew/i.test(repo.testCommand)) {
      let lastGradleResult = testResult
      if (!/\bclean\b/i.test(repo.testCommand)) {
        appendLog(
          run,
          'Detected Gradle incremental tracking issue. Retrying with clean build.',
          'warn',
          repo.name,
        )
        const cleanCommand = repo.testCommand.replace(
          /gradlew(?:\.bat)?\s+/i,
          (match) => `${match}clean `,
        )
        const cleanResult = await execCommand(cleanCommand, repo.path, run, repo.name)
        lastGradleResult = cleanResult
        if (cleanResult.code === 0) {
          appendLog(run, 'Clean Gradle test run passed.', 'success', repo.name)
          return true
        }
        appendLog(run, 'Clean Gradle test run failed.', 'warn', repo.name)
      }

      if (isGradleIncrementalTrackingError(lastGradleResult.output)) {
        const rescueCommand = buildGradleRescueCommand(repo.testCommand)
        if (rescueCommand) {
          appendLog(
            run,
            'Retrying Gradle with incremental features disabled for kapt stability.',
            'warn',
            repo.name,
          )
          const rescueResult = await execCommand(rescueCommand, repo.path, run, repo.name)
          if (rescueResult.code === 0) {
            appendLog(run, 'Gradle rescue run passed.', 'success', repo.name)
            return true
          }
          appendLog(run, 'Gradle rescue run failed.', 'warn', repo.name)

          if (isGradleIncrementalTrackingError(rescueResult.output)) {
            const resetCommand = buildGradleStateResetCommand(repo.testCommand)
            if (resetCommand) {
              appendLog(
                run,
                'Resetting Gradle local state (.gradle/build) and retrying rescue command.',
                'warn',
                repo.name,
              )
              const resetResult = await execCommand(resetCommand, repo.path, run, repo.name)
              if (resetResult.code !== 0) {
                appendLog(run, 'Gradle local state reset failed.', 'warn', repo.name)
              }
              const postResetResult = await execCommand(rescueCommand, repo.path, run, repo.name)
              if (postResetResult.code === 0) {
                appendLog(run, 'Gradle post-reset rescue run passed.', 'success', repo.name)
                return true
              }
              appendLog(run, 'Gradle post-reset rescue run failed.', 'warn', repo.name)
            }
          }
        }
      }
    }

    if (/ESLint must be installed/i.test(testResult.output)) {
      appendLog(run, 'Detected missing ESLint. Installing eslint as dev dependency.', 'warn', repo.name)
      const installLintDep = await execCommand(
        'npm install --save-dev eslint',
        repo.path,
        run,
        repo.name,
      )
      if (installLintDep.code === 0) {
        appendLog(run, 'ESLint installed. Retrying tests.', 'success', repo.name)
        continue
      }
      appendLog(run, 'Failed to auto-install ESLint.', 'warn', repo.name)
    }

    appendLog(run, 'Tests failed.', 'warn', repo.name)
    const isSwe3Target = repo.name === swe3RepoName
    if (isSwe3Target) {
      appendLog(
        run,
        'This is swe3 target repo; continuing retries to satisfy swe3 validation.',
        'warn',
        repo.name,
      )
    }

    if (!runRemediationOnFailure || attempt === maxRetries) continue

    appendLog(
      run,
      `Applying remediation command before retry: ${remediationCommand}`,
      'info',
      repo.name,
    )
    const remediation = await execCommand(
      remediationCommand,
      workspaceRoot,
      run,
      repo.name,
      remediationEnv,
    )
    if (remediation.code !== 0) {
      appendLog(run, 'Remediation command failed.', 'warn', repo.name)
    }
  }
  return false
}

function normalizeRepos(payload) {
  const repos = (payload.repos || []).filter((repo) => repo.enabled !== false)
  if (!repos.length) throw new Error('No enabled repositories were provided.')
  return repos.map((repo) => ({
    name: String(repo.name || '').trim(),
    path: toAbsPath(repo.path),
    testCommand: String(repo.testCommand || '').trim(),
    enabled: repo.enabled !== false,
  }))
}

function readAgentConfigRepos() {
  const filePath = path.join(config.workspaceRoot, 'agent-config.json')
  if (!fs.existsSync(filePath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return parsed?.repos && typeof parsed.repos === 'object' ? parsed.repos : {}
  } catch {
    return {}
  }
}

function validateRunPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid run payload.')
  }
  const repos = normalizeRepos(payload)
  const configuredRepos = readAgentConfigRepos()
  for (const repo of repos) {
    if (!repo.name || !repo.testCommand) {
      throw new Error('Each enabled repository must include name, path, and testCommand.')
    }
    const configuredRepo = configuredRepos[repo.name]
    if (configuredRepo && configuredRepo.runTests !== true) {
      throw new Error(
        `Repository "${repo.name}" is not a website delivery target (runTests must be true in agent-config.json).`,
      )
    }
  }
  return repos
}

async function executeRun(run, payload, repos) {
  const branchPrefix = validateBranchPrefix(payload.branchPrefix)
  const maxRetries = Math.max(1, Number(payload.maxRetries || 3))
  const runOrchestratorFirst = Boolean(payload.runOrchestratorFirst)
  const remediationCommand = payload.remediationCommand || 'node orchestrator.js'
  const runRemediationOnFailure = Boolean(payload.runRemediationOnFailure)
  const autoPush = Boolean(payload.autoPush)
  const commitMessageTemplate = payload.commitMessageTemplate || 'chore: automated night-agent run'
  const swe3RepoName = payload.swe3RepoName || 'backend'
  const swe3Repo = repos.find((repo) => repo.name === swe3RepoName) || repos[0]
  const baseRemediationEnv = {
    AGENT_REPO_PATH: swe3Repo?.path || '',
    AGENT_REPO_NAME: swe3Repo?.name || '',
    AGENT_RUN_TESTS: 'false',
  }

  run.status = 'running'
  appendLog(run, `Run started for ${repos.length} repositories.`, 'success')
  saveRun(run)
  assertNotCancelled(run)

  if (runOrchestratorFirst) {
    appendLog(run, `Running pre-build orchestration: ${remediationCommand}`, 'info')
    const pre = await execCommand(
      remediationCommand,
      config.workspaceRoot,
      run,
      null,
      baseRemediationEnv,
    )
    if (pre.code !== 0) {
      throw new Error('Pre-build orchestration command failed.')
    }
  }

  for (const repo of repos) {
    assertNotCancelled(run, repo.name)
    const result = {
      name: repo.name,
      path: repo.path,
      branch: '',
      testsPassed: false,
      committed: false,
      pushed: false,
    }
    run.results.push(result)
    saveRun(run)

    await ensureGitRepo(repo, run)
    appendLog(run, `Processing repository: ${repo.name}`, 'success', repo.name)

    const branchName = await createBranch(repo, run, branchPrefix)
    result.branch = branchName
    saveRun(run)
    appendLog(run, `Created branch ${branchName}`, 'success', repo.name)

    const testsPassed = await runTestLoop(repo, run, {
      maxRetries,
      remediationCommand,
      runRemediationOnFailure,
      workspaceRoot: config.workspaceRoot,
      swe3RepoName,
      remediationEnv: {
        AGENT_REPO_PATH: repo.path,
        AGENT_REPO_NAME: repo.name,
        AGENT_RUN_TESTS: 'false',
      },
    })
    result.testsPassed = testsPassed
    saveRun(run)

    if (!testsPassed) {
      throw new Error(`[${repo.name}] Tests did not pass after ${maxRetries} attempts.`)
    }

    const commitMessage = `${commitMessageTemplate} (${repo.name})`
    const commitPushResult = await commitAndPush(repo, run, branchName, commitMessage, autoPush)
    result.committed = commitPushResult.committed
    result.pushed = commitPushResult.pushed
    saveRun(run)
  }

  run.status = 'completed'
  run.endedAt = nowIso()
  appendLog(run, 'Run completed successfully for all repositories.', 'success')
  saveRun(run)
}

function normalizeRunStateOnBoot() {
  const recentRuns = runStore.listRuns(100)
  for (const runSummary of recentRuns) {
    if (runSummary.status === 'running' || runSummary.status === 'queued') {
      const run = runStore.getRun(runSummary.id)
      if (!run) continue
      run.status = 'failed'
      run.endedAt = nowIso()
      appendLog(run, 'Run marked failed after service restart during execution.', 'error')
      saveRun(run)
    }
  }
}

function startRun(payload, source = 'manual', scheduleId = null) {
  const repos = validateRunPayload(payload)
  const repoPaths = repos.map((repo) => repo.path)
  lockRepos(repoPaths)

  const run = runStore.createRun({ payload, source, scheduleId })
  saveRun(run)

  executeRun(run, payload, repos)
    .catch((error) => {
      run.status = error instanceof RunCancelledError ? 'cancelled' : 'failed'
      run.endedAt = nowIso()
      appendLog(
        run,
        error.message || 'Run failed.',
        error instanceof RunCancelledError ? 'warn' : 'error',
      )
      saveRun(run)
    })
    .finally(() => {
      runChildren.delete(run.id)
      releaseRepos(repoPaths)
    })

  return run
}

function buildDefaultReposFromAgentConfig() {
  const repos = readAgentConfigRepos()
  return Object.entries(repos)
    .filter(([, value]) => value && typeof value === 'object' && value.runTests === true)
    .map(([name, value]) => ({
      id: name,
      name,
      path: value.path || '',
      testCommand: value.testCommand || '',
      enabled: true,
    }))
    .filter((repo) => repo.path && repo.testCommand)
}

function activateSchedule(schedule) {
  if (!schedule.enabled) return
  const intervalMs = Math.max(5, Number(schedule.intervalMinutes) || 60) * 60 * 1000
  if (scheduleTimers.has(schedule.id)) {
    clearInterval(scheduleTimers.get(schedule.id))
  }
  const timer = setInterval(() => {
    const latest = scheduleStore.list().find((item) => item.id === schedule.id)
    if (!latest || !latest.enabled) return

    let run = null
    try {
      run = startRun(latest.payload, 'scheduled', latest.id)
      scheduleStore.updateStatus(latest.id, {
        lastRunAt: nowIso(),
        lastRunId: run.id,
        lastStatus: 'started',
      })
    } catch (err) {
      const status = err instanceof RepoBusyError ? 'skipped_busy' : 'failed_to_start'
      scheduleStore.updateStatus(latest.id, {
        lastRunAt: nowIso(),
        lastStatus: status,
      })
    }
  }, intervalMs)
  scheduleTimers.set(schedule.id, timer)
}

function deactivateSchedule(scheduleId) {
  const timer = scheduleTimers.get(scheduleId)
  if (!timer) return
  clearInterval(timer)
  scheduleTimers.delete(scheduleId)
}

function hydrateSchedulesOnBoot() {
  for (const schedule of scheduleStore.list()) {
    if (schedule.enabled) activateSchedule(schedule)
  }
}

normalizeRunStateOnBoot()
hydrateSchedulesOnBoot()

app.post('/api/runs', (req, res) => {
  try {
    const run = startRun(req.body, 'manual', null)
    res.status(202).json({ runId: run.id })
  } catch (error) {
    if (error instanceof RepoBusyError) {
      res.status(409).json({ error: error.message })
      return
    }
    res.status(400).json({ error: error.message || 'Unable to start run.' })
  }
})

app.get('/api/runs', (req, res) => {
  const limit = Number(req.query.limit) || config.defaultRunListLimit
  res.json({
    items: runStore.listRuns(limit),
  })
})

app.get('/api/runs/:id', (req, res) => {
  const run = runStore.getRun(req.params.id)
  if (!run) {
    res.status(404).json({ error: 'Run not found' })
    return
  }
  res.json(run)
})

app.post('/api/runs/:id/cancel', (req, res) => {
  const run = runStore.getRun(req.params.id)
  if (!run) {
    res.status(404).json({ error: 'Run not found' })
    return
  }
  if (!isRunCancelable(run)) {
    res.status(409).json({ error: `Run is already ${run.status}.` })
    return
  }
  run.cancelRequested = true
  appendLog(run, 'Cancel requested by user.', 'warn')
  saveRun(run)
  terminateRunChildren(run)
  res.json({ ok: true, status: run.status, cancelRequested: true })
})

app.get('/api/config', (req, res) => {
  res.json({
    defaultRepos: buildDefaultReposFromAgentConfig(),
    defaults: {
      mission: 'Run multi-repo delivery until tests pass and push successful branches.',
      branchPrefix: 'night-agent-ui',
      maxRetries: 4,
      runOrchestratorFirst: true,
      remediationCommand: 'node orchestrator.js',
      runRemediationOnFailure: true,
      autoPush: true,
      commitMessageTemplate: 'chore: automated night-agent run',
      swe3RepoName: 'backend',
    },
  })
})

app.get('/api/schedules', (req, res) => {
  res.json({ items: scheduleStore.list() })
})

app.post('/api/schedules', (req, res) => {
  const payload = req.body || {}
  try {
    validateRunPayload(payload.payload)
  } catch (error) {
    res.status(400).json({ error: `Invalid schedule payload: ${error.message}` })
    return
  }

  const schedule = scheduleStore.create({
    name: payload.name || 'Scheduled run',
    intervalMinutes: payload.intervalMinutes || 60,
    payload: payload.payload,
  })
  activateSchedule(schedule)
  res.status(201).json(schedule)
})

app.post('/api/schedules/:id/enabled', (req, res) => {
  const enabled = Boolean(req.body?.enabled)
  const updated = scheduleStore.setEnabled(req.params.id, enabled)
  if (!updated) {
    res.status(404).json({ error: 'Schedule not found' })
    return
  }
  if (enabled) {
    activateSchedule(updated)
  } else {
    deactivateSchedule(updated.id)
  }
  res.json(updated)
})

app.delete('/api/schedules/:id', (req, res) => {
  const deleted = scheduleStore.remove(req.params.id)
  if (!deleted) {
    res.status(404).json({ error: 'Schedule not found' })
    return
  }
  deactivateSchedule(req.params.id)
  res.status(204).end()
})

app.listen(config.port, () => {
  console.log(`Night Agent API running on http://localhost:${config.port}`)
})
