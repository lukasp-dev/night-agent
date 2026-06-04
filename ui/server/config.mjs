import path from 'node:path'

function parseNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function createServerConfig() {
  const workspaceRoot = path.resolve(process.cwd(), '..')
  return {
    port: parseNumber(process.env.NIGHT_AGENT_PORT, 8787),
    workspaceRoot,
    stateDir: path.resolve(
      workspaceRoot,
      process.env.NIGHT_AGENT_STATE_DIR || '.night-agent-state',
    ),
    commandTimeoutMs: parseNumber(process.env.NIGHT_AGENT_COMMAND_TIMEOUT_MS, 30 * 60 * 1000),
    maxLogsPerRun: parseNumber(process.env.NIGHT_AGENT_MAX_LOGS_PER_RUN, 5000),
    defaultRunListLimit: parseNumber(process.env.NIGHT_AGENT_DEFAULT_RUN_LIST_LIMIT, 40),
  }
}

