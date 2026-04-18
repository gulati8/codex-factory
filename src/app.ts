import querystring from "node:querystring";

import Fastify from "fastify";

import { loadConfig } from "./config.js";
import { slackCommandSchema, type CreateMissionInput } from "./domain/types.js";
import { buildStateStore } from "./store/build-state-store.js";
import { ManifestStore } from "./store/manifest-store.js";
import {
  actorFromSlack,
  ensureSlackAuthorized,
  ensureSlackChannelAllowed,
  formatMissionSlackMessage,
  formatProjectSlackMessage,
  formatSlackHelpMessage,
  parseSlackActionPayload,
  parseSlackActionValue,
  slackIdentityFromCommand,
  type SlackUrlEncodedBody,
  verifySlackRequest,
} from "./adapters/slack.js";
import { HealthPatrol } from "./services/health-patrol.js";
import { ArtifactStore } from "./services/artifact-store.js";
import { GitHubDeliveryService } from "./services/github-delivery-service.js";
import { MissionQueue } from "./services/mission-queue.js";
import { MissionService } from "./services/mission-service.js";
import { Planner } from "./services/planner.js";
import { PolicyEngine } from "./services/policy-engine.js";
import { ProjectOnboardingService } from "./services/project-onboarding-service.js";
import { SlackIdentityService } from "./services/slack-identity-service.js";
import { SlackNotifier } from "./services/slack-notifier.js";
import { WorkerLauncher } from "./services/worker-launcher.js";
import { WorkerRuntime } from "./services/worker-runtime.js";

