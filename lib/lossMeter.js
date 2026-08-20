// Đếm từng nhánh kết thúc của một webhook tin nhắn, gom theo ngày.
//
// watchdog.recordError dùng cửa sổ trượt 900s nên không trả lời được câu hỏi
// "một ngày mất bao nhiêu". Và nhánh mất tin nặng nhất - không giải được LID ra
// số điện thoại - trước đây `return` trống, không để lại dấu vết nào.
//
// Chỉ đo, không đổi hành vi: tin nhắn vẫn bị bỏ đúng như trước. Phần `detail`
// và `?probe=1` chỉ để chứng minh cái gì đáng lẽ lấy được, chưa sửa gì cả.
import axios from 'axios';
import config from '../config.js';
import * as redis from './redis.js';
import moment from 'moment-timezone';

const TTL_SEC = 30 * 24 * 3600;
const SAMPLES_PER_KIND = 50;

export const FORWARDED = 'forwarded';
export const SKIP_NOT_GROUP = 'skip_not_group';
export const SKIP_RULES = 'skip_rules';
export const LOST_NO_SENDER = 'lost_no_sender';
export const LOST_FORWARD = 'lost_forward';
export const LOST_THROWN = 'lost_thrown';
export const LOST_BAD_PAYLOAD = 'lost_bad_payload';
export const IMAGE_FAILED = 'image_failed';

export const LOSS_KINDS = [LOST_NO_SENDER, LOST_FORWARD, LOST_THROWN, LOST_BAD_PAYLOAD];

const today = () => moment().tz(config.timezone).format('YYYY-MM-DD');
const key = (day) => `webhook:loss:${day}`;
const detailKey = (day, kind) => `${key(day)}:detail:${kind}`;

export const bump = async (kind, sample, detail) => {
  try {
    const k = key(today());
    await redis.client.hIncrBy(k, kind, 1);
    await redis.client.expire(k, TTL_SEC);
    if (sample && LOSS_KINDS.includes(kind)) {
      const dk = detailKey(today(), kind);
      const size = await redis.client.hLen(dk);
      // Giữ mẫu cũ nhất, không cuộn vòng: cần bằng chứng ổn định để đối chiếu.
      if (size < SAMPLES_PER_KIND) {
        await redis.client.hSet(dk, String(sample).slice(0, 300), JSON.stringify(detail ?? {}));
        await redis.client.expire(dk, TTL_SEC);
      }
    }
  } catch {
    // đo đạc hỏng thì im lặng, tuyệt đối không chặn đường tin nhắn
  }
};

// Sổ core dùng chung với queue_api / whatsapp_api. Chỉ đọc.
const NEW_CORE_KEY = 'waha:core:new';
const NEW_BASE = process.env.WAHA_NEW_BASE_URL || '';
const NEW_KEY = process.env.WAHA_NEW_API_KEY || '';

const coreOf = async (session) => {
  try {
    return (await redis.client.sIsMember(NEW_CORE_KEY, String(session))) ? 'new' : 'old';
  } catch {
    return 'old';
  }
};

// Hỏi ĐÚNG core xem LID đó ra số nào. Đây chính là thứ đường tin nhắn đang làm
// sai: nó luôn hỏi core cũ, nên session nằm ở core mới thì trả 422.
const probeLid = async (session, lid) => {
  const core = await coreOf(session);
  const base = core === 'new' ? NEW_BASE : config.waha.baseUrl;
  const apiKey = core === 'new' ? NEW_KEY : config.waha.apiKey;
  if (!base) return { core, ok: false, error: 'chưa cấu hình base url cho core này' };
  try {
    const res = await axios.get(`${base}/api/${session}/lids/${lid}`, {
      timeout: 10000,
      headers: { 'X-Api-Key': apiKey },
    });
    return { core, ok: true, pn: res.data?.pn ?? null };
  } catch (err) {
    return {
      core,
      ok: false,
      status: err?.response?.status ?? null,
      error: err?.response?.data?.error ?? err.message,
    };
  }
};

const withProbe = async (samples) => {
  const out = {};
  for (const [k, v] of Object.entries(samples)) {
    const [session, lid] = k.split('|');
    out[k] = { ...v };
    if (lid && lid.includes('@lid')) out[k].probe = await probeLid(session, lid);
  }
  return out;
};

export const report = async (day = today(), { probe = false } = {}) => {
  const counts = (await redis.client.hGetAll(key(day))) || {};
  const num = (k) => Number(counts[k] || 0);

  const forwarded = num(FORWARDED);
  const lost = LOSS_KINDS.reduce((s, k) => s + num(k), 0);
  const handled = forwarded + lost;

  const samples = {};
  for (const k of LOSS_KINDS) {
    if (num(k) === 0) continue;
    const raw = (await redis.client.hGetAll(detailKey(day, k))) || {};
    const parsed = {};
    for (const [sample, json] of Object.entries(raw)) {
      try { parsed[sample] = JSON.parse(json); } catch { parsed[sample] = {}; }
    }
    samples[k] = probe ? await withProbe(parsed) : parsed;
  }

  return {
    day,
    forwarded,
    lost,
    lostRate: handled ? Number(((lost / handled) * 100).toFixed(3)) : 0,
    skipped: num(SKIP_NOT_GROUP) + num(SKIP_RULES),
    imageFailed: num(IMAGE_FAILED),
    breakdown: {
      [LOST_NO_SENDER]: num(LOST_NO_SENDER),
      [LOST_FORWARD]: num(LOST_FORWARD),
      [LOST_THROWN]: num(LOST_THROWN),
      [LOST_BAD_PAYLOAD]: num(LOST_BAD_PAYLOAD),
      [SKIP_NOT_GROUP]: num(SKIP_NOT_GROUP),
      [SKIP_RULES]: num(SKIP_RULES),
    },
    samples,
  };
};

export const reportRange = async (days = 7) => {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = moment().tz(config.timezone).subtract(i, 'days').format('YYYY-MM-DD');
    out.push(await report(d));
  }
  return out;
};
