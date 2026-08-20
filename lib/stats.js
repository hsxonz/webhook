import moment from 'moment-timezone';
import config from '../config.js';
import * as redis from './redis.js';
import * as waha from './waha.js';

// Ngày thống kê đổi lúc 9h sáng, không phải 0h
export const getCountDate = () => {
  const now = moment().tz(config.timezone);
  const nineAM = now.clone().startOf('day').add(9, 'hours');
  return now.isBefore(nineAM)
    ? now.clone().subtract(1, 'day').format('YYYY-MM-DD')
    : now.format('YYYY-MM-DD');
};

const messageCountKey = (session) => `message_count:${getCountDate()}:${session}`;

export const incrementMessageCount = async (session) => {
  const key = messageCountKey(session);
  const count = await redis.client.incr(key);
  if (count === 1) await redis.client.expire(key, 7 * 24 * 60 * 60);
  return count;
};

export const getMessageCount = async (session) =>
  Number(await redis.client.get(messageCountKey(session))) || 0;

// Mot lenh MGET thay cho N lenh GET. Dung cho dashboard poll nhanh: 33 luot HTTP
// gom con 1, van ~3ms vi day chi la key phang trong Redis.
export const getMessageCounts = async (sessions) => {
  const ds = (sessions || []).map(String).filter(Boolean);
  if (!ds.length) return {};
  const d = getCountDate();
  const vals = await redis.client.mGet(ds.map((s) => `message_count:${d}:${s}`));
  return Object.fromEntries(ds.map((s, i) => [s, Number(vals[i]) || 0]));
};

export const getTotalMessageCount = async () => {
  const sessions = await waha.getWorkingSessions();
  const counts = await Promise.all(sessions.map((s) => getMessageCount(s.name)));
  return counts.reduce((sum, n) => sum + n, 0);
};

// SCAN mất ~15s vì keyspace rất lớn, nên đếm nền theo chu kỳ dài
// rồi phục vụ từ key đếm sẵn (O(1)). Không bao giờ SCAN trong request.
const COUNT_REFRESH_SEC = 600;

const cachedCount = async (name, pattern) => {
  const key = `webhook:count:${name}`;
  const cached = await redis.client.get(key).catch(() => null);
  if (cached !== null) return Number(cached);

  // Khoá NX: chỉ 1 instance trong cluster chịu chi phí SCAN
  const won = await redis.client
    .set(`${key}:lock`, '1', { NX: true, EX: COUNT_REFRESH_SEC })
    .catch(() => null);
  if (!won) return Number(await redis.client.get(`${key}:last`).catch(() => 0)) || 0;

  const count = (await redis.scanKeys(pattern)).length;
  await redis.client.set(key, String(count), { EX: COUNT_REFRESH_SEC }).catch(() => {});
  await redis.client.set(`${key}:last`, String(count)).catch(() => {});
  return count;
};

export const getGroupCount = () => cachedCount('groups', 'groupsInfo:*');

export const getUserCount = () => cachedCount('users', 'contactInfoByPhone:*');

export const getGroups = async () => {
  const keys = await redis.scanKeys('groupsInfo:*');
  const groups = await Promise.all(keys.map((k) => redis.getJson(k)));
  return groups.filter(Boolean);
};

export const getUsers = async () => {
  const keys = await redis.scanKeys('contactInfoByPhone:*');
  const users = await Promise.all(keys.map(async (key) => {
    const data = await redis.getJson(key);
    if (!data) return null;
    return {
      phone: key.split(':')[1],
      name: data.name || '',
      avatar: data.avatar || '',
      ids: data.ids || [],
    };
  }));
  return users.filter(Boolean);
};

// getGroupCount phải SCAN vài nghìn key nên rất chậm khi Redis đang tải nặng.
// Cache chung trong Redis để cả cluster chỉ tính lại 1 lần / SNAPSHOT_TTL,
// và watchdog không bị treo đúng lúc cần gửi cảnh báo.
const SNAPSHOT_KEY = 'webhook:healthSnapshot';
const SNAPSHOT_TTL = 30;

const withTimeout = (promise, ms, fallback) =>
  Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);

export const getHealthSnapshot = async () => {
  const cached = await redis.getJson(SNAPSHOT_KEY);
  if (cached) return { ...cached, redisOk: redis.isConnected(), cached: true };

  const [totalMessages, sessions, groupCount] = await Promise.all([
    withTimeout(getTotalMessageCount(), 8000, 0),
    withTimeout(waha.getWorkingSessions(), 8000, []),
    withTimeout(getGroupCount(), 8000, 0),
  ]);

  const snapshot = { totalMessages, activeSessions: sessions.length, groupCount };
  try {
    await redis.client.set(SNAPSHOT_KEY, JSON.stringify(snapshot), { EX: SNAPSHOT_TTL });
  } catch {
    // không cache được thì thôi
  }
  return { ...snapshot, redisOk: redis.isConnected(), cached: false };
};
