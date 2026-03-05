'use strict';

const express = require('express');
const { Pool }  = require('pg');
const os        = require('os');

const app  = express();
const PORT = process.env.PORT || 8080;   // Cloud Run default: 8080

// ── Config ──────────────────────────────────────────────────────────────────
const APP_NAME    = process.env.APP_NAME    || 'cloudrun-zero2prod';
const APP_VERSION = process.env.APP_VERSION || '1.0.0';
const BUILD_TIME  = process.env.BUILD_TIME  || new Date().toISOString();
const HOSTNAME    = process.env.HOSTNAME    || os.hostname();

// ── DB Pool ──────────────────────────────────────────────────────────────────
// Cloud Run  → kết nối qua Unix socket (/cloudsql/PROJECT:REGION:INSTANCE)
// Local dev  → kết nối qua TCP (DB_HOST=localhost)
function createPool() {
  const base = {
    database: process.env.DB_NAME     || 'zero2prod',
    user:     process.env.DB_USER     || 'app_user',
    password: process.env.DB_PASSWORD || '',
  };

  if (process.env.INSTANCE_CONNECTION_NAME && !process.env.DB_HOST) {
    // Cloud Run: built-in Cloud SQL Auth Proxy mount Unix socket
    return new Pool({
      ...base,
      host: `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`,
    });
  }

  // Local development
  return new Pool({
    ...base,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
  });
}

const pool = createPool();

// Graceful: app vẫn chạy nếu DB chưa sẵn sàng
async function getHistory() {
  try {
    const { rows } = await pool.query(
      `SELECT version, commit_sha, build_time, deployed_at, status
       FROM deployments
       ORDER BY deployed_at DESC
       LIMIT 10`
    );
    return rows;
  } catch (err) {
    console.error('[DB] getHistory failed:', err.message);
    return [];
  }
}

// ── API ──────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.status(200).send('OK'));

app.get('/info', (_req, res) => {
  res.json({
    app:         APP_NAME,
    version:     APP_VERSION,
    buildTime:   BUILD_TIME,
    hostname:    HOSTNAME,
    uptime:      `${Math.floor(process.uptime())}s`,
    nodeVersion: process.version,
  });
});

app.get('/history', async (_req, res) => {
  const rows = await getHistory();
  res.json(rows);
});

