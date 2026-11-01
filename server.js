/*!
 * Omni-Perf-Doctor — 本地服务 server.js (v0.1.0)
 * ----------------------------------------------------------------------------
 * 零依赖纯 Node 实现（不依赖 express / ws 等任何三方包）：
 *   - HTTP   ：提供 Demo 页 / inject.js / 历史报告（/reports）
 *   - WebSocket：内置 RFC6455 协议实现，接收采集器推送的 LCP 数据
 *   - AI     ：配置 API Key 后调用大模型（默认 DeepSeek，兼容 OpenAI 接口）
 *              生成修复建议；未配置 Key 时自动回退到本地规则引擎
 *
 * 启动：
 *   node server.js                      # 默认 127.0.0.1:8787
 *   set OMNI_AI_KEY=sk-xxx & node server.js    # 启用 AI 建议
 *
 * 环境变量：
 *   PORT            服务端口（默认 8787）
 *   HOST            监听地址（默认 127.0.0.1）
 *   OMNI_AI_KEY     AI 接口 Key（也可用 DEEPSEEK_API_KEY / OPENAI_API_KEY）
 *   OMNI_AI_BASE_URL AI 接口地址（默认 https://api.deepseek.com/v1/chat/completions）
 *   OMNI_AI_MODEL   模型名（默认 deepseek-chat）
 */
'use strict';

var http = require('http');
var https = require('https');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var PORT = Number(process.env.PORT || 8787);
var HOST = process.env.HOST || '127.0.0.1';
var ROOT = __dirname;
var DEMO_DIR = path.join(ROOT, 'demo');

var AI_BASE = process.env.OMNI_AI_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
var AI_MODEL = process.env.OMNI_AI_MODEL || 'deepseek-chat';
var AI_KEY = process.env.OMNI_AI_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';

var MAX_REPORTS = 100;
var reports = [];
var clients = new Set();

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.py': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
function log(msg) { console.log('[' + ts() + '] ' + msg); }

/* ---------------- HTTP：静态服务 + 报告接口 ---------------- */

function safeJoin(base, rel) {
  var p = path.resolve(base, '.' + (rel.charAt(0) === '/' ? rel : '/' + rel));
  if (p === base || p.indexOf(base + path.sep) === 0) return p;
  return null;
}

function sendFile(res, file) {
  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 ' + (err.code || err.message));
      return;
    }
    var ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function onRequest(req, res) {
  var urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]);
  if (urlPath === '/reports' || urlPath === '/reports/') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ count: reports.length, reports: reports }, null, 2));
    return;
  }
  if (urlPath === '/' || urlPath === '/index.html') {
    sendFile(res, path.join(DEMO_DIR, 'index.html'));
    return;
  }
  if (urlPath === '/inject.js') {
    sendFile(res, path.join(ROOT, 'inject.js'));
    return;
  }
  var f = safeJoin(DEMO_DIR, urlPath) || safeJoin(ROOT, urlPath);
  if (f && fs.existsSync(f) && fs.statSync(f).isFile()) {
    sendFile(res, f);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ---------------- WebSocket：内置 RFC6455 实现 ---------------- */

var WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function onUpgrade(req, socket, head) {
  var key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  var accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n' +
    '\r\n');
  socket.setNoDelay(true);
  var client = { socket: socket, buf: Buffer.alloc(0), frag: null, page: '?' };
  if (head && head.length) client.buf = Buffer.concat([client.buf, head]);
  clients.add(client);
  log('WebSocket 握手成功：' + (req.socket && req.socket.remoteAddress));
  socket.on('data', function (chunk) {
    client.buf = Buffer.concat([client.buf, chunk]);
    parseFrames(client);
  });
  socket.on('error', function () { destroyClient(client); });
  socket.on('close', function () { destroyClient(client); });
}

function destroyClient(client) {
  if (!clients.has(client)) return;
  clients.delete(client);
  log('采集器断开连接：' + client.page);
  try { client.socket.destroy(); } catch (e) {}
}

function parseFrames(client) {
  for (;;) {
    var buf = client.buf;
    if (buf.length < 2) return;
    var b1 = buf[0], b2 = buf[1];
    var fin = (b1 & 0x80) !== 0;
    var opcode = b1 & 0x0f;
    var masked = (b2 & 0x80) !== 0;
    var len = b2 & 0x7f;
    var offset = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = readUint64BE(buf, 2);
      offset = 10;
    }
    if (!masked) { // RFC6455：客户端帧必须掩码
      log('协议错误：未掩码的客户端帧，连接已关闭');
      destroyClient(client);
      return;
    }
    var need = offset + 4 + len;
    if (buf.length < need) return; // 等待完整帧
    var mask = buf.slice(offset, offset + 4);
    var payload = Buffer.allocUnsafe(len);
    buf.copy(payload, 0, offset + 4, need);
    for (var i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    client.buf = buf.slice(need);
    if (!handleFrame(client, fin, opcode, payload)) return;
  }
}

