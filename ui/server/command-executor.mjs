import { spawn } from 'node:child_process'

function scheduleForcedKill(child, delayMs = 3000) {
  setTimeout(() => {
    try {
      if (child && !child.killed) child.kill('SIGKILL')
    } catch {
      // Best effort.
    }
  }, delayMs)
}

export function execShellCommand({
  command,
  cwd,
  timeoutMs,
  env = {},
  onStdoutLine,
  onStderrLine,
  onSpawn,
}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...env },
    })
    if (onSpawn) onSpawn(child)

    let output = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        // Best effort.
      }
      scheduleForcedKill(child)
    }, timeoutMs)

    child.stdout.on('data', (data) => {
      const text = data.toString()
      output += text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && onStdoutLine) onStdoutLine(line)
      }
    })

    child.stderr.on('data', (data) => {
      const text = data.toString()
      output += text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && onStderrLine) onStderrLine(line)
      }
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: code ?? 1,
        output,
        timedOut,
      })
    })
  })
}

export function execProcessCommand({
  file,
  args,
  cwd,
  timeoutMs,
  env = {},
  onStdoutLine,
  onStderrLine,
  onSpawn,
}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
    })
    if (onSpawn) onSpawn(child)

    let output = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        // Best effort.
      }
      scheduleForcedKill(child)
    }, timeoutMs)

    child.stdout.on('data', (data) => {
      const text = data.toString()
      output += text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && onStdoutLine) onStdoutLine(line)
      }
    })

    child.stderr.on('data', (data) => {
      const text = data.toString()
      output += text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && onStderrLine) onStderrLine(line)
      }
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: code ?? 1,
        output,
        timedOut,
      })
    })
  })
}

