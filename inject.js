/*!
 * Omni-Perf-Doctor — 采集器 inject.js (v0.1.0)
 * ----------------------------------------------------------------------------
 * 纯 JS、零依赖、单文件。注入任意 http(s)/file 页面后：
 *   1) 用 PerformanceObserver 捕获 LCP（Largest Contentful Paint）候选元素
 *   2) 序列化元素（选择器路径 / 属性 / 计算样式 / HTML 片段）与耗时上下文
 *      （TTFB / FCP / LCP 资源的 ResourceTiming）
 *   3) 通过 WebSocket 推送到本地服务，并把服务返回的修复建议渲染到悬浮面板
 *
 * 用法：
 *   a) <script src="http://127.0.0.1:8787/inject.js"></script>
 *   b) 浏览器控制台直接粘贴本文件全部内容回车
 *   c) 注入前可通过 window.__OMNI_PERF_CONFIG__ 覆盖默认配置，例如：
 *        window.__OMNI_PERF_CONFIG__ = { wsUrl: 'ws://127.0.0.1:8787', panel: true }
 *
 * 注意：目标页面必须是 http/localhost 协议（https 页面连接 ws:// 会被混合内容策略拦截）。
 */
(function () {
  'use strict';

  if (window.__OMNI_PERF_DOCTOR__) return;
  window.__OMNI_PERF_DOCTOR__ = true;

  var CFG = Object.assign({
    wsUrl: 'ws://' + (location.hostname || '127.0.0.1') + ':8787',
    panel: true,
    log: true,
    maxHtmlLen: 400
  }, window.__OMNI_PERF_CONFIG__ || {});

  function log() {
    if (CFG.log && window.console) {
      var args = ['%c[omni-perf-doctor]', 'color:#4f8cff;font-weight:700']
        .concat([].slice.call(arguments));
      console.log.apply(console, args);
    }
  }

  function round(n) { return Math.round((n || 0) * 10) / 10; }

  /* ---------------- 元素序列化 ---------------- */

  function selectorPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      var part = node.tagName.toLowerCase();
      if (node.id) part += '#' + node.id;
      if (typeof node.className === 'string' && node.className.trim()) {
        part += '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.');
      }
      var nth = 1, sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) nth++;
      }
      if (nth > 1) part += ':nth-of-type(' + nth + ')';
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function describeElement(el) {
    if (!el) return null;
    var cs, rect;
    try { cs = getComputedStyle(el); rect = el.getBoundingClientRect(); }
    catch (e) { cs = {}; rect = {}; }
    var attrs = {};
    var attrKeys = ['src', 'srcset', 'sizes', 'href', 'rel', 'alt', 'role',
                    'loading', 'decoding', 'fetchpriority'];
    (el.getAttribute ? attrKeys : []).forEach(function (k) {
      var v = el.getAttribute(k);
      if (v !== null && v !== '') attrs[k] = v;
    });
    if (el.currentSrc) attrs.currentSrc = el.currentSrc;
    var w = el.getAttribute ? el.getAttribute('width') : null;
    var h = el.getAttribute ? el.getAttribute('height') : null;
    if (w) attrs.width = w;
    if (h) attrs.height = h;
    return {
      tag: el.tagName || null,
      id: el.id || null,
      class: (typeof el.className === 'string' && el.className) ? el.className : null,
      selector: selectorPath(el),
      rect: { width: Math.round(rect.width || 0), height: Math.round(rect.height || 0) },
      attrs: attrs,
      computed: {
        display: cs.display || null,
        fontSize: cs.fontSize || null,
        backgroundImage: (cs.backgroundImage && cs.backgroundImage !== 'none')
          ? String(cs.backgroundImage).slice(0, 200) : null
      },
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null
    };
  }

  /* ---------------- 上下文指标 ---------------- */

  var fcp = null;
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        if (e.name === 'first-contentful-paint' && fcp === null) fcp = round(e.startTime);
      });
    }).observe({ type: 'paint', buffered: true });
  } catch (e) { /* 老浏览器兜底 */ }

  function navEntry() {
    var entries = performance.getEntriesByType('navigation');
    return entries && entries[0] ? entries[0] : null;
  }

  function resourceOf(url) {
    if (!url) return null;
    var entries;
    try { entries = performance.getEntriesByName(url); } catch (e) { return null; }
    var res = entries && entries.length ? entries[entries.length - 1] : null;
    if (!res) return null;
    return {
      initiatorType: res.initiatorType || null,
      startTime: round(res.startTime),
      responseEnd: round(res.responseEnd),
      duration: round(res.duration),
      transferSize: res.transferSize || 0
    };
  }

  /* ---------------- WebSocket 客户端（断线自动重连 + 离线队列） ---------------- */

  var ws = null, ready = false, queue = [], retries = 0,
      session = 's' + Date.now().toString(36), idSeq = 0;

  function send(obj) {
    var text = JSON.stringify(obj);
    if (ready && ws && ws.readyState === 1) {
      try { ws.send(text); } catch (e) { if (queue.length < 30) queue.push(text); }
    } else if (queue.length < 30) {
      queue.push(text);
    }
  }

  function nextDelay() { return Math.min(1000 * (retries + 1), 8000); }

  function connect() {
    try {
      ws = new WebSocket(CFG.wsUrl);
    } catch (e) {
      log('WebSocket 创建失败：' + (e && e.message) + '，' + nextDelay() + 'ms 后重试');
      setTimeout(connect, nextDelay());
      retries++;
      return;
    }
    ws.onopen = function () {
      ready = true; retries = 0;
      setStatus(true);
      log('已连接到本地服务 ' + CFG.wsUrl);
      send({
        type: 'hello', session: session, page: location.href,
        ua: navigator.userAgent, viewport: window.innerWidth + 'x' + window.innerHeight
      });
      flush();
    };
    ws.onmessage = function (ev) { onServerMessage(ev.data); };
    ws.onclose = function () {
      ready = false; setStatus(false);
      log('连接断开，' + nextDelay() + 'ms 后重试');
      setTimeout(connect, nextDelay());
      retries++;
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function flush() {
    while (queue.length && ws && ws.readyState === 1) {
      try { ws.send(queue.shift()); } catch (e) { break; }
    }
  }

  function onServerMessage(text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'welcome') {
      log('服务就绪，建议来源：' + (msg.mode === 'ai' ? 'AI 大模型' : '本地规则引擎'));
    } else if (msg.type === 'suggestion') {
      renderSuggestion(msg);
      log('修复建议（' + (msg.source === 'ai' ? 'AI' : '规则') + '）已到达面板');
      (msg.list || []).forEach(function (s) { console.log('  - ' + s); });
    }
  }

  /* ---------------- 悬浮面板（Shadow DOM，不污染宿主页面样式） ---------------- */

  var panel = null;

  function ensurePanel() {
    if (panel || !CFG.panel) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', ensurePanel); return; }
    var host = document.createElement('div');
    host.setAttribute('data-omni-perf-doctor', '');
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML =
      '<div style="width:320px;max-height:300px;overflow:auto;border-radius:10px;' +
      'background:#1d1f26;color:#e9ebf2;border:1px solid #3b3f4e;' +
      'font:12px/1.55 -apple-system,Segoe UI,Roboto,"PingFang SC","Microsoft YaHei",sans-serif;' +
      'box-shadow:0 10px 34px rgba(0,0,0,.38)">' +
      '<div style="display:flex;align-items:center;gap:7px;padding:8px 10px;' +
      'border-bottom:1px solid #343846;font-weight:700">' +
      '<span id="opd-dot" style="width:8px;height:8px;border-radius:50%;background:#f0b429;flex:none"></span>' +
      'Omni-Perf-Doctor' +
      '<span id="opd-status" style="margin-left:auto;font-weight:400;color:#9ba2b2">连接中…</span></div>' +
      '<div id="opd-body" style="padding:8px 10px;color:#c9cedb"></div></div>';
    document.body.appendChild(host);
    panel = {
      root: root,
      dot: root.getElementById ? root.getElementById('opd-dot') : null,
      status: root.getElementById ? root.getElementById('opd-status') : null,
      body: root.getElementById ? root.getElementById('opd-body') : null
    };
    if (!panel.body) panel = null;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(connected) {
    if (!panel) return;
    if (panel.dot) panel.dot.style.background = connected ? '#3ecf8e' : '#f0b429';
    if (panel.status) panel.status.textContent = connected ? '已连接' : '已断开，重连中…';
  }

  function trimPanel() {
    while (panel.body.children.length > 8) panel.body.removeChild(panel.body.lastChild);
  }

  function renderLCP(p) {
    if (!panel) return;
    var el = p.element || {};
    var line = document.createElement('div');
    line.style.cssText = 'padding:4px 0 2px;border-top:1px dashed #343846';
    line.innerHTML =
      '<b style="color:#f0b429">LCP ' + esc(p.startTime) + 'ms</b> ' +
      (p.final ? '<span style="color:#3ecf8e">最终</span> ' : '<span style="color:#8b93a5">候选</span> ') +
      '<span style="color:#7ea2ff">' + esc(el.tag) + '</span> ' +
      '<span title="' + esc(el.selector) + '">' +
        esc((el.selector || '').split(' > ').pop()) + '</span>' +
      (el.rect ? ' <span style="color:#8b93a5">' + el.rect.width + '×' + el.rect.height + '</span>' : '');
    panel.body.insertBefore(line, panel.body.firstChild);
    trimPanel();
  }

  function renderSuggestion(msg) {
    if (!panel) return;
    var box = document.createElement('div');
    box.style.cssText = 'margin-top:6px;padding:7px 8px;border-radius:8px;' +
      'background:#262a35;border:1px solid #3b3f4e';
    var badge = msg.source === 'ai'
      ? '<span style="color:#3ecf8e">AI 建议</span>'
      : '<span style="color:#7ea2ff">规则建议</span>';
    var html = '<div style="margin-bottom:4px">' + badge + ' · LCP ' + esc(msg.lcpTime) +
      'ms · <span style="color:#9ba2b2">' + esc(msg.element) + '</span></div>';
    (msg.list || []).forEach(function (s) {
      html += '<div style="padding:1px 0 1px 10px;text-indent:-10px">• ' + esc(s) + '</div>';
    });
    box.innerHTML = html;
    panel.body.insertBefore(box, panel.body.firstChild);
    trimPanel();
  }

  /* ---------------- LCP 观测与上报 ---------------- */

  var lastEntry = null, finalSent = false;

  function buildPayload(entry, isFinal) {
    var el = entry.element || null;
    var url = entry.url || (el && (el.currentSrc || el.src)) || null;
    var ctx = { fcp: fcp };
    var nav = navEntry();
    if (nav) {
      ctx.ttfb = round(nav.responseStart - nav.requestStart);
      ctx.domContentLoaded = round(nav.domContentLoadedEventEnd);
      ctx.loadEventEnd = round(nav.loadEventEnd);
    }
    var res = resourceOf(url);
    if (res) ctx.resource = res;
    return {
      type: 'lcp',
      id: session + '_' + (++idSeq),
      page: location.href,
      final: !!isFinal,
      startTime: round(entry.startTime),
      renderTime: round(entry.renderTime || entry.loadTime || entry.startTime),
      size: Math.round(entry.size || 0),
      element: describeElement(el),
      html: el && el.outerHTML ? String(el.outerHTML).slice(0, CFG.maxHtmlLen) : null,
      lcpResourceUrl: url,
      context: ctx,
      ts: Date.now()
    };
  }

  function emit(entry, isFinal) {
    var p = buildPayload(entry, isFinal);
    send(p);
    renderLCP(p);
    log((isFinal ? '最终 LCP ' : 'LCP 候选 ') + p.startTime + 'ms（渲染 ' + p.renderTime +
      'ms）— ' + (p.element ? p.element.selector : '?'));
  }

  try {
    new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!lastEntry || e.startTime > lastEntry.startTime) {
          lastEntry = e;
          emit(e, false);
        }
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (err) {
    log('当前浏览器不支持 largest-contentful-paint 观测：' + (err && err.message));
  }

  // 页面失去焦点 / 关闭时上报最终 LCP（与 Chrome 判定 final LCP 的时机一致）
  function sendFinal() {
    if (finalSent || !lastEntry) return;
    finalSent = true;
    emit(lastEntry, true);
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) sendFinal(); });
  document.addEventListener('pagehide', sendFinal);

  ensurePanel();
  connect();
  log('采集器已加载，目标服务 ' + CFG.wsUrl);
})();
