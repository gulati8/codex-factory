import type { AppConfig } from "../config.js";
import type { SlackChannelIdentity, SlackIdentity } from "../adapters/slack.js";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type SlackUserInfoResponse = {
  ok: boolean;
  user?: {
    id?: string;
    name?: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
      email?: string;
    };
  };
};

type SlackConversationInfoResponse = {
  ok: boolean;
  channel?: {
    id?: string;
    name?: string;
  };
};

type SlackConversationListResponse = {
  ok: boolean;
  channels?: Array<{
    id?: string;
    name?: string;
  }>;
  response_metadata?: {
    next_cursor?: string;
  };
};

export class SlackIdentityService {
  private readonly token?: string;
  private readonly ttlMs: number;
  private readonly userCache = new Map<string, CacheEntry<SlackIdentity>>();
  private readonly channelCache = new Map<string, CacheEntry<SlackChannelIdentity>>();
  private readonly channelNameCache = new Map<string, CacheEntry<SlackChannelIdentity>>();

  public constructor(config: AppConfig) {
    this.token = config.SLACK_BOT_TOKEN;
    this.ttlMs = config.SLACK_IDENTITY_CACHE_TTL_SECONDS * 1000;
  }

  public async resolveUser(identity: SlackIdentity): Promise<SlackIdentity> {
    if (!this.token || !identity.id) {
      return identity;
    }

    const cached = this.fromCache(this.userCache, identity.id);
    if (cached) {
      return {
        ...cached,
        ...identity,
      };
    }

    try {
      const response = await this.fetchSlack<SlackUserInfoResponse>(`users.info?user=${encodeURIComponent(identity.id)}`);
      const resolved: SlackIdentity = {
        id: response.user?.id ?? identity.id,
        username: response.user?.name ?? identity.username,
        name: identity.name ?? response.user?.profile?.display_name ?? response.user?.real_name,
        displayName: response.user?.profile?.display_name,
        realName: response.user?.real_name ?? response.user?.profile?.real_name,
        email: response.user?.profile?.email,
      };
      this.toCache(this.userCache, identity.id, resolved);
      return resolved;
    } catch {
      return identity;
    }
  }

  public async resolveChannel(channelId: string | undefined): Promise<SlackChannelIdentity> {
    if (!channelId) {
      return {};
    }

    if (!this.token) {
      return { id: channelId };
    }

    const cached = this.fromCache(this.channelCache, channelId);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.fetchSlack<SlackConversationInfoResponse>(
        `conversations.info?channel=${encodeURIComponent(channelId)}`,
      );
      const resolved: SlackChannelIdentity = {
        id: response.channel?.id ?? channelId,
        name: response.channel?.name,
      };
      this.toCache(this.channelCache, channelId, resolved);
      return resolved;
    } catch {
      return { id: channelId };
    }
  }

  public async resolveChannelName(channelName: string | undefined): Promise<SlackChannelIdentity> {
    if (!channelName) {
      return {};
    }

    const normalized = channelName.trim().toLowerCase().replace(/^#/, "");
    if (!normalized) {
      return {};
    }

    if (!this.token) {
      return { name: normalized };
    }

    const cached = this.fromCache(this.channelNameCache, normalized);
    if (cached) {
      return cached;
    }

    try {
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({
          limit: "1000",
          exclude_archived: "true",
          types: "public_channel,private_channel",
        });
        if (cursor) {
          query.set("cursor", cursor);
        }

        const response = await this.fetchSlack<SlackConversationListResponse>(`conversations.list?${query.toString()}`);
        const matched = response.channels?.find((channel) => channel.name?.toLowerCase() === normalized);
        if (matched) {
          const resolved: SlackChannelIdentity = {
            id: matched.id,
            name: matched.name ?? normalized,
          };
          this.toCache(this.channelNameCache, normalized, resolved);
          if (matched.id) {
            this.toCache(this.channelCache, matched.id, resolved);
          }
          return resolved;
        }

        cursor = response.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch {
      return { name: normalized };
    }

    return { name: normalized };
  }

  private async fetchSlack<T>(path: string): Promise<T> {
    const response = await fetch(`https://slack.com/api/${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Slack API request failed with status ${response.status}.`);
    }

    const parsed = (await response.json()) as { ok?: boolean; error?: string };
    if (!parsed.ok) {
      throw new Error(`Slack API error: ${parsed.error ?? "unknown_error"}`);
    }

    return parsed as T;
  }

  private fromCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  private toCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}
