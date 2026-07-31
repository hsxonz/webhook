import path from 'node:path';
import { fileURLToPath } from 'node:url';
import winston from 'winston';
import 'winston-daily-rotate-file';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '..', 'logs', 'session-health');

// Mỗi dòng là một JSON độc lập để grep/jq truy vấn được thẳng.
// Tách hẳn khỏi log PM2 vì đây là dữ liệu cần giữ lâu và tra cứu, không phải log vận hành.
const transport = new winston.transports.DailyRotateFile({
  dirname: DIR,
  filename: 'session-health-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '50m',
  maxFiles: '90d',
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [transport],
});

export const write = (entry) => {
  try {
    logger.info(entry);
  } catch {
    // không để lỗi ghi log làm hỏng đường xử lý webhook
  }
};

export const dir = DIR;
