// Bộ đếm để trong Redis vì cluster chia request ra 10 instance
import config from '../config.js';
import * as redis from './redis.js';
import * as waha from './waha.js';
import log from './logger.js';

export const track = async (groupId, session) => {
  try {
    const key = `readCount:${session}:${groupId}`;
    const count = await redis.client.incr(key);
    if (count === 1) await redis.client.expire(key, 24 * 60 * 60);

    if (count >= config.readMessageBatch) {
      await redis.client.set(key, '0');
      log.info(`Đánh dấu đã đọc group ${groupId} (session ${session})`);
      await waha.readMessages(groupId, session);
    }
  } catch (err) {
    log.error(`readTracker lỗi (${groupId}):`, err.message);
  }
};
