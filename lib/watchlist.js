// Danh sách session cần theo dõi sát. Session nằm trong đây được hạ ngưỡng cảnh
// báo xuống một nửa và tin nhắn có dấu riêng, để phân biệt với 30+ session còn
// lại vốn chỉ cần biết khi hỏng hẳn.
//
// Để trong Redis chứ không phải env: sửa danh sách không phải restart 10 instance.
import * as redis from './redis.js';
import log from './logger.js';

const KEY = 'session_health:watchlist';
const CACHE_TTL_MS = 10_000;

let cached = null;
let cachedAt = 0;

export const list = async () => {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  try {
    cached = new Set(await redis.client.sMembers(KEY));
    cachedAt = Date.now();
  } catch (err) {
    log.warn('Không đọc được danh sách theo dõi:', err.message);
    if (!cached) cached = new Set();
  }
  return cached;
};

export const has = async (session) => (await list()).has(String(session));

export const add = async (sessions) => {
  const arr = (Array.isArray(sessions) ? sessions : [sessions]).map(String).filter(Boolean);
  if (!arr.length) return [];
  await redis.client.sAdd(KEY, arr);
  cached = null;
  return arr;
};

export const remove = async (sessions) => {
  const arr = (Array.isArray(sessions) ? sessions : [sessions]).map(String).filter(Boolean);
  if (!arr.length) return [];
  await redis.client.sRem(KEY, arr);
  cached = null;
  return arr;
};

export const all = async () => (await redis.client.sMembers(KEY)).sort();
