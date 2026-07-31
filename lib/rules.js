import axios from 'axios';
import config from '../config.js';
import * as redis from './redis.js';
import * as watchdog from './watchdog.js';
import log from './logger.js';

// Bản cũ gọi API ngoài trên MỌI tin nhắn, nay cache theo group+session
const cacheKey = (session, groupId) => `rule:${session}:${groupId}`;

const checkViaApi = async (session, groupId) => {
  try {
    const res = await axios.get(
      `${config.rule.apiUrl}/groups/${groupId}/receive/${session}`,
      {
        headers: { accept: 'application/json', Authorization: config.rule.token },
        timeout: 8000,
      },
    );
    return { ok: true, allowed: Boolean(res.data.is_receive) };
  } catch (err) {
    await watchdog.recordError('rule', err.message);
    return { ok: false, allowed: false };
  }
};

// Fallback khi API lỗi: dựa vào số thành viên đã cache trong Redis
const checkViaMemberCount = async (groupId) => {
  const info = await redis.getJson(`groupsInfo:${groupId}`);
  return info ? (info.memberCount || 0) >= config.rule.minMembers : false;
};

export const shouldProcess = async (session, groupId) => {
  const key = cacheKey(session, groupId);

  try {
    const cached = await redis.client.get(key);
    if (cached !== null) return cached === '1';
  } catch {
    // Redis lỗi thì đi tiếp, chỉ mất cache
  }

  const api = await checkViaApi(session, groupId);
  const allowed = api.ok ? api.allowed : await checkViaMemberCount(groupId);

  // Chỉ cache khi API trả lời được, tránh đóng băng kết quả fallback
  if (api.ok) {
    try {
      await redis.client.set(key, allowed ? '1' : '0', { EX: config.rule.cacheTtl });
    } catch (err) {
      log.warn('Không cache được rule:', err.message);
    }
  }

  return allowed;
};
