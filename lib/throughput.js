// Phát hiện session "WORKING giả": WAHA báo đang chạy nhưng websocket của gows
// đã chết, session không nhận cũng không gửi được gì. Trạng thái của WAHA không
// phản ánh websocket thật nên không có event nào báo - phải tự đo.
//
// Hai lớp:
//   1. So nhịp của session với NHỊP CHUNG cả đàn, không phải với một mốc cố
//      định. Lưu lượng lên xuống theo giờ trong ngày nên mốc cố định sẽ báo
//      nhầm hàng loạt vào giờ thấp điểm.
//   2. Nghi ngờ thì hỏi thẳng websocket. Đây mới là bằng chứng dứt khoát.
import * as redis from './redis.js';
import * as waha from './waha.js';
import * as telegram from './telegram.js';
import * as watchlist from './watchlist.js';
import * as stats from './stats.js';
import log from './logger.js';

const SAMPLE_MS = 5 * 60 * 1000;
// Giữ 24h mẫu để trung bình không bị một giờ cao điểm kéo lệch
const HISTORY_LEN = 288;
// Dưới mức này thì nhóm vốn đã im, so tỉ lệ không có ý nghĩa
const MIN_BASELINE = 30;
// So với CẢ ĐÀN, không phải với mốc tuyệt đối của riêng session.
//
// Lưu lượng WhatsApp lên xuống theo ngày đêm rất mạnh (cao điểm ~31k tin/giờ,
// rạng sáng ~10k). Lấy trung bình phẳng 24h làm mốc thì sáng sớm MỌI session
// đều tụt dưới 30% và bắn cảnh báo hàng loạt - đúng thứ đã xảy ra lúc 08:23
// ngày 04/08. Nhịp cả đàn tự nó phản ánh giờ trong ngày, nên chỉ cần hỏi:
// session này có tụt hơn hẳn phần còn lại không.
const DROP_RATIO = 0.3;
// Phải thấp liên tiếp mấy lần mới báo, tránh nhiễu do nhóm im nhất thời
const CONSECUTIVE = 2;

const rateKey = (s) => `session_rate:${s}`;
const lastKey = (s) => `session_rate:${s}:last`;
const lowKey = (s) => `session_rate:${s}:low`;

let timer = null;

const trimmedMean = (nums) => {
  if (nums.length < 4) return nums.reduce((a, b) => a + b, 0) / (nums.length || 1);
  // Bỏ 10% cao nhất và thấp nhất: một đợt bùng tin hoặc một lần chết
  // không được phép định nghĩa "bình thường".
  const sorted = [...nums].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * 0.1);
  const core = sorted.slice(cut, sorted.length - cut);
  return core.reduce((a, b) => a + b, 0) / core.length;
};

// Bằng chứng dứt khoát: gọi một API phải đi qua websocket của gows.
const websocketAlive = async (session) => {
  try {
    await waha.getGroupCountFor(session);
    return true;
  } catch (err) {
    const msg = err?.response?.data?.exception?.message ?? err.message ?? '';
    if (/websocket not connected/i.test(msg)) return false;
    // Lỗi khác (timeout, 404...) không kết luận được, coi như còn sống
    return true;
  }
};

// Lấy mẫu và tính nhịp của một session. Chưa phán xét gì ở đây - việc so sánh
// cần biết cả đàn đang ở mức nào nên phải làm sau khi lấy mẫu xong tất cả.
const sampleSession = async (session) => {
  const total = await stats.getMessageCount(session);
  const prev = Number(await redis.client.get(lastKey(session))) || null;
  await redis.client.set(lastKey(session), String(total), { EX: 24 * 3600 });

  // Lần đầu gặp, hoặc bộ đếm vừa reset lúc 9h sáng
  if (prev === null || total < prev) return null;

  const delta = total - prev;
  await redis.client.lPush(rateKey(session), String(delta));
  await redis.client.lTrim(rateKey(session), 0, HISTORY_LEN - 1);
  await redis.client.expire(rateKey(session), 7 * 24 * 3600);

  const raw = await redis.client.lRange(rateKey(session), 1, HISTORY_LEN - 1);
  const history = raw.map(Number).filter((n) => Number.isFinite(n));
  if (history.length < 6) return null;

  const baseline = trimmedMean(history);
  // Nhóm vốn im thì so tỉ lệ không nói lên điều gì
  if (baseline < MIN_BASELINE) return null;

  return { session, delta, baseline, ratio: delta / baseline };
};

// Nhịp chung của cả đàn tại thời điểm này. Sáng sớm con số này tự thấp, tối tự
// cao - đó chính là cái thay cho việc phải lưu lịch sử theo giờ trong ngày.
const fleetRatio = (samples) => {
  const totalNow = samples.reduce((s, x) => s + x.delta, 0);
  const totalBase = samples.reduce((s, x) => s + x.baseline, 0);
  return totalBase > 0 ? totalNow / totalBase : 1;
};

