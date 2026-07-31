import 'dotenv/config';
import os from 'node:os';

const required = (key) => {
  const value = process.env[key];
  if (!value) {
    console.error(`[config] ❌ Thiếu biến môi trường bắt buộc: ${key}`);
    process.exit(1);
  }
  return value;
};

const num = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
};

export default {
  port: num('PORT', 3010),
  env: process.env.NODE_ENV || 'development',
  serverName: process.env.SERVER_NAME || os.hostname(),
  serverIp: process.env.SERVER_IP || '',

  redisUrl: required('REDIS_URL'),

  waha: {
    baseUrl: process.env.WAHA_BASE_URL || 'http://localhost:3000',
    apiKey: required('WAHA_API_KEY'),
  },

  azure: {
    blobUrl: required('AZURE_BLOB_URL'),
    sasToken: required('AZURE_SAS_TOKEN'),
    container: process.env.AZURE_CONTAINER || 'hsxonzblod',
    frontDoorUrl: required('AZURE_FRONTDOOR_URL'),
    extension: 'jpg',
  },

  forwardWebhookUrl: process.env.FORWARD_WEBHOOK_URL || 'http://localhost:5200/webhook',

  rule: {
    apiUrl: process.env.RULE_API_URL || 'https://test.gobbay.online/v1/api',
    token: process.env.RULE_API_TOKEN || '',
    cacheTtl: num('RULE_CACHE_TTL', 300),
    minMembers: num('MIN_GROUP_MEMBERS', 100),
  },

  telegram: {
    enabled: process.env.TELEGRAM_ENABLED !== 'false',
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    repeatSec: num('TELEGRAM_REPEAT_SEC', 1800),
  },

  watchdog: {
    silenceSec: num('WATCHDOG_SILENCE_SEC', 300),
  },

  readMessageBatch: num('READ_MESSAGE_BATCH', 5000),
  timezone: 'Asia/Bangkok',
};
