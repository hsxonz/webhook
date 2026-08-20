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
import * as loss from '../lib/lossMeter.js';
import * as redis from '../lib/redis.js';

const router = express.Router();

const invalidateGroupCache = (session, payload) => {
  const raw = payload?.event ?? payload?.Event ?? '';
  const kind = String(raw).replace(/^\*?(events|gows|whatsmeow)\./, '');
  const data = payload?.data ?? payload?.Data ?? payload ?? {};
  const changed =
    kind === 'JoinedGroup' ||
    (kind === 'GroupInfo' && ((data.Join?.length ?? 0) > 0 || (data.Leave?.length ?? 0) > 0));
  if (!changed) return;
  redis.client
    .del([`groups:${session}`, `groupCount:${session}`])
    .then(() => log.info(`[GROUP-CACHE] xoa cache nhom cua ${session} sau su kien ${kind}`))
    .catch((err) => log.error('Xoa cache nhom loi:', err.message));
};
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

const AZURE_HOSTS = ['blob.core.windows.net', 'azurefd.net'];
const alreadyOnAzure = (url) => AZURE_HOSTS.some((h) => url.includes(h));

const resolveImage = async (payload, session) => {
  if (!payload.hasMedia || !payload.media?.url) return '';
  // Core mới ghi thẳng media lên Azure, nên url trả về đã là link Azure. Tải về
  // rồi upload lại chỉ tốn băng thông và tạo bản trùng trong cùng container.
  if (alreadyOnAzure(payload.media.url)) return payload.media.url;
  try {
    const base64 = await waha.downloadMedia(payload.media.url, session);
    return await azure.uploadImage(base64);
  } catch (err) {
    await watchdog.recordError('azure', err.message);
    await loss.bump(loss.IMAGE_FAILED);
    return '';
  }
};

const handleMessage = async (session, payload) => {
  processed += 1;
  await Promise.all([
    stats.incrementMessageCount(session),
    watchdog.markMessageReceived(),
  ]);

  if (!payload._data.Info.IsGroup) {
    await loss.bump(loss.SKIP_NOT_GROUP);
    return;
  }

  const groupId = payload.from;
  if (!(await rules.shouldProcess(session, groupId))) {
    await loss.bump(loss.SKIP_RULES);
    return;
  }

  const senderId = await resolveSenderId(payload.participant, session);
  if (!senderId) {
    // Không tra được @lid ra số thật thì tin bị bỏ hẳn, mà WAHA đã nhận 200
    // nên không có lần gửi lại nào. Trước đây nhánh này không để lại dấu vết.
    // Ghi kèm các trường whatsmeow gửi sẵn trong payload để đối chiếu xem
    // đáng lẽ có lấy được số mà không cần tra ngược hay không.
    const info = payload._data?.Info ?? {};
    await loss.bump(loss.LOST_NO_SENDER, `${session}|${payload.participant}|${payload.id}`, {
      senderAlt: info.SenderAlt ?? null,
      addressingMode: info.AddressingMode ?? null,
      sender: info.Sender ?? null,
      pushName: info.PushName ?? null,
      at: new Date().toISOString(),
    });
    return;
  }

  const image = await resolveImage(payload, session);

  log.event(`Tin nhắn #${processed} · group ${groupId} · session ${session}`);

  const sent = await forwardMessage({
    msg_id: payload.id,
    message: payload.body || '',
    groupName: '',
    senderName: payload._data.Info.PushName || senderId,
    senderPhone: senderId,
    time: new Date().toISOString(),
    image,
    session,
  });
  await loss.bump(sent ? loss.FORWARDED : loss.LOST_FORWARD, sent ? null : `${session}|${payload.id}`);

  await readTracker.track(groupId, session);
};

router.post('/webhook', async (req, res) => {
  const { event, session = 'default', payload } = req.body || {};
  // WAHA gắn header này theo customHeaders trong config session
  const core = req.get('X-Waha-Core') === 'new' ? 'new' : 'old';

  if (event === 'engine.event' && core === 'new') {
    invalidateGroupCache(session, payload);
  }

  if (event !== 'message' && event !== 'message.any') {
    const entry = sessionHealth.extract(event, payload, core);
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
    loss.bump(loss.LOST_BAD_PAYLOAD, `${session}|${payload?.id ?? '?'}`).catch(() => {});
    return res.status(200).send('OK');
  }

  // Trả lời ngay rồi xử lý nền: bản cũ await cả pipeline nên WAHA bị timeout khi tải cao
  res.status(200).send('OK');

  handleMessage(session, payload).catch((err) => {
    log.error('Xử lý webhook lỗi:', err.message);
    loss.bump(loss.LOST_THROWN, `${session}|${payload?.id ?? '?'}|${err.message}`).catch(() => {});
  });
});

export default router;
