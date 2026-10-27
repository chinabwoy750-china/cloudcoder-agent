import { config, validateEnv, validateGitHubEnv, validateTelegramEnv } from './config/env.js';
import { logger } from './utils/logger.js';
import { startOpenCode, waitForOpenCode, stopOpenCode } from './agent/opencode.js';
import { createApp } from './server/app.js';
import { startTelegramBot, stopTelegramBot } from './telegram/bot.js';
import { fetchCustomModels } from './config/custom-models.js';
import { loadRuntimeSettings } from './config/runtime-settings.js';

async function main() {
  logger.info(`CloudCoder Agent starting (NODE_ENV=${process.env.NODE_ENV || 'development'})`);

  // Strip non-ASCII from API key early — HTTP Authorization headers reject code points > 255
  // (e.g. bullet • U+2022 sometimes pasted into Render env vars).
  if (process.env.CUSTOM_AI_API_KEY) {
    const cleaned = process.env.CUSTOM_AI_API_KEY.replace(/[^\x20-\x7E]/g, '').trim();
    if (cleaned !== process.env.CUSTOM_AI_API_KEY.trim()) {
      logger.warn('CUSTOM_AI_API_KEY contained non-ASCII characters; sanitized for HTTP use');
    }
    process.env.CUSTOM_AI_API_KEY = cleaned;
  }

  validateEnv();
  // Load site-managed provider/model settings before model discovery and OpenCode startup.
  await loadRuntimeSettings();
  validateGitHubEnv();
  const telegramEnabled = validateTelegramEnv();

  // Discover custom models BEFORE building OpenCode config so all models
  // are registered in OPENCODE_CONFIG_CONTENT (never logs the API key).
  try {
    await fetchCustomModels({ force: true });
  } catch (err) {
    logger.warn(`Custom model discovery skipped: ${err.message}`);
  }

  // Bind public port first so Render sees $PORT immediately.
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info(`CloudCoder API listening on ${config.host}:${config.port}`);
  });

  startOpenCode();
  waitForOpenCode(120000)
    .then(() => logger.info('OpenCode readiness confirmed'))
    .catch((err) => {
      logger.error(`OpenCode startup failed: ${err.message}`);
      logger.error('Public API remains up; /health will stay 503 until OpenCode recovers.');
    });

  if (telegramEnabled) {
    startTelegramBot().catch((err) => logger.error(`Telegram bot failed to start: ${err.message}`));
  }

  const shutdown = (sig) => {
    logger.info(`Received ${sig}, shutting down...`);
    stopTelegramBot();
    stopOpenCode();
    server.close(() => { logger.info('HTTP closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (r) => logger.error(`Unhandled rejection: ${r}`));
  process.on('uncaughtException', (e) => {
    logger.error(`Uncaught: ${e.message}`);
    process.exit(1);
  });
}

main();
