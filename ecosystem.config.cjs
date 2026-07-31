// .cjs vì package.json đã bật "type": "module" còn PM2 đọc config theo CommonJS
module.exports = {
  apps: [
    {
      name: 'webhook-server',
      script: './index.js',
      instances: 10,
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '500M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
