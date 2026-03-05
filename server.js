import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, watchFile, unwatchFile, statSync, readdirSync, renameSync, unlinkSync, openSync, readSync, closeSync, realpathSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { homedir, userInfo, platform, networkInterfaces } from 'node:os';
import { execSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { LOG_FILE, _initPromise, _resumeState, resolveResumeChoice, _projectName, _logDir, _cachedApiKey, _cachedAuthHeader, _cachedHaikuModel } from './interceptor.js';
import { LOG_DIR } from './findcc.js';
import { t, detectLanguage } from './i18n.js';
import { checkAndUpdate } from './updater.js';
import { loadPlugins, runWaterfallHook, runParallelHook, getPluginsInfo, PLUGINS_DIR } from './plugin-loader.js';

const PREFS_FILE = join(LOG_DIR, 'preferences.json');
const isCliMode = process.env.CCV_CLI_MODE === '1';
const isCodexProvider = ['openai', 'codex'].includes((process.env.CCV_PROVIDER || '').toLowerCase());
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');


// macOS user profile (avatar + display name), cached once
let _userProfile = null;
function getUserProfile() {
  if (_userProfile) return _userProfile;
  const info = userInfo();
  const name = info.username || 'User';
  let displayName = name;
  let avatarBase64 = null;

  if (platform() === 'darwin') {
    try {
      const rn = execSync(`dscl . -read /Users/${name} RealName`, { encoding: 'utf-8', timeout: 3000 });
      const match = rn.match(/RealName:\n?\s*(.+)/);
      if (match && match[1].trim()) displayName = match[1].trim();
    } catch { }

    try {
      const buf = execSync(`dscl . -read /Users/${name} JPEGPhoto | tail -1 | xxd -r -p`, { timeout: 5000, maxBuffer: 1024 * 1024 });
      if (buf && buf.length > 100) {
        avatarBase64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
      }
    } catch { }
  }

  _userProfile = { name: displayName, avatar: avatarBase64 };
  return _userProfile;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const START_PORT = 7008;
const MAX_PORT = 7099;
const HOST = '0.0.0.0';

// 局域网访问 token（本地 127.0.0.1 免验证）
const ACCESS_TOKEN = randomBytes(16).toString('hex');

let clients = [];
let server;
let actualPort = START_PORT;
// 跟踪所有被 watch 的日志文件
const watchedFiles = new Map();
let codexPollingTimer = null;
let codexCurrentSessionFile = null;
let codexLastMtimeMs = 0;
let codexEntriesCache = [];
// Stats Worker 实例
let statsWorker = null;

function startStatsWorker() {
  try {
    statsWorker = new Worker(new URL('./stats-worker.js', import.meta.url));
    statsWorker.on('error', (err) => {
      console.error('[CC Viewer] Stats worker error:', err.message);
      statsWorker = null;
    });
    statsWorker.on('exit', (code) => {
      if (code !== 0) {
        console.error('[CC Viewer] Stats worker exited with code', code);
      }
      statsWorker = null;
    });
    // 初始化：全量扫描当前项目
    if (_projectName && _logDir) {
      statsWorker.postMessage({ type: 'init', logDir: LOG_DIR, projectName: _projectName });
    }
  } catch (err) {
    console.error('[CC Viewer] Failed to start stats worker:', err.message);
  }
}

function notifyStatsWorker(logFile) {
  if (statsWorker && _projectName) {
    statsWorker.postMessage({ type: 'update', logDir: LOG_DIR, projectName: _projectName, logFile });
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function extractTextBlocks(content = []) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(block => block && typeof block === 'object' && typeof block.text === 'string')
    .map(block => block.text);
}

function normalizeToolInput(argumentsRaw) {
  if (typeof argumentsRaw !== 'string') return argumentsRaw ?? {};
  try {
    return JSON.parse(argumentsRaw);
  } catch {
    return { raw: argumentsRaw };
  }
}

function normalizeToolOutput(outputRaw) {
  if (typeof outputRaw === 'string') return outputRaw;
  if (outputRaw == null) return '';
  try {
    return JSON.stringify(outputRaw, null, 2);
  } catch {
    return String(outputRaw);
  }
}

function mapTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const total = usage.total_tokens ?? input + output;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cache_read_input_tokens: cached,
  };
}

function parseCodexSessionContent(content) {
  const lines = content.split('\n').filter(Boolean);
  const records = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  if (records.length === 0) return [];
  const hasCodexShape = records.some(r => r.type === 'session_meta' || (r.type === 'event_msg' && r.payload?.type === 'user_message'));
  if (!hasCodexShape) return [];

  const meta = records.find(r => r.type === 'session_meta')?.payload || {};
  const sessionId = meta.id || 'unknown';
  const model = meta.model || meta.model_slug || 'codex';
  const project = (meta.cwd || '').split('/').filter(Boolean).pop() || 'codex';

  const entries = [];
  const conversation = [];
  let latestUsage = null;
  let callSeq = 0;
  let currentTurn = null;

  const finalizeTurn = () => {
    if (!currentTurn) return;
    const baseTs = currentTurn.timestamp || new Date().toISOString();

    if (currentTurn.userText) {
      conversation.push({
        role: 'user',
        content: [{ type: 'text', text: currentTurn.userText }],
        _timestamp: baseTs,
      });
    }

    let lastAssistantText = '';
    for (const event of currentTurn.events) {
      if (event.kind === 'tool_call') {
        conversation.push({
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: event.id,
            name: event.name || 'tool',
            input: event.input ?? {},
          }],
          _timestamp: event.timestamp || baseTs,
        });
      } else if (event.kind === 'tool_result') {
        conversation.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: event.callId,
            content: event.output || '',
            is_error: false,
          }],
          _timestamp: event.timestamp || baseTs,
        });
      } else if (event.kind === 'assistant_text' && event.text) {
        lastAssistantText = event.text;
        conversation.push({
          role: 'assistant',
          content: [{ type: 'text', text: event.text }],
          _timestamp: event.timestamp || baseTs,
        });
      }
    }

    if (!lastAssistantText && currentTurn.lastAgentMessage) {
      lastAssistantText = currentTurn.lastAgentMessage;
      conversation.push({
        role: 'assistant',
        content: [{ type: 'text', text: currentTurn.lastAgentMessage }],
        _timestamp: currentTurn.endTimestamp || baseTs,
      });
    }

    const usage = mapTokenUsage(currentTurn.tokenUsage || latestUsage);
    const timestamp = currentTurn.endTimestamp || baseTs;
    const turnKey = currentTurn.turnId || (entries.length + 1);
    entries.push({
      timestamp,
      project,
      url: `codex://session/${sessionId}/turn/${turnKey}`,
      method: 'SESSION',
      provider: 'openai',
      mainAgent: true,
      body: {
        model,
        messages: JSON.parse(JSON.stringify(conversation)),
        metadata: {
          user_id: sessionId,
          source: 'codex_session',
          turn_id: currentTurn.turnId || null,
        },
      },
      response: {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: {
          output_text: lastAssistantText,
          usage: usage || undefined,
        },
      },
      duration: currentTurn.durationMs || 0,
      isStream: false,
      isCountTokens: false,
    });

    currentTurn = null;
  };

  for (const record of records) {
    const ts = record.timestamp || new Date().toISOString();
    if (record.type === 'event_msg' && record.payload?.type === 'token_count') {
      latestUsage = record.payload?.info?.last_token_usage || record.payload?.info?.total_token_usage || latestUsage;
      if (currentTurn) currentTurn.tokenUsage = latestUsage;
      continue;
    }
    if (record.type === 'event_msg' && record.payload?.type === 'user_message') {
      finalizeTurn();
      currentTurn = {
        turnId: null,
        timestamp: ts,
        endTimestamp: null,
        durationMs: 0,
        userText: record.payload?.message || '',
        events: [],
        lastAgentMessage: '',
        tokenUsage: latestUsage,
      };
      continue;
    }
    if (record.type === 'event_msg' && record.payload?.type === 'task_started') {
      if (currentTurn) currentTurn.turnId = record.payload?.turn_id || currentTurn.turnId;
      continue;
    }
    if (record.type === 'event_msg' && record.payload?.type === 'task_complete') {
      if (currentTurn) {
        currentTurn.turnId = record.payload?.turn_id || currentTurn.turnId;
        currentTurn.endTimestamp = ts;
        currentTurn.lastAgentMessage = record.payload?.last_agent_message || currentTurn.lastAgentMessage;
        currentTurn.durationMs = Math.max(0, new Date(currentTurn.endTimestamp).getTime() - new Date(currentTurn.timestamp).getTime());
      }
      finalizeTurn();
      continue;
    }
    if (!currentTurn || record.type !== 'response_item' || !record.payload) continue;

    const payload = record.payload;
    if (payload.type === 'message' && payload.role === 'assistant') {
      const textBlocks = extractTextBlocks(payload.content);
      for (const text of textBlocks) {
        if (!text) continue;
        currentTurn.events.push({ kind: 'assistant_text', text, timestamp: ts });
      }
    } else if (payload.type === 'function_call') {
      const callId = payload.call_id || `call_${++callSeq}`;
      currentTurn.events.push({
        kind: 'tool_call',
        callId,
        id: callId,
        name: payload.name || 'tool',
        input: normalizeToolInput(payload.arguments),
        timestamp: ts,
      });
    } else if (payload.type === 'function_call_output') {
      const callId = payload.call_id || `call_${++callSeq}`;
      currentTurn.events.push({
        kind: 'tool_result',
        callId,
        output: normalizeToolOutput(payload.output),
        timestamp: ts,
      });
    }
  }
  finalizeTurn();
  return entries;
}

