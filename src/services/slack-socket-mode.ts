import crypto from "node:crypto";
import querystring from "node:querystring";

import { App as SlackApp } from "@slack/bolt/dist/index.js";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import type { AppConfig } from "../config.js";

type SlashCommandPayload = {
  text?: string;
  user_id?: string;
  user_name?: string;
  channel_id?: string;
};

export class SlackSocketModeBridge {
  private readonly config: AppConfig;
  private readonly fastify: FastifyInstance;
  private slackApp?: SlackApp;

  public constructor(config: AppConfig, fastify: FastifyInstance) {
    this.config = config;
    this.fastify = fastify;
  }

  public isEnabled(): boolean {
    return Boolean(
      this.config.SLACK_SOCKET_MODE &&
        this.config.SLACK_BOT_TOKEN &&
        this.config.SLACK_APP_TOKEN &&
        this.config.SLACK_SIGNING_SECRET,
    );
  }

  public async start(): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    const slackApp = new SlackApp({
      token: this.config.SLACK_BOT_TOKEN,
      signingSecret: this.config.SLACK_SIGNING_SECRET,
      socketMode: true,
      appToken: this.config.SLACK_APP_TOKEN,
    });

    slackApp.command(this.config.SLACK_COMMAND_NAME, async (args) => {
      const command = args.command as SlashCommandPayload;
      const ack = args.ack as (payload: Record<string, unknown>) => Promise<void>;
      const response = await this.forwardCommand(command);
      await ack(this.toSlackResponse(response));
    });

    slackApp.action({ action_id: /.*/ }, async (args) => {
      const body = args.body as unknown as Record<string, unknown>;
      const ack = args.ack as (payload: Record<string, unknown>) => Promise<void>;
      const response = await this.forwardAction(body);
      await ack(this.toSlackResponse(response));
    });

    await slackApp.start();
    this.slackApp = slackApp;
    return true;
  }

  public async stop(): Promise<void> {
    if (!this.slackApp) {
      return;
    }

    await this.slackApp.stop();
    this.slackApp = undefined;
  }

  private async forwardCommand(command: SlashCommandPayload): Promise<LightMyRequestResponse> {
    return this.forward("/slack/commands/intake", querystring.stringify({
      text: command.text ?? "",
      user_id: command.user_id ?? "",
      user_name: command.user_name ?? "",
      channel_id: command.channel_id ?? "",
    }));
  }

  private async forwardAction(payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return this.forward(
      "/slack/actions",
      querystring.stringify({
        payload: JSON.stringify(payload),
      }),
    );
  }

  private async forward(url: string, rawBody: string): Promise<LightMyRequestResponse> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.sign(rawBody, timestamp);

    return this.fastify.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      payload: rawBody,
    });
  }

  private sign(rawBody: string, timestamp: string): string {
    const digest = crypto
      .createHmac("sha256", this.config.SLACK_SIGNING_SECRET ?? "")
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");

    return `v0=${digest}`;
  }

  private toSlackResponse(response: LightMyRequestResponse): Record<string, unknown> {
    const parsed = this.parseJson(response.body);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }

      return {
        response_type: "ephemeral",
        text: response.body || "Slack request completed.",
      };
    }

    const message =
      (parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string" && parsed.text) ||
      (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string" && parsed.error) ||
      `Slack bridge failed with status ${response.statusCode}.`;

    return {
      response_type: "ephemeral",
      text: message,
    };
  }

  private parseJson(body: string): unknown {
    if (!body) {
      return undefined;
    }

    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
}