// ── Dashboard ────────────────────────────────────────────────────────────────
app.get('/', async (_req, res) => {
  const uptime  = Math.floor(process.uptime());
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  const uptimeStr = `${h}h ${m}m ${s}s`;

  const history = await getHistory();

  const historyRows = history.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px">
         No deployments recorded yet
       </td></tr>`
    : history.map(r => {
        const deployedAt = new Date(r.deployed_at).toISOString().replace('T', ' ').slice(0, 19);
        const buildTime  = new Date(r.build_time).toISOString().replace('T', ' ').slice(0, 19);
        return `
        <tr>
          <td><span class="version-badge">${r.version}</span></td>
          <td><code>${r.commit_sha}</code></td>
          <td>${buildTime}</td>
          <td>${deployedAt}</td>
          <td><span class="status-badge status-${r.status}">${r.status}</span></td>
        </tr>`;
      }).join('');

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
      --bg:      #0d1117;
      --surface: #161b22;
      --border:  #30363d;
      --accent:  #58a6ff;
      --green:   #3fb950;
      --yellow:  #d29922;
      --red:     #f85149;
      --purple:  #a371f7;
      --text:    #e6edf3;
      --muted:   #8b949e;
      --radius:  12px;
    }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px 60px;
    }

    /* ── Topbar ── */
    .topbar {
      width: 100%; max-width: 900px;
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 40px;
    }
    .logo {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.05rem; font-weight: 700;
      color: var(--accent);
      display: flex; align-items: center; gap: 8px;
    }
    .badge-live {
      display: flex; align-items: center; gap: 6px;
      background: #1a2d1a; border: 1px solid #2ea04326;
      color: var(--green); font-size: .75rem; font-weight: 600;
      padding: 4px 12px; border-radius: 999px; letter-spacing: .05em;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--green);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%,100% { opacity:1; transform:scale(1); }
      50%      { opacity:.4; transform:scale(.8); }
    }

    /* ── Title ── */
    .title-block { text-align: center; margin-bottom: 44px; }
    .title-block h1 {
      font-size: 2.2rem; font-weight: 700; letter-spacing: -.03em;
      background: linear-gradient(135deg, #58a6ff 0%, #a371f7 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .title-block p { color: var(--muted); margin-top: 8px; font-size: .9rem; }

    /* ── Cards ── */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 14px; width: 100%; max-width: 900px;
    }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 22px;
      position: relative; overflow: hidden;
      transition: border-color .2s, transform .2s;
    }
    .card:hover { border-color: var(--accent); transform: translateY(-2px); }
    .card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
      background: var(--card-accent, var(--accent)); opacity: .7;
    }
    .card-icon   { font-size: 1.5rem; margin-bottom: 10px; }
    .card-label  { font-size: .7rem; font-weight: 600; color: var(--muted);
                   text-transform: uppercase; letter-spacing: .08em; margin-bottom: 5px; }
    .card-value  { font-family: 'JetBrains Mono', monospace;
                   font-size: 1.05rem; font-weight: 600; word-break: break-all; }
    .card-value.big { color: var(--accent); font-size: 1.4rem; }

    .c-version { --card-accent: #58a6ff; }
    .c-build   { --card-accent: #a371f7; }
    .c-host    { --card-accent: #3fb950; }
    .c-uptime  { --card-accent: #d29922; }
    .c-node    { --card-accent: #f78166; }

    /* ── Health bar ── */
    .card-full { grid-column: 1 / -1; }
    .health-row { display: flex; align-items: center; gap: 12px; }
    .health-status { font-family:'JetBrains Mono',monospace;
                     font-size:1rem; font-weight:700; color:var(--green); }
    .health-bar  { flex:1; height:6px; background:var(--border); border-radius:999px; overflow:hidden; }
    .health-fill { height:100%; background:linear-gradient(90deg,var(--green),#56d364);
                   animation: shimmer 2.5s ease-in-out infinite; }
    @keyframes shimmer { 0%,100%{opacity:1} 50%{opacity:.55} }

    /* ── Deployment History ── */
    .section {
      width: 100%; max-width: 900px;
      margin-top: 28px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); overflow: hidden;
    }
    .section-header {
      padding: 16px 22px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }
    .section-title {
      font-size: .72rem; font-weight: 600; color: var(--muted);
      text-transform: uppercase; letter-spacing: .08em;
    }
    .history-count {
      font-family: 'JetBrains Mono', monospace;
      font-size: .72rem; color: var(--muted);
    }

    table { width: 100%; border-collapse: collapse; }
    thead th {
      padding: 10px 22px; text-align: left;
      font-size: .68rem; font-weight: 600; color: var(--muted);
      text-transform: uppercase; letter-spacing: .06em;
      border-bottom: 1px solid var(--border);
    }
    tbody tr { border-bottom: 1px solid var(--border); transition: background .15s; }
    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: rgba(88,166,255,.04); }
    tbody td {
      padding: 12px 22px;
      font-size: .85rem; color: var(--text);
    }
    tbody td code {
      font-family: 'JetBrains Mono', monospace;
      font-size: .82rem; color: var(--muted);
      background: var(--bg); padding: 2px 6px;
      border-radius: 4px; border: 1px solid var(--border);
    }

    .version-badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: .82rem; font-weight: 700;
      color: var(--accent); background: rgba(88,166,255,.1);
      padding: 2px 8px; border-radius: 4px;
    }
    .status-badge {
      font-size: .72rem; font-weight: 700;
      padding: 2px 8px; border-radius: 999px;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .status-success { background: #1a2d1a; color: var(--green); }
    .status-failed  { background: #2d1a1a; color: var(--red); }

    /* ── APIs ── */
    .endpoint-row {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 22px; border-bottom: 1px solid var(--border);
    }
    .endpoint-row:last-child { border-bottom: none; }
    .method {
      font-family: 'JetBrains Mono', monospace; font-size: .7rem; font-weight: 700;
      padding: 2px 8px; border-radius: 4px; min-width: 44px; text-align: center;
      background: #1b2a1b; color: var(--green);
    }
    .path { font-family: 'JetBrains Mono', monospace; font-size: .88rem; color: var(--accent); }
    .desc { font-size: .8rem; color: var(--muted); margin-left: auto; }

    footer {
      margin-top: 36px; color: var(--muted); font-size: .75rem;
      text-align: center; line-height: 2;
    }
    footer code {
      font-family: 'JetBrains Mono', monospace;
      background: var(--surface); border: 1px solid var(--border);
      padding: 1px 6px; border-radius: 4px;
    }

    @media (max-width: 520px) {
      .title-block h1 { font-size: 1.7rem; }
      thead th:nth-child(3), tbody td:nth-child(3) { display: none; }
    }
  </style>
</head>
<body>

  <div class="topbar">
    <div class="logo">⚙ DevOps Dashboard</div>
    <div class="badge-live"><span class="dot"></span>LIVE</div>
  </div>

  <div class="title-block">
    <h1>${APP_NAME}</h1>
    <p>Version Dashboard · Cloud Run + Cloud SQL + Cloud Build</p>
  </div>

  <div class="grid">
    <div class="card c-version">
      <div class="card-icon">🏷</div>
      <div class="card-label">Version</div>
      <div class="card-value big">${APP_VERSION}</div>
    </div>
    <div class="card c-build">
      <div class="card-icon">🔨</div>
      <div class="card-label">Build Time</div>
      <div class="card-value">${BUILD_TIME}</div>
    </div>
    <div class="card c-host">
      <div class="card-icon">☁</div>
      <div class="card-label">Instance</div>
      <div class="card-value">${HOSTNAME}</div>
    </div>
    <div class="card c-uptime">
      <div class="card-icon">⏱</div>
      <div class="card-label">Uptime</div>
      <div class="card-value">${uptimeStr}</div>
    </div>
    <div class="card c-node">
      <div class="card-icon">🟢</div>
      <div class="card-label">Node.js</div>
      <div class="card-value">${process.version}</div>
    </div>
    <div class="card card-full" style="--card-accent:#3fb950">
      <div class="card-label" style="margin-bottom:12px">Health Status</div>
      <div class="health-row">
        <div class="health-status">● HEALTHY</div>
        <div class="health-bar"><div class="health-fill"></div></div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:.78rem;color:var(--muted)">200 OK</div>
      </div>
    </div>
  </div>

  <!-- Deployment History -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">Deployment History</span>
      <span class="history-count">${history.length} record(s)</span>
    </div>
    <table>
      <thead>
        <tr>
          <th>Version</th>
          <th>Commit</th>
          <th>Build Time</th>
          <th>Deployed At</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${historyRows}</tbody>
    </table>
  </div>

  <!-- API Endpoints -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">API Endpoints</span>
    </div>
    <div class="endpoint-row">
      <span class="method">GET</span>
      <span class="path">/health</span>
      <span class="desc">Liveness check → 200 OK</span>
    </div>
    <div class="endpoint-row">
      <span class="method">GET</span>
      <span class="path">/info</span>
      <span class="desc">App metadata → JSON</span>
    </div>
    <div class="endpoint-row">
      <span class="method">GET</span>
      <span class="path">/history</span>
      <span class="desc">Deployment history → JSON</span>
    </div>
    <div class="endpoint-row">
      <span class="method">GET</span>
      <span class="path">/</span>
      <span class="desc">This dashboard</span>
    </div>
  </div>

  <footer>
    Port <code>${PORT}</code> &nbsp;·&nbsp;
    DB <code>${process.env.INSTANCE_CONNECTION_NAME || process.env.DB_HOST || 'not connected'}</code>
  </footer>

</body>
</html>`;

  res.send(html);
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ⚙  ${APP_NAME}`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Version  : ${APP_VERSION}`);
  console.log(`  Build    : ${BUILD_TIME}`);
  console.log(`  DB       : ${process.env.INSTANCE_CONNECTION_NAME || process.env.DB_HOST || 'none'}`);
  console.log(`  Port     : ${PORT}`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  http://localhost:${PORT}\n`);
});
