import express from 'express';
import axios from 'axios';
import config from '../config.js';
import log from '../lib/logger.js';
import * as azure from '../lib/azure.js';
import * as waha from '../lib/waha.js';
import * as rules from '../lib/rules.js';
import * as stats from '../lib/stats.js';
import * as watchdog from '../lib/watchdog.js';
import * as readTracker from '../lib/readTracker.js';
import * as sessionHealth from '../lib/sessionHealth.js';

const router = express.Router();
let processed = 0;

const forwardMessage = async (payload) => {
  try {
    await axios.post(config.forwardWebhookUrl, payload, { timeout: 15000 });
    return true;
  } catch (err) {
    log.error('Đẩy webhook thất bại:', err.message);
    await watchdog.recordError('forward', err.message);
    return false;
  }
};

const resolveSenderId = async (participant, session) => {
  if (!participant) return null;
  if (!participant.includes('lid')) return participant.split('@')[0];

  const info = await waha.getContactInfo(participant, session);
  return info.status ? info.data.pn.split('@')[0] : null;
};

const resolveImage = async (payload) => {
  if (!payload.hasMedia || !payload.media?.url) return '';
  try {
    const base64 = await waha.downloadMedia(payload.media.url);
    return await azure.uploadImage(base64);
  } catch (err) {
    await watchdog.recordError('azure', err.message);
    return '';
  }
};

const handleMessage = async (session, payload) => {
  processed += 1;
  await Promise.all([
    stats.incrementMessageCount(session),
    watchdog.markMessageReceived(),
  ]);

  if (!payload._data.Info.IsGroup) return;

  const groupId = payload.from;
  if (!(await rules.shouldProcess(session, groupId))) return;

  const senderId = await resolveSenderId(payload.participant, session);
  if (!senderId) return;

  const image = await resolveImage(payload);

  log.event(`Tin nhắn #${processed} · group ${groupId} · session ${session}`);

  await forwardMessage({
    msg_id: payload.id,
    message: payload.body || '',
    groupName: '',
    senderName: payload._data.Info.PushName || senderId,
    senderPhone: senderId,
    time: new Date().toISOString(),
    image,
    session,
  });

  await readTracker.track(groupId, session);
};

router.post('/webhook', async (req, res) => {
  const { event, session = 'default', payload } = req.body || {};

  if (event !== 'message' && event !== 'message.any') {
    const entry = sessionHealth.extract(event, payload);
    if (entry) {
      res.status(200).send('OK');
      sessionHealth.record(session, entry).catch((err) => {
        log.error('Ghi session health lỗi:', err.message);
      });
      return;
    }
    return res.status(200).send('OK');
  }
  if (!payload?._data?.Info) {
    log.warn('Payload không đúng định dạng, bỏ qua');
    return res.status(200).send('OK');
  }

  // Trả lời ngay rồi xử lý nền: bản cũ await cả pipeline nên WAHA bị timeout khi tải cao
  res.status(200).send('OK');

  handleMessage(session, payload).catch((err) => {
    log.error('Xử lý webhook lỗi:', err.message);
  });
});

export default router;
