# Omni-Perf-Doctor

注入式 LCP 性能诊断器：**浏览器采集 LCP 元素 → WebSocket → 本地 Node 服务 → AI 修复建议**。

- `inject.js`：纯 JS、零依赖、单文件采集器。注入页面后用 `PerformanceObserver` 捕获
  LCP（最大内容绘制）候选元素，序列化元素信息与耗时上下文，经 WebSocket 推送到本地服务，
  并把返回的修复建议渲染到页面右下角的悬浮面板。
- `server.js`：零依赖纯 Node 本地服务。内置 RFC6455 WebSocket 协议实现，提供 HTTP
  静态服务与 `/reports` 历史报告接口，并调用 AI（默认 DeepSeek，兼容 OpenAI 接口）
  生成修复建议；未配置 API Key 时自动回退到本地规则引擎。

## 数据流

```
┌────────────────────────────┐        WebSocket         ┌─────────────────────────────┐
│  任意页面 + inject.js      │  ─────────────────────►  │  本地 Node 服务 server.js   │
│  PerformanceObserver       │   LCP 元素 + 上下文       │  ├─ 内置 WS 协议实现         │
│  · LCP 候选/最终元素       │  ◄─────────────────────  │  ├─ 规则引擎 / AI 大模型     │
│  · TTFB / FCP / 资源耗时   │       修复建议回传        │  └─ /reports 历史报告        │
└────────────────────────────┘                          └─────────────────────────────┘
```

## 快速开始

```bash
# 1. 启动本地服务（默认 127.0.0.1:8787）
node server.js

# 2. 打开 Demo 页面（内置一个刻意保留性能问题的首屏）
#    浏览器访问 http://127.0.0.1:8787/
#    右下角悬浮面板将展示 LCP 捕获结果与修复建议

# 3. 查看历史报告
#    浏览器访问 http://127.0.0.1:8787/reports
```

## 注入到任意页面

满足以下任一方式即可诊断自己的页面（页面须为 http/localhost/file 协议）：

1. 在页面模板中加入 `<script src="http://127.0.0.1:8787/inject.js"></script>`；
2. 打开目标页面，在浏览器控制台粘贴 `inject.js` 全部内容并回车；
3. 注入前覆盖默认配置：
   ```js
   window.__OMNI_PERF_CONFIG__ = { wsUrl: 'ws://127.0.0.1:8787', panel: true, log: true };
   ```

> 注意：https 页面直接连接 `ws://` 会被浏览器的混合内容策略拦截，目前仅支持
> http / localhost / file 协议页面。

## 启用 AI 建议（可选）

未配置 Key 时使用内置规则引擎（零成本开箱即用）。配置后走 AI 大模型：

```bash
# Windows cmd
set OMNI_AI_KEY=sk-xxxxxxxx
node server.js

# 也可用 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 环境变量
# 可选：OMNI_AI_BASE_URL / OMNI_AI_MODEL 指向其它兼容接口
```

AI 调用失败（网络/配额/超时）时会自动回退到规则引擎，面板上的徽标会区分来源：
`AI 建议` / `规则建议`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `OMNI_AI_KEY` | - | AI 接口 Key（等价回退：`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`） |
| `OMNI_AI_BASE_URL` | `https://api.deepseek.com/v1/chat/completions` | AI 接口地址 |
| `OMNI_AI_MODEL` | `deepseek-chat` | 模型名 |

## 采集器上报字段

每条 LCP 报告（`type: 'lcp'`）包含：

- `startTime` / `renderTime` / `size`：LCP 时间与绘制面积
- `element`：`tag` / `id` / `class` / `selector`（CSS 选择器路径）/ `rect` / `attrs`
  （src、srcset、loading、fetchpriority…）/ `computed`（display、fontSize、
  backgroundImage）/ `text`
- `html`：元素 outerHTML 片段（截断）
- `context`：`ttfb` / `fcp` / `domContentLoaded` / `loadEventEnd`，以及 LCP 资源的
  ResourceTiming（`startTime` / `responseEnd` / `duration` / `transferSize`）
- `final`：页面隐藏/关闭时上报的最终 LCP 标记

## 目录结构

```
omni-perf-doctor/
├── inject.js            # 采集器（纯 JS 单文件，含 Shadow DOM 悬浮面板）
├── server.js            # 本地服务（HTTP + 内置 WebSocket + AI/规则建议引擎）
├── package.json
├── .gitignore
├── README.md
└── demo/
    ├── index.html       # 演示页（延迟插入大图模拟 LCP 问题）
    ├── hero.jpg         # 演示首屏大图（由 make-hero.py 生成）
    └── make-hero.py     # 重新生成演示大图
```

重新生成演示大图：`python demo/make-hero.py`（依赖 Pillow）。

## 已知限制

- 仅支持 http / localhost / file 协议页面（https 页面需自建 wss 代理）。
- LCP 元素的 `element` 字段由浏览器提供，个别场景（如匿名元素）可能为 `null`。
- 跨域资源需要响应头 `Timing-Allow-Origin` 才能读取 `transferSize` 等字段。
