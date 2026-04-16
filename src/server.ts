import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SlackSocketModeBridge } from "./services/slack-socket-mode.js";

const config = loadConfig();
const app = await buildApp();
const slackSocketMode = new SlackSocketModeBridge(config, app);

app.addHook("onClose", async () => {
  await slackSocketMode.stop();
});

const shutdown = async () => {
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({
    port: config.PORT,
    host: config.HOST,
  });
  if (await slackSocketMode.start()) {
    app.log.info({ command: config.SLACK_COMMAND_NAME }, "Slack socket mode connected");
  }
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
