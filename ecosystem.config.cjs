// PM2 process definitions for project-gecko on a VPS.
//
// Two processes:
//   1. ibkr-gateway: the IBKR Client Portal Gateway (Java) — keeps an
//      authenticated session alive that the bot talks to via localhost.
//   2. gecko-bot: the Node.js trading bot. Auto-restarts on crash,
//      reads tokens from data/ibkr-tokens.json, hits the local gateway.
//
// Both processes log to logs/*.log and are managed by `pm2`. Start with:
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup    # generates systemd unit so pm2 survives reboot

const path = require("path");

module.exports = {
  apps: [
    {
      name: "ibkr-gateway",
      // The IBKR Client Portal Gateway is a Java app. Path assumes it was
      // unpacked to ~/clientportal.gw via deploy/install-ibkr-gateway.sh.
      script: "bin/run.sh",
      args: "root/conf.yaml",
      cwd: path.join(process.env.HOME || "/root", "clientportal.gw"),
      interpreter: "bash",
      autorestart: true,
      watch: false,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: "800M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/ibkr-gateway-error.log",
      out_file: "logs/ibkr-gateway-out.log",
      merge_logs: true,
    },
    {
      name: "gecko-bot",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 100,
      restart_delay: 3000,
      max_memory_restart: "700M",
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/gecko-error.log",
      out_file: "logs/gecko-out.log",
      merge_logs: true,
    },
  ],
};