function readUint64BE(buf, off) {
  if (typeof buf.readBigUInt64BE === 'function') return Number(buf.readBigUInt64BE(off));
  return buf.readUInt32BE(off) * 4294967296 + buf.readUInt32BE(off + 4);
}

function handleFrame(client, fin, opcode, payload) {
  if (opcode === 8) { // close：回送关闭帧后销毁
    sendFrame(client.socket, 0x8, Buffer.alloc(0));
    destroyClient(client);
    return false;
  }
  if (opcode === 9) { // ping → pong
    sendFrame(client.socket, 0xA, payload);
    return true;
  }
  if (opcode === 0xA) return true; // pong
  if (opcode !== 1 && opcode !== 2 && opcode !== 0) return true; // 忽略其它控制帧
  var data = client.frag ? Buffer.concat([client.frag, payload]) : payload;
  if (!fin) { client.frag = data; return true; } // 分片累积
  client.frag = null;
  var text;
  try { text = data.toString('utf8'); } catch (e) { return true; }
  var msg;
  try { msg = JSON.parse(text); } catch (e) { return true; } // 忽略非法 JSON
  try { onMessage(client, msg); } catch (err) { log('处理消息出错：' + (err && err.message)); }
  return true;
}

function sendFrame(socket, opcode, payload) {
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len % 4294967296, 6);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch (e) {}
}

function sendJSON(client, obj) {
  if (client && clients.has(client)) {
    sendFrame(client.socket, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }
}

/* ---------------- 业务：LCP 报告处理 + 建议生成 ---------------- */

function onMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'hello') {
    client.page = msg.page || '?';
    log('采集器已连接：' + client.page);
    sendJSON(client, { type: 'welcome', version: '0.1.0', mode: AI_KEY ? 'ai' : 'rules' });
    return;
  }
  if (msg.type === 'lcp') {
    handleLCP(client, msg);
    return;
  }
  log('收到未知消息类型：' + msg.type);
}

function describe(p) {
  var el = p.element || {};
  var extra = el.id ? '#' + el.id
    : (el.class ? '.' + String(el.class).trim().split(/\s+/)[0] : '');
  return (el.tag || '?') + extra;
}

function handleLCP(client, p) {
  log('LCP 报告[' + (p.final ? '最终' : '候选') + '] ' + p.startTime + 'ms · ' +
    describe(p) + ' · ' + ((p.element && p.element.selector) || '-'));
  var record = { at: ts(), page: p.page, payload: p, source: null, suggestions: null };
  reports.push(record);
  if (reports.length > MAX_REPORTS) reports.shift();
  suggest(p).then(function (r) {
    record.source = r.source;
    record.suggestions = r.list;
    sendJSON(client, {
      type: 'suggestion', for: p.id, source: r.source, list: r.list,
      lcpTime: p.startTime, element: describe(p)
    });
    log('→ ' + (r.source === 'ai' ? 'AI' : '规则') + '建议已返回（' + r.list.length +
      ' 条）：' + r.list[0]);
  }).catch(function (err) {
    log('→ 建议生成失败：' + (err && err.message));
  });
}

function suggest(p) {
  if (AI_KEY) {
    return aiSuggest(p)
      .then(function (list) { return { source: 'ai', list: list }; })
      .catch(function (err) {
        log('AI 调用失败，回退到规则引擎：' + (err && err.message));
        return { source: 'rules', list: ruleSuggest(p) };
      });
  }
  return Promise.resolve({ source: 'rules', list: ruleSuggest(p) });
}

function stripLarge(p) {
  var copy = JSON.parse(JSON.stringify(p));
  if (copy.html) copy.html = String(copy.html).slice(0, 300);
  return copy;
}

function aiSuggest(p) {
  return new Promise(function (resolve, reject) {
    var url;
    try { url = new URL(AI_BASE); } catch (e) { return reject(new Error('OMNI_AI_BASE_URL 无效')); }
    var body = JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content: '你是 Web 性能优化专家。用户会给出 LCP（Largest Contentful Paint）' +
            '观测数据（JSON，时间单位均为 ms）。请给出 3-5 条可执行修复建议，每条一句话，' +
            '聚焦缩短 LCP 时间。使用无序列表输出，不要额外解释。'
        },
        {
          role: 'user',
          content: '页面 LCP 观测数据：\n```json\n' + JSON.stringify(stripLarge(p), null, 2) + '\n```'
        }
      ],
      temperature: 0.3
    });
    var lib = url.protocol === 'https:' ? https : http;
    var req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AI_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('AI 接口 HTTP ' + res.statusCode + '：' + String(data).slice(0, 160)));
        }
        var content;
        try { content = JSON.parse(data).choices[0].message.content; }
        catch (e) { return reject(new Error('AI 响应解析失败')); }
        var list = String(content || '').split('\n')
          .map(function (l) { return l.replace(/^[\s>*\-–•]+/, '').trim(); })
          .filter(Boolean);
        resolve(list.length ? list : ['AI 未返回有效建议']);
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, function () { req.destroy(new Error('AI 请求超时(20s)')); });
    req.end(body);
  });
}

