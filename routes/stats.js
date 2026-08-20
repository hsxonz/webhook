import express from 'express';
import * as stats from '../lib/stats.js';
import * as redis from '../lib/redis.js';
import * as waha from '../lib/waha.js';
import * as watchdog from '../lib/watchdog.js';
import * as sessionHealth from '../lib/sessionHealth.js';
import * as loss from '../lib/lossMeter.js';
import * as watchlist from '../lib/watchlist.js';
import * as throughput from '../lib/throughput.js';

const router = express.Router();

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Mỗi nhánh kết thúc của một tin nhắn, gom theo ngày. ?day=YYYY-MM-DD xem ngày cũ,
// ?days=N xem nhiều ngày liền.
// ?probe=1 hỏi lại ĐÚNG core cho từng mẫu bị mất, để thấy đáng lẽ lấy được gì.
router.get('/loss', handle(async (req) => (
  req.query.days
    ? loss.reportRange(Number(req.query.days))
    : loss.report(req.query.day, { probe: req.query.probe === '1' })
)));

// Nhịp nhận tin của từng session so với trung bình của chính nó.
router.get('/throughput', handle(() => throughput.report()));

// Chạy ngay một vòng đo thay vì chờ chu kỳ 5 phút.
router.post('/throughput/sweep', handle(async () => ({ found: (await throughput.sweep()) ?? [] })));

// Session trọng tâm: trạng thái sống ở cả hai core + sự kiện gần nhất.
router.get('/watchlist', handle(async () => {
  const names = await watchlist.all();
  const sessions = await waha.getWorkingSessions();
  const live = new Map(sessions.map((s) => [s.name, s]));
  const rows = await Promise.all(names.map(async (name) => {
    const s = live.get(name);
    return {
      session: name,
      status: s ? s.status : 'KHÔNG THẤY',
      core: s ? s.core : null,
      last: await sessionHealth.getLast(name).catch(() => null),
    };
  }));
  return { count: rows.length, sessions: rows };
}));

router.post('/watchlist', handle(async (req) => {
  const { add, remove } = req.body ?? {};
  const added = add ? await watchlist.add(add) : [];
  const removed = remove ? await watchlist.remove(remove) : [];
  return { added, removed, current: await watchlist.all() };
}));

router.get('/health', handle(async () => ({
  ok: redis.isConnected(),
  redis: redis.isConnected() ? 'up' : 'down',
  ...(await stats.getHealthSnapshot()),
  errors: await watchdog.getErrorCounts(),
})));

router.get('/stats/messages', handle(async (req) => ({
  count: await stats.getMessageCount(req.query.session),
})));

router.get('/stats/messages_all', handle(async (req) => {
  const ss = String(req.query.sessions || '').split(',').map((x) => x.trim()).filter(Boolean);
  return { counts: await stats.getMessageCounts(ss) };
}));

router.get('/stats/messages_count', handle(async () => ({
  count: await stats.getTotalMessageCount(),
})));

router.get('/stats/crawlers_count', handle(async () => ({
  count: (await waha.getWorkingSessions()).length,
})));

router.get('/stats/groups_count', handle(async () => ({
  count: await stats.getGroupCount(),
})));

router.get('/stats/users_count', handle(async () => ({
  count: await stats.getUserCount(),
})));

router.get('/stats/groupsInfo', handle(() => stats.getGroups()));

router.get('/stats/users', handle(() => stats.getUsers()));

router.get('/stats/group', handle(async (req) => {
  const info = await redis.getJson(`groupsInfo:${req.query.groupId}`);
  return info ? [info] : { message: 'No groups found' };
}));

router.get('/sessions/health', handle(() => sessionHealth.getAllLast()));

router.get('/sessions/health/kinds', handle(() => sessionHealth.getKindsSeen()));

router.get('/sessions/:session/health', handle(async (req) => ({
  session: req.params.session,
  last: await sessionHealth.getLast(req.params.session),
  history: await sessionHealth.getHistory(req.params.session, Number(req.query.limit) || 50),
})));

export default router;
