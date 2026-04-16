import { z } from "zod";

export const autonomyModeSchema = z.enum(["pair", "managed", "mission"]);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;

export const riskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const missionStatusSchema = z.enum([
  "draft",
  "awaiting_plan_approval",
  "ready_to_dispatch",
  "running",
  "blocked",
  "completed",
  "failed",
]);
export type MissionStatus = z.infer<typeof missionStatusSchema>;

export const stageKindSchema = z.enum([
  "intake",
  "research",
  "architect",
  "implement",
  "integrate",
  "review",
  "qa",
  "security",
  "docs",
]);
export type StageKind = z.infer<typeof stageKindSchema>;

export const stageStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "skipped",
  "failed",
]);
export type StageStatus = z.infer<typeof stageStatusSchema>;

export const stageSchema = z.object({
  id: z.string(),
  kind: stageKindSchema,
  label: z.string(),
  status: stageStatusSchema,
  required: z.boolean(),
  dependsOn: z.array(z.string()),
  workstreamId: z.string().optional(),
  workerHint: z.string(),
  notes: z.array(z.string()),
  lastHeartbeatAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type MissionStage = z.infer<typeof stageSchema>;

export const workstreamSchema = z.object({
  id: z.string(),
  title: z.string(),
  paths: z.array(z.string()),
  goal: z.string(),
});
export type Workstream = z.infer<typeof workstreamSchema>;

export const planArtifactSchema = z.object({
  summary: z.string(),
  objectives: z.array(z.string()),
  assumptions: z.array(z.string()),
  workstreams: z.array(workstreamSchema),
  routeDecisions: z.array(z.string()),
});
export type PlanArtifact = z.infer<typeof planArtifactSchema>;

export const approvalStateSchema = z.object({
  planApproved: z.boolean(),
  mergeApprovalRequired: z.boolean(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
});
export type ApprovalState = z.infer<typeof approvalStateSchema>;

export const missionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  request: z.string(),
  changedPaths: z.array(z.string()),
  autonomyMode: autonomyModeSchema,
  riskLevel: riskLevelSchema,
  status: missionStatusSchema,
  plan: planArtifactSchema,
  approval: approvalStateSchema,
  stages: z.array(stageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Mission = z.infer<typeof missionSchema>;

export const missionEventSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  type: z.enum([
    "mission.created",
    "plan.approved",
    "mission.dispatched",
    "stage.started",
    "stage.heartbeat",
    "stage.completed",
    "stage.failed",
    "stage.retry_scheduled",
    "stage.escalated",
  ]),
  actor: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.any()),
});
export type MissionEvent = z.infer<typeof missionEventSchema>;
export type MissionEventType = MissionEvent["type"];

export const stageRunSchema = z.object({
  missionId: z.string(),
  stageId: z.string(),
  stageKind: stageKindSchema,
  status: z.enum(["queued", "running", "completed", "failed"]),
  attempt: z.number().int().positive(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  worktreePath: z.string(),
  artifactDir: z.string(),
  summary: z.string(),
});
export type StageRun = z.infer<typeof stageRunSchema>;

export const agentRunnerSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  stages: z.array(stageKindSchema).default(["implement", "review", "docs", "architect", "research", "security"]),
});
export type AgentRunnerConfig = z.infer<typeof agentRunnerSchema>;

export const projectManifestSchema = z.object({
  projectId: z.string(),
  displayName: z.string(),
  repoPath: z.string(),
  runtimeContainer: z.string().default("node:22-bookworm-slim"),
  maxParallelWorkers: z.number().int().positive().default(2),
  commands: z.object({
    "install": z.string(),
    "lint": z.string(),
    "test": z.string(),
    "build": z.string(),
  }),
  approval: z.object({
    requirePlanApproval: z.boolean(),
    allowRiskBasedAutonomy: z.boolean(),
    allowFireAndForget: z.boolean(),
  }),
  slack: z
    .object({
      allowedChannelIds: z.array(z.string()).default([]),
      allowedChannels: z.array(z.string()).default([]),
      operatorUsers: z.array(z.string()).default([]),
      approverUsers: z.array(z.string()).default([]),
      responseType: z.enum(["ephemeral", "in_channel"]).default("ephemeral"),
      notifications: z
        .object({
          channelIds: z.array(z.string()).default([]),
          channelNames: z.array(z.string()).default([]),
          events: z.array(missionEventSchema.shape.type).default([
            "mission.created",
            "plan.approved",
            "stage.failed",
            "stage.retry_scheduled",
            "stage.escalated",
          ]),
        })
        .default({
          channelIds: [],
          channelNames: [],
          events: ["mission.created", "plan.approved", "stage.failed", "stage.retry_scheduled", "stage.escalated"],
        }),
    })
    .default({
      allowedChannelIds: [],
      allowedChannels: [],
      operatorUsers: [],
      approverUsers: [],
      responseType: "ephemeral",
      notifications: {
        channelIds: [],
        channelNames: [],
        events: ["mission.created", "plan.approved", "stage.failed", "stage.retry_scheduled", "stage.escalated"],
      },
    }),
  agentRunner: agentRunnerSchema.optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().positive().default(2),
      retryableStages: z.array(stageKindSchema).default(["implement", "review", "docs", "qa", "integrate"]),
    })
    .default({
      maxAttempts: 2,
      retryableStages: ["implement", "review", "docs", "qa", "integrate"],
    }),
  risk: z.object({
    highRiskGlobs: z.array(z.string()),
    architectureGlobs: z.array(z.string()),
    securityGlobs: z.array(z.string()),
    docsGlobs: z.array(z.string()),
  }),
});
export type ProjectManifest = z.infer<typeof projectManifestSchema>;

export const createMissionInputSchema = z.object({
  projectId: z.string(),
  title: z.string(),
  request: z.string(),
  changedPaths: z.array(z.string()).default([]),
  autonomyMode: autonomyModeSchema.default("managed"),
  actor: z.string().default("slack"),
});
export type CreateMissionInput = z.infer<typeof createMissionInputSchema>;

export const slackCommandSchema = z.object({
  text: z.string().min(1),
  user_id: z.string().optional(),
  user_name: z.string().optional(),
  channel_id: z.string().optional(),
});
export type SlackCommand = z.infer<typeof slackCommandSchema>;
