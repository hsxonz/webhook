import axios from 'axios';
import config from '../config.js';
import * as redis from './redis.js';
import log from './logger.js';

// Hai core WAHA chạy song song. Trước đây file này chỉ có một baseURL trỏ core
// cũ, nên mọi lời gọi cho session đã dời sang core mới đều gặp bản sót đang
// STOPPED và trả 422 - tin nhắn của các session đó bị vứt vì không tra được số
// người gửi. Sổ Redis dùng chung với queue_api / whatsapp_api quyết định core.
const REGISTRY_KEY = 'waha:core:new';
const CACHE_TTL_MS = 5_000;

const build = (waha) => axios.create({
  baseURL: waha.baseUrl,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'X-Api-Key': waha.apiKey,
  },
});

const clients = {
  old: build(config.waha),
  new: config.wahaNew.baseUrl ? build(config.wahaNew) : null,
};

let newCore = null;
let newCoreAt = 0;

const newCoreSessions = async () => {
  if (newCore && Date.now() - newCoreAt < CACHE_TTL_MS) return newCore;
  try {
    newCore = new Set(await redis.client.sMembers(REGISTRY_KEY));
    newCoreAt = Date.now();
  } catch (err) {
    log.warn('Không đọc được sổ core từ Redis:', err.message);
    // Mất Redis thì coi như mọi session ở core cũ - trạng thái trước khi có
    // tính năng này, an toàn hơn là hỏi nhầm core.
    if (!newCore) newCore = new Set();
  }
  return newCore;
};

const clientFor = async (session) => {
  if (!clients.new) return clients.old;
  return (await newCoreSessions()).has(String(session)) ? clients.new : clients.old;
};

// Hai biến môi trường WAHA_BASE_URL và WAHA_NEW_BASE_URL hiện trỏ CÙNG một nơi
// (chỉ còn một core gows tự dựng). Nếu vẫn trả về cả hai thì mọi thứ đếm qua
// getWorkingSessions đều nhân đôi - dashboard từng báo 48 crawler trên 24 session
// thật, và tổng số tin nhắn cũng gấp đôi theo.
const activeClients = () => {
  if (!clients.new) return [['old', clients.old]];
  if (config.wahaNew.baseUrl === config.waha.baseUrl) return [['new', clients.new]];
  return [['old', clients.old], ['new', clients.new]];
};

// Cache lid -> số điện thoại, có giới hạn để không phình bộ nhớ như bản cũ.
// Ánh xạ này giống nhau ở mọi session nên không cần tách theo session.
const LID_CACHE_MAX = 50000;
const lidCache = new Map();

const cacheLid = (key, value) => {
  if (lidCache.size >= LID_CACHE_MAX) {
    lidCache.delete(lidCache.keys().next().value);
  }
  lidCache.set(key, value);
};

export const getContactInfo = async (contact, session = 'default') => {
  if (lidCache.has(contact)) return lidCache.get(contact);
  try {
    const http = await clientFor(session);
    const res = await http.get(`/api/${session}/lids/${contact}`);
    const result = { status: true, data: res.data };
    cacheLid(contact, result);
    return result;
  } catch (err) {
    log.error(`Lấy thông tin contact ${contact} lỗi:`, err.message);
    return { status: false, data: null };
  }
};

export const readMessages = async (groupId, session) => {
  try {
    const http = await clientFor(session);
    await http.post(`/api/${session}/chats/${groupId}/messages/read?messages=30&days=7`);
    return true;
  } catch (err) {
    log.error(`Đánh dấu đã đọc ${groupId} lỗi:`, err.message);
    return false;
  }
};

export const getWorkingSessions = async () => {
  const perCore = await Promise.all(activeClients().map(async ([core, http]) => {
    try {
      const res = await http.get('/api/sessions?all=false');
      return (res.data || [])
        .filter((s) => s.status === 'WORKING')
        .map((s) => ({ ...s, core }));
    } catch (err) {
      log.error(`Lấy danh sách session core ${core} lỗi:`, err.message);
      return [];
    }
  }));
  return perCore.flat();
};

// Lời gọi này bắt buộc đi qua websocket của gows, nên nó là cách duy nhất biết
// websocket còn sống hay không - trạng thái WORKING của WAHA không nói lên điều đó.
// Cố tình KHÔNG bắt lỗi: phía gọi cần đọc được thông điệp "websocket not connected".
// Danh sach MOI session bat ke trang thai. Dung de phan biet "session dang
// hong" voi "session khong con ton tai" - cai thu hai thi khong co gi phai cho
// hoi phuc nua.
export const getAllSessionNames = async () => {
  const perCore = await Promise.all(activeClients().map(async ([core, http]) => {
    try {
      const res = await http.get('/api/sessions?all=true');
      return (res.data || []).map((s) => s.name);
    } catch (err) {
      log.error(`Lay danh sach session (all) core ${core} loi:`, err.message);
      throw err;
    }
  }));
  return perCore.flat();
};

export const getGroupCountFor = async (session) => {
  const http = await clientFor(session);
  const res = await http.get(`/api/${session}/groups/count`, { timeout: 25000 });
  return res.data?.count ?? 0;
};

export const downloadMedia = async (url, session) => {
  const http = await clientFor(session);
  const res = await http.get(url, { responseType: 'arraybuffer', baseURL: undefined });
  return Buffer.from(res.data, 'binary').toString('base64');
};
