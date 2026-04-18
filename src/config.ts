import dotenv from "dotenv";
import { z } from "zod";

const envSchema = z.object({
  STATE_BACKEND: z.enum(["file", "postgres"]).default("file"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATA_FILE: z.string().default("./data/state.json"),
  POSTGRES_URL: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  MANIFESTS_DIR: z.string().default("./manifests"),
  ARTIFACTS_DIR: z.string().default("./runtime/artifacts"),
  DEFAULT_WORKTREE_ROOT: z.string().default("./runtime/worktrees"),
  PROJECTS_ROOT: z.string().default("./runtime/projects"),
  DEFAULT_CONTAINER_IMAGE: z.string().default("node:22-bookworm-slim"),
  HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  STAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(900000),
  FACTORY_ADMIN_USERS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean),
    ),
  SLACK_SOCKET_MODE: z.coerce.boolean().default(false),
  SLACK_COMMAND_NAME: z.string().default("/codex-factory"),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_IDENTITY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  SLACK_ALLOWED_TIMESTAMP_AGE_SECONDS: z.coerce.number().int().positive().default(300),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    dotenv.config({ override: false, quiet: true });
  }

  return envSchema.parse(env);
}
