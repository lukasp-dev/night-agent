# Skill: backend-review-prior-start

Apply this checklist before starting backend implementation.

1. Read `AGENT_BACKEND_CONTEXT.md` fully.
2. Confirm datasource profile behavior in:
   - `src/main/resources/application.yml`
   - `src/main/resources/application-local.yml`
   - `docker-compose.yml`
3. If task touches persistence, inspect affected:
   - entity files under `model`
   - repository interfaces under `repository`
   - service/controller callers
4. Preserve API contract compatibility unless task explicitly allows breaking changes.
5. Do not hardcode credentials or new secrets.
6. Prefer config/profile-safe changes and add/update tests for persistence changes.
