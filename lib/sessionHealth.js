import moment from 'moment-timezone';
import config from '../config.js';
import * as redis from './redis.js';
import log from './logger.js';
import * as auditLog from './auditLog.js';
import * as telegram from './telegram.js';
import * as watchlist from './watchlist.js';
import * as waha from './waha.js';

const HISTORY_LEN = 200;
const TTL_SEC = 30 * 24 * 60 * 60;

const eventsKey = (session) => `session_health:events:${session}`;
const lastKey = (session) => `session_health:last:${session}`;
// Giữ danh sách session có sự cố, để không phải SCAN keyspace khi đọc
const INDEX_KEY = 'session_health:sessions';
// Đếm các loại engine.event hiếm, để biết thực tế session phát ra những gì.
// Bỏ qua nhóm khối lượng lớn: chúng chiếm hầu hết lưu lượng và không mang tin
// gì về sức khoẻ tài khoản, đếm chỉ tổ thêm việc cho Redis trên luồng nóng.
const SEEN_KEY = 'session_health:kinds_seen';
// Sổ theo dõi session đang mất kết nối: score = mốc thời gian đứt.
// Chỉ báo khi đứt LÂU, vì đứt rồi nối lại trong vài giây là chuyện thường.
// Sự cố kết nối tự lành trong vài giây là chuyện thường, chỉ báo khi kéo dài.
// Mỗi loại có một sổ riêng: mở khi gặp sự cố, đóng khi có dấu hiệu phục hồi.
const ALERT_AFTER_SEC = 300;
// Quá mốc này thì thôi nhắc: session đã chết hẳn hoặc bị xoá, nhắc nữa chỉ là ồn
const GIVE_UP_AFTER_SEC = 6 * 60 * 60;
const PENDING = {
  Disconnected: {
    key: 'session_health:pending:disconnected',
    label: 'MẤT KẾT NỐI',
    detail: 'Bình thường session tự nối lại trong vài giây.',
  },
  KeepAliveTimeout: {
    key: 'session_health:pending:keepalive',
    label: 'MẤT NHỊP GIỮ KẾT NỐI',
    detail: 'Đường truyền hoặc proxy đang yếu. Bình thường phục hồi trong vài chục giây.',
  },
  // Mỗi lần dừng/khởi động lại session đều có thể sinh ra sự kiện này khi socket
  // cũ chưa đóng hẳn, và nó tự hết trong vài giây. Chỉ đáng báo khi kéo dài, vì
  // lúc đó mới đúng nghĩa "hai nơi cùng chạy một session và đá nhau".
  StreamReplaced: {
    key: 'session_health:pending:streamreplaced',
    label: 'BỊ ĐÁ KHỎI KẾT NỐI',
    detail: 'Có nơi khác dùng cùng bộ khoá của session này.',
    alertAfterSec: 60,
  },
};
// Event báo hiệu đã phục hồi -> đóng sổ tương ứng
const RESOLVES = {
  KeepAliveRestored: 'KeepAliveTimeout',
  ConnectedEventData: 'Disconnected',
};
const HOT_KINDS = new Set([
  'Message',
  'IdentityChange',
  'GroupInfo',
  'UndecryptableMessage',
  'Receipt',
  'ChatPresence',
  'Presence',
]);

// Mã whatsmeow gửi kèm events.TemporaryBan
const BAN_REASONS = {
  101: 'gửi tin cho quá nhiều người chưa lưu số bạn',
  102: 'quá nhiều người chặn bạn',
  103: 'tạo quá nhiều nhóm với người chưa lưu số bạn',
  104: 'gửi cùng một nội dung cho quá nhiều người',
  106: 'gửi quá nhiều tin vào broadcast list',
};

// Mã whatsmeow gửi kèm events.ConnectFailure / events.LoggedOut
const CONNECT_FAILURE_REASONS = {
  400: 'lỗi chung',
  401: 'đã logout khỏi thiết bị (thường do người dùng tự gỡ liên kết) — quét QR lại là dùng tiếp',
  402: 'bị cấm tạm thời',
  403: 'máy chính bị gỡ liên kết (WhatsApp Web gọi là LOCKED) — có thể do bị cấm, cũng có thể do đổi điện thoại',
  405: 'client quá cũ, WhatsApp từ chối',
  406: 'TÀI KHOẢN BỊ CẤM VĨNH VIỄN — WhatsApp Web gọi mã này là BANNED',
  409: 'user agent không hợp lệ',
  413: 'CAT hết hạn',
  414: 'CAT không hợp lệ',
  415: 'không tìm thấy',
  418: 'mã lạ',
  500: 'lỗi phía WhatsApp',
  501: 'tính năng thử nghiệm',
  503: 'WhatsApp tạm ngưng phục vụ',
};

