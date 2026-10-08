/**
 * api-recorder-extension.service.ts
 * ─────────────────────────────────
 * Serves the source of a tiny MV3 Chrome extension that records API traffic from
 * the browser's DevTools network panel and streams it into a capture session via
 * the existing ingest endpoint. One-click browser capture (the lower-friction
 * norm) vs. the proxy snippet.
 *
 * Standalone and opt-in: the files are generated here as plain text so the UI can
 * offer them for download ("load unpacked"); the extension then POSTs to the same
 * authed ingest route every other recorder uses. The pipeline is never involved.
 */

export interface ExtensionFile { path: string; content: string; contentType: string }

const MANIFEST = `{
  "manifest_version": 3,
  "name": "IntelliQE Traffic Recorder",
  "version": "1.0.0",
  "description": "Record API traffic from DevTools and stream it into an IntelliQE capture session.",
  "permissions": ["storage"],
  "host_permissions": ["http://*/*", "https://*/*"],
  "devtools_page": "devtools.html"
}
`;

const DEVTOOLS_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body><script src="devtools.js"></script></body></html>
`;

const DEVTOOLS_JS = `// Create the IntelliQE panel inside DevTools.
chrome.devtools.panels.create('IntelliQE', '', 'panel.html', function () {});
`;

const PANEL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font: 13px -apple-system, Segoe UI, sans-serif; margin: 12px; color: #1f2937; }
  h1 { font-size: 14px; margin: 0 0 10px; color: #6d28d9; }
  label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin: 8px 0 3px; }
  input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #e4e0f5; border-radius: 6px; font-size: 12px; }
  button { margin-top: 12px; padding: 7px 14px; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; color: #fff; background: #7c3aed; }
  button.stop { background: #dc2626; }
  .row { display: flex; gap: 8px; }
  .row > div { flex: 1; }
  #status { margin-top: 10px; font-size: 12px; color: #374151; }
  .count { font-weight: 700; color: #6d28d9; }
  small { color: #9ca3af; }
</style>
</head>
<body>
  <h1>IntelliQE Traffic Recorder</h1>
  <label>Backend base URL</label>
  <input id="base" placeholder="http://localhost:3001" />
  <label>Capture session ingest URL</label>
  <input id="url" placeholder="http://localhost:3001/api/api-automation/capture/sessions/SESSION_ID/ingest" />
  <label>Bearer token</label>
  <input id="token" type="password" placeholder="intelliqe-demo-token-...:username" />
  <button id="toggle">Start recording</button>
  <div id="status">Idle. <small>Fill the fields from the API Studio "Browser recorder" dialog, then Start.</small></div>
  <script src="panel.js"></script>
</body>
</html>
`;

const PANEL_JS = `// Captures finished network requests and batches them to the ingest URL.
let recording = false;
let queue = [];
let sent = 0;
let flushTimer = null;

const $ = (id) => document.getElementById(id);
const statusEl = () => $('status');

// Restore saved config.
chrome.storage.local.get(['base', 'url', 'token'], (cfg) => {
  if (cfg.base) $('base').value = cfg.base;
  if (cfg.url) $('url').value = cfg.url;
  if (cfg.token) $('token').value = cfg.token;
});

function save() {
  chrome.storage.local.set({ base: $('base').value, url: $('url').value, token: $('token').value });
}

function setStatus(html) { statusEl().innerHTML = html; }

async function flush() {
  if (!queue.length) return;
  const batch = queue.splice(0, queue.length);
  const url = $('url').value.trim();
  const token = $('token').value.trim();
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ entries: batch }),
    });
    if (res.ok) { sent += batch.length; setStatus('Recording — <span class="count">' + sent + '</span> requests sent.'); }
    else { const t = await res.text(); setStatus('Send failed (' + res.status + '): ' + t.slice(0, 120)); }
  } catch (e) {
    setStatus('Send error: ' + (e && e.message ? e.message : e));
  }
}

function onRequestFinished(req) {
  if (!recording) return;
  try {
    const r = req.request || {};
    const resp = req.response || {};
    const url = r.url || '';
    if (!/^https?:\\/\\//i.test(url)) return;
    req.getContent(function (body, encoding) {
      queue.push({
        method: r.method,
        url: url,
        status: resp.status,
        responseMime: (resp.content && resp.content.mimeType) || '',
        requestHeaders: (r.headers || []).map(function (h) { return { key: h.name, value: h.value }; }),
        requestBody: r.postData ? r.postData.text : undefined,
        responseBody: encoding === 'base64' ? undefined : body,
      });
    });
  } catch (e) { /* ignore a single bad entry */ }
}

$('toggle').addEventListener('click', function () {
  recording = !recording;
  save();
  if (recording) {
    $('toggle').textContent = 'Stop recording';
    $('toggle').classList.add('stop');
    chrome.devtools.network.onRequestFinished.addListener(onRequestFinished);
    flushTimer = setInterval(flush, 3000);
    setStatus('Recording — <span class="count">0</span> requests sent. Browse your app in this tab.');
  } else {
    $('toggle').textContent = 'Start recording';
    $('toggle').classList.remove('stop');
    chrome.devtools.network.onRequestFinished.removeListener(onRequestFinished);
    if (flushTimer) clearInterval(flushTimer);
    flush();
    setStatus('Stopped. <span class="count">' + sent + '</span> requests sent in total.');
  }
});
`;

const README = `# IntelliQE Traffic Recorder (Chrome/Edge extension)

Records API traffic from your browser's DevTools and streams it straight into an
IntelliQE capture session — then turn that session into endpoints in API Studio.

## Install (load unpacked)
1. Download all files in this folder (keep the names).
2. Open chrome://extensions (or edge://extensions).
3. Enable "Developer mode".
4. "Load unpacked" → select this folder.

## Use
1. In IntelliQE → API Studio → Tools → "Browser recorder", create/choose a capture
   session and copy the **ingest URL** and **bearer token** shown there.
2. Open DevTools (F12) on your app's tab → the **IntelliQE** panel.
3. Paste the backend URL, ingest URL and token, then click **Start recording**.
4. Use your app. Requests are batched to the capture session every few seconds.
5. Back in API Studio, open the capture session and "Convert to endpoints".

Static assets (js/css/images) are filtered server-side, so only real API calls
become endpoints.
`;

export function recorderExtensionFiles(): ExtensionFile[] {
  return [
    { path: 'manifest.json', content: MANIFEST, contentType: 'application/json' },
    { path: 'devtools.html', content: DEVTOOLS_HTML, contentType: 'text/html' },
    { path: 'devtools.js', content: DEVTOOLS_JS, contentType: 'text/javascript' },
    { path: 'panel.html', content: PANEL_HTML, contentType: 'text/html' },
    { path: 'panel.js', content: PANEL_JS, contentType: 'text/javascript' },
    { path: 'README.md', content: README, contentType: 'text/markdown' },
  ];
}