function findLatestCodexSessionFile() {
  if (!existsSync(CODEX_SESSIONS_DIR)) return null;
  try {
    const years = readdirSync(CODEX_SESSIONS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
    for (const y of years) {
      const yPath = join(CODEX_SESSIONS_DIR, y);
      const months = readdirSync(yPath, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
      for (const m of months) {
        const mPath = join(yPath, m);
        const days = readdirSync(mPath, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
        for (const d of days) {
          const dPath = join(mPath, d);
          const files = readdirSync(dPath).filter(f => /^rollout-.*\.jsonl$/.test(f)).sort().reverse();
          if (files.length > 0) return join(dPath, files[0]);
        }
      }
    }
  } catch { }
  return null;
}

function readCodexEntries() {
  const latest = findLatestCodexSessionFile();
  if (!latest || !existsSync(latest)) return [];
  try {
    const content = readFileSync(latest, 'utf-8');
    const entries = parseCodexSessionContent(content);
    codexCurrentSessionFile = latest;
    codexEntriesCache = entries;
    codexLastMtimeMs = statSync(latest).mtimeMs || 0;
    return entries;
  } catch {
    return [];
  }
}

function hasViewerLogEntries() {
  if (!existsSync(LOG_FILE)) return false;
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    return content.split('\n---\n').some(line => line.trim());
  } catch {
    return false;
  }
}

function readLogFile() {
  if (!existsSync(LOG_FILE)) {
    if (isCodexProvider) {
      // Codex 模式兜底：当代理日志为空时，回退到 ~/.codex/sessions 解析
      return readCodexEntries();
    }
    return [];
  }

  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    const entries = content.split('\n---\n').filter(line => line.trim());
    const parsed = entries.map(entry => {
      try {
        return JSON.parse(entry);
      } catch {
        return null;
      }
    }).filter(Boolean);
    // 去重：同一 timestamp+url 的条目，后出现的（带 response）覆盖先出现的（在途）
    const map = new Map();
    for (const entry of parsed) {
      const key = `${entry.timestamp}|${entry.url}`;
      map.set(key, entry);
    }
    const viewerEntries = Array.from(map.values());
    if (isCodexProvider && viewerEntries.length === 0) {
      // Codex 模式兜底：代理日志尚未写入时，回退到 session 解析
      return readCodexEntries();
    }
    return viewerEntries;
  } catch (err) {
    console.error('Error reading log file:', err);
    if (isCodexProvider) return readCodexEntries();
    return [];
  }
}

function sendToClients(entry) {
  clients.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch (err) {
      // Client disconnected
    }
  });
}