// Mức độ dùng để chọn icon và để bạn lọc lại sau này
const SEVERITY = {
  TemporaryBan: 'critical',
  LoggedOut: 'critical',
  ReachoutTimelock: 'critical',
  ConnectFailure: 'warning',
  ClientOutdated: 'warning',
  StreamReplaced: 'warning',
  PairError: 'warning',
  PairPasskeyError: 'warning',
  QRScannedWithoutMultidevice: 'warning',
  KeepAliveTimeout: 'info',
  KeepAliveRestored: 'info',
  StreamError: 'info',
  Blocklist: 'info',
  GroupSuspended: 'warning',
  GroupUnsuspended: 'info',
  Disconnected: 'info',
  QR: 'info',
  PairSuccess: 'info',
  PrivacySettings: 'info',
  status: 'info',
};

const ICONS = { critical: '🚫', warning: '⚠️', info: 'ℹ️' };

// Loại vẫn ghi vào log/lịch sử nhưng KHÔNG bắn Telegram.
// IdentityChange chỉ là liên hệ đổi máy - không nói gì về tài khoản mình.
const SILENT_KINDS = new Set([
  'status',
  'QR',
  'Disconnected',
  'KeepAliveTimeout',
  'KeepAliveRestored',
]);

const describe = (kind, code) => {
  if (code === undefined || code === null) return null;
  const table = kind === 'TemporaryBan' ? BAN_REASONS : CONNECT_FAILURE_REASONS;
  return table[code] ?? `mã ${code} chưa rõ nghĩa`;
};

const PERMANENT_CODES = new Set([403, 406]);
const RELINK_CODES = new Set([401]);

const nsToSec = (ns) => (ns ? Math.round(ns / 1e9) : null);

/**
 * Rút thông tin sức khoẻ tài khoản từ một event webhook.
 * Nhận cả event đã map của WAHA lẫn engine.event thô từ gows.
 * Trả về null nếu event không nói gì về sức khoẻ session.
 */
