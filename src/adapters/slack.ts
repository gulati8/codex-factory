import crypto from "node:crypto";

import type { AppConfig } from "../config.js";
import type { Mission, ProjectManifest, ProjectRecord, StageRun } from "../domain/types.js";
import type { HealthIncident } from "../services/health-patrol.js";

type SlackText = {
  type: "mrkdwn" | "plain_text";
  text: string;
};

type SlackBlock =
  | {
      type: "section";
      text: SlackText;
      accessory?: {
        type: "button";
        text: SlackText;
        action_id: string;
        value: string;
        style?: "primary" | "danger";
      };
    }
  | {
      type: "actions";
      elements: Array<{
        type: "button";
        text: SlackText;
        action_id: string;
        value: string;
        style?: "primary" | "danger";
      }>;
    }
  | {
      type: "context";
      elements: SlackText[];
    }
  | {
      type: "divider";
    };

export type SlackMessage = {
  response_type?: "ephemeral" | "in_channel";
  replace_original?: boolean;
  text: string;
  blocks: SlackBlock[];
};

export type SlackUrlEncodedBody = Record<string, string | undefined> & {
  __rawBody?: string;
};

type SlackAction = {
  action_id: string;
  value: string;
};

export type SlackActionPayload = {
  type: string;
  user: {
    id?: string;
    username?: string;
    name?: string;
  };
  channel?: {
    id?: string;
  };
  actions: SlackAction[];
};

export type SlackIdentity = {
  id?: string;
  username?: string;
  name?: string;
  displayName?: string;
  realName?: string;
  email?: string;
};

export type SlackChannelIdentity = {
  id?: string;
  name?: string;
};

