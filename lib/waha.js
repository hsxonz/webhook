import axios from 'axios';
import config from '../config.js';
import log from './logger.js';

const http = axios.create({
  baseURL: config.waha.baseUrl,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'X-Api-Key': config.waha.apiKey,
  },
});

// Cache lid -> số điện thoại, có giới hạn để không phình bộ nhớ như bản cũ
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
    await http.post(`/api/${session}/chats/${groupId}/messages/read?messages=30&days=7`);
    return true;
  } catch (err) {
    log.error(`Đánh dấu đã đọc ${groupId} lỗi:`, err.message);
    return false;
  }
};

export const getWorkingSessions = async () => {
  try {
    const res = await http.get('/api/sessions?all=false');
    return (res.data || []).filter((s) => s.status === 'WORKING');
  } catch (err) {
    log.error('Lấy danh sách session lỗi:', err.message);
    return [];
  }
};

export const downloadMedia = async (url) => {
  const res = await http.get(url, { responseType: 'arraybuffer', baseURL: undefined });
  return Buffer.from(res.data, 'binary').toString('base64');
};
