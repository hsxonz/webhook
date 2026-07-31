import axios from 'axios';
import moment from 'moment-timezone';
import config from '../config.js';
import * as redis from './redis.js';
import log from './logger.js';

const API = `https://api.telegram.org/bot${config.telegram.botToken}`;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const now = () => moment().tz(config.timezone).format('YYYY-MM-DD HH:mm:ss');

// 435 -> "7 phút 15 giây"
export const humanDuration = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const parts = [];
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) parts.push(`${d} ngày`);
  if (h) parts.push(`${h} giờ`);
  if (m) parts.push(`${m} phút`);
  if (sec || !parts.length) parts.push(`${sec} giây`);
  return parts.join(' ');
};

const numberFmt = (n) => Number(n || 0).toLocaleString('vi-VN');

const tree = (rows) => rows
  .filter(Boolean)
  .map(([label, value], i, arr) => `${i === arr.length - 1 ? '└' : '├'} ${label}: <b>${value}</b>`)
  .join('\n');

const header = (icon, title) =>
  `${icon} <b>${title}</b>\n`
  + `<code>${esc(config.serverName)}${config.serverIp ? ` · ${esc(config.serverIp)}` : ''}</code>`;

export const sendRaw = async (text) => {
  if (!config.telegram.enabled) return false;
  if (!config.telegram.botToken || !config.telegram.chatId) {
    log.warn('Telegram chưa cấu hình, bỏ qua thông báo');
    return false;
  }
  try {
    await axios.post(`${API}/sendMessage`, {
      chat_id: config.telegram.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 10000 });
    return true;
  } catch (err) {
    log.error('Gửi Telegram thất bại:', err.response?.data?.description || err.message);
    return false;
  }
};

// Khoá NX: instance đầu tiên thắng, 9 instance còn lại bỏ qua -> không gửi trùng
export const sendOnce = async (key, text, ttl = config.telegram.repeatSec) => {
  try {
    const won = await redis.client.set(`tg:lock:${key}`, log.instance, { NX: true, EX: ttl });
    if (!won) return false;
  } catch (err) {
    log.warn('Không lấy được khoá Telegram, gửi trực tiếp:', err.message);
  }
  return sendRaw(text);
};

export const clearLock = async (key) => {
  try { await redis.client.del(`tg:lock:${key}`); } catch { /* bỏ qua */ }
};

export const notifyDown = ({ silenceSec, lastMessageAt, stats, errors }) => {
  const hasErrors = errors && errors.total > 0;
  const text = [
    header('🔴', 'WEBHOOK NGỪNG NHẬN TIN NHẮN'),
    '',
    tree([
      ['Im lặng', humanDuration(silenceSec)],
      ['Tin cuối', lastMessageAt ? moment(lastMessageAt).tz(config.timezone).format('YYYY-MM-DD HH:mm:ss') : 'không rõ'],
      ['Hiện tại', now()],
    ]),
    '',
    '📊 <b>Thống kê hôm nay</b>',
    tree([
      ['Tổng tin nhắn', numberFmt(stats.totalMessages)],
      ['Session hoạt động', String(stats.activeSessions)],
      ['Nhóm đã lưu', numberFmt(stats.groupCount)],
      ['Redis', stats.redisOk ? '✅ kết nối' : '❌ mất kết nối'],
    ]),
    hasErrors ? '' : null,
    hasErrors ? '⚠️ <b>Lỗi 15 phút qua</b>' : null,
    hasErrors ? tree([
      ['Upload ảnh Azure', numberFmt(errors.azure)],
      ['Đẩy webhook', numberFmt(errors.forward)],
      ['Rule API', numberFmt(errors.rule)],
    ]) : null,
    '',
    '👉 <code>pm2 logs webhook-server --lines 100</code>',
  ].filter((line) => line !== null).join('\n');

  return sendOnce('watchdog:down', text);
};

export const notifyRecovered = async ({ downSec, stats }) => {
  await clearLock('watchdog:down');
  return sendOnce('watchdog:recovered', [
    header('🟢', 'WEBHOOK ĐÃ HOẠT ĐỘNG TRỞ LẠI'),
    '',
    tree([
      ['Thời gian gián đoạn', humanDuration(downSec)],
      ['Phục hồi lúc', now()],
      ['Tổng tin hôm nay', numberFmt(stats.totalMessages)],
    ]),
  ].join('\n'), 60);
};

export const notifyRedisDown = (errMessage) => sendOnce('redis:down', [
  header('🟠', 'REDIS MẤT KẾT NỐI'),
  '',
  tree([
    ['Thời gian', now()],
    ['Lỗi', esc(errMessage)],
  ]),
  '',
  'Cache group/lids và bộ đếm tin nhắn sẽ không hoạt động.',
].join('\n'));

export const notifyRedisUp = async () => {
  await clearLock('redis:down');
  return sendOnce('redis:up', [
    header('🟢', 'REDIS ĐÃ KẾT NỐI LẠI'),
    '',
    tree([['Thời gian', now()]]),
  ].join('\n'), 60);
};

export const notifyStartup = ({ port, instances }) => sendOnce('startup', [
  header('🚀', 'WEBHOOK SERVER KHỞI ĐỘNG'),
  '',
  tree([
    ['Cổng', String(port)],
    ['Instances', String(instances)],
    ['Môi trường', esc(config.env)],
    ['Thời gian', now()],
  ]),
].join('\n'), 60);

export const notifyErrorSpike = ({ kind, count, windowSec, sample }) => sendOnce(`error:${kind}`, [
  header('🟡', 'TỈ LỆ LỖI CAO'),
  '',
  tree([
    ['Loại', esc(kind)],
    ['Số lỗi', `${numberFmt(count)} / ${humanDuration(windowSec)}`],
    ['Thời gian', now()],
    sample ? ['Ví dụ', esc(String(sample).slice(0, 200))] : null,
  ]),
].join('\n'));
