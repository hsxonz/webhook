import express from 'express';
import config from './config.js';
import log from './lib/logger.js';
import * as redis from './lib/redis.js';
import * as stats from './lib/stats.js';
import * as telegram from './lib/telegram.js';
import * as watchdog from './lib/watchdog.js';
import * as sessionHealth from './lib/sessionHealth.js';
import * as throughput from './lib/throughput.js';
import webhookRoutes from './routes/webhook.js';
import statsRoutes from './routes/stats.js';

const app = express();

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(webhookRoutes);
app.use(statsRoutes);

app.use((err, req, res, _next) => {
  log.error('Lỗi không bắt được:', err.message);
  res.status(500).json({ error: 'Internal Server Error' });
});

const start = async () => {
  await redis.connect();

  watchdog.start({ getStats: stats.getHealthSnapshot });

  // Quét session mất kết nối quá lâu. Khoá Redis lo việc chỉ một instance chạy.
  setInterval(() => {
    sessionHealth.sweepDisconnected().catch(() => {});
  }, 60_000).unref();

  // Bắt session "WORKING giả": WAHA báo chạy nhưng websocket gows đã đứt.
  throughput.start();

  const server = app.listen(config.port, () => {
    log.ok(`Webhook server chạy ở cổng ${config.port}`);
  });

  // sendOnce có khoá Redis nên chỉ 1 instance trong cluster gửi
  await telegram.notifyStartup({
    port: config.port,
    instances: process.env.NODE_APP_INSTANCE !== undefined ? 'cluster' : 1,
  });

  const shutdown = async (signal) => {
    log.info(`Nhận ${signal}, đang tắt...`);
    watchdog.stop();
    throughput.stop();
    server.close();
    try { await redis.client.quit(); } catch { /* bỏ qua */ }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

process.on('unhandledRejection', (err) => log.error('Promise chưa bắt lỗi:', err?.message || err));

start().catch((err) => {
  log.error('Không khởi động được:', err.message);
  process.exit(1);
});