export const extract = (event, payload, core = 'old') => {
  const at = moment().tz(config.timezone).format('YYYY-MM-DD HH:mm:ss');

  if (event === 'session.status') {
    return { at, core, kind: 'status', severity: 'info', status: payload?.status ?? null };
  }

  if (event !== 'engine.event') return null;

  // gows đặt tên theo kiểu Go: "*events.TemporaryBan"
  const raw = payload?.event ?? payload?.Event ?? '';
  const kind = String(raw).replace(/^\*?(events|gows|whatsmeow)\./, '');
  const data = payload?.data ?? payload?.Data ?? payload ?? {};
  const base = { at, core, kind, severity: SEVERITY[kind] ?? 'info' };

  if (kind && !HOT_KINDS.has(kind)) redis.client.hIncrBy(SEEN_KEY, kind, 1).catch(() => {});

  switch (kind) {
    // ---- Cấm / mất tài khoản ----
    case 'TemporaryBan':
      return {
        ...base,
        code: data.Code ?? null,
        expiresInSec: nsToSec(data.Expire),
        reason: describe(kind, data.Code),
      };
    case 'LoggedOut': {
      const code = data.Reason ?? null;
      return {
        ...base,
        code,
        // Gỡ liên kết là việc phải xử lý nhưng không mất tài khoản, nên hạ khỏi
        // mức critical để phân biệt với 406 - cấm vĩnh viễn thật.
        severity: RELINK_CODES.has(code) ? 'warning' : base.severity,
        permanent: PERMANENT_CODES.has(code),
        needsRelink: RELINK_CODES.has(code),
        onConnect: data.OnConnect ?? null,
        reason: describe(kind, code),
      };
    }
    case 'ConnectFailure':
      return {
        ...base,
        code: data.Reason ?? null,
        message: data.Message ?? null,
        reason: describe(kind, data.Reason),
      };

    // ---- Cảnh báo sớm: WhatsApp hạn chế nhắn người lạ ----
    case 'NotifyAccountReachoutTimelock': {
      // gows chủ động hỏi trạng thái này mỗi lần connect (gows.go:62), nên event
      // bắn cả khi tài khoản BÌNH THƯỜNG. Struct whatsmeow dùng omitempty nên
      // lúc không bị hạn chế thì mọi trường vắng mặt -> chỉ báo khi active=true.
      const active = data.is_active ?? data.IsActive ?? false;
      if (active !== true) return null;
      return {
        ...base,
        kind: 'ReachoutTimelock',
        severity: 'critical',
        active: true,
        enforcementType: data.enforcement_type ?? data.EnforcementType ?? null,
        endsAt: data.time_enforcement_ends ?? data.TimeEnforcementEnds ?? null,
        reason: 'WhatsApp đang hạn chế khả năng nhắn cho người lạ của tài khoản này',
      };
    }

    // ---- Kết nối ----
    case 'ClientOutdated':
      return { ...base, reason: 'client quá cũ, cần nâng engine' };
    case 'StreamReplaced':
      return { ...base, reason: 'session bị kết nối từ nơi khác, bản này bị đá ra' };
    case 'StreamError':
      return { ...base, code: data.Code ?? null, reason: 'stream lỗi' };
    case 'KeepAliveTimeout':
      return {
        ...base,
        failedCount: data.ErrorCount ?? data.FailedCount ?? null,
        reason: 'mất nhịp giữ kết nối, đường truyền hoặc proxy đang yếu',
      };
    case 'KeepAliveRestored':
      return { ...base, reason: 'nhịp giữ kết nối đã phục hồi' };
    case 'Disconnected':
      return { ...base, reason: 'mất kết nối tới WhatsApp' };

    // ---- Ghép thiết bị ----
    case 'PairSuccess':
      return { ...base, jid: data.ID ?? null, reason: 'ghép thiết bị thành công' };
    case 'PairError':
      return { ...base, message: data.Error ?? null, reason: 'ghép thiết bị thất bại' };
    case 'PairPasskeyError':
      return { ...base, message: data.Error ?? null, reason: 'passkey ghép thiết bị lỗi' };
    case 'QRScannedWithoutMultidevice':
      return { ...base, reason: 'quét QR khi chưa bật multi-device' };
    case 'QR':
      return { ...base, reason: 'session đang chờ quét QR' };

    // ---- Nhóm bị WhatsApp đình chỉ ----
    // Nhóm vẫn nằm trong danh sách và mình vẫn là thành viên, nhưng mọi lần
    // gửi đều trả 401. Không bắt event này thì chỉ biết khi bài đăng hỏng.
    case 'GroupInfo': {
      if (data.Suspended) {
        return {
          ...base,
          kind: 'GroupSuspended',
          severity: 'warning',
          jid: data.JID ?? null,
          reason: 'WhatsApp đã đình chỉ nhóm này - gửi tin vào sẽ luôn lỗi 401',
        };
      }
      if (data.Unsuspended) {
        return {
          ...base,
          kind: 'GroupUnsuspended',
          severity: 'info',
          jid: data.JID ?? null,
          reason: 'nhóm đã được gỡ đình chỉ, gửi tin lại được',
        };
      }
      return null;
    }

    // ---- Ít giá trị nhưng vẫn ghi, lọc lại sau ----
    case 'Blocklist':
      return {
        ...base,
        action: data.Action ?? null,
        changeCount: Array.isArray(data.Changes) ? data.Changes.length : null,
        reason: 'danh sách chặn của tài khoản thay đổi',
      };
    case 'PrivacySettings':
      return { ...base, reason: 'cài đặt riêng tư của tài khoản thay đổi' };

    default:
      return null;
  }
};

/** Ghi lại một sự cố, giữ HISTORY_LEN bản gần nhất mỗi session. */
export const record = async (session, entry) => {
  if (!entry) return;
  const payload = JSON.stringify({ session, ...entry });
  try {
    await redis.client
      .multi()
      .lPush(eventsKey(session), payload)
      .lTrim(eventsKey(session), 0, HISTORY_LEN - 1)
      .expire(eventsKey(session), TTL_SEC)
      .set(lastKey(session), payload, { EX: TTL_SEC })
      .sAdd(INDEX_KEY, session)
      .exec();
  } catch (err) {
    log.error('Không ghi được session health:', err.message);
    return;
  }

  auditLog.write({ session, ...entry });

  await trackConnectivity(session, entry);

  if (entry.kind === 'status') {
    log.event(`Session ${session} → ${entry.status}`);
    return;
  }

  const parts = [`Session ${session}: ${entry.kind}`];
  if (entry.code !== undefined && entry.code !== null) parts.push(`mã ${entry.code}`);
  if (entry.reason) parts.push(entry.reason);
  if (entry.expiresInSec) parts.push(`hết cấm sau ${telegram.humanDuration(entry.expiresInSec)}`);
  log.warn(parts.join(' · '));

  if (SILENT_KINDS.has(entry.kind)) return;
  await alert(session, entry);
};