function watchLogFile(logFile) {
  if (watchedFiles.has(logFile)) return;
  let lastSize = 0;
  watchedFiles.set(logFile, true);
  watchFile(logFile, { interval: 500 }, () => {
    try {
      const content = readFileSync(logFile, 'utf-8');
      const newContent = content.slice(lastSize);
      lastSize = content.length;

      if (newContent.trim()) {
        const entries = newContent.split('\n---\n').filter(line => line.trim());
        entries.forEach(entry => {
          try {
            const parsed = JSON.parse(entry);
            sendToClients(parsed);
          } catch (err) {
            // Skip invalid entries
          }
        });
        // 通知 stats worker 更新统计
        notifyStatsWorker(logFile);
      }

      // 检测日志文件是否已轮转到新文件
      if (LOG_FILE !== logFile && !watchedFiles.has(LOG_FILE)) {
        // 轮转发生，发送 full_reload 让客户端重新加载新文件
        const newEntries = readLogFile();
        clients.forEach(client => {
          try {
            client.write(`event: full_reload\ndata: ${JSON.stringify(newEntries)}\n\n`);
          } catch { }
        });
        watchLogFile(LOG_FILE);
      }
    } catch (err) {
      // File not yet created, will retry on next poll
    }
  });
}

function startWatching() {
  watchLogFile(LOG_FILE);
  // Codex 模式下保留 session 轮询作为兜底（仅在代理日志为空时前端才会显示）
  if (isCodexProvider) {
    startWatchingCodexSession();
  }
}

