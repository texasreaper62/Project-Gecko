module.exports = {
  apps: [{
    name: "predictionarb",
    script: "dist/index.js",
    node_args: "--experimental-specifier-resolution=node",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "500M",
    env: {
      NODE_ENV: "production",
    },
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: "logs/error.log",
    out_file: "logs/out.log",
    merge_logs: true,
  }],
};
