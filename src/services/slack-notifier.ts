import type { AppConfig } from "../config.js";
import { formatMissionSlackMessage } from "../adapters/slack.js";
import type { Mission, MissionEvent, ProjectManifest } from "../domain/types.js";
import type { HealthIncident } from "./health-patrol.js";
import type { SlackIdentityService } from "./slack-identity-service.js";

type SlackApiResponse = {
  ok?: boolean;
  error?: string;
};

export class SlackNotifier {
  private readonly token?: string;
  private readonly slackIdentityService?: SlackIdentityService;

  public constructor(config: AppConfig, slackIdentityService?: SlackIdentityService) {
    this.token = config.SLACK_BOT_TOKEN;
    this.slackIdentityService = slackIdentityService;
  }

  public async notify(params: {
    mission: Mission;
    event: MissionEvent;
    manifest: ProjectManifest;
    health: HealthIncident[];
  }): Promise<void> {
    const { mission, event, manifest, health } = params;
    const channels = await this.notificationTargets(manifest);
    const shouldNotify =
      Boolean(this.token) &&
      channels.length > 0 &&
      manifest.slack.notifications.events.includes(event.type);

    if (!shouldNotify) {
      return;
    }

    const missionCard = formatMissionSlackMessage({
      mission,
      health,
      responseType: "in_channel",
    });
    const blocks = [
      {
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: `*${manifest.displayName}* · ${event.summary}`,
        },
      },
      { type: "divider" as const },
      ...missionCard.blocks,
    ];

    for (const channel of channels) {
      await this.postMessage({
        channel,
        text: `${manifest.displayName}: ${event.summary}`,
        blocks,
      });
    }
  }

  private async notificationTargets(manifest: ProjectManifest): Promise<string[]> {
    const targets = new Set<string>();

    for (const channelId of manifest.slack.notifications.channelIds) {
      const normalized = channelId.trim();
      if (normalized) {
        targets.add(normalized);
      }
    }

    for (const channelName of manifest.slack.notifications.channelNames) {
      const resolved = await this.slackIdentityService?.resolveChannelName(channelName);
      const target = resolved?.id ?? resolved?.name ?? channelName.trim().replace(/^#/, "");
      if (target) {
        targets.add(target);
      }
    }

    return [...targets];
  }

  private async postMessage(payload: {
    channel: string;
    text: string;
    blocks: unknown[];
  }): Promise<void> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack postMessage failed with status ${response.status}.`);
    }

    const parsed = (await response.json()) as SlackApiResponse;
    if (!parsed.ok) {
      throw new Error(`Slack postMessage error: ${parsed.error ?? "unknown_error"}`);
    }
  }
}
