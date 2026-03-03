'use strict';

const express = require('express');
const crypto  = require('crypto');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ──────────────────────────────────────────────────────────────────
const APP_NAME       = process.env.APP_NAME       || 'gce-zero2prod';
const APP_VERSION    = process.env.APP_VERSION    || '1.0.0';
const BUILD_TIME     = process.env.BUILD_TIME     || new Date().toISOString();
const HOSTNAME       = process.env.HOSTNAME       || os.hostname();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ── Auth helpers ─────────────────────────────────────────────────────────────
function makeToken(pwd) {
  return crypto.createHmac('sha256', pwd).update('authenticated').digest('hex');
}

function parseCookies(req) {
  const map = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const [k, ...rest] = pair.trim().split('=');
    if (k) map[k.trim()] = decodeURIComponent(rest.join('='));
  });
  return map;
}

function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const { auth } = parseCookies(req);
  if (auth === makeToken(ADMIN_PASSWORD)) return next();
  res.redirect('/login');
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.status(200).send('OK'));

app.get('/info', requireAuth, (_req, res) => {
  res.json({
    app:         APP_NAME,
    version:     APP_VERSION,
    buildTime:   BUILD_TIME,
    hostname:    HOSTNAME,
    uptime:      `${Math.floor(process.uptime())}s`,
    nodeVersion: process.version,
  });
});

app.get('/login', (req, res) => {
  if (ADMIN_PASSWORD) {
    const { auth } = parseCookies(req);
    if (auth === makeToken(ADMIN_PASSWORD)) return res.redirect('/');
  }
  res.send(loginPage());
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    const isHttps = req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie',
      `auth=${makeToken(ADMIN_PASSWORD)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${isHttps ? '; Secure' : ''}`
    );
    return res.redirect('/');
  }
  res.status(401).send(loginPage('Mật khẩu không đúng, thử lại.'));
});

app.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'auth=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/login');
});

app.get('/', requireAuth, (_req, res) => {
  const uptime = Math.floor(process.uptime());
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  res.send(dashboardPage(`${h}h ${m}m ${s}s`));
});

// ── HTML: Login page ─────────────────────────────────────────────────────────
function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${APP_NAME} · Login</title>
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
      --red:     #f85149;
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
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 40px 36px;
      width: 100%;
      max-width: 380px;
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, #58a6ff, #a371f7);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 1rem;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 28px;
    }
    .lock-icon {
      width: 36px; height: 36px;
      background: #1c2d4a;
      border: 1px solid #2155a3;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1rem;
    }

    h1 {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 6px;
    }
    .subtitle {
      font-size: 0.85rem;
      color: var(--muted);
      margin-bottom: 28px;
    }

    label {
      display: block;
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 8px;
    }

    input[type="password"] {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.95rem;
      padding: 10px 14px;
      outline: none;
      transition: border-color .2s;
      letter-spacing: 0.1em;
    }
    input[type="password"]:focus {
      border-color: var(--accent);
    }

    .error {
      margin-top: 10px;
      font-size: 0.82rem;
      color: var(--red);
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 20px;
    }

    button {
      margin-top: 20px;
      width: 100%;
      background: var(--accent);
      color: #0d1117;
      border: none;
      border-radius: 8px;
      font-family: 'Inter', sans-serif;
      font-size: 0.9rem;
      font-weight: 700;
      padding: 11px;
      cursor: pointer;
      transition: opacity .2s, transform .1s;
    }
    button:hover  { opacity: 0.88; }
    button:active { transform: scale(0.98); }

    .footer {
      margin-top: 24px;
      text-align: center;
      font-size: 0.75rem;
      color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="lock-icon">🔒</div>
      DevOps Dashboard
    </div>

    <h1>Xác thực</h1>
    <p class="subtitle">Nhập mật khẩu để truy cập ${APP_NAME}</p>

    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input
        type="password"
        id="password"
        name="password"
        placeholder="••••••••••••"
        autocomplete="current-password"
        autofocus
      />
      <div class="error">${error ? '⚠ ' + error : ''}</div>
      <button type="submit">Đăng nhập</button>
    </form>

    <div class="footer">${APP_NAME} · v${APP_VERSION}</div>
  </div>
</body>
</html>`;
}

// ── HTML: Dashboard page ──────────────────────────────────────────────────────
function dashboardPage(uptimeStr) {
  return `<!DOCTYPE html>
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
      --text:    #e6edf3;
      --muted:   #8b949e;
      --radius:  12px;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
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
    .topbar-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }
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
    .logout-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      font-family: 'Inter', sans-serif;
      font-size: 0.78rem;
      font-weight: 500;
      padding: 4px 12px;
      border-radius: 999px;
      cursor: pointer;
      text-decoration: none;
      transition: border-color .2s, color .2s;
    }
    .logout-btn:hover { border-color: var(--red); color: var(--red); }

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
    .card:hover { border-color: var(--accent); transform: translateY(-2px); }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: var(--card-accent, var(--accent));
      opacity: 0.7;
    }
    .card-icon  { font-size: 1.6rem; margin-bottom: 12px; }
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
    .card-value.highlight { color: var(--accent); font-size: 1.4rem; }

    .card-version { --card-accent: #58a6ff; }
    .card-build   { --card-accent: #a371f7; }
    .card-host    { --card-accent: #3fb950; }
    .card-uptime  { --card-accent: #d29922; }
    .card-node    { --card-accent: #f78166; }
    .card-health  { --card-accent: #3fb950; }

    .card-full { grid-column: 1 / -1; }
    .health-row { display: flex; align-items: center; gap: 12px; }
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
    .path { font-family: 'JetBrains Mono', monospace; font-size: 0.9rem; color: var(--accent); }
    .endpoint-desc { font-size: 0.82rem; color: var(--muted); margin-left: auto; }

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
    <div class="topbar-right">
      <div class="badge-live"><span class="dot"></span>LIVE</div>
      ${ADMIN_PASSWORD ? '<a href="/logout" class="logout-btn">⎋ Logout</a>' : ''}
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
    Refresh to update uptime
  </footer>

</body>
</html>`;
}

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ⚙  DevOps Dashboard`);
  console.log(`  ─────────────────────────────`);
  console.log(`  App      : ${APP_NAME}`);
  console.log(`  Version  : ${APP_VERSION}`);
  console.log(`  Build    : ${BUILD_TIME}`);
  console.log(`  Hostname : ${HOSTNAME}`);
  console.log(`  Auth     : ${ADMIN_PASSWORD ? 'enabled' : 'disabled (no ADMIN_PASSWORD set)'}`);
  console.log(`  Port     : ${PORT}`);
  console.log(`  ─────────────────────────────`);
  console.log(`  http://localhost:${PORT}\n`);
});
