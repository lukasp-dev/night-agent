import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import express from 'express'
import path from 'node:path'

const app = express()
app.use(express.json())

const PORT = 8787
const runs = new Map()
const runChildren = new Map()
const WORKSPACE_ROOT = path.resolve(process.cwd(), '..')

class RunCancelledError extends Error {
  constructor(message = 'Run cancelled by user.') {
    super(message)
    this.name = 'RunCancelledError'
  }
}

function nowIso() {
  return new Date().toISOString()
}

function slug(value) {
  return String(value || 'repo')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function appendLog(run, message, level = 'info', repo = null) {
  run.logs.push({
    time: nowIso(),
    level,
    repo,
    message,
  })
}

function getChildSet(runId) {
  if (!runChildren.has(runId)) {
    runChildren.set(runId, new Set())
  }
  return runChildren.get(runId)
}

function isRunCancelable(run) {
  return run.status === 'queued' || run.status === 'running'
}

function assertNotCancelled(run, repoName = null) {
  if (run.cancelRequested) {
    appendLog(run, 'Run cancellation requested. Stopping execution.', 'warn', repoName)
    throw new RunCancelledError()
  }
}

function terminateRunChildren(run) {
  const children = runChildren.get(run.id)
  if (!children?.size) return
  for (const child of children) {
    try {
      if (child && !child.killed) child.kill('SIGTERM')
    } catch {
      // Ignore kill race if process already exited.
    }
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

function execCommand(command, cwd, run, repoName = null, envOverrides = {}) {
  return new Promise((resolve) => {
    if (run.cancelRequested) {
      resolve({ code: 130, output: 'Run cancelled before command start.' })
      return
    }
    appendLog(run, `$ ${command}`, 'info', repoName)
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...envOverrides },
    })
    getChildSet(run.id).add(child)

    let output = ''
    child.stdout.on('data', (data) => {
      const text = data.toString()
      output += text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) appendLog(run, line, 'info', repoName)
      }
    })
    child.stderr.on('data', (data) => {
      const text = data.toString()
      output += text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) appendLog(run, line, 'warn', repoName)
      }
    })
    child.on('close', (code) => {
      getChildSet(run.id).delete(child)
      resolve({ code: code ?? 1, output })
    })
  })
}

async function execGit(repoPath, args, run, repoName = null) {
  const command = `git -C "${repoPath}" ${args.join(' ')}`
  return execCommand(command, repoPath, run, repoName)
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

  const commit = await execGit(
    repo.path,
    ['commit', '-m', `"${commitMessage}"`],
    run,
    repo.name,
  )
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

async function executeRun(run, payload) {
  const repos = (payload.repos || []).filter((repo) => repo.enabled !== false)
  if (!repos.length) {
    throw new Error('No enabled repositories were provided.')
  }

  const branchPrefix = payload.branchPrefix || 'night-agent-ui'
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
  assertNotCancelled(run)

  if (runOrchestratorFirst) {
    appendLog(run, `Running pre-build orchestration: ${remediationCommand}`, 'info')
    const pre = await execCommand(remediationCommand, WORKSPACE_ROOT, run, null, baseRemediationEnv)
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

    await ensureGitRepo(repo, run)
    appendLog(run, `Processing repository: ${repo.name}`, 'success', repo.name)

    const branchName = await createBranch(repo, run, branchPrefix)
    result.branch = branchName
    appendLog(run, `Created branch ${branchName}`, 'success', repo.name)

    const testsPassed = await runTestLoop(repo, run, {
      maxRetries,
      remediationCommand,
      runRemediationOnFailure,
      workspaceRoot: WORKSPACE_ROOT,
      swe3RepoName,
      remediationEnv: {
        AGENT_REPO_PATH: repo.path,
        AGENT_REPO_NAME: repo.name,
        AGENT_RUN_TESTS: 'false',
      },
    })
    result.testsPassed = testsPassed

    if (!testsPassed) {
      throw new Error(`[${repo.name}] Tests did not pass after ${maxRetries} attempts.`)
    }

    const commitMessage = `${commitMessageTemplate} (${repo.name})`
    const commitPushResult = await commitAndPush(repo, run, branchName, commitMessage, autoPush)
    result.committed = commitPushResult.committed
    result.pushed = commitPushResult.pushed
  }

  run.status = 'completed'
  run.endedAt = nowIso()
  appendLog(run, 'Run completed successfully for all repositories.', 'success')
}

app.post('/api/runs', async (req, res) => {
  const runId = crypto.randomUUID()
  const run = {
    id: runId,
    status: 'queued',
    startedAt: nowIso(),
    endedAt: null,
    logs: [],
    results: [],
    cancelRequested: false,
  }
  runs.set(runId, run)
  res.status(202).json({ runId })

  executeRun(run, req.body)
    .catch((error) => {
      run.status = error instanceof RunCancelledError ? 'cancelled' : 'failed'
      run.endedAt = nowIso()
      appendLog(run, error.message || 'Run failed.', error instanceof RunCancelledError ? 'warn' : 'error')
    })
    .finally(() => {
      runChildren.delete(run.id)
    })
})

app.get('/api/runs/:id', (req, res) => {
  const run = runs.get(req.params.id)
  if (!run) {
    res.status(404).json({ error: 'Run not found' })
    return
  }
  res.json(run)
})

app.post('/api/runs/:id/cancel', (req, res) => {
  const run = runs.get(req.params.id)
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
  terminateRunChildren(run)
  res.json({ ok: true, status: run.status, cancelRequested: true })
})

app.listen(PORT, () => {
  console.log(`Night Agent API running on http://localhost:${PORT}`)
})