const judge = async (s, fleet, watched) => {
  // Cả đàn cùng thấp thì không ai bất thường. Chỉ bắt session tụt hơn HẲN
  // phần còn lại. Chặn dưới 0,05 để lúc cả đàn im hẳn không sinh phép chia
  // cho số quá nhỏ rồi báo bừa.
  const relative = s.ratio / Math.max(fleet, 0.05);
  if (relative >= DROP_RATIO) {
    await redis.client.del(lowKey(s.session));
    return null;
  }

  const lowCount = await redis.client.incr(lowKey(s.session));
  await redis.client.expire(lowKey(s.session), 3600);
  if (lowCount < CONSECUTIVE) return null;

  return {
    session: s.session,
    delta: s.delta,
    baseline: Math.round(s.baseline),
    percent: Math.round(s.ratio * 100),
    fleetPercent: Math.round(fleet * 100),
    relativePercent: Math.round(relative * 100),
    watched,
    alive: await websocketAlive(s.session),
  };
};

export const sweep = async () => {
  // Khoá để chỉ một instance trong cluster làm việc
  const won = await redis.client.set('throughput:sweep:lock', '1', { NX: true, EX: 240 });
  if (!won) return;

  const sessions = await waha.getWorkingSessions();
  const watched = await watchlist.list();
  const coreOf = new Map(sessions.map((s) => [s.name, s.core]));

  // Bước 1: lấy mẫu toàn bộ trước, chưa kết luận gì
  const samples = [];
  for (const s of sessions) {
    try {
      const r = await sampleSession(s.name);
      if (r) samples.push(r);
    } catch (err) {
      log.warn(`Đo nhịp ${s.name} lỗi: ${err.message}`);
    }
  }
  if (samples.length < 3) return [];

  // Bước 2: biết nhịp cả đàn rồi mới xét từng session
  const fleet = fleetRatio(samples);
  const found = [];
  for (const s of samples) {
    try {
      const r = await judge(s, fleet, watched.has(s.session));
      if (r) found.push({ ...r, core: coreOf.get(s.session) ?? null });
    } catch (err) {
      log.warn(`Xét nhịp ${s.session} lỗi: ${err.message}`);
    }
  }

  for (const r of found) {
    const title = r.alive
      ? '⚠️ SESSION TỤT LƯU LƯỢNG'
      : '🚫 SESSION CHẾT CÂM — WEBSOCKET ĐỨT';
    const detail = r.alive
      ? 'Websocket còn sống, có thể nhóm đang im hoặc bị hạn chế.'
      : 'WAHA vẫn báo WORKING nhưng gows mất websocket. Session không nhận cũng không gửi được. Cần restart.';
    const sent = await telegram.sendOnce(
      `throughput:${r.session}:${r.alive ? 'low' : 'dead'}`,
      [
        title,
        '',
        `Nguồn: <b>${r.core === 'new' ? '🟢 CORE MỚI' : '⚪ core cũ'}</b>`,
        `Session: <b>${r.session}</b>${r.watched ? ' 👁 <b>THEO DÕI SÁT</b>' : ''}`,
        `Nhịp hiện tại: <b>${r.delta}</b> tin / 5 phút`,
        `Trung bình của nó: <b>${r.baseline}</b> tin / 5 phút`,
        `Còn <b>${r.percent}%</b> so với chính nó, trong khi cả đàn còn <b>${r.fleetPercent}%</b>`,
        `→ chỉ bằng <b>${r.relativePercent}%</b> mức chung`,
        '',
        detail,
      ].join('\n'),
    );
    if (sent) {
      log.warn(`Session ${r.session} còn ${r.relativePercent}% so với đàn (đàn ${r.fleetPercent}%), websocket ${r.alive ? 'ok' : 'ĐỨT'}`);
    }
  }

  return found;
};

export const report = async () => {
  const sessions = await waha.getWorkingSessions();
  const rows = await Promise.all(sessions.map(async (s) => {
    const raw = await redis.client.lRange(rateKey(s.name), 0, HISTORY_LEN - 1);
    const history = raw.map(Number).filter((n) => Number.isFinite(n));
    const baseline = history.length > 1 ? Math.round(trimmedMean(history.slice(1))) : null;
    return {
      session: s.name,
      core: s.core,
      last5min: history[0] ?? null,
      baseline,
      percent: baseline ? Math.round(((history[0] ?? 0) / baseline) * 100) : null,
      samples: history.length,
    };
  }));
  rows.sort((a, b) => (a.percent ?? 999) - (b.percent ?? 999));
  // Nhịp chung để đối chiếu: một session còn 20% mà cả đàn cũng 20% là bình thường.
  const usable = rows.filter((r) => r.baseline && r.last5min != null);
  const now = usable.reduce((s, r) => s + r.last5min, 0);
  const base = usable.reduce((s, r) => s + r.baseline, 0);
  const fleetPercent = base > 0 ? Math.round((now / base) * 100) : null;
  return {
    threshold: `${DROP_RATIO * 100}% so với nhịp chung`,
    fleetPercent,
    sessions: rows,
  };
};

export const start = () => {
  if (timer) return;
  timer = setInterval(() => { sweep().catch((e) => log.error('Quét lưu lượng lỗi:', e.message)); }, SAMPLE_MS);
  timer.unref();
  log.info(`Theo dõi lưu lượng: mỗi ${SAMPLE_MS / 60000} phút, báo khi dưới ${DROP_RATIO * 100}% trung bình`);
};

export const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