/* ---------------- 本地规则引擎（无 API Key 时的建议来源） ---------------- */

function ruleSuggest(p) {
  var out = [];
  var el = p.element || {};
  var attrs = el.attrs || {};
  var comp = el.computed || {};
  var ctx = p.context || {};
  var res = ctx.resource;
  var isImg = el.tag === 'IMG';
  var isBg = !!comp.backgroundImage;

  if (isImg) {
    if (!attrs.width || !attrs.height) {
      out.push('为 <img> 补充显式 width/height（或容器 aspect-ratio），避免布局偏移并提前预留空间');
    }
    if (attrs.loading === 'lazy') {
      out.push('LCP 图片正在使用 loading="lazy"，请改为立即加载（首屏关键图不应懒加载）');
    }
    if (!attrs.srcset) {
      out.push('补充 srcset/sizes，按 DPR 与视口提供多档尺寸，减少不必要的下载');
    }
    if (!attrs.fetchpriority) {
      out.push('为 LCP 图片设置 fetchpriority="high"，与首屏其它资源竞争时优先调度');
    }
  }
  if (isImg || isBg) {
    if (res) {
      var kb = res.transferSize / 1024;
      if (kb > 150) {
        out.push('LCP 图片传输体积约 ' + Math.round(kb) + 'KB：建议压缩并转 WebP/AVIF，经 CDN 提供（目标 < 100KB）');
      }
      if (res.startTime > 500) {
        out.push('LCP 资源在 ' + Math.round(res.startTime) + 'ms 才开始下载（晚发现）：' +
          '对关键图增加 <link rel="preload" as="image">，或直接内联在首屏 HTML 中');
      }
      if (res.duration > 300) {
        out.push('LCP 资源下载耗时 ' + Math.round(res.duration) + 'ms：检查 CDN 回源与带宽，考虑多档尺寸分发');
      }
    } else {
      out.push('未观测到该 LCP 资源的 ResourceTiming（可能是 data: URI 或跨域缺少 Timing-Allow-Origin）：' +
        '如为外部资源请确认可被度量');
    }
  } else {
    out.push('LCP 为文本元素：为字体设置 font-display: swap 并 <link rel="preload"> 首屏字体，避免字体加载阻塞渲染');
    out.push('内联首屏关键 CSS（Critical CSS），剔除首屏未使用的 CSS 以提前首次绘制');
    if (comp.fontSize && parseFloat(comp.fontSize) > 40) {
      out.push('LCP 为大号标题（' + comp.fontSize + '）：可使用系统字体兜底或对 Web 字体做子集化');
    }
  }
  if (ctx.ttfb != null && ctx.ttfb > 300) {
    out.push('TTFB ' + Math.round(ctx.ttfb) + 'ms 偏高：检查服务端渲染与缓存，引入边缘 CDN 或静态化首屏');
  }
  if (p.startTime > 2500) {
    out.push('整体 LCP ' + p.startTime + 'ms 超过 2500ms（差）：优先减少渲染阻塞 JS/CSS，延迟加载非首屏资源');
  } else if (p.startTime < 1200) {
    out.push('当前 LCP ' + p.startTime + 'ms < 1200ms（良好）：保持现有结构，持续监控回归');
  }
  if (!out.length) out.push('未发现明显问题，建议结合火焰图进一步定位');
  return out.slice(0, 6);
}

/* ---------------- 启动 ---------------- */

var server = http.createServer(onRequest);
server.on('upgrade', onUpgrade);
server.on('error', function (err) {
  var hint = err && err.code === 'EADDRINUSE'
    ? '（端口 ' + PORT + ' 被占用，可用 set PORT=xxxx 更换）' : '';
  log('服务启动失败：' + (err && err.message) + hint);
  process.exit(1);
});
server.listen(PORT, HOST, function () {
  log('Omni-Perf-Doctor 本地服务已启动 @ ' + HOST + ':' + PORT);
  log('  Demo 页面  http://' + HOST + ':' + PORT + '/');
  log('  注入脚本  http://' + HOST + ':' + PORT + '/inject.js');
  log('  历史报告  http://' + HOST + ':' + PORT + '/reports');
  log('  建议引擎  ' + (AI_KEY
    ? 'AI（' + AI_BASE + '，模型 ' + AI_MODEL + '）'
    : '本地规则引擎（设置 OMNI_AI_KEY 或 DEEPSEEK_API_KEY 启用 AI）'));
  log('等待采集器连接…（Ctrl+C 退出）');
});