/** Mở/đóng sổ theo dõi sự cố kết nối. */
const trackConnectivity = async (session, entry) => {
  try {
    if (PENDING[entry.kind]) {
      await redis.client.zAdd(
        PENDING[entry.kind].key,
        [{ score: Date.now(), value: session }],
        { NX: true },
      );
      return;
    }

    // LoggedOut và QR là trạng thái riêng, đã có cảnh báo của chúng. Giữ trong
    // sổ mất-kết-nối nữa thì nhắc trùng về một sự cố đã báo bằng đường khác.
    if (entry.kind === 'LoggedOut' || entry.kind === 'QR') {
      for (const cfg of Object.values(PENDING)) {
        await redis.client.zRem(cfg.key, session);
      }
      return;
    }

    const resolved = RESOLVES[entry.kind];
    if (resolved) {
      await redis.client.zRem(PENDING[resolved].key, session);
    }
    // Session chạy lại được thì mọi sự cố kết nối coi như hết
    if (entry.kind === 'status' && entry.status === 'WORKING') {
      for (const cfg of Object.values(PENDING)) {
        await redis.client.zRem(cfg.key, session);
      }
    }
  } catch (err) {
    log.warn('Không cập nhật được sổ sự cố:', err.message);
  }
};

/**
 * Quét các session gặp sự cố kết nối quá lâu mà chưa phục hồi.
 * Chạy trên mọi instance nhưng khoá Redis đảm bảo chỉ một instance làm việc.
 */
export const sweepDisconnected = async () => {
  try {
    const won = await redis.client.set('session_health:sweep:lock', log.instance, { NX: true, EX: 55 });
    if (!won) return;

    const watched = await watchlist.list();

    // Sổ chỉ đóng khi có event CHUYỂN trạng thái. Nếu sự cố đến sau lúc session
    // đã WORKING (ví dụ StreamReplaced bắn muộn vài giây), sẽ không còn status
    // nào tới nữa và mục kẹt lại vĩnh viễn -> báo động giả kéo dài hàng giờ.
    // Vì vậy hỏi thẳng WAHA trạng thái thật trước khi báo.
    let live = null;
    try {
      live = new Set((await waha.getWorkingSessions()).map((s) => s.name));
    } catch (err) {
      // Không hỏi được thì giữ hành vi cũ, thà báo thừa còn hơn bỏ sót.
      log.warn('Không kiểm tra được trạng thái sống:', err.message);
    }

    for (const [kind, cfg] of Object.entries(PENDING)) {
      const normal = cfg.alertAfterSec ?? ALERT_AFTER_SEC;
      // Session trọng tâm được báo sớm hơn một nửa. Quét theo ngưỡng thấp hơn
      // trong hai, rồi lọc lại từng session theo ngưỡng của riêng nó.
      const forWatched = Math.max(30, Math.round(normal / 2));
      const stale = await redis.client.zRangeByScore(
        cfg.key, 0, Date.now() - Math.min(normal, forWatched) * 1000,
      );
      const giveUp = Date.now() - GIVE_UP_AFTER_SEC * 1000;
      for (const session of stale) {
        const since = await redis.client.zScore(cfg.key, session);
        if (since && since < giveUp) {
          await redis.client.zRem(cfg.key, session);
          log.warn(`Session ${session} ${cfg.label} quá ${GIVE_UP_AFTER_SEC / 3600}h, ngừng nhắc`);
          continue;
        }
        // Đang chạy bình thường thì sự cố đã qua, dù không có event báo hồi.
        if (live && live.has(String(session))) {
          await redis.client.zRem(cfg.key, session);
          log.event(`Session ${session} ${cfg.label} nhưng đang WORKING, đóng sổ`);
          continue;
        }

        const isWatched = watched.has(String(session));
        const threshold = isWatched ? forWatched : normal;
        if (since && Date.now() - since < threshold * 1000) continue;

        const mins = since ? Math.round((Date.now() - since) / 60000) : '?';
        const human = threshold >= 60 ? `${Math.round(threshold / 60)} phút` : `${threshold} giây`;
        // sendOnce có khoá 30 phút; chỉ ghi log khi thực sự gửi, tránh lặp mỗi phút
        const sent = await telegram.sendOnce(
          `session_health:${session}:${kind}_long`,
          [
            `⚠️ SESSION ${cfg.label} LÂU`,
            '',
            `Session: <b>${session}</b>${isWatched ? ' 👁 <b>THEO DÕI SÁT</b>' : ''}`,
            `Đã kéo dài: <b>${mins} phút</b>`,
            `${cfg.detail} Quá ${human} là bất thường.`,
          ].join('\n'),
        );
        if (sent) log.warn(`Session ${session} ${cfg.label} ${mins} phút`);
      }
    }
  } catch (err) {
    log.error('Quét sự cố kết nối lỗi:', err.message);
  }
};

