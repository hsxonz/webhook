import { createClient } from 'redis';
import config from '../config.js';
import log from './logger.js';

export const client = createClient({
  url: config.redisUrl,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
  },
});

let connected = false;

client.on('error', (err) => {
  if (connected) log.error('Redis mất kết nối:', err.message);
  connected = false;
});
client.on('ready', () => {
  connected = true;
  log.info('Redis đã sẵn sàng');
});

// Connection riêng cho SCAN/thống kê: luồng tin nhắn đẩy hàng nghìn lệnh/phút,
// nếu dùng chung thì SCAN vài nghìn key sẽ xếp hàng sau và timeout.
export const scanClient = client.duplicate();
scanClient.on('error', (err) => log.error('Redis (scan) lỗi:', err.message));

export const connect = async () => {
  if (!client.isOpen) await client.connect();
  if (!scanClient.isOpen) await scanClient.connect();
};

export const isConnected = () => connected;

export const getJson = async (key) => {
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    log.error(`Redis getJson lỗi (${key}):`, err.message);
    return null;
  }
};

// SCAN thay cho KEYS vì KEYS block toàn bộ Redis
export const scanKeys = async (pattern) => {
  const keys = [];
  let cursor = '0';
  do {
    const result = await scanClient.scan(cursor, { MATCH: pattern, COUNT: 1000 });
    cursor = result.cursor;
    keys.push(...result.keys);
  } while (cursor !== '0');
  return keys;
};