function renderDashboard(missions: ReturnType<MissionService["listMissions"]>): string {
  const cards = missions
    .map((mission) => {
      const stages = mission.stages
        .map((stage) => `<li><strong>${stage.label}</strong> <span>${stage.status}</span></li>`)
        .join("");

      return `
        <article class="card">
          <header>
            <h2>${mission.title}</h2>
            <p>${mission.projectId} · ${mission.status} · ${mission.riskLevel}</p>
          </header>
          <p>${mission.request}</p>
          <section>
            <h3>Plan</h3>
            <p>${mission.plan.summary}</p>
          </section>
          <section>
            <h3>Stages</h3>
            <ul>${stages}</ul>
          </section>
        </article>
      `;
    })
    .join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Codex Factory Dashboard</title>
      <style>
        :root {
          color-scheme: light;
          --bg: #f3efe6;
          --surface: #fffaf2;
          --ink: #1f2430;
          --accent: #a84b2a;
          --line: #d9cfbf;
        }
        body {
          margin: 0;
          font-family: "Iowan Old Style", "Palatino Linotype", serif;
          background: radial-gradient(circle at top, #fff8e9 0, var(--bg) 48%, #e9dfcf 100%);
          color: var(--ink);
        }
        main {
          max-width: 1100px;
          margin: 0 auto;
          padding: 40px 20px 60px;
        }
        h1 {
          font-size: 3rem;
          margin-bottom: 0.25rem;
        }
        .grid {
          display: grid;
          gap: 16px;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        }
        .card {
          background: color-mix(in srgb, var(--surface) 92%, white 8%);
          border: 1px solid var(--line);
          border-radius: 18px;
          padding: 18px;
          box-shadow: 0 10px 30px rgba(86, 63, 40, 0.08);
        }
        h2, h3 {
          margin: 0 0 8px;
        }
        ul {
          padding-left: 20px;
        }
        strong {
          color: var(--accent);
        }
      </style>
    </head>
    <body>
      <main>
        <h1>Codex Factory</h1>
        <p>Explicit mission state, bounded workers, and policy-routed quality gates.</p>
        <section class="grid">
          ${cards || "<p>No missions yet.</p>"}
        </section>
      </main>
    </body>
  </html>`;
}

function actorCandidatesFromIdentity(identity: {
  id?: string;
  username?: string;
  name?: string;
  displayName?: string;
  realName?: string;
  email?: string;
}): string[] {
  return [identity.id, identity.username, identity.name, identity.displayName, identity.realName, identity.email]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim());
}

export async function buildApp() {
  const config = loadConfig();
  const store = buildStateStore(config);
  const manifestStore = new ManifestStore(config.MANIFESTS_DIR, {
    postgresUrl: config.STATE_BACKEND === "postgres" ? config.POSTGRES_URL : undefined,
  });
  await store.init();
  await manifestStore.init();
  const app = Fastify({ logger: true });
  const healthPatrol = new HealthPatrol(config);
  const slackIdentityService = new SlackIdentityService(config);
  const slackNotifier = new SlackNotifier(config, slackIdentityService);
  const projectOnboarding = new ProjectOnboardingService({
    config,
    manifestStore,
  });

  let deliveryService: GitHubDeliveryService | null = null;
  const missionService = new MissionService({
    store,
    policyEngine: new PolicyEngine(),
    planner: new Planner(),
    workerRuntime: new WorkerRuntime(config),
    onMissionEvent: async ({ mission, event }) => {
      try {
        const manifest = manifestStore.get(mission.projectId);
        await slackNotifier.notify({
          mission,
          event,
          manifest,
          health: healthPatrol.inspect(mission),
        });
      } catch (error) {
        app.log.error({ err: error, missionId: mission.id, eventType: event.type }, "Slack notification failed");
      }

      if (deliveryService && event.type === "stage.completed" && mission.status === "completed") {
        try {
          const manifest = manifestStore.get(mission.projectId);
          await deliveryService.deliverMission(mission, manifest);
        } catch (error) {
          app.log.error({ err: error, missionId: mission.id }, "GitHub delivery failed");
        }
      }
    },
  });
  deliveryService = new GitHubDeliveryService(config, missionService);
  const workerRuntime = new WorkerRuntime(config);
  const artifactStore = new ArtifactStore(config);
  const queue = new MissionQueue({
    config,
    missionService,
    manifestStore,
    launcher: new WorkerLauncher({
      config,
      missionService,
      store,
      workerRuntime,
    }),
  });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, async (_request: unknown, body: string) => {
    const rawBody = body;
    const parsed = querystring.parse(rawBody);

    return {
      __rawBody: rawBody,
      ...Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, Array.isArray(value) ? (value[0] ?? "") : (value ?? "").toString()]),
      ),
    };
  });
  queue.start();
  await deliveryService.reconcileCompletedMissions(manifestStore.list());
  app.addHook("onClose", async () => {
    await queue.stop();
    await manifestStore.close();
    await store.close();
  });

  app.get("/health", async () => ({
    ok: true,
    manifests: manifestStore.list().length,
    missions: missionService.listMissions().length,
  }));

  app.get("/", async (_, reply) => {
    reply.redirect("/dashboard");
  });

  app.get("/dashboard", async (_, reply) => {
    reply.type("text/html").send(renderDashboard(missionService.listMissions()));
  });

  app.get("/api/manifests", async () => ({
    manifests: manifestStore.list(),
  }));

  app.get("/api/projects", async () => ({
    projects: manifestStore.listRecords(),
  }));

  app.get("/api/projects/:projectId", async (request, reply) => {
    try {
      return {
        project: manifestStore.getRecord((request.params as { projectId: string }).projectId),
      };
    } catch (error) {
      reply.status(404).send({
        error: error instanceof Error ? error.message : "Project not found",
      });
    }
  });

  app.post("/api/projects/connect", async (request, reply) => {
    try {
      const body = request.body as {
        repoUrl: string;
        actor: string;
        actorCandidates?: string[];
        channelId?: string;
        channelName?: string;
      };
      const project = await projectOnboarding.connect({
        repoUrl: body.repoUrl,
        actor: body.actor,
        actorCandidates: body.actorCandidates ?? [body.actor],
        channelId: body.channelId,
        channelName: body.channelName,
      });
      reply.status(201).send({ project });
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : "Unable to connect project",
      });
    }
  });

  app.post("/api/projects/:projectId/approve", async (request, reply) => {
    try {
      const project = await projectOnboarding.approve((request.params as { projectId: string }).projectId);
      reply.send({ project });
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : "Unable to approve project",
      });
    }
  });

  app.get("/api/missions", async () => ({
    missions: missionService.listMissions(),
  }));

  app.get("/api/missions/:missionId", async (request) => {
    const mission = missionService.getMission((request.params as { missionId: string }).missionId);
    if (!mission) {
      return {
        error: "Mission not found",
      };
    }

    return {
      mission,
      events: missionService.listEvents(mission.id),
      stageRuns: missionService.listStageRuns(mission.id),
      health: healthPatrol.inspect(mission),
    };
  });

  app.post("/api/missions", async (request, reply) => {
    try {
      const input = request.body as CreateMissionInput;
      const manifest = manifestStore.get(input.projectId);
      const mission = await missionService.createMission(input, manifest);
      await queue.trigger();
      reply.status(201).send({ mission });
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : "Unable to create mission",
      });
    }
  });

  app.post("/api/missions/:missionId/approve-plan", async (request, reply) => {
    try {
      const { missionId } = request.params as { missionId: string };
      const actor = (request.body as { actor?: string } | undefined)?.actor ?? "user";
      const mission = await missionService.approvePlan(missionId, actor);
      await queue.trigger();
      reply.send({ mission });
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : "Unable to approve plan",
      });
    }
  });

  app.post("/api/missions/:missionId/dispatch", async (request, reply) => {
    try {
      const { missionId } = request.params as { missionId: string };
      const mission = missionService.getMission(missionId);
      if (!mission) {
        throw new Error("Mission not found");
      }
      const manifest = manifestStore.get(mission.projectId);
      const payload = await missionService.dispatch(missionId, manifest);
      await queue.trigger();
      reply.send(payload);
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : "Unable to dispatch mission",
      });
    }
  });

  app.post("/api/missions/:missionId/stages/:stageId/heartbeat", async (request, reply) => {
    try {
      const { missionId, stageId } = request.params as { missionId: string; stageId: string };
      const body = (request.body as { actor?: string; summary?: string } | undefined) ?? {};
      const mission = await missionService.recordHeartbeat(
        missionId,
        stageId,
        body.actor ?? "worker",
        body.summary ?? "Worker heartbeat received.",
      );
      reply.send({ mission });
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : "Unable to record heartbeat",
      });
    }
  });

  app.post("/api/missions/:missionId/stages/:stageId/complete", async (request, reply) => {
    try {
      const { missionId, stageId } = request.params as { missionId: string; stageId: string };
      const body = (request.body as { actor?: string; summary?: string; failed?: boolean } | undefined) ?? {};
      const mission = await missionService.completeStage(
        missionId,
        stageId,
        body.actor ?? "worker",
        body.summary ?? "Stage finished.",
        body.failed ?? false,
      );
      await queue.trigger();
      reply.send({ mission });
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : "Unable to complete stage",
      });
    }
  });

  app.post("/api/missions/:missionId/stages/:stageId/retry", async (request, reply) => {
    try {
      const { missionId, stageId } = request.params as { missionId: string; stageId: string };
      const body = (request.body as { actor?: string } | undefined) ?? {};
      const mission = missionService.getMission(missionId);
      if (!mission) {
        throw new Error("Mission not found");
      }

      const stage = mission.stages.find((candidate) => candidate.id === stageId);
      if (!stage) {
        throw new Error("Stage not found");
      }

      if (stage.status !== "failed") {
        throw new Error("Only failed stages can be retried manually.");
      }

      const updated = await missionService.scheduleRetry(
        missionId,
        stageId,
        body.actor ?? "user",
        `Manual retry scheduled for ${stage.label}.`,
      );
      await queue.trigger();
      reply.send({ mission: updated });
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : "Unable to retry stage",
      });
    }
  });

  app.post("/api/missions/:missionId/stages/:stageId/escalate", async (request, reply) => {
    try {
      const { missionId, stageId } = request.params as { missionId: string; stageId: string };
      const body = (request.body as { actor?: string; summary?: string } | undefined) ?? {};
      const mission = missionService.getMission(missionId);
      if (!mission) {
        throw new Error("Mission not found");
      }

      const stage = mission.stages.find((candidate) => candidate.id === stageId);
      if (!stage) {
        throw new Error("Stage not found");
      }

      const summary = body.summary ?? `Escalated ${stage.label} for human review.`;
      const updated = await missionService.escalateStage(
        missionId,
        stageId,
        body.actor ?? "user",
        summary,
      );

      const escalationPath = await artifactStore.writeEscalation(missionId, stageId, {
        missionId,
        stageId,
        actor: body.actor ?? "user",
        summary,
        escalatedAt: new Date().toISOString(),
      });

      reply.send({
        mission: updated,
        escalationPath,
      });
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : "Unable to escalate stage",
      });
    }
  });

  app.get("/api/missions/:missionId/health", async (request, reply) => {
    const mission = missionService.getMission((request.params as { missionId: string }).missionId);
    if (!mission) {
      reply.status(404).send({ error: "Mission not found" });
      return;
    }

    reply.send({
      incidents: healthPatrol.inspect(mission),
    });
  });

  app.get("/api/missions/:missionId/stage-runs", async (request, reply) => {
    const mission = missionService.getMission((request.params as { missionId: string }).missionId);
    if (!mission) {
      reply.status(404).send({ error: "Mission not found" });
      return;
    }

    reply.send({
      stageRuns: missionService.listStageRuns(mission.id),
    });
  });

  app.get("/api/missions/:missionId/stages/:stageId/artifact-path", async (request, reply) => {
    const { missionId, stageId } = request.params as { missionId: string; stageId: string };
    reply.send({
      artifactDir: artifactStore.artifactDirForStage(missionId, stageId),
    });
  });

  app.post("/slack/commands/intake", async (request, reply) => {
    try {
      const body = request.body as SlackUrlEncodedBody;
      if (
        !verifySlackRequest({
          rawBody: body.__rawBody ?? "",
          timestamp: request.headers["x-slack-request-timestamp"]?.toString(),
          signature: request.headers["x-slack-signature"]?.toString(),
          config,
        })
      ) {
        reply.status(401).send({ error: "Invalid Slack signature." });
        return;
      }

      const payload = slackCommandSchema.parse(body);
      const identity = await slackIdentityService.resolveUser(slackIdentityFromCommand(payload));
      const actorCandidates = actorCandidatesFromIdentity(identity);
      const channel = await slackIdentityService.resolveChannel(payload.channel_id);
      const [command, ...requestParts] = payload.text.trim().split(/\s+/);
      if (!command) {
        reply.type("application/json").send(formatSlackHelpMessage());
        return;
      }

      if (command === "connect") {
        const repoUrl = requestParts.join(" ").trim();
        if (!repoUrl) {
          reply.type("application/json").send(formatSlackHelpMessage());
          return;
        }

        const project = await projectOnboarding.connect({
          repoUrl,
          actor: actorFromSlack({ user: identity }),
          actorCandidates,
          channelId: channel.id,
          channelName: channel.name,
        });
        reply.type("application/json").send(
          formatProjectSlackMessage({
            project,
            responseType: project.manifest.slack.responseType,
          }),
        );
        return;
      }

      if (command === "status") {
        const missionId = requestParts[0];
        if (!missionId) {
          reply.type("application/json").send(formatSlackHelpMessage());
          return;
        }

        const mission = missionService.getMission(missionId);
        if (!mission) {
          reply.type("application/json").send({
            response_type: "ephemeral",
            text: `Mission ${missionId} not found.`,
          });
          return;
        }
        const manifest = manifestStore.get(mission.projectId);
        ensureSlackChannelAllowed({ channel, manifest });

        reply.type("application/json").send(
          formatMissionSlackMessage({
            mission,
            stageRuns: missionService.listStageRuns(mission.id),
            health: healthPatrol.inspect(mission),
            responseType: manifest.slack.responseType,
          }),
        );
        return;
      }

      if (command === "approve") {
        const missionId = requestParts[0];
        if (!missionId) {
          reply.type("application/json").send(formatSlackHelpMessage());
          return;
        }

        const mission = missionService.getMission(missionId);
        if (!mission) {
          throw new Error(`Mission ${missionId} not found.`);
        }
        const manifest = manifestStore.get(mission.projectId);
        ensureSlackChannelAllowed({ channel, manifest });
        ensureSlackAuthorized({ identity, manifest, capability: "approve" });
        const updated = await missionService.approvePlan(missionId, actorFromSlack({ user: identity }));
        await queue.trigger();
        reply.type("application/json").send(
          formatMissionSlackMessage({
            mission: updated,
            stageRuns: missionService.listStageRuns(updated.id),
            health: healthPatrol.inspect(updated),
            responseType: manifest.slack.responseType,
          }),
        );
        return;
      }

      if (command === "approve-project") {
        const projectId = requestParts[0];
        if (!projectId) {
          reply.type("application/json").send(formatSlackHelpMessage());
          return;
        }

        const project = manifestStore.getRecord(projectId);
        ensureSlackAuthorized({ identity, manifest: project.manifest, capability: "approve" });
        const updatedProject = await projectOnboarding.approve(projectId);
        reply.type("application/json").send(
          formatProjectSlackMessage({
            project: updatedProject,
            responseType: updatedProject.manifest.slack.responseType,
          }),
        );
        return;
      }

      if (command === "retry") {
        const [missionId, stageId] = requestParts;
        if (!missionId || !stageId) {
          reply.type("application/json").send(formatSlackHelpMessage());
          return;
        }

        const mission = missionService.getMission(missionId);
        if (!mission) {
          throw new Error(`Mission ${missionId} not found.`);
        }
        const stage = mission.stages.find((candidate) => candidate.id === stageId);
        if (!stage) {
          throw new Error(`Stage ${stageId} not found.`);
        }
        if (!["failed", "blocked"].includes(stage.status)) {
          throw new Error("Only failed or blocked stages can be retried from Slack.");
        }
        const manifest = manifestStore.get(mission.projectId);
        ensureSlackChannelAllowed({ channel, manifest });
        ensureSlackAuthorized({ identity, manifest, capability: "operate" });
        const updated = await missionService.scheduleRetry(
          missionId,
          stageId,
          actorFromSlack({ user: identity }),
          `Manual retry scheduled from slash command by ${actorFromSlack({ user: identity })}.`,
        );
        await queue.trigger();
        reply.type("application/json").send(
          formatMissionSlackMessage({
            mission: updated,
            stageRuns: missionService.listStageRuns(updated.id),
            health: healthPatrol.inspect(updated),
            responseType: manifest.slack.responseType,
          }),
        );
        return;
      }

      if (command === "escalate") {
        const [missionId, stageId, ...summaryParts] = requestParts;
        if (!missionId || !stageId) {
          reply.type("application/json").send(formatSlackHelpMessage());
          return;
        }

        const mission = missionService.getMission(missionId);
        if (!mission) {
          throw new Error(`Mission ${missionId} not found.`);
        }
        const stage = mission.stages.find((candidate) => candidate.id === stageId);
        if (!stage) {
          throw new Error(`Stage ${stageId} not found.`);
        }
        const manifest = manifestStore.get(mission.projectId);
        ensureSlackChannelAllowed({ channel, manifest });
        ensureSlackAuthorized({ identity, manifest, capability: "operate" });
        const summary =
          summaryParts.join(" ").trim() || `Escalated from slash command by ${actorFromSlack({ user: identity })}.`;
        const updated = await missionService.escalateStage(
          missionId,
          stageId,
          actorFromSlack({ user: identity }),
          summary,
        );
        await artifactStore.writeEscalation(missionId, stageId, {
          missionId,
          stageId,
          actor: actorFromSlack({ user: identity }),
          summary,
          escalatedAt: new Date().toISOString(),
          source: "slack-command",
        });
        reply.type("application/json").send(
          formatMissionSlackMessage({
            mission: updated,
            stageRuns: missionService.listStageRuns(updated.id),
            health: healthPatrol.inspect(updated),
            responseType: manifest.slack.responseType,
          }),
        );
        return;
      }

      const boundProject = manifestStore.findActiveByChannel(channel);
      let manifest = boundProject?.manifest;
      let requestText = payload.text.trim();

      try {
        manifest = manifestStore.get(command);
        requestText = requestParts.join(" ").trim();
      } catch {
        manifest = boundProject?.manifest;
        requestText = payload.text.trim();
      }

      if (!manifest) {
        throw new Error("No active project is bound to this channel, and the first word did not match a known project id.");
      }

      if (!requestText) {
        reply.type("application/json").send(formatSlackHelpMessage());
        return;
      }

      ensureSlackChannelAllowed({ channel, manifest });
      ensureSlackAuthorized({ identity, manifest, capability: "operate" });
      const mission = await missionService.createMission(
        {
          projectId: manifest.projectId,
          title: requestText.slice(0, 80),
          request: requestText,
          changedPaths: [],
          autonomyMode: "managed",
          actor: actorFromSlack({ user: identity }),
        },
        manifest,
      );
      await queue.trigger();

      reply.type("application/json").send(
        formatMissionSlackMessage({
          mission,
          stageRuns: missionService.listStageRuns(mission.id),
          health: healthPatrol.inspect(mission),
          responseType: manifest.slack.responseType,
        }),
      );
    } catch (error) {
      reply.status(400).type("application/json").send({
        response_type: "ephemeral",
        text: error instanceof Error ? error.message : "Invalid Slack command.",
      });
    }
  });

  app.post("/slack/actions", async (request, reply) => {
    try {
      const body = request.body as SlackUrlEncodedBody;
      if (
        !verifySlackRequest({
          rawBody: body.__rawBody ?? "",
          timestamp: request.headers["x-slack-request-timestamp"]?.toString(),
          signature: request.headers["x-slack-signature"]?.toString(),
          config,
        })
      ) {
        reply.status(401).send({ error: "Invalid Slack signature." });
        return;
      }

      const payload = parseSlackActionPayload(body.payload);
      const action = payload.actions[0];
      if (!action) {
        throw new Error("Missing Slack action.");
      }

      const identity = await slackIdentityService.resolveUser(payload.user);
      const actor = actorFromSlack({ user: identity });
      const channel = await slackIdentityService.resolveChannel(payload.channel?.id);
      const actionValue = parseSlackActionValue(action.value);

      if (action.action_id === "approve_project") {
        const projectId = actionValue.projectId;
        if (!projectId) {
          throw new Error("Missing project id for approval.");
        }
        const project = manifestStore.getRecord(projectId);
        ensureSlackAuthorized({ identity, manifest: project.manifest, capability: "approve" });
        const updatedProject = await projectOnboarding.approve(projectId);
        reply.type("application/json").send(
          formatProjectSlackMessage({
            project: updatedProject,
            responseType: updatedProject.manifest.slack.responseType,
            replaceOriginal: true,
          }),
        );
        return;
      }

      const missionId = actionValue.missionId;
      const stageId = actionValue.stageId;
      if (!missionId) {
        throw new Error("Missing mission id.");
      }
      const mission = missionService.getMission(missionId);
      if (!mission) {
        throw new Error("Mission not found.");
      }
      const manifest = manifestStore.get(mission.projectId);
      ensureSlackChannelAllowed({ channel, manifest });

      if (action.action_id === "approve_plan") {
        ensureSlackAuthorized({ identity, manifest, capability: "approve" });
        await missionService.approvePlan(missionId, actor);
        await queue.trigger();
      } else if (action.action_id === "retry_stage") {
        if (!stageId) {
          throw new Error("Missing stage id for retry.");
        }
        const stage = mission.stages.find((candidate) => candidate.id === stageId);
        if (!stage) {
          throw new Error("Stage not found.");
        }
        if (!["failed", "blocked"].includes(stage.status)) {
          throw new Error("Only failed or blocked stages can be retried.");
        }
        ensureSlackAuthorized({ identity, manifest, capability: "operate" });
        await missionService.scheduleRetry(missionId, stageId, actor, `Manual retry scheduled from Slack by ${actor}.`);
        await queue.trigger();
      } else if (action.action_id === "escalate_stage") {
        if (!stageId) {
          throw new Error("Missing stage id for escalation.");
        }
        ensureSlackAuthorized({ identity, manifest, capability: "operate" });
        const stage = mission.stages.find((candidate) => candidate.id === stageId);
        const summary = `Escalated from Slack by ${actor}${stage ? ` on ${stage.label}` : ""}.`;
        await missionService.escalateStage(missionId, stageId, actor, summary);
        await artifactStore.writeEscalation(missionId, stageId, {
          missionId,
          stageId,
          actor,
          summary,
          escalatedAt: new Date().toISOString(),
          source: "slack",
        });
      } else if (action.action_id !== "refresh_mission") {
        throw new Error(`Unsupported Slack action: ${action.action_id}`);
      }

      const updatedMission = missionService.getMission(missionId);
      if (!updatedMission) {
        throw new Error("Mission not found after action.");
      }

      reply.type("application/json").send(
        formatMissionSlackMessage({
          mission: updatedMission,
          stageRuns: missionService.listStageRuns(updatedMission.id),
          health: healthPatrol.inspect(updatedMission),
          responseType: manifest.slack.responseType,
          replaceOriginal: true,
        }),
      );
    } catch (error) {
      reply.status(400).type("application/json").send({
        response_type: "ephemeral",
        text: error instanceof Error ? error.message : "Invalid Slack action.",
      });
    }
  });

  return app;
}
