import express from 'express';
import * as stats from '../lib/stats.js';
import * as redis from '../lib/redis.js';
import * as waha from '../lib/waha.js';
import * as watchdog from '../lib/watchdog.js';
import * as sessionHealth from '../lib/sessionHealth.js';

const router = express.Router();

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

router.get('/health', handle(async () => ({
  ok: redis.isConnected(),
  redis: redis.isConnected() ? 'up' : 'down',
  ...(await stats.getHealthSnapshot()),
  errors: await watchdog.getErrorCounts(),
})));

router.get('/stats/messages', handle(async (req) => ({
  count: await stats.getMessageCount(req.query.session),
})));

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
