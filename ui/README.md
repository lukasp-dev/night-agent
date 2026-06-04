# Night Agent UI + API

This UI controls the Night Agent multi-repo execution service.

## What it provides

- Start/cancel multi-repo runs from the browser
- Durable run state persisted under `.night-agent-state`
- Per-repo lock protection (prevents overlapping runs on the same repo)
- Recent run history API (`GET /api/runs`)
- Schedule API for recurring "all-day" execution
- Default repo targets come from `agent-config.json` entries where `runTests` is `true`

## Run locally

```bash
npm install
npm run start
```

- UI: `http://localhost:5173`
- API: `http://localhost:8787`

## API summary

- `POST /api/runs` start a run
- `GET /api/runs` list recent runs
- `GET /api/runs/:id` get run detail + logs
- `POST /api/runs/:id/cancel` cancel active run
- `GET /api/config` load server-provided default repos/form values
- `GET /api/schedules` list recurring schedules
- `POST /api/schedules` create recurring schedule
- `POST /api/schedules/:id/enabled` enable/disable schedule
- `DELETE /api/schedules/:id` delete schedule

## Environment variables

- `NIGHT_AGENT_PORT` (default `8787`)
- `NIGHT_AGENT_STATE_DIR` (default `.night-agent-state` from repo root)
- `NIGHT_AGENT_COMMAND_TIMEOUT_MS` (default `1800000`)
- `NIGHT_AGENT_MAX_LOGS_PER_RUN` (default `5000`)
- `NIGHT_AGENT_DEFAULT_RUN_LIST_LIMIT` (default `40`)
