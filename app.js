'use strict';

const express = require('express');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config (inject via env for CI/CD) ──────────────────────────────────────
const APP_NAME    = process.env.APP_NAME    || 'gce-zero2prod';
const APP_VERSION = process.env.APP_VERSION || '1.0.0';
const BUILD_TIME  = process.env.BUILD_TIME  || new Date().toISOString();
const HOSTNAME    = process.env.HOSTNAME    || os.hostname();

// ── API ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

app.get('/info', (_req, res) => {
  res.json({
    app:       APP_NAME,
    version:   APP_VERSION,
    buildTime: BUILD_TIME,
    hostname:  HOSTNAME,
    uptime:    `${Math.floor(process.uptime())}s`,
    nodeVersion: process.version,
  });
});

// ── Dashboard UI ───────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  const uptime = Math.floor(process.uptime());
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  const uptimeStr = `${h}h ${m}m ${s}s`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${APP_NAME} · DevOps Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0d1117;
      --surface:   #161b22;
      --border:    #30363d;
      --accent:    #58a6ff;
      --green:     #3fb950;
      --yellow:    #d29922;
      --red:       #f85149;
      --text:      #e6edf3;
      --muted:     #8b949e;
      --radius:    12px;
    }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px;
    }

    /* ── Top bar ── */
    .topbar {
      width: 100%;
      max-width: 820px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 40px;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--accent);
    }
    .logo .icon { font-size: 1.4rem; }
    .badge-live {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #1a2d1a;
      border: 1px solid #2ea04326;
      color: var(--green);
      font-size: 0.75rem;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 999px;
      letter-spacing: 0.05em;
    }
    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.4; transform: scale(0.8); }
    }

    /* ── Title ── */
    .title-block {
      text-align: center;
      margin-bottom: 48px;
    }
    .title-block h1 {
      font-size: 2.4rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      background: linear-gradient(135deg, #58a6ff 0%, #a371f7 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .title-block p {
      color: var(--muted);
      margin-top: 8px;
      font-size: 0.95rem;
    }

    /* ── Grid ── */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      width: 100%;
      max-width: 820px;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
      transition: border-color .2s, transform .2s;
      position: relative;
      overflow: hidden;
    }
    .card:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: var(--card-accent, var(--accent));
      opacity: 0.7;
    }
    .card-icon {
      font-size: 1.6rem;
      margin-bottom: 12px;
    }
    .card-label {
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }
    .card-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--text);
      word-break: break-all;
    }
    .card-value.highlight {
      color: var(--accent);
      font-size: 1.4rem;
    }

    /* card accent colors */
    .card-version  { --card-accent: #58a6ff; }
    .card-build    { --card-accent: #a371f7; }
    .card-host     { --card-accent: #3fb950; }
    .card-uptime   { --card-accent: #d29922; }
    .card-node     { --card-accent: #f78166; }
    .card-health   { --card-accent: #3fb950; }

    /* ── Health wide card ── */
    .card-full { grid-column: 1 / -1; }
    .health-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .health-status {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--green);
    }
    .health-bar {
      flex: 1;
      height: 6px;
      background: var(--border);
      border-radius: 999px;
      overflow: hidden;
    }
    .health-bar-fill {
      height: 100%;
      width: 100%;
      background: linear-gradient(90deg, var(--green), #56d364);
      border-radius: 999px;
      animation: shimmer 2.5s ease-in-out infinite;
    }
    @keyframes shimmer {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.6; }
    }

    /* ── API Endpoints ── */
    .endpoints {
      width: 100%;
      max-width: 820px;
      margin-top: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 24px;
    }
    .endpoints h3 {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 14px;
    }
    .endpoint-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
    }
    .endpoint-row:last-child { border-bottom: none; }
    .method {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.72rem;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
      background: #1b2a1b;
      color: var(--green);
      min-width: 44px;
      text-align: center;
    }
    .path {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.9rem;
      color: var(--accent);
    }
    .endpoint-desc {
      font-size: 0.82rem;
      color: var(--muted);
      margin-left: auto;
    }

    /* ── Footer ── */
    footer {
      margin-top: 40px;
      color: var(--muted);
      font-size: 0.78rem;
      text-align: center;
      line-height: 1.8;
    }
    footer code {
      font-family: 'JetBrains Mono', monospace;
      background: var(--surface);
      border: 1px solid var(--border);
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 0.78rem;
    }

    /* ── Responsive ── */
    @media (max-width: 480px) {
      .title-block h1 { font-size: 1.8rem; }
      .card-value.highlight { font-size: 1.2rem; }
    }
  </style>
</head>
<body>

  <div class="topbar">
    <div class="logo">
      <span class="icon">⚙</span>
      DevOps Dashboard
    </div>
    <div class="badge-live">
      <span class="dot"></span>
      LIVE
    </div>
  </div>

  <div class="title-block">
    <h1>${APP_NAME}</h1>
    <p>Version Dashboard · CI/CD Demo</p>
  </div>

  <div class="grid">

    <div class="card card-version">
      <div class="card-icon">🏷</div>
      <div class="card-label">Version</div>
      <div class="card-value highlight">${APP_VERSION}</div>
    </div>

    <div class="card card-build">
      <div class="card-icon">🔨</div>
      <div class="card-label">Build Time</div>
      <div class="card-value">${BUILD_TIME}</div>
    </div>

    <div class="card card-host">
      <div class="card-icon">🖥</div>
      <div class="card-label">Hostname</div>
      <div class="card-value">${HOSTNAME}</div>
    </div>

    <div class="card card-uptime">
      <div class="card-icon">⏱</div>
      <div class="card-label">Uptime</div>
      <div class="card-value">${uptimeStr}</div>
    </div>

    <div class="card card-node">
      <div class="card-icon">🟢</div>
      <div class="card-label">Node.js</div>
      <div class="card-value">${process.version}</div>
    </div>

    <div class="card card-health card-full">
      <div class="card-label" style="margin-bottom:14px">Health Status</div>
      <div class="health-row">
        <div class="health-status">● HEALTHY</div>
        <div class="health-bar"><div class="health-bar-fill"></div></div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:.8rem;color:var(--muted)">200 OK</div>
      </div>
    </div>

  </div>

  <div class="endpoints">
    <h3>API Endpoints</h3>
    <div class="endpoint-row">
      <span class="method">GET</span>
      <span class="path">/health</span>
      <span class="endpoint-desc">Liveness check → 200 OK</span>
    </div>
    <div class="endpoint-row">
      <span class="method">GET</span>
      <span class="path">/info</span>
      <span class="endpoint-desc">App metadata → JSON</span>
    </div>
    <div class="endpoint-row">
      <span class="method">GET</span>
      <span class="path">/</span>
      <span class="endpoint-desc">This dashboard</span>
    </div>
  </div>

  <footer>
    Running on port <code>${PORT}</code> &nbsp;·&nbsp;
    Refresh to update uptime &nbsp;·&nbsp;
    Set <code>APP_VERSION</code>, <code>BUILD_TIME</code>, <code>HOSTNAME</code> via env
  </footer>

</body>
</html>`;

  res.send(html);
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ⚙  DevOps Dashboard`);
  console.log(`  ─────────────────────────────`);
  console.log(`  App      : ${APP_NAME}`);
  console.log(`  Version  : ${APP_VERSION}`);
  console.log(`  Build    : ${BUILD_TIME}`);
  console.log(`  Hostname : ${HOSTNAME}`);
  console.log(`  Port     : ${PORT}`);
  console.log(`  ─────────────────────────────`);
  console.log(`  http://localhost:${PORT}\n`);
});
