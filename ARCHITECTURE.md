# Architecture Notes

## Control plane

The orchestrator is deterministic application code. It owns:

- mission lifecycle
- policy routing
- approval gates
- worker dispatch eligibility
- health inspection
- audit trail

This avoids the central failure mode of prompt-driven orchestration: implicit state that only exists inside a model conversation.

## Worker model

Workers are not peers negotiating with each other. They receive:

- a mission id
- a stage id
- bounded scope
- worktree path
- runtime container image
- success criteria

That is the seam where a future Claude Code, Codex, or other coding-agent runner can be attached without rewriting the control plane.

## State model

There are three explicit contracts:

1. `project manifest`
2. `mission record`
3. `mission event log`

Together they make behavior inspectable and replayable.

## Routing model

The policy engine computes:

- risk level
- required specialist stages
- whether merge approval is still required
- the reasons behind those decisions

Routing is therefore inspectable rather than magical.

## Parallelism model

Parallelism is created only in implementation lanes. The planner infers workstreams from affected path groups. Integration is a separate explicit stage that depends on all implementation lanes.

That keeps concurrency useful without turning the whole system into an unconstrained mesh of agents.

## Deployment stance

This scaffold runs as a containerized HTTP service. Persistence now supports either the original file-backed mode or a Postgres-backed store behind the same state-store contract. The domain model did not need to change to make that swap.

## Execution stance

The service now includes an in-process queue and worker launcher. Ready stages are turned into explicit mission packets, attached to workspace leases, and executed through stage adapters that write evidence bundles on disk.

The adapter layer is intentionally the seam for integrating a real coding agent. The control plane should not need to change when that swap happens. The current implementation already supports a manifest-driven external command runner; replacing the example runner with a real Codex or Claude adapter is now a configuration and command-contract task, not a control-plane rewrite.

## Slack stance

Slack is treated as a policy-governed control surface, not just a webhook source. Incoming actions can be verified by signing secret, then enriched with workspace identity and channel metadata through the bot token before project policy is enforced.

Outbound Slack is also event-driven: the control plane emits explicit mission events, and a notifier can mirror selected events into configured channels without entangling route handlers with notification policy.

The live deployment path now prefers Socket Mode. A thin bridge terminates the Slack WebSocket connection, signs an internal form payload, and forwards it into the same Fastify handlers used by the HTTP Slack endpoints. That keeps Slack behavior single-sourced even though the transport differs.
