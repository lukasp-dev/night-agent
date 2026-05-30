# Night Agent

Night Agent is a local coding-agent harness that plans coding tasks, asks an LLM for file edits, applies validated patches, and optionally runs repository checks.

It supports two modes:

1. **Single-agent mode** via `run-agent.js` (one repo context at a time)
2. **Orchestrator mode** via `orchestrator.js` (multi-role execution: `swe1`, `swe2`, `swe3`)

---

## What this project does

- Reads task instructions (`tasks.txt` or role task files)
- Loads runtime/config context from JSON files
- Calls an Azure OpenAI chat-completions endpoint
- Requests JSON-only patch instructions from the model
- Applies patch operations to candidate or working files
- Persists logs and state for resumable orchestration runs
- Optionally runs preflight and post-run checks (lint/tests)

---

## Repository structure

| Path | Purpose |
|---|---|
| `run-agent.js` | Main single-agent runner: model call, file selection, patch apply, safety checks |
| `orchestrator.js` | Multi-role coordinator that generates/loads tasks and runs role agents |
| `config.json` | Base runtime config for `run-agent.js` |
| `agent-config.json` | Per-repository config map (repo paths, test commands, constraints) |
| `orchestrator-config.json` | Orchestrator runtime settings (plan path, state path, role map, final checks) |
| `orchestrator-tasks.json` | Either fixed tasks or a `ceoTask` prompt for plan generation |
| `tasks.txt` | Default single-agent task input |
| `logs.txt` | Execution logs written by `run-agent.js` |
| `ui/` | React + Vite multi-repo dashboard with Start Building controls and live logs |
| `ui/server.mjs` | Local API runner that creates branches, retries tests, commits, and pushes |
| `scripts/` | Utility scripts (for example backend preflight) |
| `skills/` and `.copilot/skills/` | Skill docs and behavior definitions (smart-commit, type correction, etc.) |
| `run-agent.next.js` / `run-agent.patch.json` | Candidate output artifacts produced by runs |

---

## Prerequisites

1. **Node.js 18+** (Node 20+ recommended)
2. **Azure CLI** logged in (`az login`)
3. Access to the configured Azure OpenAI endpoint/model
4. Git installed (needed for repository checks and commit-aware workflows)

---

## Installation

```bash
npm install
```

> `package.json` is currently minimal. If you add dependencies later, re-run `npm install`.

---

## Quick start (single-agent mode)

1. Edit `tasks.txt` with the task you want.
2. Confirm `config.json` points to the correct repo and files.
3. Run:

```bash
node run-agent.js
```

Outputs are written to:

- `logs.txt`
- `run-agent.next.js` (candidate output when `applyMode` is candidate)
- `run-agent.patch.json` (generated patch instructions)

---

## Quick start (orchestrator mode)

1. Configure repos in `agent-config.json`
2. Configure orchestration in `orchestrator-config.json`
3. Define either:
   - fixed `tasks` in `orchestrator-tasks.json`, or
   - a high-level `ceoTask` that the orchestrator expands into role tasks
4. Run:

```bash
node orchestrator.js
```

Orchestrator artifacts:

- `orchestrator-plan.json` (generated plan when using `ceoTask`)
- `.orchestrator/run-state.json` (resumable state)
- `.orchestrator/task-<role>.txt` (role task files)

---

## Quick start (UI harness form)

Use the React UI + API runner when you want real multi-repo execution with branch creation, retries, and push automation.

```bash
cd ui
npm install
npm run start
```

Open the local URL shown by Vite (typically `http://localhost:5173`).

The UI posts to `http://localhost:8787/api/runs` and streams status/logs by polling run state.

To build/preview the UI:

```bash
cd ui
npm run build
npm run preview
```

### UI form fields

