// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'webhook-server',
      script: './index.js',
      instances: 10,               // Chạy 5 tiến trình cluster
      exec_mode: 'cluster',       // Kích hoạt chế độ cluster
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3001                // PORT dùng trong cluster sẽ được auto balance
      }
    }
  ]
};