function startWatchingCodexSession() {
  const pushFullReload = (entries) => {
    clients.forEach(client => {
      try {
        client.write(`event: full_reload\ndata: ${JSON.stringify(entries)}\n\n`);
      } catch { }
    });
  };

  const tick = () => {
    // 一旦代理日志有内容，优先使用代理日志实时流，不再用 session 快照覆盖列表
    if (hasViewerLogEntries()) return;

    const latest = findLatestCodexSessionFile();
    if (!latest || !existsSync(latest)) return;
    let changed = false;
    try {
      const mtimeMs = statSync(latest).mtimeMs || 0;
      if (latest !== codexCurrentSessionFile) {
        changed = true;
      } else if (mtimeMs > codexLastMtimeMs + 0.1) {
        changed = true;
      }
      if (!changed) return;
      const content = readFileSync(latest, 'utf-8');
      const parsed = parseCodexSessionContent(content);
      codexCurrentSessionFile = latest;
      codexLastMtimeMs = mtimeMs;
      codexEntriesCache = parsed;
      pushFullReload(parsed);
    } catch { }
  };

  const initEntries = readCodexEntries();
  if (!hasViewerLogEntries() && initEntries.length > 0) {
    clients.forEach(client => {
      try {
        client.write(`event: full_reload\ndata: ${JSON.stringify(initEntries)}\n\n`);
      } catch { }
    });
  }

  if (codexPollingTimer) clearInterval(codexPollingTimer);
  codexPollingTimer = setInterval(tick, 1000);
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const url = parsedUrl.pathname;
  const method = req.method;

  // WebSocket 路径不处理，交给 upgrade 事件
  if (url === '/ws/terminal') {
    return;
  }

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 局域网访问 token 验证（本地 127.0.0.1 / ::1 免验证，静态资源免验证）
  const remoteIp = req.socket.remoteAddress;
  const isLocal = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
  const isStaticAsset = url.startsWith('/assets/') || url === '/favicon.ico';
  if (!isLocal && !isStaticAsset) {
    const urlToken = parsedUrl.searchParams.get('token');
    if (urlToken !== ACCESS_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: invalid token' }));
      return;
    }
  }

  // User preferences API
  if (url === '/api/preferences' && method === 'GET') {
    let prefs = {};
    try { if (existsSync(PREFS_FILE)) prefs = JSON.parse(readFileSync(PREFS_FILE, 'utf-8')); } catch { }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(prefs));
    return;
  }

  if (url === '/api/preferences' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        let prefs = {};
        try { if (existsSync(PREFS_FILE)) prefs = JSON.parse(readFileSync(PREFS_FILE, 'utf-8')); } catch { }
        Object.assign(prefs, incoming);
        writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(prefs));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // 注册新的日志文件进行 watch（供新进程复用旧服务时调用）
  if (url === '/api/register-log' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { logFile } = JSON.parse(body);
        if (logFile && typeof logFile === 'string' && logFile.startsWith(LOG_DIR) && existsSync(logFile)) {
          watchLogFile(logFile);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid log file path' }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request body' }));
      }
    });
    return;
  }

  // 用户选择继续/新开日志
  if (url === '/api/resume-choice' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { choice } = JSON.parse(body);
        if (choice !== 'continue' && choice !== 'new') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid choice' }));
          return;
        }
        const result = resolveResumeChoice(choice);
        if (!result) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Already resolved' }));
          return;
        }
        // 重新 watch 最终的日志文件
        watchLogFile(result.logFile);
        // 广播 resume_resolved + full_reload
        const resolvedData = JSON.stringify({ logFile: result.logFile });
        clients.forEach(client => {
          try {
            client.write(`event: resume_resolved\ndata: ${resolvedData}\n\n`);
          } catch { }
        });
        // 发送 full_reload 让客户端重新加载数据
        const entries = readLogFile();
        clients.forEach(client => {
          try {
            client.write(`event: full_reload\ndata: ${JSON.stringify(entries)}\n\n`);
          } catch { }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, logFile: result.logFile }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request body' }));
      }
    });
    return;
  }

  // 翻译 API
  if (url === '/api/translate' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { text, from = 'en', to } = JSON.parse(body);
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "text" field' }));
          return;
        }

        // 确定目标语言
        let targetLang = to;
        if (!targetLang) {
          try {
            if (existsSync(PREFS_FILE)) {
              const prefs = JSON.parse(readFileSync(PREFS_FILE, 'utf-8'));
              if (prefs.lang) targetLang = prefs.lang;
            }
          } catch { }
          if (!targetLang) targetLang = detectLanguage();
        }

        // 源语言与目标语言相同，直接返回
        if (targetLang === from) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text, from, to: targetLang }));
          return;
        }

        // 获取 API Key（仅 x-api-key 认证，不复用 session token 避免上下文污染）
        // 优先级: 环境变量 > 拦截缓存 > 从 authHeader 中提取 sk- 开头的 key
        let apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || _cachedApiKey;
        if (!apiKey && _cachedAuthHeader) {
          // Bearer sk-xxx 格式：提取实际的 API key
          const m = _cachedAuthHeader.match(/^Bearer\s+(sk-\S+)$/i);
          if (m) apiKey = m[1];
        }
        if (!apiKey) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No API key available. Set ANTHROPIC_API_KEY or use x-api-key authentication.' }));
          return;
        }

        const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
        const inputText = Array.isArray(text) ? text.join('\n---SPLIT---\n') : text;

        const reqHeaders = {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
          'x-cc-viewer-internal': '1',
        };

        const apiRes = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify({
            model: _cachedHaikuModel || 'claude-haiku-4-5-20251001',
            max_tokens: 32000,
            tools: [],
            system: [{
              type: "text",
              text: `You are a translator. Translate the following text from ${from} to ${targetLang}. Output only the translated text, nothing else.`
            }],
            messages: [{ role: 'user', content: inputText }],
            stream: false,
            temperature: 1,
          }),
        });

        if (!apiRes.ok) {
          const errBody = await apiRes.text();
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Translation API failed', status: apiRes.status, detail: errBody }));
          return;
        }

        const apiData = await apiRes.json();
        let translated = apiData.content?.[0]?.text || '';

        // 如果输入是数组，拆分回数组
        if (Array.isArray(text)) {
          translated = translated.split(/\n?---SPLIT---\n?/);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: translated, from, to: targetLang }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error', message: err.message }));
      }
    });
    return;
  }

  // SSE endpoint
  if (url === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    clients.push(res);

    // 如果有待决的 resume 选择，发送 resume_prompt 事件
    if (_resumeState) {
      res.write(`event: resume_prompt\ndata: ${JSON.stringify({ recentFileName: _resumeState.recentFileName })}\n\n`);
    }

    const entries = readLogFile();
    // 初始化时发送 full_reload 事件（而非逐条发送），让前端可以批量处理时间戳
    res.write(`event: full_reload\ndata: ${JSON.stringify(entries)}\n\n`);

    req.on('close', () => {
      clients = clients.filter(client => client !== res);
    });
    return;
  }

  // API endpoint
  if (url === '/api/requests' && method === 'GET') {
    const entries = readLogFile();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
    return;
  }

  // 当前监控的项目名称
  if (url === '/api/project-name' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projectName: _projectName || '' }));
    return;
  }

  // 当前版本号
  if (url === '/api/version-info' && method === 'GET') {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: pkg.version }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read version' }));
    }
    return;
  }

  // 项目统计数据
  if (url === '/api/project-stats' && method === 'GET') {
    try {
      if (!_projectName) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No project name' }));
        return;
      }
      const statsFile = join(LOG_DIR, _projectName, `${_projectName}.json`);
      if (!existsSync(statsFile)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Stats file not found' }));
        return;
      }
      const stats = readFileSync(statsFile, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(stats);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 所有项目统计数据
  if (url === '/api/all-project-stats' && method === 'GET') {
    try {
      const allStats = {};
      if (existsSync(LOG_DIR)) {
        const entries = readdirSync(LOG_DIR, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const project = entry.name;
          const statsFile = join(LOG_DIR, project, `${project}.json`);
          if (existsSync(statsFile)) {
            try {
              allStats[project] = JSON.parse(readFileSync(statsFile, 'utf-8'));
            } catch { }
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(allStats));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // macOS 用户头像和显示名
  if (url === '/api/user-profile' && method === 'GET') {
    const profile = getUserProfile();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(profile));
    return;
  }

  // 文件浏览器 API（CLI 模式下项目目录浏览）
  if (url === '/api/files' && method === 'GET') {
    const reqPath = parsedUrl.searchParams.get('path') || '.';
    // 安全校验：拒绝绝对路径和 .. 路径穿越
    if (reqPath.startsWith('/') || reqPath.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid path' }));
      return;
    }
    const cwd = process.env.CCV_PROJECT_DIR || process.cwd();
    const targetDir = join(cwd, reqPath);
    try {
      const entries = readdirSync(targetDir, { withFileTypes: true });
      const HIDDEN = new Set(['node_modules', '.git', '.svn', '.hg', '.DS_Store', '__pycache__', '.next', '.nuxt', 'dist', '.cache', '.idea', '.vscode']);
      const items = entries
        .filter(e => !e.name.startsWith('.') && !HIDDEN.has(e.name))
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(items));
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Directory not found' }));
    }
    return;
  }

  // 读取文件内容 API
  if (url === '/api/file-content' && method === 'GET') {
    const reqPath = parsedUrl.searchParams.get('path');
    if (!reqPath || reqPath.startsWith('/') || reqPath.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid path' }));
      return;
    }
    const cwd = process.env.CCV_PROJECT_DIR || process.cwd();
    const targetFile = join(cwd, reqPath);
    try {
      if (!existsSync(targetFile)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `File not found: ${targetFile}` }));
        return;
      }
      const stat = statSync(targetFile);
      if (!stat.isFile()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not a file' }));
        return;
      }
      // 限制文件大小 5MB
      if (stat.size > 5 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large' }));
        return;
      }
      const content = readFileSync(targetFile, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: reqPath, content, size: stat.size }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Cannot read file: ${err.message}` }));
    }
    return;
  }

  // CLI 模式检测
  if (url === '/api/cli-mode' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cliMode: isCliMode }));
    return;
  }

  // Git 状态
  if (url === '/api/git-status' && method === 'GET') {
    try {
      const cwd = process.env.CCV_PROJECT_DIR || process.cwd();
      const output = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = output.split('\n').filter(line => line.trim());
      const changes = lines.map(line => {
        const status = line.substring(0, 2).trim();
        const file = line.substring(3).trim();
        return { status, file };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ changes }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, changes: [] }));
    }
    return;
  }

  // Git diff 数据获取
  if (url.startsWith('/api/git-diff') && method === 'GET') {
    try {
      const cwd = process.env.CCV_PROJECT_DIR || process.cwd();
      const filesParam = parsedUrl.searchParams.get('files');

      if (!filesParam) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing files parameter' }));
        return;
      }

      const files = filesParam.split(',').map(f => f.trim()).filter(Boolean);
      const diffs = [];

      for (const file of files) {
        // 安全检查：防止路径穿越
        if (file.includes('..') || file.startsWith('/')) continue;

        try {
          const statusOutput = execSync(`git status --porcelain -- "${file}"`, { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
          if (!statusOutput.trim()) continue;

          const status = statusOutput.substring(0, 2).trim();
          const is_new = status === 'A' || status === '??';
          const is_deleted = status === 'D';

          // 检查是否为二进制文件（已删除文件跳过）
          let is_binary = false;
          if (!is_deleted) {
            try {
              const diffCheck = execSync(`git diff --numstat HEAD -- "${file}"`, { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
              if (diffCheck.includes('-\t-\t')) {
                is_binary = true;
              }
            } catch {}
          }

          let old_content = '';
          let new_content = '';

          if (!is_binary) {
            // 获取旧内容（HEAD 版本）
            if (!is_new) {
              try {
                old_content = execSync(`git show HEAD:"${file}"`, { cwd, encoding: 'utf-8', timeout: 5000, maxBuffer: 5 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
              } catch {
                old_content = '';
              }
            }

            // 获取新内容（工作区版本）
            if (!is_deleted) {
              try {
                const filePath = join(cwd, file);
                if (existsSync(filePath)) {
                  const stat = statSync(filePath);
                  if (stat.size > 5 * 1024 * 1024) {
                    // 文件过大
                    diffs.push({ file, status, is_large: true, size: stat.size });
                    continue;
                  }
                  new_content = readFileSync(filePath, 'utf-8');
                }
              } catch {
                new_content = '';
              }
            }
          }

          diffs.push({
            file,
            status,
            old_content,
            new_content,
            is_binary,
            is_new,
            is_deleted
          });
        } catch (err) {
          // 跳过无法处理的文件
          continue;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ diffs }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, diffs: [] }));
    }
    return;
  }

  // 插件管理 API
  if (url === '/api/plugins' && method === 'GET') {
    const plugins = getPluginsInfo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ plugins, pluginsDir: PLUGINS_DIR }));
    return;
  }

  if (url === '/api/plugins' && method === 'DELETE') {
    const file = parsedUrl.searchParams.get('file');
    if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid file name' }));
      return;
    }
    const filePath = join(PLUGINS_DIR, file);
    try {
      if (!existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }
      unlinkSync(filePath);
      await loadPlugins();
      const plugins = getPluginsInfo();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plugins, pluginsDir: PLUGINS_DIR }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url === '/api/plugins/reload' && method === 'POST') {
    try {
      await loadPlugins();
      const plugins = getPluginsInfo();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plugins, pluginsDir: PLUGINS_DIR }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url === '/api/plugins/upload' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { files: fileList } = JSON.parse(body);
        if (!Array.isArray(fileList) || fileList.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No files provided' }));
          return;
        }
        // 确保插件目录存在
        if (!existsSync(PLUGINS_DIR)) {
          mkdirSync(PLUGINS_DIR, { recursive: true });
        }
        for (const { name, content } of fileList) {
          if (!name || typeof content !== 'string') continue;
          const filename = name.replace(/.*[/\\]/, '');
          if (!filename.endsWith('.js') && !filename.endsWith('.mjs')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Only .js or .mjs files are allowed' }));
            return;
          }
          if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid file name' }));
            return;
          }
          writeFileSync(join(PLUGINS_DIR, filename), content, 'utf-8');
        }
        await loadPlugins();
        const plugins = getPluginsInfo();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, plugins, pluginsDir: PLUGINS_DIR }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 返回局域网访问地址
  if (url === '/api/local-url' && method === 'GET') {
    const nets = networkInterfaces();
    let localIp = '127.0.0.1';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          localIp = net.address;
          break;
        }
      }
      if (localIp !== '127.0.0.1') break;
    }
    const defaultUrl = `http://${localIp}:${actualPort}?token=${ACCESS_TOKEN}`;
    const hookResult = await runWaterfallHook('localUrl', { url: defaultUrl, ip: localIp, port: actualPort, token: ACCESS_TOKEN });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: hookResult.url }));
    return;
  }

  // 列出本地日志文件（按项目分组，遍历项目子目录）
  if (url === '/api/local-logs' && method === 'GET') {
    try {
      const grouped = {};
      if (existsSync(LOG_DIR)) {
        const entries = readdirSync(LOG_DIR, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const project = entry.name;
          const projectDir = join(LOG_DIR, project);
          const files = readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl'))
            .sort()
            .reverse();
          // 从项目统计缓存中读取 per-file 数据，避免逐文件扫描
          let statsFiles = null;
          try {
            const statsFile = join(projectDir, `${project}.json`);
            if (existsSync(statsFile)) {
              statsFiles = JSON.parse(readFileSync(statsFile, 'utf-8')).files;
            }
          } catch { }
          for (const f of files) {
            const match = f.match(/^(.+?)_(\d{8}_\d{6})\.jsonl$/);
            if (!match) continue;
            const ts = match[2];
            const filePath = join(projectDir, f);
            const size = statSync(filePath).size;
            const turns = statsFiles?.[f]?.summary?.sessionCount || 0;
            if (!grouped[project]) grouped[project] = [];
            grouped[project].push({ file: `${project}/${f}`, timestamp: ts, size, turns });
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...grouped, _currentProject: _projectName || '' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 读取指定本地日志文件（支持 project/file 路径）
  if (url === '/api/local-log' && method === 'GET') {
    const file = parsedUrl.searchParams.get('file');
    if (!file || file.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid file name' }));
      return;
    }

    // 验证文件类型：只允许 .jsonl 文件
    if (!file.endsWith('.jsonl')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid file type. Only .jsonl files are allowed.' }));
      return;
    }

    const filePath = join(LOG_DIR, file);
    try {
      if (!existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }

      // 验证文件确实在 LOG_DIR 内（防止路径穿越）
      const realPath = realpathSync(filePath);
      const realLogDir = realpathSync(LOG_DIR);
      if (!realPath.startsWith(realLogDir)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied' }));
        return;
      }

      const content = readFileSync(filePath, 'utf-8');
      const entries = content.split('\n---\n').filter(line => line.trim()).map(entry => {
        try { return JSON.parse(entry); } catch { return null; }
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entries));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 合并日志文件
  if (url === '/api/merge-logs' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { files } = JSON.parse(body);
        if (!Array.isArray(files) || files.length < 2) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'At least 2 files required' }));
          return;
        }
        // 校验所有文件属于同一 project
        const projects = new Set(files.map(f => f.split('/')[0]));
        if (projects.size !== 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'All files must belong to the same project' }));
          return;
        }
        // 校验文件存在且无路径穿越
        for (const f of files) {
          if (f.includes('..')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid file path' }));
            return;
          }
          if (!existsSync(join(LOG_DIR, f))) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `File not found: ${f}` }));
            return;
          }
        }
        // files 已按时间正序传入，合并内容写入第一个文件
        const targetFile = files[0];
        const targetPath = join(LOG_DIR, targetFile);
        const contents = files.map(f => readFileSync(join(LOG_DIR, f), 'utf-8').trimEnd());
        writeFileSync(targetPath, contents.join('\n---\n') + '\n');
        // 删除其余文件
        for (let i = 1; i < files.length; i++) {
          unlinkSync(join(LOG_DIR, files[i]));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, merged: targetFile }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET /api/concept?lang=zh&doc=Tool-Bash
  if (method === 'GET' && url === '/api/concept') {
    const lang = parsedUrl.searchParams.get('lang') || 'zh';
    const doc = parsedUrl.searchParams.get('doc') || '';
    // 安全校验：只允许字母、数字、连字符
    if (!/^[a-zA-Z0-9-]+$/.test(doc) || !/^[a-z]{2}(-[a-zA-Z]{2,})?$/.test(lang)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid parameters' }));
      return;
    }
    let mdPath = join(__dirname, 'concepts', lang, `${doc}.md`);
    if (!existsSync(mdPath) && lang !== 'zh') {
      mdPath = join(__dirname, 'concepts', 'zh', `${doc}.md`);
    }
    if (existsSync(mdPath)) {
      const content = readFileSync(mdPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(content);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
    return;
  }

  // 静态文件服务
  if (method === 'GET') {
    let filePath = url === '/' ? '/index.html' : url;
    // 去掉 query string
    filePath = filePath.split('?')[0];

    const fullPath = join(__dirname, 'dist', filePath);

    try {
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        const content = readFileSync(fullPath);
        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return;
      }
    } catch (err) {
      // fall through to SPA fallback
    }

    // SPA fallback: 非 API/非静态文件请求返回 index.html
    try {
      const indexPath = join(__dirname, 'dist', 'index.html');
      const html = readFileSync(indexPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(404);
      res.end('Not Found');
    }
    return;
  }

  // 非 GET 请求的 API 404
  if (url.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}

export async function startViewer() {
  return new Promise((resolve, reject) => {
    function tryListen(port) {
      if (port > MAX_PORT) {
        console.error(t('server.portsBusy', { start: START_PORT, end: MAX_PORT }));
        resolve(null);
        return;
      }

      // 先检测 127.0.0.1:port 是否已被占用（避免 0.0.0.0 和 127.0.0.1 绑定不冲突的问题）
      const probe = createConnection({ host: '127.0.0.1', port });
      probe.on('connect', () => {
        probe.destroy();
        tryListen(port + 1); // 端口已被占用，尝试下一个
      });
      probe.on('error', () => {
        probe.destroy();
        // 端口空闲，绑定 0.0.0.0
        const currentServer = createServer(handleRequest);

        currentServer.listen(port, HOST, () => {
          server = currentServer;
          actualPort = port;
          const url = `http://127.0.0.1:${port}`;
          console.error(t('server.started', { host: '127.0.0.1', port }));
          // v2.0.69 之前的版本会清空控制台，自动打开浏览器确保用户能看到界面
          try {
            const ccPkgPath = join(__dirname, '..', '@anthropic-ai', 'claude-code', 'package.json');
            const ccVer = JSON.parse(readFileSync(ccPkgPath, 'utf-8')).version;
            const [maj, min, pat] = ccVer.split('.').map(Number);
            if (maj < 2 || (maj === 2 && min === 0 && pat < 69)) {
              const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
              execSync(`${cmd} ${url}`, { stdio: 'ignore', timeout: 5000 });
            }
          } catch { }
          startWatching();
          startStatsWorker();
          // CLI 模式下启动 WebSocket 服务
          if (isCliMode) {
            setupTerminalWebSocket(currentServer);
          }
          // 加载插件并通知服务器已启动
          loadPlugins()
            .then(() => runParallelHook('serverStarted', { port, host: HOST }))
            .catch(err => console.error('[CC Viewer] Plugin init error:', err.message));
          resolve(server);
        });

        currentServer.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            tryListen(port + 1);
          } else {
            reject(err);
          }
        });
      });
    }

    tryListen(START_PORT);
  });
}