- `Mission`: high-level objective for the run
- `Branch prefix`: prefix used when creating per-repo branches
- `Max retries per repo`: retry limit for failing test commands
- `Swe3 validation repo name`: repo that should receive stricter retry focus
- `Commit message template`: base commit text for auto-commit per repo
- `Remediation command`: command executed from `night-agent` root to apply fixes between retries (for example `node orchestrator.js`)
- `Run remediation command before test loop`: applies remediation once before testing starts
- `Re-run remediation command whenever tests fail`: applies remediation between failed test attempts
- `Push branch when tests pass`: performs `git push -u origin <branch>`
- `Repositories` list:
  - `Enabled`
  - `Name`
  - `Path`
  - `Test command`
  - add/remove repo rows

### Start/Stop Building and logs behavior

When you click **Start Building**, the backend run does this:

1. (Optional) run remediation command first (for orchestration-driven edits)
2. For each enabled repo:
   - verify git repo
   - create a new branch (`<prefix>/<repo>-<timestamp>`)
   - run test command with retry loop
   - if enabled, run remediation command between retries
   - commit changed files with the configured template
   - push branch to origin (if push is enabled)
3. Stream logs and per-repo result status to the UI until complete/failed/cancelled

When you click **Stop Run** during execution, the harness sends a cancellation request, terminates active commands, and marks the run as `cancelled`.

---

## Configuration reference

### `config.json` (single-agent core)

Key fields:

- `endpoint`, `model`: Azure OpenAI chat-completion target
- `repoPath`: working repository path
- `agentConfigPath`, `tasksPath`, `orchestratorConfigPath`: config/task file locations
- `maxFilesToEdit`, `maxPatchChanges`, `maxPatchChars`: patch constraints
- `repoMapMaxFiles`, `repoMapCachePath`, `repoMapCacheTtlMinutes`: repository indexing/cache controls
- `maxFileBytes`: file read safety limit
- `retryAttempts`, `maxIterations`: execution control
- `applyMode`: `candidate` or `working`
- `candidateDir`, `targetFile`, `candidateFile`, `patchFile`
- `git.*`: branch/commit behavior flags

### `agent-config.json` (multi-repo map)

Defines:

- `activeRepo`
- `repos.<name>.path`
- allowed paths and test/preflight commands
- optional runtime context passed through prompts

### `orchestrator-config.json`

Controls:

- task/config file locations
- resume behavior
- role-to-repo mapping
- final check commands per repo

---

## Execution flow

### Single-agent (`run-agent.js`)

1. Load config and active repo settings
2. Load task text and optional instruction/context files
3. Build repo map and select target files
4. Call model for JSON patch instructions
5. Validate and apply patch operations
6. Write candidate/working outputs and logs
7. Run configured checks if enabled

### Orchestrator (`orchestrator.js`)

1. Load orchestrator + agent config
2. Build role tasks (from static tasks or `ceoTask`)
3. Persist plan/state for resume support
4. Run `swe1`, `swe2`, `swe3` sequentially
5. Execute repo-level final checks
6. Mark run state complete or failed

---

## Logs, state, and artifacts

- `logs.txt`: timestamped run-agent logs
- `.agent-cache/`: repo-map cache
- `.agent-candidates/`: candidate outputs when enabled
- `.orchestrator/`: state and role task files for orchestration

If a run stops mid-way, rerunning `node orchestrator.js` resumes from state when `resume` is enabled.

---

## Troubleshooting

### `Model call failed` / auth errors

- Run `az login`
- Confirm subscription/account context
- Verify `endpoint` and `model` in `config.json`
- Ensure token scope matches Cognitive Services resource

### `Agent config not found` / `tasks file not found`

- Check relative paths are correct from repository root
- Prefer Windows-style paths on this environment

### Patch apply errors

- Ensure target files still match expected text (`find` fragments)
- Reduce task scope or lower files/changes in one run

### Final check failures

- Review configured command in `agent-config.json` or `orchestrator-config.json`
- Run the command manually inside target repo to inspect root cause

---

## Current notes

- This repo is designed to operate primarily as a local harness.
- Keep credentials out of committed config files.
- Prefer `candidate` mode when testing new prompts/flows.