export function verifySlackRequest(params: {
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  config: AppConfig;
}): boolean {
  const { rawBody, timestamp, signature, config } = params;
  if (!config.SLACK_SIGNING_SECRET) {
    return true;
  }

  if (!timestamp || !signature) {
    return false;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > config.SLACK_ALLOWED_TIMESTAMP_AGE_SECONDS) {
    return false;
  }

  const basestring = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto
    .createHmac("sha256", config.SLACK_SIGNING_SECRET)
    .update(basestring)
    .digest("hex")}`;

  if (expected.length !== signature.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function parseSlackActionPayload(payload: string | undefined): SlackActionPayload {
  if (!payload) {
    throw new Error("Missing Slack action payload.");
  }

  return JSON.parse(payload) as SlackActionPayload;
}

export function parseSlackActionValue(value: string): Record<string, string | undefined> {
  return JSON.parse(value) as Record<string, string | undefined>;
}

export function actorFromSlack(payload: { user?: SlackIdentity }): string {
  return payload.user?.id ?? payload.user?.username ?? payload.user?.name ?? "slack-user";
}

export function slackIdentityFromCommand(body: { user_id?: string; user_name?: string }): SlackIdentity {
  return {
    id: body.user_id,
    username: body.user_name,
    name: body.user_name,
  };
}

export function ensureSlackAuthorized(params: {
  identity: SlackIdentity;
  manifest: ProjectManifest;
  capability: "operate" | "approve";
}): void {
  const { identity, manifest, capability } = params;
  const candidates = [
    identity.id,
    identity.username,
    identity.name,
    identity.displayName,
    identity.realName,
    identity.email,
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeSlackValue) as string[];
  const policyList =
    capability === "approve"
      ? manifest.slack.approverUsers.length > 0
        ? manifest.slack.approverUsers
        : manifest.slack.operatorUsers
      : manifest.slack.operatorUsers;

  if (policyList.length === 0) {
    return;
  }

  const normalizedPolicy = policyList.map(normalizeSlackValue);
  const authorized = candidates.some((candidate) => normalizedPolicy.includes(candidate));
  if (!authorized) {
    throw new Error(`Slack user is not authorized to ${capability} for project ${manifest.projectId}.`);
  }
}

export function ensureSlackChannelAllowed(params: {
  channel: SlackChannelIdentity;
  manifest: ProjectManifest;
}): void {
  const { channel, manifest } = params;
  const allowedChannels = [...manifest.slack.allowedChannelIds, ...manifest.slack.allowedChannels];
  if (allowedChannels.length === 0) {
    return;
  }

  const candidates = [channel.id, channel.name]
    .filter((value): value is string => Boolean(value))
    .map(normalizeSlackValue);
  const normalizedAllowed = allowedChannels.map(normalizeSlackValue);
  if (candidates.length === 0 || !candidates.some((candidate) => normalizedAllowed.includes(candidate))) {
    throw new Error(`Slack channel is not authorized for project ${manifest.projectId}.`);
  }
}

function normalizeSlackValue(value: string): string {
  return value.trim().toLowerCase();
}

export function formatMissionSlackMessage(params: {
  mission: Mission;
  stageRuns?: StageRun[];
  health?: HealthIncident[];
  responseType?: "ephemeral" | "in_channel";
  replaceOriginal?: boolean;
}): SlackMessage {
  const { mission, stageRuns = [], health = [], responseType = "ephemeral", replaceOriginal = false } = params;
  const latestRunByStage = new Map<string, StageRun>();
  for (const stageRun of stageRuns) {
    const previous = latestRunByStage.get(stageRun.stageId);
    if (!previous || previous.attempt < stageRun.attempt) {
      latestRunByStage.set(stageRun.stageId, stageRun);
    }
  }

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${mission.title}*\n${mission.request}`,
      },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Project: *${mission.projectId}*` },
        { type: "mrkdwn", text: `Status: *${mission.status}*` },
        { type: "mrkdwn", text: `Risk: *${mission.riskLevel}*` },
        { type: "mrkdwn", text: `Mission: \`${mission.id}\`` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Plan*\n${mission.plan.summary}`,
      },
    },
  ];

  if (!mission.approval.planApproved) {
    blocks.push({
      type: "actions",
      elements: [
        slackButton("Approve Plan", "approve_plan", { missionId: mission.id }, "primary"),
        slackButton("Refresh", "refresh_mission", { missionId: mission.id }),
      ],
    });
  } else {
    blocks.push({
      type: "actions",
      elements: [slackButton("Refresh", "refresh_mission", { missionId: mission.id })],
    });
  }

  for (const stage of mission.stages) {
    const stageRun = latestRunByStage.get(stage.id);
    const stageSummary = stageRun ? `attempt ${stageRun.attempt} · ${stageRun.summary}` : "no attempts yet";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${stage.label}* · ${stage.status}\n${stageSummary}`,
      },
    });

    if (stage.status === "failed") {
      blocks.push({
        type: "actions",
        elements: [
          slackButton("Retry", "retry_stage", { missionId: mission.id, stageId: stage.id }, "primary"),
          slackButton("Escalate", "escalate_stage", { missionId: mission.id, stageId: stage.id }, "danger"),
        ],
      });
    }

    if (stage.status === "blocked") {
      blocks.push({
        type: "actions",
        elements: [
          slackButton("Retry", "retry_stage", { missionId: mission.id, stageId: stage.id }),
          slackButton("Refresh", "refresh_mission", { missionId: mission.id }),
        ],
      });
    }
  }

  if (health.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Health*\n${health.map((incident) => `- ${incident.severity}: ${incident.message}`).join("\n")}`,
      },
    });
  }

  return {
    response_type: responseType,
    replace_original: replaceOriginal,
    text: `${mission.title} · ${mission.status} · ${mission.riskLevel}`,
    blocks,
  };
}

export function formatProjectSlackMessage(params: {
  project: ProjectRecord;
  responseType?: "ephemeral" | "in_channel";
  replaceOriginal?: boolean;
}): SlackMessage {
  const { project, responseType = project.manifest.slack.responseType, replaceOriginal = false } = params;
  const notes = project.inference.notes.length > 0 ? project.inference.notes.map((note) => `- ${note}`).join("\n") : "- No inference notes.";
  const repoDetails = [
    `Repo: \`${project.access.repoUrl}\``,
    `Clone path: \`${project.access.clonePath}\``,
    `Status: *${project.status}*`,
    `Confidence: *${Math.round(project.inference.confidence * 100)}%*`,
  ].join(" · ");

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Project onboarding: ${project.manifest.displayName}*\n${repoDetails}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Inferred commands*\n` +
          `- install: \`${project.manifest.commands.install}\`\n` +
          `- lint: \`${project.manifest.commands.lint}\`\n` +
          `- test: \`${project.manifest.commands.test}\`\n` +
          `- build: \`${project.manifest.commands.build}\``,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Notes*\n${notes}`,
      },
    },
  ];

  if (project.access.remediation) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*What to fix*\n${project.access.remediation}`,
      },
    });
  }

  if (project.status === "pending_approval") {
    blocks.push({
      type: "actions",
      elements: [
        slackButton("Approve Setup", "approve_project", { projectId: project.projectId }, "primary"),
      ],
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          project.status === "active"
            ? `Project \`${project.projectId}\` is active. Ask for work in this channel or reference the project id from anywhere.`
            : `Once approved, ask what work to do next or let the bot propose something.`,
      },
    ],
  });

  return {
    response_type: responseType,
    replace_original: replaceOriginal,
    text: `${project.manifest.displayName} · ${project.status}`,
    blocks,
  };
}

export function formatSlackHelpMessage(): SlackMessage {
  return {
    response_type: "ephemeral",
    text: "Codex Factory Slack help",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*Codex Factory*\nUse one of these forms:\n- `connect <github-url>`\n- `<projectId> <request>`\n- `<request>` in a bound project channel\n- `status <missionId>`\n- `approve <missionId>`\n- `approve-project <projectId>`\n- `retry <missionId> <stageId>`\n- `escalate <missionId> <stageId> <summary>`",
        },
      },
    ],
  };
}

function slackButton(
  label: string,
  actionId: string,
  value: Record<string, string | undefined>,
  style?: "primary" | "danger",
) {
  return {
    type: "button" as const,
    text: {
      type: "plain_text" as const,
      text: label,
    },
    action_id: actionId,
    value: JSON.stringify(value),
    ...(style ? { style } : {}),
  };
}