async function setupTerminalWebSocket(httpServer) {
  try {
    const { WebSocketServer } = await import('ws');
    const { writeToPty, resizePty, onPtyData, onPtyExit, getPtyState, getOutputBuffer } = await import('./pty-manager.js');

    const wss = new WebSocketServer({ noServer: true });

    // 多客户端共享 PTY 的尺寸冲突解决：
    // 移动端优先——只要有移动端在线，PTY 始终使用移动端尺寸，
    // PC 端的 resize 仅存储不生效，避免宽屏尺寸导致移动端乱码。
    // PC 端显示窄输出但完全可读，移动端永远不会乱码。
    let activeWs = null;              // 当前活跃的 WebSocket 连接
    const clientSizes = new Map();    // ws → { cols, rows }
    const mobileClients = new Set();  // 移动端连接集合

    // 找到一个在线的移动端并返回其尺寸
    const getMobileSize = () => {
      for (const mws of mobileClients) {
        if (mws.readyState === 1) {
          const size = clientSizes.get(mws);
          if (size) return size;
        }
      }
      return null;
    };

    httpServer.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (pathname === '/ws/terminal') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on('connection', (ws) => {
      // 发送当前 PTY 状态
      const state = getPtyState();
      ws.send(JSON.stringify({ type: 'state', ...state }));

      // 发送历史输出缓冲
      const buffer = getOutputBuffer();
      if (buffer) {
        ws.send(JSON.stringify({ type: 'data', data: buffer }));
      }

      // PTY 输出 → WebSocket
      const removeDataListener = onPtyData((data) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'data', data }));
        }
      });

      // PTY 退出 → WebSocket
      const removeExitListener = onPtyExit((exitCode) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'exit', exitCode }));
        }
      });

      // WebSocket → PTY
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'input') {
            // 发送 input 的客户端成为活跃客户端
            if (activeWs !== ws) {
              activeWs = ws;
              // 切换活跃客户端时，如果有移动端在线则保持移动端尺寸，
              // 否则切换到新活跃客户端的尺寸
              const mSize = getMobileSize();
              if (mSize) {
                resizePty(mSize.cols, mSize.rows);
              } else {
                const size = clientSizes.get(ws);
                if (size) {
                  resizePty(size.cols, size.rows);
                }
              }
            }
            writeToPty(msg.data);
          } else if (msg.type === 'resize') {
            // 存储该客户端的尺寸
            clientSizes.set(ws, { cols: msg.cols, rows: msg.rows });
            if (msg.mobile) mobileClients.add(ws);
            // 移动端 resize 始终生效；PC 端仅在无移动端时生效
            if (msg.mobile) {
              resizePty(msg.cols, msg.rows);
            } else if (mobileClients.size === 0 && (activeWs === ws || activeWs === null)) {
              activeWs = ws;
              resizePty(msg.cols, msg.rows);
            }
          }
        } catch {}
      });

      ws.on('close', () => {
        removeDataListener();
        removeExitListener();
        clientSizes.delete(ws);
        mobileClients.delete(ws);
        if (activeWs === ws) {
          // 活跃客户端断开，将控制权交给剩余的某个客户端
          activeWs = null;
          // 优先使用移动端尺寸，无移动端则用剩余客户端尺寸
          const mSize = getMobileSize();
          if (mSize) {
            resizePty(mSize.cols, mSize.rows);
          } else {
            for (const [remainWs, size] of clientSizes) {
              if (remainWs.readyState === 1) {
                activeWs = remainWs;
                resizePty(size.cols, size.rows);
                break;
              }
            }
          }
        }
      });
    });
  } catch (err) {
    console.error('[CC Viewer] Failed to setup terminal WebSocket:', err.message);
  }
}

