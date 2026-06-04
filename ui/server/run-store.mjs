import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function nowIso() {
  return new Date().toISOString()
}

function safeReadJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return fallbackValue
  }
}

export class RunStore {
  constructor({ stateDir, maxLogsPerRun }) {
    this.stateDir = stateDir
    this.maxLogsPerRun = maxLogsPerRun
    this.runsDir = path.join(stateDir, 'runs')
    this.runIndexPath = path.join(stateDir, 'runs-index.json')
    fs.mkdirSync(this.runsDir, { recursive: true })
    this.runIndex = safeReadJson(this.runIndexPath, { byId: {} })
    if (!this.runIndex || typeof this.runIndex !== 'object' || !this.runIndex.byId) {
      this.runIndex = { byId: {} }
      this.persistRunIndex()
    }
  }

  persistRunIndex() {
    fs.mkdirSync(path.dirname(this.runIndexPath), { recursive: true })
    fs.writeFileSync(this.runIndexPath, JSON.stringify(this.runIndex, null, 2), 'utf-8')
  }

  runPath(runId) {
    return path.join(this.runsDir, `${runId}.json`)
  }

  createRun({ payload, source, scheduleId }) {
    const run = {
      id: crypto.randomUUID(),
      status: 'queued',
      source: source || 'manual',
      scheduleId: scheduleId || null,
      payload,
      startedAt: nowIso(),
      endedAt: null,
      logsDropped: 0,
      logs: [],
      results: [],
      cancelRequested: false,
    }
    this.saveRun(run)
    return run
  }

  appendLog(run, message, level = 'info', repo = null) {
    if (!run || typeof message !== 'string') return
    run.logs.push({
      time: nowIso(),
      level,
      repo,
      message,
    })
    if (run.logs.length > this.maxLogsPerRun) {
      run.logs.shift()
      run.logsDropped += 1
    }
    this.saveRun(run)
  }

  saveRun(run) {
    fs.writeFileSync(this.runPath(run.id), JSON.stringify(run, null, 2), 'utf-8')
    this.runIndex.byId[run.id] = {
      id: run.id,
      status: run.status,
      source: run.source || 'manual',
      scheduleId: run.scheduleId || null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      resultsCount: Array.isArray(run.results) ? run.results.length : 0,
      logsDropped: run.logsDropped || 0,
    }
    this.persistRunIndex()
  }

  getRun(runId) {
    return safeReadJson(this.runPath(runId), null)
  }

  listRuns(limit = 40) {
    const all = Object.values(this.runIndex.byId || {})
    all.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    return all.slice(0, Math.max(1, Number(limit) || 40))
  }
}

export class ScheduleStore {
  constructor({ stateDir }) {
    this.schedulePath = path.join(stateDir, 'schedules.json')
    this.schedules = safeReadJson(this.schedulePath, [])
    if (!Array.isArray(this.schedules)) {
      this.schedules = []
      this.persist()
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.schedulePath), { recursive: true })
    fs.writeFileSync(this.schedulePath, JSON.stringify(this.schedules, null, 2), 'utf-8')
  }

  list() {
    return [...this.schedules]
  }

  create({ name, intervalMinutes, payload }) {
    const now = nowIso()
    const schedule = {
      id: crypto.randomUUID(),
      name: name || 'Scheduled run',
      intervalMinutes: Math.max(5, Number(intervalMinutes) || 60),
      payload,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastRunId: null,
      lastStatus: 'never',
    }
    this.schedules.push(schedule)
    this.persist()
    return schedule
  }

  updateStatus(id, patch) {
    const index = this.schedules.findIndex((item) => item.id === id)
    if (index === -1) return null
    this.schedules[index] = {
      ...this.schedules[index],
      ...patch,
      updatedAt: nowIso(),
    }
    this.persist()
    return this.schedules[index]
  }

  setEnabled(id, enabled) {
    return this.updateStatus(id, { enabled: Boolean(enabled) })
  }

  remove(id) {
    const before = this.schedules.length
    this.schedules = this.schedules.filter((item) => item.id !== id)
    if (this.schedules.length === before) return false
    this.persist()
    return true
  }
}