const alert = async (session, entry) => {
  const icon = ICONS[entry.severity] ?? 'ℹ️';
  const title = entry.permanent
    ? `${icon} TÀI KHOẢN BỊ CẤM VĨNH VIỄN`
    : entry.needsRelink
    ? `⚠️ SESSION BỊ GỠ LIÊN KẾT — CẦN QUÉT QR LẠI`
    : entry.kind === 'TemporaryBan'
    ? `${icon} TÀI KHOẢN BỊ CẤM TẠM THỜI`
    : entry.kind === 'ReachoutTimelock'
      ? `${icon} TÀI KHOẢN BỊ HẠN CHẾ NHẮN NGƯỜI LẠ`
      : `${icon} SỰ CỐ TÀI KHOẢN`;

  const watched = await watchlist.has(session);
  const coreTag = entry.core === 'new' ? '🟢 CORE MỚI' : '⚪ core cũ';
  const lines = [
    title,
    '',
    `Nguồn: <b>${coreTag}</b>`,
    `Session: <b>${session}</b>${watched ? ' 👁 <b>THEO DÕI SÁT</b>' : ''}`,
    `Loại: <b>${entry.kind}</b>`,
  ];
  if (entry.code !== undefined && entry.code !== null) lines.push(`Mã: <b>${entry.code}</b>`);
  if (entry.reason) lines.push(`Lý do: ${entry.reason}`);
  if (entry.expiresInSec) lines.push(`Hết cấm sau: <b>${telegram.humanDuration(entry.expiresInSec)}</b>`);
  if (entry.endsAt) lines.push(`Hết hạn chế lúc: <b>${entry.endsAt}</b>`);
  if (entry.enforcementType) lines.push(`Kiểu hạn chế: ${entry.enforcementType}`);
  if (entry.failedCount) lines.push(`Số nhịp lỗi: ${entry.failedCount}`);
  if (entry.action) lines.push(`Hành động: ${entry.action}`);
  if (entry.jid) lines.push(`Liên quan: ${entry.jid}`);
  if (entry.message) lines.push(`Chi tiết: ${entry.message}`);
  lines.push('', `Lúc: ${entry.at}`);

  // Khoá theo session+loại để không bắn trùng khi event lặp
  await telegram.sendOnce(`session_health:${session}:${entry.kind}`, lines.join('\n'));
};

/** Thống kê mọi loại engine.event đã đi qua, kể cả loại chưa xử lý. */
export const getKindsSeen = async () => {
  const raw = await redis.client.hGetAll(SEEN_KEY).catch(() => ({}));
  return Object.fromEntries(
    Object.entries(raw)
      .map(([k, v]) => [k, Number(v)])
      .sort((a, b) => b[1] - a[1]),
  );
};

export const getHistory = async (session, limit = 50) => {
  const rows = await redis.client
    .lRange(eventsKey(session), 0, limit - 1)
    .catch(() => []);
  return rows.map((r) => {
    try {
      return JSON.parse(r);
    } catch {
      return null;
    }
  }).filter(Boolean);
};

export const getLast = async (session) => {
  const row = await redis.client.get(lastKey(session)).catch(() => null);
  if (!row) return null;
  try {
    return JSON.parse(row);
  } catch {
    return null;
  }
};

export const getAllLast = async () => {
  const sessions = await redis.client.sMembers(INDEX_KEY).catch(() => []);
  const rows = await Promise.all(
    sessions.map(async (session) => {
      const row = await redis.client.get(lastKey(session)).catch(() => null);
      if (!row) {
        // key đã hết hạn, dọn khỏi index luôn
        await redis.client.sRem(INDEX_KEY, session).catch(() => {});
        return null;
      }
      try {
        return JSON.parse(row);
      } catch {
        return null;
      }
    }),
  );
  return rows.filter(Boolean);
};
