# Codex Factory

`codex-factory` is a standalone control-plane scaffold for a solo developer software factory. It treats orchestration as code, workers as bounded executors, and mission state as an explicit persisted contract.

## What is implemented

- Fastify service with JSON APIs and a lightweight dashboard
- File-backed or Postgres-backed mission and event store with explicit state transitions
- Project manifests as the stable per-repo contract
- Policy engine for risk-based routing
- Planner that compiles workstreams into an execution graph
- Worker envelope generation for isolated worktrees and containers
- Background queue and launcher that execute ready stages
- Artifact and evidence bundles persisted per mission stage
- External agent-runner adapter with manifest-driven command execution
- Optional GitHub pull request publishing after successful runs
- Automatic and manual retry paths for bounded stage recovery
- Slack slash-command intake endpoint
- Slack Socket Mode bridge that forwards slash commands and interactive actions into the same control-plane routes
- Health patrol for stale or silent worker detection

## Why it is shaped this way

The scaffold is opinionated around the constraints you gave:

- Slack is the primary interaction surface
- Deployment is a first-class target, not an afterthought
- True parallelism is essential, so work is decomposed into isolated lanes
- Hidden state is avoided by persisting mission state and events explicitly
- LLM agents are workers, not the orchestrator

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

`loadConfig()` bootstraps local `.env` values into `process.env` for app startup, but deployed environments should still inject real environment variables directly.

Open:

- `http://localhost:4000/dashboard`
- `http://localhost:4000/api/manifests`
- `http://localhost:4000/health`

## External runner contract

Each project manifest can optionally declare an `agentRunner`. When enabled for a stage kind, the service:

- writes `mission-packet.json` and `stage-prompt.md` into the stage artifact directory
- launches the configured command inside the leased workspace
- passes stable `FACTORY_*` env vars pointing at the workspace and artifacts
- records stdout, stderr, evidence, and final stage status

The repo includes `scripts/example-agent-runner.mjs` as a reference implementation of that contract. The sample manifest keeps it disabled by default and points at the script through the `{serviceRoot}` placeholder so the adapter path stays stable regardless of the target project workspace.

## Slack operations

If `SLACK_SOCKET_MODE=true` and `SLACK_APP_TOKEN` is set, the service connects to Slack over Socket Mode and forwards slash commands plus interactive actions into the existing HTTP handlers.
If `SLACK_SIGNING_SECRET` is set, the service verifies Slack signatures for HTTP slash commands and interactive actions.
If `SLACK_BOT_TOKEN` is set, the service resolves incoming Slack users and channels against workspace metadata before enforcing manifest policy.
If `slack.notifications.channelIds` or `slack.notifications.channelNames` is configured in a project manifest, significant mission events are also posted outbound with `chat.postMessage`.

Supported slash command forms:

- `<projectId> <request>`
- `status <missionId>`
- `approve <missionId>`
- `retry <missionId> <stageId>`
- `escalate <missionId> <stageId> <summary...>`

Interactive mission cards support:

- plan approval
- refresh
- retry failed stage
- escalate failed stage

## Example mission creation

```bash
curl -X POST http://localhost:4000/api/missions \
  -H 'content-type: application/json' \
  -d '{
    "projectId": "codex-factory",
    "title": "Harden the deploy workflow",
    "request": "Tighten the deploy workflow permissions and document the rollout path",
    "changedPaths": [".github/workflows/deploy.yml", "README.md", "deploy/server-deploy.sh"],
    "autonomyMode": "managed",
    "actor": "amit"
  }'
```

Approve the plan:

```bash
curl -X POST http://localhost:4000/api/missions/<mission-id>/approve-plan \
  -H 'content-type: application/json' \
  -d '{"actor":"amit"}'
```

Dispatch ready workers:

```bash
curl -X POST http://localhost:4000/api/missions/<mission-id>/dispatch
```

Inspect execution state:

```bash
curl http://localhost:4000/api/missions/<mission-id>
curl http://localhost:4000/api/missions/<mission-id>/stage-runs
```

Retry a failed stage:

```bash
curl -X POST http://localhost:4000/api/missions/<mission-id>/stages/<stage-id>/retry \
  -H 'content-type: application/json' \
  -d '{"actor":"amit"}'
```

Escalate a stage for human intervention:

```bash
curl -X POST http://localhost:4000/api/missions/<mission-id>/stages/<stage-id>/escalate \
  -H 'content-type: application/json' \
  -d '{"actor":"amit","summary":"Needs product decision before continuing."}'
```

## Slack intake format

If you are using HTTP delivery, point a slash command to `POST /slack/commands/intake` and send:

```text
codex-factory Harden the deploy workflow permissions and document the rollout path
```

Supported commands:

```text
codex-factory Harden the deploy workflow permissions and document the rollout path
status mission_123
approve mission_123
retry mission_123 implement_lane_1
escalate mission_123 qa Needs a product call before continuing
```

Per-project Slack policy now lives in the manifest:

- `slack.allowedChannelIds`: optional allow-list for channel ids
- `slack.allowedChannels`: optional allow-list for channel names
- `slack.operatorUsers`: who can create missions, retry work, and escalate stages; can match ids, usernames, display names, or emails when bot-token resolution is enabled
- `slack.approverUsers`: who can approve plans; falls back to `operatorUsers` when empty
- `slack.responseType`: whether replies stay ephemeral or post in-channel
- `slack.notifications.channelIds`: optional outbound notification targets for mission events
- `slack.notifications.channelNames`: optional outbound notification channel names; resolved through the Slack bot token when available
- `slack.notifications.events`: which mission events should generate outbound Slack posts

The endpoint creates a managed mission for the named project, returns a terse Slack-friendly summary, and the queue can begin execution as soon as approval gates are satisfied.

## Production deploy

The repo includes a production compose file and server scripts under `deploy/`:

- `deploy/docker-compose.prod.yml`: app + Postgres on the shared Docker host, attached to the `proxy` network
- `deploy/server-deploy.sh`: idempotent git sync and compose rollout on the EC2 box
- `deploy/configure-caddy.sh`: adds `codexfactory.gulatilabs.me` to the host Caddyfile and reloads Caddy
- `.github/workflows/deploy.yml`: deploy on `main` via AWS SSM

The production manifest is `manifests/codex-factory.json`. It assumes:

- the managed repo is mounted at `/workspace/repo`
- runtime artifacts live under `/workspace/runtime`
- Slack operator and approver identity is matched by `gulati8@gmail.com`
- the OpenAI-backed shell runner is enabled for architectural, implementation, review, docs, and security stages

## Persistence modes

Set `STATE_BACKEND=file` to keep the original JSON state file.

Set `STATE_BACKEND=postgres` and provide `POSTGRES_URL` to persist missions, events, and stage runs in Postgres. The service auto-creates its tables on startup.

`docker compose up --build` now brings up both the factory and a local Postgres instance using the defaults from `.env.example`.

## Next build steps

1. Add conflict-aware integration lanes and richer failure policy beyond per-stage retries.
2. Wire Slack identity mapping to your actual workspace policy source if you want group-based authorization beyond explicit manifest lists.
3. Introduce learner-generated prompt and policy patches gated by explicit approval.
