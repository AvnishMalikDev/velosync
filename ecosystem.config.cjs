/**
 * VeloSync — PM2 process manifest.
 *
 * Defines both long-running apps:
 *   - velosync-web   : dashboard + API on http://localhost:3000 (server.js)
 *   - velosync-sync  : jira-md-export nightly cron (runs once per day at 12:00 AM)
 *
 * Start both with:  pm2 start ecosystem.config.cjs
 * Persist across reboot:  pm2 save  (use `pm2 startup` on Linux; pm2-windows-startup on Windows Server if needed)
 */
module.exports = {
  apps: [
    {
      name: "velosync-web",
      cwd: "./",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "velosync-sync",
      cwd: "./jira-md-export",
      script: "index.js",
      instances: 1,
      exec_mode: "fork",
      // Cron-only: do not auto-restart between scheduled runs.
      autorestart: false,
      watch: false,
      // Every day at 12:00 AM local time (minute hour dom month dow).
      cron_restart: "0 0 * * *",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
