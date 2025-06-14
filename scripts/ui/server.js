const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const app = express();

// Directories
const repoRoot = path.join(__dirname, '..', '..');
const inputDir = path.join(repoRoot, 'input');
const tmpDir = path.join(repoRoot, 'tmp');
const agentsFile = path.join(repoRoot, 'installed-agents.json');
const usageFile = path.join(repoRoot, 'usage.json');
const marketFile = path.join(repoRoot, 'kernel-slate', 'docs', 'available-agents.json');

// Ensure input directory exists
fs.mkdirSync(inputDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

// Multer setup to store original filenames and restrict extensions
const storage = multer.diskStorage({
  destination: tmpDir,
  filename: (req, file, cb) => cb(null, file.originalname),
});
function filter(exts) {
  return (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (exts.includes(ext)) cb(null, true);
    else cb(new Error('Invalid file type'));
  };
}
const chatUpload = multer({ storage, fileFilter: filter(['.txt', '.md', '.json', '.html']) });
const voiceUpload = multer({ storage, fileFilter: filter(['.wav', '.mp3', '.m4a']) });
const agentUpload = multer({ storage, fileFilter: filter(['.yaml', '.yml']) });

// Utility to safely read JSON
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function slugify(name) {
  return encodeURIComponent(String(name).toLowerCase().replace(/\s+/g, '-'));
}

function loadVault(user) {
  const base = path.join(repoRoot, 'vault', user || 'demo');
  const usage = readJson(path.join(base, 'usage.json'));
  let tokens = 0;
  try { tokens = readJson(path.join(base, 'tokens.json')).tokens || 0; } catch {}
  let lastAgent = null;
  if (Array.isArray(usage) && usage.length) {
    const last = [...usage].reverse().find(u => u.agent || u.slug);
    if (last) lastAgent = last.agent || last.slug;
  }
  const promptDir = path.join(repoRoot, 'vault-prompts', user || 'demo');
  let suggestions = [];
  if (fs.existsSync(path.join(promptDir, 'new-suggestions.json'))) {
    try {
      suggestions = JSON.parse(fs.readFileSync(path.join(promptDir, 'new-suggestions.json'), 'utf8'));
    } catch {}
  }
  return { tokens, lastAgent, suggestions };
}

app.get('/', (req, res) => {
  const agents = readJson(agentsFile);
  const usage = readJson(usageFile);

  const agentsList = agents
    .map((a) => `<li>${a}</li>`) // assuming array of names
    .join('');
  const usageDisplay = `<pre>${JSON.stringify(usage, null, 2)}</pre>`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Agent Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; }
    h1, h2 { margin-top: 1.5em; }
    form { margin-top: 1em; }
  </style>
</head>
<body>
  <h1>Installed Agents</h1>
  <ul>${agentsList}</ul>

  <h2>Usage Metrics</h2>
  ${usageDisplay}

  <h2>Upload Chatlog</h2>
  <form method="post" action="/upload-chatlog" enctype="multipart/form-data">
    <input type="file" name="file" accept=".txt,.md,.json,.html" required>
    <button type="submit">Upload</button>
  </form>

  <h2>Upload Voice Recording</h2>
  <form method="post" action="/upload-voice" enctype="multipart/form-data">
    <input type="file" name="file" accept=".wav,.mp3,.m4a" required>
    <button type="submit">Upload</button>
  </form>

  <h2>Install Agent</h2>
  <form method="post" action="/install" enctype="multipart/form-data">
    <input type="file" name="file" accept=".yaml,.yml" required>
    <button type="submit">Install</button>
  </form>
</body>
</html>`;
  res.send(html);
});

app.get('/agents/:id', async (req, res) => {
  const list = readJson(marketFile);
  const usage = readJson(usageFile);
  const id = req.params.id;
  const agent =
    list.find((a) => slugify(a.name) === id) || list[parseInt(id, 10)] || null;
  if (!agent) return res.status(404).send('Agent not found');

  const installCount = usage.filter(
    (u) => u.agent === agent.name && u.action === 'install'
  ).length;
  const logs = usage.filter((u) => u.agent === agent.name);

  let yamlSummary = '';
  if (agent.url && agent.url.includes('github.com')) {
    const raw = agent.url
      .replace('github.com/', 'raw.githubusercontent.com/')
      .replace('/blob/', '/');
    try {
      const resp = await fetch(raw);
      if (resp.ok) yamlSummary = await resp.text();
    } catch {}
  } else if (agent.path && fs.existsSync(path.join(repoRoot, agent.path))) {
    yamlSummary = fs.readFileSync(path.join(repoRoot, agent.path), 'utf8');
  }

  const html = `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>${agent.name}</title>
    <style>body{font-family:Arial,sans-serif;margin:40px;}button{margin-right:1em;}</style>
  </head>
  <body>
    <h1>${agent.name}</h1>
    <p><strong>Install count:</strong> ${installCount}</p>
    <h2>Usage Logs</h2>
    <pre>${JSON.stringify(logs, null, 2)}</pre>
    <h2>YAML Summary</h2>
    <pre>${yamlSummary}</pre>
    <div>
      <button onclick="location.href='/install-agent/${id}'">Install</button>
      <button onclick="location.href='/inspect-agent/${id}'">Inspect</button>
      <a href="${agent.url || '#'}" target="_blank"><button>View Docs</button></a>
    </div>
  </body>
  </html>`;
  res.send(html);
});

function run(script, file, res, msg) {
  const proc = spawn('node', [script, file], { stdio: 'inherit' });
  proc.on('close', code => {
    fs.unlinkSync(file);
    if (code === 0) res.send(msg);
    else res.status(500).send('Error running script');
  });
}

app.post('/upload-chatlog', chatUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded');
  const script = path.join(repoRoot, 'kernel-slate', 'scripts', 'features', 'chatlog-parser', 'from-export.js');
  run(script, req.file.path, res, 'Chatlog processed');
});

app.post('/upload-voice', voiceUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded');
  const script = path.join(repoRoot, 'kernel-slate', 'scripts', 'features', 'record-voice-log.js');
  run(script, req.file.path, res, 'Voice processed');
});

app.post('/install', agentUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded');
  const script = path.join(repoRoot, 'kernel-slate', 'scripts', 'market', 'install-agent.js');
  run(script, req.file.path, res, 'Install started');
});

app.get('/dashboard', (req, res) => {
  const user = req.query.user || 'demo';
  const info = loadVault(user);
  if (req.query.json) return res.json(info);
  const html = `<!DOCTYPE html>
  <html><head><meta charset="UTF-8"><title>Dashboard</title>
  <style>body{font-family:Arial,sans-serif;margin:40px;}form{margin-top:1em;}</style></head>
  <body><h1>User Dashboard</h1>
  <p>Tokens: ${info.tokens}</p>
  <p>Last Agent Run: ${info.lastAgent || 'N/A'}</p>
  <h2>Pending Suggestions</h2>
  <pre>${JSON.stringify(info.suggestions, null, 2)}</pre>
  <h2>Upload Files</h2>
  <form method="post" action="/upload-chatlog" enctype="multipart/form-data">
    <input type="file" name="file" accept=".zip" required>
    <button>Upload Chatlog</button>
  </form>
  <form method="post" action="/install" enctype="multipart/form-data">
    <input type="file" name="file" accept=".idea.yaml" required>
    <button>Upload Idea</button>
  </form>
  </body></html>`;
  res.send(html);
});

app.get('/usage', (req, res) => {
  const logs = readJson(usageFile);
  const stats = {};
  let totalBilling = 0;

  for (const entry of logs) {
    const agent = entry.agent || 'unknown';
    if (!stats[agent]) stats[agent] = { count: 0, tokens: 0, last: '', billing: 0 };
    stats[agent].count += 1;
    if (entry.tokens) stats[agent].tokens += entry.tokens;
    if (entry.timestamp && entry.timestamp > stats[agent].last) stats[agent].last = entry.timestamp;
    const cost = entry.billing ?? entry.cost;
    if (typeof cost === 'number') {
      stats[agent].billing += cost;
      totalBilling += cost;
    }
  }

  const rows = Object.entries(stats)
    .sort((a, b) => b[1].count - a[1].count)
    .map(
      ([agent, d]) =>
        `<tr><td>${agent}</td><td>${d.count}</td><td>${d.tokens}</td><td>${d.last}</td><td>${d.billing.toFixed ? d.billing.toFixed(2) : d.billing}</td></tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Usage Summary</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 40px; }
      table { border-collapse: collapse; }
      th, td { border: 1px solid #ccc; padding: 8px; }
    </style>
  </head>
  <body>
    <h1>Usage Summary</h1>
    <table>
      <tr><th>Agent</th><th>Runs</th><th>Tokens</th><th>Last Run</th><th>Billing</th></tr>
      ${rows}
    </table>
    <p>Total Billing: ${totalBilling.toFixed ? totalBilling.toFixed(2) : totalBilling}</p>
  </body>
  </html>`;

  res.send(html);
});

app.get('/vault/:user', (req, res) => {
  const user = req.params.user;
  const base = path.join(repoRoot, 'vault', user);
  const out = {
    usage: readJson(path.join(base, 'usage.json')),
    prompts: readJson(path.join(repoRoot, 'vault-prompts', user, 'new-suggestions.json')),
    queued: readJson(path.join(base, 'job-queue.json')),
    billing: readJson(path.join(base, 'billing-history.json'))
  };
  if (req.query.json || !req.accepts('html')) return res.json(out);
  res.send(`<pre>${JSON.stringify(out, null, 2)}</pre>`);
});

app.get('/marketplace', (req, res) => {
  const ideasDir = path.join(repoRoot, 'ideas');
  const files = fs.existsSync(ideasDir) ? fs.readdirSync(ideasDir).filter(f => f.endsWith('.idea.yaml')) : [];
  const list = files.map(f => ({ name: f, cost: 1, remixAvailable: false }));
  if (req.query.json || !req.accepts('html')) return res.json(list);
  const rows = list.map(i => `<tr><td>${i.name}</td><td>${i.cost}</td><td>${i.remixAvailable ? 'remix' : 'locked'}</td></tr>`).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Marketplace</title></head><body><h1>Marketplace</h1><table border="1"><tr><th>Idea</th><th>Cost</th><th>Remix</th></tr>${rows}</table></body></html>`);
});

app.listen(PORT, () => {
  console.log(`UI server running at http://localhost:${PORT}`);
});
