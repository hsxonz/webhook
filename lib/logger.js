const INSTANCE = process.env.NODE_APP_INSTANCE ?? '0';

const prefix = (icon) => `[${new Date().toISOString()}][i${INSTANCE}] ${icon}`;

export default {
  instance: INSTANCE,
  info: (...args) => console.log(prefix('ℹ️'), ...args),
  ok: (...args) => console.log(prefix('✅'), ...args),
  warn: (...args) => console.warn(prefix('⚠️'), ...args),
  error: (...args) => console.error(prefix('❌'), ...args),
  event: (...args) => console.log(prefix('📥'), ...args),
};