export function getPort() {
  return actualPort;
}

export function stopViewer() {
  runParallelHook('serverStopping').catch(() => {});
  // 如果用户未做选择，将临时文件转为正式文件
  if (_resumeState && _resumeState.tempFile) {
    try {
      const { tempFile } = _resumeState;
      if (existsSync(tempFile)) {
        const newPath = tempFile.replace('_temp.jsonl', '.jsonl');
        renameSync(tempFile, newPath);
      }
    } catch { }
  }
  for (const logFile of watchedFiles.keys()) {
    unwatchFile(logFile);
  }
  watchedFiles.clear();
  if (codexPollingTimer) {
    clearInterval(codexPollingTimer);
    codexPollingTimer = null;
  }
  clients.forEach(client => client.end());
  clients = [];
  if (server) {
    server.close();
  }
  if (statsWorker) {
    statsWorker.terminate();
    statsWorker = null;
  }
}

// Auto-start the viewer after log file init completes
_initPromise.then(() => {
  startViewer().then((srv) => {
    if (!srv) return;
    // 延迟 3 秒异步检查更新
    setTimeout(() => {
      checkAndUpdate().then(result => {
        if (result.status === 'updated') {
          clients.forEach(client => {
            try { client.write(`event: update_completed\ndata: ${JSON.stringify({ version: result.remoteVersion })}\n\n`); } catch { }
          });
        } else if (result.status === 'major_available') {
          clients.forEach(client => {
            try { client.write(`event: update_major_available\ndata: ${JSON.stringify({ version: result.remoteVersion })}\n\n`); } catch { }
          });
        }
      }).catch(() => { });
    }, 3000);
  }).catch(err => {
    console.error('Failed to start CC Viewer:', err);
  });
});

// 进程退出时，将未决的临时文件转为正式文件
function handleExit() {
  if (_resumeState && _resumeState.tempFile) {
    try {
      if (existsSync(_resumeState.tempFile)) {
        const newPath = _resumeState.tempFile.replace('_temp.jsonl', '.jsonl');
        renameSync(_resumeState.tempFile, newPath);
      }
    } catch { }
  }
}
process.on('exit', handleExit);
process.on('SIGINT', () => { handleExit(); process.exit(); });
process.on('SIGTERM', () => { handleExit(); process.exit(); });
