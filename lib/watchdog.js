// Trạng thái lưu trong Redis, không phải biến process:
// bản cũ dùng biến cục bộ nên 10 instance cluster vừa báo động giả vừa gửi trùng 10 lần.
import config from '../config.js';
import * as redis from './redis.js';
import * as telegram from './telegram.js';
import log from './logger.js';

const KEY_LAST_MSG = 'webhook:lastMessageAt';
const KEY_DOWN_SINCE = 'webhook:downSince';
const ERR_WINDOW_SEC = 900;

let checkTimer = null;
let redisWasDown = false;

export const markMessageReceived = async () => {
  try {
    await redis.client.set(KEY_LAST_MSG, String(Date.now()));
  } catch (err) {
    log.warn('Không ghi được mốc thời gian tin nhắn:', err.message);
  }
};

export const recordError = async (kind, sample) => {
  try {
    const key = `webhook:err:${kind}`;
    const count = await redis.client.incr(key);
    if (count === 1) await redis.client.expire(key, ERR_WINDOW_SEC);
    if (sample) await redis.client.set(`${key}:sample`, String(sample), { EX: ERR_WINDOW_SEC });
  } catch {
    // đếm lỗi hỏng thì bỏ qua, không chặn luồng chính
  }
};

export const getErrorCounts = async () => {
  const read = async (kind) => {
    try {
      return Number(await redis.client.get(`webhook:err:${kind}`)) || 0;
    } catch {
      return 0;
    }
  };
  const [azure, forward, rule] = await Promise.all([read('azure'), read('forward'), read('rule')]);
  return { azure, forward, rule, total: azure + forward + rule };
};

export const start = ({ getStats }) => {
  if (checkTimer) return;

  checkTimer = setInterval(async () => {
    if (!redis.isConnected()) {
      if (!redisWasDown) {
        redisWasDown = true;
        await telegram.notifyRedisDown('Client báo trạng thái mất kết nối');
      }
      return;
    }
    if (redisWasDown) {
      redisWasDown = false;
      await telegram.notifyRedisUp();
    }

    try {
      const lastRaw = await redis.client.get(KEY_LAST_MSG);
      if (!lastRaw) return;

      const silenceSec = (Date.now() - Number(lastRaw)) / 1000;
      const downSince = await redis.client.get(KEY_DOWN_SINCE);

      if (silenceSec > config.watchdog.silenceSec) {
        if (!downSince) await redis.client.set(KEY_DOWN_SINCE, String(Date.now()));
        const [stats, errors] = await Promise.all([getStats(), getErrorCounts()]);
        const sent = await telegram.notifyDown({
          silenceSec,
          lastMessageAt: Number(lastRaw),
          stats,
          errors,
        });
        if (sent) log.warn(`Đã gửi cảnh báo: im lặng ${telegram.humanDuration(silenceSec)}`);
      } else if (downSince) {
        await redis.client.del(KEY_DOWN_SINCE);
        const stats = await getStats();
        const sent = await telegram.notifyRecovered({
          downSec: (Date.now() - Number(downSince)) / 1000,
          stats,
        });
        if (sent) log.ok('Đã gửi thông báo phục hồi');
      }
    } catch (err) {
      log.error('Watchdog lỗi:', err.message);
    }
  }, 10000);

  checkTimer.unref?.();
};

export const stop = () => {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
};
