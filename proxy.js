
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setupInterceptor } from './interceptor.js';

// Setup interceptor to patch fetch
setupInterceptor();

function getBaseUrlFromSettings(settingsPath) {
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.env && settings.env.ANTHROPIC_BASE_URL) {
        return settings.env.ANTHROPIC_BASE_URL;
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function getAnthropicBaseUrl() {
  let cwd;
  try { cwd = process.cwd(); } catch { cwd = null; }

  // Check config files in priority order (highest first)
  const configPaths = [];
  if (cwd) {
    configPaths.push(join(cwd, '.claude', 'settings.local.json'));
    configPaths.push(join(cwd, '.claude', 'settings.json'));
  }
  configPaths.push(join(homedir(), '.claude', 'settings.json'));

  for (const configPath of configPaths) {
    const url = getBaseUrlFromSettings(configPath);
    if (url) return url;
  }

  // Check env var
  if (process.env.ANTHROPIC_BASE_URL) {
    return process.env.ANTHROPIC_BASE_URL;
  }

  // Default
  return 'https://api.anthropic.com';
}

function getOpenAIBaseUrl() {
  const candidates = [
    process.env.OPENAI_BASE_URL,
    process.env.OPENAI_API_BASE_URL,
    process.env.OPENAI_API_BASE,
  ];
  for (const v of candidates) {
    if (v && typeof v === 'string') return v;
  }
  return 'https://api.openai.com/v1';
}

function buildForwardUrl(baseUrl, reqUrl) {
  const base = new URL(baseUrl);
  const req = new URL(reqUrl, 'http://127.0.0.1');
  let reqPath = req.pathname || '/';
  const basePath = base.pathname || '/';

  if (basePath.endsWith('/v1') && reqPath.startsWith('/v1/')) {
    reqPath = reqPath.slice(3);
  }

  const normalizedBasePath = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const normalizedReqPath = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
  base.pathname = `${normalizedBasePath}${normalizedReqPath}`.replace(/\/{2,}/g, '/');
  base.search = req.search || '';
  return base.toString();
}

export function startProxy(options = {}) {
  const provider = options.provider === 'openai' ? 'openai' : 'anthropic';
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const originalBaseUrl = provider === 'openai' ? getOpenAIBaseUrl() : getAnthropicBaseUrl();

      // Use the patched fetch (which logs to cc-viewer)
      try {
        // Convert incoming headers
        const headers = { ...req.headers };
        delete headers.host; // Let fetch set the host

        const buffers = [];
        for await (const chunk of req) {
          buffers.push(chunk);
        }
        const body = Buffer.concat(buffers);

        const fetchOptions = {
          method: req.method,
          headers: headers,
        };

        // 标记此请求为 CC-Viewer 代理转发的 Claude API 请求
        // 拦截器识别到此 Header 会强制记录，忽略 URL 匹配规则
        fetchOptions.headers['x-cc-viewer-trace'] = 'true';

        if (body.length > 0) {
          fetchOptions.body = body;
        }

        // 拼接完整 URL，并处理 baseUrl 带路径前缀时的重复路径问题（如 /v1 + /v1/responses）
        const fullUrl = buildForwardUrl(originalBaseUrl, req.url || '/');

        const response = await fetch(fullUrl, fetchOptions);

        // fetch 自动解压，需移除编码相关 header 避免客户端重复解压
        const responseHeaders = {};
        for (const [key, value] of response.headers.entries()) {
          // Skip Content-Encoding and Transfer-Encoding to let Node/Client handle it
          if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'transfer-encoding' && key.toLowerCase() !== 'content-length') {
            responseHeaders[key] = value;
          }
        }

        // 如果是错误响应，尝试解析并打印具体的错误信息
        if (!response.ok) {
          try {
            const errorText = await response.text();
            try {
              const errorJson = JSON.parse(errorText);
              // 提取 Anthropic 格式的错误信息
              if (errorJson.error && errorJson.error.message) {
                console.error(`[CC-Viewer Proxy] API Error: ${errorJson.error.message}`);
              } else if (errorJson.message) {
                console.error(`[CC-Viewer Proxy] API Error: ${errorJson.message}`);
              } else {
                console.error(`[CC-Viewer Proxy] API Error (${response.status}): ${errorText.slice(0, 200)}`);
              }
            } catch {
              console.error(`[CC-Viewer Proxy] API Error (${response.status}): ${errorText.slice(0, 200)}`);
            }

            res.writeHead(response.status, responseHeaders);
            res.end(errorText);
            return;
          } catch (err) {
            // 读取 body 失败，回退到流式处理
            console.error('[CC-Viewer Proxy] Failed to read error body:', err);
          }
        }

        res.writeHead(response.status, responseHeaders);

        if (response.body) {
          const { Readable } = await import('node:stream');
          // @ts-ignore
          const nodeStream = Readable.fromWeb(response.body);
          nodeStream.pipe(res);
        } else {
          res.end();
        }
      } catch (err) {
        // Log concise error unless debugging
        if (process.env.CCV_DEBUG) {
          console.error('[CC-Viewer Proxy] Error:', err);
        } else {
          // Format concise error message
          let msg = err.message;
          if (err.cause) msg += ` (${err.cause.message || err.cause.code || err.cause})`;
          // Shorten common timeout errors
          if (msg.includes('HEADERS_TIMEOUT')) msg = 'Upstream headers timeout';
          if (msg.includes('BODY_TIMEOUT')) msg = 'Upstream body timeout';

          console.error(`[CC-Viewer Proxy] Request failed: ${msg}`);
        }

        res.statusCode = 502;
        res.end('Proxy Error');
      }
    });

    // Start on random port
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(address.port);
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}
