#!/usr/bin/env node
/**
 * OpenCode Unified — CLI Agent (Termux / PC)
 * TUI Edition: блоки, индикаторы, панели, спиннеры, прогресс-бары.
 * Использует curl для Zen API (обход Cloudflare TLS fingerprinting).
 * Встроенный MCP API: http://localhost:8765/mcp/call по умолчанию (MCP_PORT для смены).
 * Порт 3000 оставлен приложению пользователя.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, execFileSync, spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const vm = require('vm');
// Optional project helpers. The runtime is deliberately self-contained: it can
// still start when the original ../lib directory is not installed (for example
// when this single file is copied to Termux or run from a downloaded archive).
let resolveWithDoH = async hostname => {
  try {
    const dns = require('dns').promises;
    const records = await dns.resolve4(String(hostname));
    return records?.[0] ? { ip: records[0], server: 'system DNS' } : null;
  } catch { return null; }
};
let TUNNEL_DEFAULT_PORT = 8877;
let startTunnel = (port = TUNNEL_DEFAULT_PORT, host = '127.0.0.1', onReady) => {
  // Minimal HTTP forwarder fallback. It supports the exact /proxy/<absolute-url>
  // contract used by this file and has no dependency on an external module.
  const server = http.createServer((req, res) => {
    const marker = '/proxy/';
    if (!req.url.startsWith(marker)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Tunnel route not found');
      return;
    }
    let target;
    try { target = new URL(decodeURIComponent(req.url.slice(marker.length))); }
    catch { res.writeHead(400); res.end('Invalid proxy target'); return; }
    if (!['http:', 'https:'].includes(target.protocol)) {
      res.writeHead(400); res.end('Only HTTP(S) targets are supported'); return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: target.host };
    delete headers['content-length'];
    const forward = client.request(target, { method: req.method, headers }, upstream => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    });
    forward.on('error', error => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      if (!res.writableEnded) res.end(String(error.message || error));
    });
    req.pipe(forward);
  });
  server.once('listening', () => { try { onReady?.(); } catch {} });
  server.listen(Number(port) || TUNNEL_DEFAULT_PORT, host);
  return server;
};
try {
  const doh = require('../lib/doh');
  if (typeof doh.resolveWithDoH === 'function') resolveWithDoH = doh.resolveWithDoH;
} catch {}
try {
  const tunnel = require('../lib/tunnel');
  if (typeof tunnel.startTunnel === 'function') startTunnel = tunnel.startTunnel;
  if (Number.isInteger(tunnel.TUNNEL_DEFAULT_PORT)) TUNNEL_DEFAULT_PORT = tunnel.TUNNEL_DEFAULT_PORT;
} catch {}

// Optional at module-load time so MCP/CLI still starts with a clear terminal
// capability error if npm dependencies have not been installed yet.
let WebSocketServer = null;
let nodePty = null;
try { ({ WebSocketServer } = require('ws')); } catch {}
try { nodePty = require('node-pty'); } catch {}
let onnxRuntime = null;
try { onnxRuntime = require('onnxruntime-node'); } catch {}

// MCP/agent API никогда не должна занимать порт проекта (обычно 3000).
// Переопределение: MCP_PORT=8765 node cli-agent-unified-termux-mcp.js
function validPort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}
let UI_PORT = validPort(process.env.MCP_PORT || process.env.AGENT_PORT || '8765', 8765);

// ═══════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════
let CONFIG = {
  defaultModel: 'deepseek-v4-flash-free',
  maxHistory: 25,
  maxTokens: 32000,
  temperature: 0.5,
  autoUseTools: true,
  verbose: process.env.VERBOSE === '1',
  maxAgentSteps: parseInt(process.env.MAX_STEPS || '25', 10),
  sessionHistoryLimit: Math.max(50, parseInt(process.env.SESSION_HISTORY_LIMIT || '500', 10) || 500),
  longTaskMode: process.env.ZEN_LONG_TASKS === '1',
  longTaskMaxSteps: Math.max(50, parseInt(process.env.ZEN_LONG_MAX_STEPS || '250', 10) || 250),
  longCommandTimeoutMs: Math.max(300000, parseInt(process.env.ZEN_LONG_COMMAND_TIMEOUT_MS || '3600000', 10) || 3600000),
  maxProviderRetries: Math.max(1, parseInt(process.env.MAX_PROVIDER_RETRIES || '3', 10) || 3),
  // Ответ модели выводится по мере поступления; /stream переключает режим.
  streamMode: true,
  autoApprove: false,
  agentMode: 'build',
  askClarifyingQuestions: process.env.ZEN_CLARIFY !== '0',
  showThinking: true,
  reasoningEffort: 'low',
  compactMode: false,
  showDashboard: true,
  proxy: process.env.ZEN_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || '',
  proxyPool: (process.env.ZEN_PROXY_POOL || '').split(',').map(item => item.trim()).filter(Boolean),
  proxyActiveIndex: 0,
  proxyFailover: process.env.ZEN_PROXY_FAILOVER !== '0',
  proxySlowMs: Math.max(1000, parseInt(process.env.ZEN_PROXY_SLOW_MS || '12000', 10) || 12000),
  curlIpv4: true,
  // На Termux все относительные пути MCP идут в общую память Android, а не в $HOME Termux.
  workspaceRoot: process.env.ZEN_WORKSPACE || process.env.MCP_WORKSPACE || '',
  activeProject: process.env.ZEN_PROJECT || '',
  // Реальный stdout/stderr команд сразу печатается в терминал, без скрывающего спиннера.
  liveToolLogs: process.env.ZEN_LIVE_LOGS !== '0',
  // Защита от «блуждания»: агент не должен без предупреждения изменять файлы вне
  // рабочей папки активной сессии. Включено по умолчанию; отключить: ZEN_WORKSPACE_LOCK=0.
  workspaceLock: process.env.ZEN_WORKSPACE_LOCK !== '0',
  // В некоторых UI-обёртках Termux ANSI cursorTo вырезается и кадры склеиваются.
  // Включается вручную только для настоящего ANSI-терминала: /animation on.
  animatedIndicator: process.env.ZEN_ANIMATION === '1',
  indicatorAnimationMs: Math.max(80, parseInt(process.env.ZEN_ANIMATION_MS || '120', 10) || 120),
  indicatorFallbackMs: Math.max(500, parseInt(process.env.ZEN_INDICATOR_MS || '1000', 10) || 1000),
  indicatorStyle: process.env.ZEN_INDICATOR_STYLE || 'game',
  provider: 'zen',
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || '',
  visionModel: process.env.OPENROUTER_VISION_MODEL || 'google/gemma-4-31b-it:free',
  pollinationsApiKey: process.env.POLLINATIONS_API_KEY || '',
  zenApiBaseUrl: process.env.ZEN_API_BASE_URL || 'https://opencode.ai/zen/v1',
  zenApiFallbackUrls: (process.env.ZEN_API_FALLBACK_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
  tunnelEnabled: process.env.ZEN_TUNNEL === '1' || process.env.ZEN_TUNNEL === 'true',
  tunnelPort: validPort(process.env.ZEN_TUNNEL_PORT || String(TUNNEL_DEFAULT_PORT), TUNNEL_DEFAULT_PORT),
  githubToken: '',
  githubRepo: process.env.GITHUB_REPO || '',
  githubApiBaseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  onnxModelPath: process.env.ZEN_ONNX_MODEL || '',
};

let tunnelServer = null;

function zenApiUrls() {
  const urls = [CONFIG.zenApiBaseUrl];
  for (const u of CONFIG.zenApiFallbackUrls) if (!urls.includes(u)) urls.push(u);
  if (CONFIG.tunnelEnabled) {
    const tunnelUrl = `http://127.0.0.1:${CONFIG.tunnelPort}`;
    const primaryUrl = urls[0].replace(/\/+$/, '');
    const tunnelProxied = tunnelUrl + '/proxy/' + primaryUrl;
    if (!urls.includes(tunnelProxied)) urls.push(tunnelProxied);
  }
  return urls;
}

function zenApiChatUrl() { return zenApiUrls().map(u => u.replace(/\/+$/, '') + '/chat/completions'); }
function zenApiModelsUrl() { return zenApiUrls().map(u => u.replace(/\/+$/, '') + '/models'); }

const AGENT_MODES = {
  build: { label: '🔨 Build', description: 'Разработка и выполнение инструментов с подтверждениями.' },
  plan: { label: '🗺️ Plan', description: 'Только анализ, уточняющие вопросы и план; изменения запрещены.' },
  explore: { label: '🔎 Explore', description: 'Только чтение, поиск и диагностика; изменения запрещены.' }
};
function normalizedAgentMode(value) { return AGENT_MODES[value] ? value : 'build'; }
function providerDisplayName() { return currentProvider === 'openrouter' ? 'OpenRouter' : currentProvider === 'zen' ? 'Zen' : currentProvider; }
function agentStepLimit() { return CONFIG.longTaskMode ? Math.max(CONFIG.maxAgentSteps, CONFIG.longTaskMaxSteps) : CONFIG.maxAgentSteps; }
function safeCommandTimeout(value, defaultValue = 18000) {
  const requested = parseInt(value || String(defaultValue), 10) || defaultValue;
  const max = CONFIG.longTaskMode ? CONFIG.longCommandTimeoutMs : 120000;
  return Math.min(Math.max(requested, 1000), max);
}
function setAgentMode(mode) {
  CONFIG.agentMode = normalizedAgentMode(mode);
  saveHistory();
  return { mode: CONFIG.agentMode, ...AGENT_MODES[CONFIG.agentMode] };
}

// ═══════════════════════════════════════════════════════════════════
//  BOX DRAWING & TUI UTILS
// ═══════════════════════════════════════════════════════════════════
const B = {
  h: '─', v: '│', tl: '┌', tr: '┐', bl: '└', br: '┘',
  tj: '┬', bj: '┴', lj: '├', rj: '┤', cj: '┼',
  h2: '═', v2: '║', tl2: '╔', tr2: '╗', bl2: '╚', br2: '╝',
  tj2: '╦', bj2: '╩', lj2: '╠', rj2: '╣', cj2: '╬',
};

const SPINNERS = {
  dots:    ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'],
  line:    ['-','\\','|','/'],
  pulse:   ['▁','▃','▄','▅','▆','▇','█','▇','▆','▅','▄','▃'],
  arrow:   ['←','↖','↑','↗','→','↘','↓','↙'],
  moon:    ['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'],
  bounce:  ['( ●    )','(  ●   )','(   ●  )','(    ● )','(   ●  )','(  ●   )','( ●    )','(●     )'],
};
const INDICATOR_THEMES = {
  game: { label: '🎮 Игра — движущийся заряд' },
  dots: { label: '⠋ Точки — braille spinner' },
  line: { label: '| Линия — классический spinner' },
  pulse: { label: '▇ Пульс — волна загрузки' },
  minimal: { label: '⏳ Минимальный — только статус' }
};

const COL = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  italic:'\x1b[3m',
  ul:    '\x1b[4m',
  blink: '\x1b[5m',
  rev:   '\x1b[7m',
  hide:  '\x1b[8m',
  // Foreground
  black: '\x1b[30m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  gray: '\x1b[90m', brightRed: '\x1b[91m', brightGreen: '\x1b[92m', brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m', brightMagenta: '\x1b[95m', brightCyan: '\x1b[96m', brightWhite: '\x1b[97m',
  // Background
  bgBlack: '\x1b[40m', bgRed: '\x1b[41m', bgGreen: '\x1b[42m', bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m', bgMagenta: '\x1b[45m', bgCyan: '\x1b[46m', bgWhite: '\x1b[47m',
  bgGray: '\x1b[100m',
};

function c(s, ...styles) {
  if (!styles.length) return s;
  const codes = styles.map(st => {
    if (COL[st]) return COL[st];
    const m = st.match(/^(bg)?([a-z]+)$/i);
    if (!m) return '';
    const key = (m[1] ? 'bg' : '') + m[2].toLowerCase();
    return COL[key] || '';
  }).join('');
  return codes + s + COL.reset;
}

function termWidth() { return process.stdout.columns || 80; }
function termHeight() { return process.stdout.rows || 24; }
function pad(s, w, align = 'left') {
  const str = String(s);
  if (str.length >= w) return str.slice(0, w);
  const pad = w - str.length;
  if (align === 'right') return ' '.repeat(pad) + str;
  if (align === 'center') return ' '.repeat(Math.floor(pad/2)) + str + ' '.repeat(Math.ceil(pad/2));
  return str + ' '.repeat(pad);
}

// ═══════════════════════════════════════════════════════════════════
//  BOX DRAWING
// ═══════════════════════════════════════════════════════════════════
function box(textLines, opts = {}) {
  const { width, title, style = 'single', color = 'cyan', titleColor = 'brightCyan', padding = 1 } = opts;
  const sourceLines = (Array.isArray(textLines) ? textLines : [textLines]).flatMap(line => String(line ?? '').split('\n'));
  const naturalWidth = Math.max(1, ...sourceLines.map(line => stripAnsi(line).length)) + padding * 2 + 2;
  const w = Math.max(4, width || naturalWidth);
  const useDouble = style === 'double';
  const h = useDouble ? B.h2 : B.h;
  const v = useDouble ? B.v2 : B.v;
  const tl = useDouble ? B.tl2 : B.tl;
  const tr = useDouble ? B.tr2 : B.tr;
  const bl = useDouble ? B.bl2 : B.bl;
  const br = useDouble ? B.br2 : B.br;
  const cc = COL[color] || COL.cyan;
  const tc = COL[titleColor] || COL.brightCyan;

  let top = tl + h.repeat(Math.max(0, w - 2)) + tr;
  if (title) {
    const t = ` ${title} `;
    const available = Math.max(0, w - 2 - stripAnsi(t).length);
    const pos = Math.floor(available / 2);
    top = tl + h.repeat(pos) + tc + t + cc + h.repeat(Math.max(0, available - pos)) + tr;
  }

  const maxLine = Math.max(1, w - 2 - padding);
  const wrapped = [];
  for (const line of sourceLines) {
    const plain = stripAnsi(line);
    if (plain.length <= maxLine) { wrapped.push(line); continue; }
    for (let offset = 0; offset < plain.length; offset += maxLine) wrapped.push(plain.slice(offset, offset + maxLine));
  }
  const body = wrapped.map(line => {
    const plain = stripAnsi(line);
    return v + ' '.repeat(padding) + line + ' '.repeat(Math.max(0, w - 2 - padding - plain.length)) + v;
  });

  return [cc + top + COL.reset, ...body, cc + bl + h.repeat(Math.max(0, w - 2)) + br + COL.reset];
}

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

function progressBar(value, max, width = 20, opts = {}) {
  const { filled = '█', empty = '░', color = 'green', bgColor = 'gray' } = opts;
  const pct = Math.min(1, Math.max(0, value / max));
  const filledW = Math.round(width * pct);
  const emptyW = width - filledW;
  const bar = c(filled.repeat(filledW), color) + c(empty.repeat(emptyW), bgColor);
  const pctStr = `${Math.round(pct * 100)}%`;
  return `[${bar}] ${pctStr}`;
}

function miniProgress(value, max, width = 12) {
  const safeMax = Number(max) > 0 ? Number(max) : 1;
  const pct = Math.min(1, Math.max(0, Number(value || 0) / safeMax));
  const exact = width * pct;
  const full = Math.floor(exact);
  const fraction = exact - full;
  const blocks = ['▏','▎','▍','▌','▋','▊','▉','█'];
  let bar = '█'.repeat(full);
  if (fraction > 0 && bar.length < width) bar += blocks[Math.min(7, Math.ceil(fraction * 7) - 1)];
  bar += ' '.repeat(Math.max(0, width - bar.length));
  return `[${c(bar.slice(0, width), 'green')}]`;
}

function horizontalRule(char = '─', color = 'gray') {
  const w = termWidth();
  return c(char.repeat(w), color);
}

function badge(text, bg = 'bgGreen', fg = 'black') {
  return c(` ${text} `, fg, bg);
}

function tag(text, color = 'cyan') {
  return c(`[${text}]`, color);
}

// ═══════════════════════════════════════════════════════════════════
//  SPINNER ENGINE
// ═══════════════════════════════════════════════════════════════════
class Spinner {
  constructor(text, style = 'dots') {
    this.text = text;
    this.style = style;
    this.frames = SPINNERS[style] || SPINNERS.dots;
    this.idx = 0;
    this.timer = null;
    this.active = false;
  }
  gameBar(width = 18) {
    // Не показываем фальшивый процент: у модели неизвестен реальный прогресс.
    // Вместо него движущийся «заряд» как в игровом loading screen.
    const pos = (this.idx % (width + 6)) - 3;
    const cells = [];
    for (let i = 0; i < width; i++) {
      const distance = Math.abs(i - pos);
      if (distance === 0) cells.push(c('█', 'brightCyan'));
      else if (distance === 1) cells.push(c('▓', 'cyan'));
      else if (distance === 2) cells.push(c('▒', 'blue'));
      else cells.push(c('░', 'gray'));
    }
    return cells.join('');
  }
  indicatorLine() {
    const theme = INDICATOR_THEMES[CONFIG.indicatorStyle] ? CONFIG.indicatorStyle : 'game';
    const themeFrames = SPINNERS[theme] || this.frames;
    const frame = themeFrames[this.idx % themeFrames.length];
    let prefix;
    if (theme === 'game') prefix = `${c('🎮 ЗАГРУЗКА', 'brightMagenta')} ${c('[', 'gray')}${this.gameBar()}${c(']', 'gray')}`;
    else if (theme === 'dots') prefix = `${c(frame, 'magenta')} ${c('ДУМАЮ', 'brightMagenta')}`;
    else if (theme === 'line') prefix = `${c(frame, 'cyan')} ${c('ОЖИДАНИЕ', 'brightCyan')}`;
    else if (theme === 'pulse') prefix = `${c('[' + frame.repeat(2) + ']', 'brightGreen')} ${c('ОБРАБОТКА', 'green')}`;
    else prefix = `${c('⏳', 'yellow')} ${c('ЗАПРОС', 'yellow')}`;
    this.idx++;
    return `${prefix} ${c(this.text, 'gray')}`;
  }
  render() {
    // 1G = первый столбец, 2K = стереть всю текущую строку.
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(this.indicatorLine());
  }
  start() {
    this.active = true;
    // Не включаем перерисовку автоматически: некоторые агентские UI вырезают ANSI-коды,
    // превращая кадры в одну длинную склеенную строку.
    this.animated = !!CONFIG.animatedIndicator && !!process.stdout.isTTY && process.env.ZEN_NO_ANIMATION !== '1';
    if (!this.animated) {
      console.log(this.indicatorLine());
      this.timer = setInterval(() => { if (this.active) console.log(this.indicatorLine()); }, CONFIG.indicatorFallbackMs);
      return;
    }
    process.stdout.write('\x1b[?25l'); // скрыть курсор, пока перерисовывается статус
    this.render();
    this.timer = setInterval(() => { if (this.active) this.render(); }, CONFIG.indicatorAnimationMs);
  }
  stop(finalText = '') {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    if (this.animated) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      process.stdout.write('\x1b[?25h'); // вернуть курсор
    }
    if (finalText) console.log(finalText);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  DASHBOARD / STATUS PANEL
// ═══════════════════════════════════════════════════════════════════
function drawDashboard() {
  if (!CONFIG.showDashboard) return;
  const tw = termWidth();
  const w = Math.min(72, tw - 4);
  const half = Math.floor((w - 3) / 2);

  const mem = process.memoryUsage();
  const memMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const memTotal = (mem.heapTotal / 1024 / 1024).toFixed(1);
  const uptime = process.uptime();
  const upStr = uptime < 60 ? `${Math.floor(uptime)}s` : `${Math.floor(uptime/60)}m`;

  const leftLines = [
    `${c('Платформа:', 'gray')} ${c(PLATFORM.name, 'brightCyan')}`,
    `${c('Провайдер:', 'gray')} ${c(providerDisplayName(), currentProvider === 'openrouter' ? 'brightMagenta' : 'brightCyan')}`,
    `${c('Режим:', 'gray')}     ${c(AGENT_MODES[CONFIG.agentMode]?.label || CONFIG.agentMode, 'brightYellow')}`,
    `${c('Модель:', 'gray')}     ${c(currentModel, 'brightGreen')}`,
    `${c('MCP:', 'gray')}       ${mcpAvailable ? c('● подключён', 'green') : c('○ не запущен', 'gray')}`,
    `${c('Прокси:', 'gray')}    ${CONFIG.proxy ? c('● ' + maskProxy(CONFIG.proxy), 'green') : c('○ нет', 'gray')}`,
    `${c('Папка MCP:', 'gray')} ${c(WORKSPACE_ROOT, 'gray')}`,
    `${c('Память:', 'gray')}    ${progressBar(memMB, memTotal, 12, {color:'cyan', bgColor:'gray'})}`,
  ];
  const rightLines = [
    `${c('Авто-одобрение:', 'gray')} ${CONFIG.autoApprove ? c('✓ ON', 'green') : c('✗ OFF', 'gray')}`,
    `${c('Долгая задача:', 'gray')}  ${CONFIG.longTaskMode ? c('✓ ON', 'green') : c('✗ OFF', 'gray')}`,
    `${c('Стриминг:', 'gray')}       ${CONFIG.streamMode ? c('✓ ON', 'green') : c('✗ OFF', 'gray')}`,
    `${c('Размышления:', 'gray')}    ${CONFIG.showThinking ? c('✓ ON', 'green') : c('✗ OFF', 'gray')}`,
    `${c('Аптайм:', 'gray')}         ${c(upStr, 'yellow')}`,
  ];

  const maxH = Math.max(leftLines.length, rightLines.length);
  const body = [];
  for (let i = 0; i < maxH; i++) {
    const l = leftLines[i] || '';
    const r = rightLines[i] || '';
    const lPlain = stripAnsi(l).length;
    const rPlain = stripAnsi(r).length;
    const gap = w - 2 - lPlain - rPlain;
    body.push(l + ' '.repeat(Math.max(1, gap)) + r);
  }

  const lines = box(body, { width: w, title: ' Статус ', style: 'double', color: 'cyan', titleColor: 'brightCyan' });
  lines.forEach(ln => console.log(ln));
}

function drawMiniStatus() {
  const parts = [
    badge(PLATFORM.type.toUpperCase(), 'bgCyan', 'black'),
    badge(CONFIG.agentMode.toUpperCase(), CONFIG.agentMode === 'build' ? 'bgGreen' : 'bgYellow', 'black'),
    badge(currentProvider === 'openrouter' ? 'OPEN' : 'ZEN', currentProvider === 'openrouter' ? 'bgMagenta' : 'bgBlue', 'white'),
    badge(currentModel, 'bgBlue', 'white'),
    badge(mcpAvailable ? 'MCP●' : 'MCP○', mcpAvailable ? 'bgGreen' : 'bgGray', 'black'),
    badge(CONFIG.autoApprove ? 'AUTO●' : 'AUTO○', CONFIG.autoApprove ? 'bgGreen' : 'bgGray', 'black'),
  ];
  console.log(parts.join(' '));
}

// ═══════════════════════════════════════════════════════════════════
//  TOOL OUTPUT FORMATTERS
// ═══════════════════════════════════════════════════════════════════
function formatToolResult(name, result, args) {
  result = redactSecrets(String(result ?? ''));
  const iconMap = {
    list_dir: '📂', read_file: '📖', write_file: '✏️',
    edit_file: '📝', delete_file: '🗑️', append_file: '➕',
    execute_command: '⚙️', web_search: '🔍', download_file: '⬇️',
    image_info: '🖼️', ocr_image: '🔤', vision_analyze: '👁️', analyze_image: '👁️', vision_ui_audit: '🧩', vision_compare: '🆚', pollinations_generate: '🌸', pollinations_models: '🌸', custom_tool_list: '🧰', custom_tool_create: '🛠️', custom_tool_inspect: '🔎', custom_tool_run: '▶️', custom_tool_delete: '🗑️', subagent_list: '👥', subagent_create: '👤', subagent_task: '🤝', subagent_delete: '🗑️', plugin_list: '🧩', plugin_create: '🧩', plugin_inspect: '🔎', plugin_delete: '🗑️', plugin_tool_list: '🧰', plugin_tool_run: '▶️', plugin_provider_list: '🔌',
    workspace_info: '📍', set_workspace: '📍', project_inspect: '🧭', project_list: '📚', project_register: '➕', project_use: '📌', project_remove: '🗑️', project_memory: '🧠', onnx_status: '🧠', onnx_set_model: '📦', onnx_memory_list: '🗂️', onnx_memory_add: '➕', onnx_memory_search: '🔎', onnx_run: '▶️', termux_info: '📱', network_check: '🌐', tree_dir: '🌳', search_text: '🔎', file_info: 'ℹ️', find_files: '🔎',
    file_backup: '💾', file_diff: '🧩', mkdir: '📁', copy_file: '📋', move_file: '🚚', archive_create: '🗜️', archive_extract: '📦',
    process_start: '▶️', process_status: '📊', process_logs: '📜', process_stop: '⏹️', monitor_start: '🩺', monitor_list: '🩺', monitor_logs: '📜', monitor_stop: '⏹️',
    terminal_create: '💻', terminal_write: '⌨️', terminal_read: '📟', terminal_list: '💻', terminal_close: '⏹️',
    http_request: '🌐', health_check: '💓', websocket_test: '🔌', npm_install: '📦', npm_run: '▶️', sqlite_info: '🗃️', sqlite_query: '🗃️', sqlite_schema: '🗃️', sqlite_backup: '💾', env_list: '🔐', env_set: '🔐', env_delete: '🔐', run_tests: '🧪', run_lint: '🧹', code_check: '✅', dependency_audit: '🔐',
    git_status: '🌿', git_diff: '🌿', git_branch: '🌿', git_log: '🌿', git_init: '🌿', git_commit: '🌿', git_push: '⬆️', github_repo_info: '🐙', github_commits: '🐙', github_builds: '🏗️', github_watch_build: '⏱️', github_download_apk: '📱', open_url: '🌐', clipboard_read: '📋', clipboard_write: '📋', notify: '🔔', termux_api_status: '📱', termux_battery: '🔋', termux_wifi: '📶', termux_toast: '💬', termux_vibrate: '📳', termux_share: '📤', termux_volume: '🔊', termux_location: '📍',
    todo_list: '📋', todo_add: '➕', todo_done: '✅', todo_remove: '🗑️',
  };
  const icon = iconMap[name] || '🔧';
  const tw = termWidth();
  const w = Math.min(76, tw - 2);
  let json = null;
  try { json = JSON.parse(result); } catch {}

  let content = '';
  if (COMMAND_RESULT_TOOLS.has(name)) {
    content = redactSecrets(result);
  } else if (name === 'workspace_info' && json) {
    content = [
      `${c('Рабочая папка:', 'gray')} ${c(json.workspace || '', 'brightCyan')}`,
      `${c('Относительные пути:', 'gray')} ${json.relativePathsResolveTo || ''}`,
      `${c('Правило:', 'gray')} ${json.policy || ''}`
    ].join('\n');
  } else if (name === 'set_workspace' && json) {
    content = `${c('✓ Активная MCP-папка:', 'green')} ${json.workspace || ''}`;
  } else if (name === 'list_dir' && json) {
    const items = json.items || [];
    content = `${c('Папка:', 'gray')} ${json.path || ''}\n` +
      (items.length ? items.map(it => `  ${it.type === 'directory' ? c('▸', 'cyan') : c('•', 'gray')} ${it.name}`).join('\n') : c('  Папка пуста', 'gray'));
  } else if (name === 'find_files' && json) {
    const matches = json.matches || [];
    content = `${c('Искали в:', 'gray')} ${json.searched || ''}\n` +
      (matches.length ? matches.map(it => `  ${it.type === 'directory' ? c('▸', 'cyan') : c('•', 'gray')} ${it.path}`).join('\n') : c('  Ничего не найдено', 'gray'));
    if (json.truncated) content += '\n' + c('  Показаны первые результаты; сузь запрос.', 'yellow');
  } else if (name === 'todo_list' && json) {
    const items = json.todos || [];
    content = `${c('Проект:', 'gray')} ${json.workspace || ''}\n` +
      (items.length ? items.map(t => `  ${t.done ? c('✓', 'green') : c('○', 'gray')} #${t.id} ${t.text}`).join('\n') : c('  Нет задач', 'gray'));
  } else if (name === 'read_file' || name === 'process_logs' || name === 'monitor_logs' || name === 'terminal_read') {
    content = frag(result, 30, 15);
  } else if (name === 'write_file' || name === 'append_file') {
    const lines = (args.content || '').split('\n');
    content = `${c('Результат:', 'gray')} ${redactSecrets(result)}\n${c(lines.length + ' строк передано', 'gray')}\n` + frag(redactSecrets(args.content || ''), 8, 4);
  } else if (name === 'edit_file') {
    content = `${c('Результат:', 'gray')} ${result}\n${c('−', 'brightRed')} ${frag(args.old || '', 3, 2)}\n${c('+', 'brightCyan')} ${frag(args.new || '', 3, 2)}`;
  } else {
    content = redactSecrets(result).slice(0, 900);
  }

  const body = [
    `${icon} ${c(name, 'brightCyan')} ${args.path ? c(args.path, 'gray') : ''}`,
    '',
    content,
  ];
  const lines = box(body, { width: w, style: 'single', color: 'blue' });
  lines.forEach(ln => console.log(ln));
}

function formatFinalAnswer(text) {
  const tw = termWidth();
  const w = Math.min(78, tw - 2);
  const lines = redactSecrets(text).split('\n');
  const body = lines.map(l => {
    const plain = stripAnsi(l);
    if (plain.length > w - 4) {
      const chunks = [];
      let i = 0;
      while (i < plain.length) {
        chunks.push(plain.slice(i, i + w - 4));
        i += w - 4;
      }
      return chunks.join('\n');
    }
    return l;
  });
  const boxed = box(body, { width: w, style: 'single', color: 'green' });
  boxed.forEach(ln => console.log(ln));
}

// ═══════════════════════════════════════════════════════════════════
//  BANNER
// ═══════════════════════════════════════════════════════════════════
function printBanner() {
  const art = [
    c('    ╔══════════════════════════════════════════════════════════════╗', 'cyan'),
    c('    ║  ██████╗ ██████╗ ███████╗███╗   ██╗ ██████╗ ██████╗ ███████╗║', 'cyan'),
    c('    ║  ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██╔═══██╗██╔════╝║', 'cyan'),
    c('    ║  ██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║     ██║   ██║█████╗  ║', 'cyan'),
    c('    ║  ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║     ██║   ██║██╔══╝  ║', 'cyan'),
    c('    ║  ╚██████╔╝██║     ███████╗██║ ╚████║╚██████╗╚██████╔╝██║     ║', 'cyan'),
    c('    ║   ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚═╝     ║', 'cyan'),
    c('    ║                                                              ║', 'cyan'),
    c('    ║         Unified CLI Agent  •  Termux / Linux / PC            ║', 'cyan'),
    c('    ╚══════════════════════════════════════════════════════════════╝', 'cyan'),
  ];
  art.forEach(l => console.log(l));

  const tw = termWidth();
  const infoW = Math.min(60, tw - 4);
  const info = [
    `${c('🤖', 'brightCyan')} ${c('Модель:', 'gray')} ${c(currentModel, 'brightGreen')}`,
    `${c('🔀', 'brightMagenta')} ${c('Провайдер:', 'gray')} ${c(providerDisplayName(), currentProvider === 'openrouter' ? 'brightMagenta' : 'brightCyan')}`,
    `${c('📱', 'yellow')} ${c('Платформа:', 'gray')} ${c(PLATFORM.name, 'brightCyan')}`,
    `${c('🔗', 'green')} ${c('MCP:', 'gray')} ${mcpAvailable ? c('● встроенный сервер', 'green') : c('○ недоступен', 'gray')}`,
    `${c('🌐', 'yellow')} ${c('Прокси:', 'gray')} ${c(CONFIG.proxy ? maskProxy(CONFIG.proxy) : 'не задан', CONFIG.proxy ? 'green' : 'gray')}`,
    `${c('💾', 'magenta')} ${c('MCP-папка:', 'gray')} ${c(WORKSPACE_ROOT, 'gray')}`,
  ];
  box(info, { width: infoW, title: ' Инфо ', style: 'single', color: 'gray' }).forEach(l => console.log(l));

  console.log();
  const cmds = [
    c('/help', 'brightCyan'), c('/tools', 'brightCyan'), c('/mode', 'brightCyan'), c('/zen', 'brightCyan'), c('/open', 'brightCyan'), c('/models', 'brightCyan'), c('/session', 'brightCyan'), c('/mcp', 'brightCyan'), c('/net', 'brightCyan'), c('/vpn', 'brightCyan'), c('/proxy', 'brightCyan'), c('/project', 'brightCyan'), c('/onnx', 'brightCyan'), c('/git', 'brightCyan'), c('/agents', 'brightCyan'),
    c('/stream', 'brightCyan'), c('/auto', 'brightCyan'), c('/think', 'brightCyan'), c('/logs', 'brightCyan'),
    c('/clear', 'brightCyan'), c('/save', 'brightCyan'), c('/exit', 'brightCyan'),
  ];
  console.log(c('Команды:', 'gray') + ' ' + cmds.join(c(' │ ', 'gray')));
  console.log(horizontalRule('─', 'gray'));
}

// ═══════════════════════════════════════════════════════════════════
//  ZEN FREE MODELS
// ═══════════════════════════════════════════════════════════════════
// Эти id сверены с живым списком https://opencode.ai/zen/v1/models (авг 2026).
// north-mini-code-free удалён: API возвращает 401 "Model not supported".
const ZEN_MODELS = [
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash', ctx: '200K' },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5', ctx: '128K' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra', ctx: '128K' },
  { id: 'hy3-free', name: 'Hy3 Free', ctx: '128K' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', ctx: '128K' },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1', ctx: '128K' }
];

// ═══════════════════════════════════════════════════════════════════
//  LEGACY COLOR HELPER (backward compat)
// ═══════════════════════════════════════════════════════════════════
const col = (s, color) => c(s, color);

function frag(s, head = 10, tail = 6) {
  const lines = String(s).split('\n');
  if (lines.length <= head + tail + 2) return s;
  return lines.slice(0, head).join('\n') + `\n${c('… (' + (lines.length - head - tail) + ' строк скрыто) …', 'gray')}\n` + lines.slice(-tail).join('\n');
}

// ═══════════════════════════════════════════════════════════════════
//  PLATFORM
// ═══════════════════════════════════════════════════════════════════
function detectPlatform() {
  const env = process.env;
  let isTermux = false;
  if (env.TERMUX_VERSION || env.TERMUX ||
      (env.PREFIX && env.PREFIX.includes('termux')) ||
      (env.HOME && env.HOME.includes('com.termux')) ||
      /termux/i.test(env.SHELL || '')) {
    isTermux = true;
  }
  if (!isTermux) {
    try {
      const termuxPaths = [
        '/data/data/com.termux/files/usr/bin/termux-info',
        '/data/data/com.termux/files/usr/bin/pkg',
        '/data/data/com.termux/files/home'
      ];
      for (const p of termuxPaths) {
        if (fs.existsSync(p)) { isTermux = true; break; }
      }
    } catch {}
  }
  const cwd = process.cwd();
  if (!isTermux && (cwd.includes('storage/emulated') || cwd.includes('emulated/0') || cwd.includes('Download'))) {
    isTermux = true;
  }
  return {
    type: isTermux ? 'termux' : 'pc',
    name: isTermux ? 'Termux (Android)' : (os.platform() === 'linux' ? 'Linux PC' : os.platform()),
    isTermux,
    cwd,
    recommendedStorage: isTermux ? '/storage/emulated/0/Download/zenai' : cwd
  };
}
const PLATFORM = detectPlatform();

// ═══════════════════════════════════════════════════════════════════
//  TERMUX WORKSPACE POLICY
//  На Android проекты должны жить в общей памяти. Внутренний $HOME
//  Termux предназначен только для самого агента и его настроек.
// ═══════════════════════════════════════════════════════════════════
const TERMUX_SHARED_ROOT = '/storage/emulated/0';
const WORKSPACE_FILE = path.join(os.homedir(), '.zen_workspace.json');
const PROJECTS_FILE = path.join(os.homedir(), '.zen_projects.json');
const PROJECT_MEMORY_LIMIT = 50 * 1024 * 1024;

function isPathInside(candidate, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function isTermuxSharedPath(candidate) {
  return !PLATFORM.isTermux || isPathInside(candidate, TERMUX_SHARED_ROOT);
}

function loadWorkspaceConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8'));
    if (saved && typeof saved.root === 'string' && fs.existsSync(saved.root) &&
        fs.statSync(saved.root).isDirectory() && isTermuxSharedPath(saved.root)) return saved;
  } catch {}
  return {};
}

function defaultWorkspaceRoot() {
  const saved = loadWorkspaceConfig();
  const requested = CONFIG.workspaceRoot || saved.root;
  const candidates = [
    requested,
    PLATFORM.isTermux ? '/storage/emulated/0/Download/zenai' : null,
    PLATFORM.isTermux ? TERMUX_SHARED_ROOT : null,
    !PLATFORM.isTermux ? process.cwd() : null
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const root = path.resolve(candidate);
      if (fs.existsSync(root) && fs.statSync(root).isDirectory() && isTermuxSharedPath(root)) return root;
    } catch {}
  }
  // Не откатываемся к $HOME Termux: там только настройки агента, не проекты.
  return PLATFORM.isTermux ? TERMUX_SHARED_ROOT : process.cwd();
}

let WORKSPACE_ROOT = defaultWorkspaceRoot();

function saveWorkspaceConfig() {
  try {
    fs.writeFileSync(WORKSPACE_FILE, JSON.stringify({
      root: WORKSPACE_ROOT,
      updated: new Date().toISOString(),
      platform: PLATFORM.type
    }, null, 2));
  } catch {}
}

function safeProjectAlias(value) {
  const alias = String(value || '').trim();
  return /^[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9._-]{0,47}$/.test(alias) ? alias : null;
}
function loadProjectRegistry() {
  try {
    const saved = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    if (saved && saved.projects && typeof saved.projects === 'object') return saved;
  } catch {}
  return { active: CONFIG.activeProject || '', projects: {} };
}
function saveProjectRegistry(registry) {
  try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(registry, null, 2), { mode: 0o600 }); try { fs.chmodSync(PROJECTS_FILE, 0o600); } catch {} return { success: true }; }
  catch (e) { return { error: 'Не удалось сохранить список проектов: ' + e.message }; }
}
function projectMemoryPath(workspace = WORKSPACE_ROOT) { return path.join(workspace, '.zen-agent', 'memory.json'); }
function loadProjectMemory(workspace = WORKSPACE_ROOT) {
  const file = projectMemoryPath(workspace);
  try {
    const stat = fs.statSync(file);
    if (stat.size > PROJECT_MEMORY_LIMIT) return { schema: 1, workspace, error: 'Файл памяти проекта больше 50 MiB.' };
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
  } catch {}
  return { schema: 1, project: CONFIG.activeProject || path.basename(workspace), workspace, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), visited: [], created: [], notes: [] };
}
function saveProjectMemory(memory, workspace = WORKSPACE_ROOT) {
  const file = projectMemoryPath(workspace);
  try {
    const data = JSON.stringify({ ...memory, workspace, updatedAt: new Date().toISOString() }, null, 2);
    if (Buffer.byteLength(data, 'utf8') > PROJECT_MEMORY_LIMIT) return { error: 'Память проекта превысила лимит 50 MiB.' };
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, 'utf8');
    return { success: true, path: file, size: Buffer.byteLength(data, 'utf8') };
  } catch (e) { return { error: 'Не удалось сохранить память проекта: ' + e.message }; }
}
function rememberProjectEvent(kind, data = {}) {
  const memory = loadProjectMemory();
  const entry = { at: new Date().toISOString(), kind, ...Object.fromEntries(Object.entries(data).filter(([key]) => !['content', 'result', 'token'].includes(key)).map(([key, value]) => [key, String(value ?? '').slice(0, 500)])) };
  if (kind === 'visited') memory.visited = [entry, ...(memory.visited || [])].slice(0, 500);
  else if (kind === 'created') memory.created = [entry, ...(memory.created || [])].slice(0, 500);
  else memory.notes = [entry, ...(memory.notes || [])].slice(0, 500);
  return saveProjectMemory(memory);
}
function projectListTool() {
  const registry = loadProjectRegistry();
  return { active: CONFIG.activeProject || registry.active || '', projects: Object.entries(registry.projects || {}).map(([alias, item]) => ({ alias, ...item, active: alias === CONFIG.activeProject })) };
}
function registerProjectTool(args) {
  const alias = safeProjectAlias(args.alias || args.name);
  if (!alias) return { error: 'Имя проекта: до 48 букв, цифр, точки, дефиса или подчёркивания.' };
  const resolved = path.resolve(path.isAbsolute(String(args.path || '')) ? String(args.path) : path.join(WORKSPACE_ROOT, String(args.path || '')));
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return { error: 'Папка проекта не найдена: ' + resolved };
    if (!isTermuxSharedPath(resolved)) return { error: 'На Termux проект должен находиться в общей памяти Android.' };
    const real = fs.realpathSync.native(resolved);
    if (!isTermuxSharedPath(real)) return { error: 'Путь проекта через symlink выходит за пределы общей памяти.' };
    const registry = loadProjectRegistry();
    registry.projects[alias] = { path: real, name: String(args.title || alias).slice(0, 120), createdAt: registry.projects[alias]?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    const saved = saveProjectRegistry(registry);
    return saved.error ? saved : { success: true, alias, path: real, project: registry.projects[alias] };
  } catch (e) { return { error: 'Не удалось зарегистрировать проект: ' + e.message }; }
}
function useProjectTool(args) {
  const alias = safeProjectAlias(args.alias || args.name);
  if (!alias) return { error: 'Укажи короткое имя проекта.' };
  const registry = loadProjectRegistry(); const item = registry.projects?.[alias];
  if (!item) return { error: `Проект '${alias}' не найден. Используй project_register или /project add.` };
  const changed = setWorkspaceRoot(item.path);
  if (changed.error) return changed;
  CONFIG.activeProject = alias; registry.active = alias; saveProjectRegistry(registry); saveHistory();
  return { success: true, alias, workspace: WORKSPACE_ROOT, memoryFile: projectMemoryPath() };
}
function removeProjectTool(args) {
  const alias = safeProjectAlias(args.alias || args.name); if (!alias) return { error: 'Укажи короткое имя проекта.' };
  const registry = loadProjectRegistry(); if (!registry.projects?.[alias]) return { error: `Проект '${alias}' не найден.` };
  if (registry.active === alias || CONFIG.activeProject === alias) return { error: 'Нельзя удалить активный проект. Сначала переключись на другой.' };
  delete registry.projects[alias]; const saved = saveProjectRegistry(registry); return saved.error ? saved : { success: true, alias };
}
function projectMemoryTool(args) {
  const action = String(args.action || 'read').toLowerCase();
  if (action === 'read') { const memory = loadProjectMemory(); return { success: true, path: projectMemoryPath(), limitBytes: PROJECT_MEMORY_LIMIT, memory }; }
  if (action === 'clear') { const result = saveProjectMemory({ schema: 1, project: CONFIG.activeProject || path.basename(WORKSPACE_ROOT), visited: [], created: [], notes: [] }); return result.error ? result : { ...result, message: 'Память активного проекта очищена.' }; }
  if (action === 'note') { const note = String(args.note || args.text || '').trim(); if (!note) return { error: 'Для project_memory note нужен note.' }; return rememberProjectEvent('note', { note }); }
  return { error: 'Действие project_memory: read, note или clear.' };
}

function onnxRoot(workspace = WORKSPACE_ROOT) { return path.join(workspace, '.zen-agent', 'onnx'); }
function onnxConfigPath(workspace = WORKSPACE_ROOT) { return path.join(onnxRoot(workspace), 'config.json'); }
function onnxMemoryDirectory(workspace = WORKSPACE_ROOT) { return path.join(onnxRoot(workspace), 'memory'); }
function readOnnxConfig() {
  try { const data = JSON.parse(fs.readFileSync(onnxConfigPath(), 'utf8')); return data && typeof data === 'object' ? data : {}; } catch { return {}; }
}
function writeOnnxConfig(data) {
  try { fs.mkdirSync(onnxRoot(), { recursive: true }); fs.writeFileSync(onnxConfigPath(), JSON.stringify(data, null, 2), 'utf8'); return { success: true, path: onnxConfigPath() }; }
  catch (e) { return { error: 'Не удалось сохранить ONNX-конфигурацию: ' + e.message }; }
}
function onnxMemoryFiles() {
  const dir = onnxMemoryDirectory();
  try { fs.mkdirSync(dir, { recursive: true }); return fs.readdirSync(dir).filter(name => /^memory-\d{4,}\.json$/i.test(name)).sort(); }
  catch { return []; }
}
function onnxMemoryListTool() {
  const dir = onnxMemoryDirectory();
  const files = onnxMemoryFiles().map(name => {
    const file = path.join(dir, name); let size = 0; let entries = 0;
    try { size = fs.statSync(file).size; const data = JSON.parse(fs.readFileSync(file, 'utf8')); entries = Array.isArray(data.entries) ? data.entries.length : 0; } catch {}
    return { name, path: file, size, entries, limit: PROJECT_MEMORY_LIMIT, withinLimit: size <= PROJECT_MEMORY_LIMIT };
  });
  return { directory: dir, limitBytes: PROJECT_MEMORY_LIMIT, files, totalEntries: files.reduce((sum, x) => sum + x.entries, 0), note: 'Это RAG/knowledge memory. JSON-память не изменяет веса ONNX-модели без отдельного обучения.' };
}
function onnxMemoryAddTool(args) {
  const text = String(args.text || args.content || '').trim();
  if (!text) return { error: 'Для onnx_memory_add нужен text.' };
  if (Buffer.byteLength(text, 'utf8') > PROJECT_MEMORY_LIMIT - 4096) return { error: 'Одна запись слишком большая: максимум почти 50 MiB.' };
  const dir = onnxMemoryDirectory(); fs.mkdirSync(dir, { recursive: true });
  const files = onnxMemoryFiles(); let fileName = files[files.length - 1] || 'memory-0001.json';
  let file = path.join(dir, fileName); let data = { schema: 1, project: CONFIG.activeProject || path.basename(WORKSPACE_ROOT), entries: [] };
  try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const entry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), source: String(args.source || 'online-agent').slice(0, 500), title: String(args.title || '').slice(0, 300), tags: Array.isArray(args.tags) ? args.tags.map(x => String(x).slice(0, 80)).slice(0, 30) : String(args.tags || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 30), text };
  const candidate = { ...data, entries: [...(Array.isArray(data.entries) ? data.entries : []), entry], updatedAt: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PROJECT_MEMORY_LIMIT) {
    const next = files.length ? Number(fileName.match(/(\d+)/)?.[1] || 1) + 1 : 2;
    fileName = `memory-${String(next).padStart(4, '0')}.json`; file = path.join(dir, fileName); data = { schema: 1, project: CONFIG.activeProject || path.basename(WORKSPACE_ROOT), entries: [] };
    candidate.entries = [entry];
  }
  try { fs.writeFileSync(file, JSON.stringify(candidate, null, 2), 'utf8'); return { success: true, path: file, entryId: entry.id, size: fs.statSync(file).size, fileLimit: PROJECT_MEMORY_LIMIT }; }
  catch (e) { return { error: 'Не удалось добавить ONNX memory: ' + e.message }; }
}
function onnxMemorySearchTool(args) {
  const query = String(args.query || args.text || '').trim().toLowerCase(); if (!query) return { error: 'Для onnx_memory_search нужен query.' };
  const limit = boundedInt(args.limit, 20, 1, 200); const results = [];
  for (const name of onnxMemoryFiles()) {
    if (results.length >= limit) break;
    try { const data = JSON.parse(fs.readFileSync(path.join(onnxMemoryDirectory(), name), 'utf8')); for (const entry of data.entries || []) { const hay = `${entry.title || ''} ${entry.tags || ''} ${entry.text || ''}`.toLowerCase(); if (hay.includes(query)) { results.push({ ...entry, file: name, text: String(entry.text || '').slice(0, 4000) }); if (results.length >= limit) break; } } } catch {}
  }
  return { query, results, total: results.length, directory: onnxMemoryDirectory() };
}
async function onnxStatusTool() {
  const config = readOnnxConfig(); const modelPath = CONFIG.onnxModelPath || config.modelPath || '';
  let model = { configured: !!modelPath, path: modelPath || null, exists: false, size: 0, validExtension: /\.onnx$/i.test(modelPath) };
  if (modelPath) { try { const stat = fs.statSync(modelPath); model.exists = stat.isFile(); model.size = stat.size; } catch {} }
  let runtime = { available: !!onnxRuntime, package: onnxRuntime ? 'onnxruntime-node' : null };
  if (onnxRuntime && model.exists) { try { const session = await onnxRuntime.InferenceSession.create(modelPath); runtime.inputs = session.inputNames; runtime.outputs = session.outputNames; } catch (e) { runtime.error = String(e.message || e).slice(0, 400); } }
  return { model, runtime, memory: onnxMemoryListTool(), learning: 'JSON knowledge memory/RAG is supported. Actual weight training is not performed automatically.' };
}
async function onnxSetModelTool(args) {
  const resolved = mcpPathOrError(args.path || args.model, 'model', true); if (resolved.error) return resolved;
  if (!/\.onnx$/i.test(resolved.path)) return { error: 'Модель должна иметь расширение .onnx.' };
  const stat = fs.statSync(resolved.path); if (!stat.isFile()) return { error: 'ONNX-путь должен быть файлом.' };
  const config = { ...readOnnxConfig(), modelPath: resolved.path, updatedAt: new Date().toISOString() }; const saved = writeOnnxConfig(config); return saved.error ? saved : { success: true, modelPath: resolved.path, size: stat.size, note: 'Файл подключён. Для inference нужен onnxruntime-node.' };
}
async function onnxRunTool(args) {
  if (!onnxRuntime) return { error: 'onnxruntime-node не установлен. Установи его в окружении агента, затем повтори onnx_run.' };
  const config = readOnnxConfig(); const modelPath = CONFIG.onnxModelPath || config.modelPath; if (!modelPath) return { error: 'Сначала подключи файл через onnx_set_model.' };
  let session; try { session = await onnxRuntime.InferenceSession.create(modelPath); } catch (e) { return { error: 'Не удалось открыть ONNX-модель: ' + e.message }; }
  const inputs = args.inputs && typeof args.inputs === 'object' ? args.inputs : {};
  const feeds = {};
  try {
    for (const [name, value] of Object.entries(inputs)) {
      const spec = value && typeof value === 'object' && !Array.isArray(value) ? value : { data: value, dims: [Array.isArray(value) ? value.length : 1], type: 'float32' };
      const type = String(spec.type || 'float32'); feeds[name] = new onnxRuntime.Tensor(type, spec.data || [], spec.dims || [Array.isArray(spec.data) ? spec.data.length : 1]);
    }
    const output = await session.run(feeds); const safe = {};
    for (const [name, tensor] of Object.entries(output)) safe[name] = { type: tensor.type, dims: tensor.dims, data: Array.from(tensor.data || []).slice(0, 10000) };
    return { success: true, modelPath, inputs: session.inputNames, outputs: session.outputNames, result: safe };
  } catch (e) { return { error: 'ONNX inference error: ' + e.message, inputs: session.inputNames, outputs: session.outputNames }; }
}

function setWorkspaceRoot(rawPath) {
  const requested = String(rawPath || '').trim();
  if (!requested) return { error: 'Укажи папку проекта в общей памяти Android.' };
  const resolved = path.resolve(path.isAbsolute(requested) ? requested : path.join(WORKSPACE_ROOT, requested));
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { error: 'Папка не найдена: ' + resolved };
    }
    if (!isTermuxSharedPath(resolved)) {
      return { error: 'На Termux рабочая папка должна быть в /storage/emulated/0, а не во внутреннем $HOME.' };
    }
    const realResolved = fs.realpathSync.native(resolved);
    if (!isTermuxSharedPath(realResolved)) {
      return { error: 'Рабочая папка через symlink выходит за пределы общей памяти Android.' };
    }
  } catch (e) { return { error: 'Не удалось открыть папку: ' + e.message }; }
  WORKSPACE_ROOT = resolved;
  CONFIG.workspaceRoot = resolved;
  const registry = loadProjectRegistry();
  const found = Object.entries(registry.projects || {}).find(([, item]) => path.resolve(item.path) === path.resolve(resolved));
  if (found) { CONFIG.activeProject = found[0]; registry.active = found[0]; saveProjectRegistry(registry); }
  else if (CONFIG.activeProject) { CONFIG.activeProject = ''; registry.active = ''; saveProjectRegistry(registry); }
  saveWorkspaceConfig();
  return { success: true, workspace: WORKSPACE_ROOT, project: CONFIG.activeProject || null, memoryFile: projectMemoryPath() };
}

function resolveWorkspacePath(rawPath, label = 'path') {
  const supplied = rawPath === undefined || rawPath === null || String(rawPath).trim() === '' ? '.' : String(rawPath).trim();
  if (supplied.includes('\0')) return { error: `${label} содержит запрещённый NUL-символ.` };
  const resolved = path.resolve(path.isAbsolute(supplied) ? supplied : path.join(WORKSPACE_ROOT, supplied));
  if (PLATFORM.isTermux && !isTermuxSharedPath(resolved)) {
    return { error: `${label} вне общей памяти Android: ${resolved}. Используй /storage/emulated/0/...` };
  }
  // Lexical path checks do not stop a symlink such as project/link -> /etc.
  // Reject existing symlink escapes on Termux, where the storage boundary is a
  // security requirement. New files are checked through their nearest existing
  // parent, so a symlinked directory cannot bypass the boundary either.
  if (PLATFORM.isTermux) {
    try {
      let probe = resolved;
      while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      const realProbe = fs.realpathSync.native(probe);
      if (!isTermuxSharedPath(realProbe)) return { error: `${label} указывает через symlink за пределы общей памяти Android.` };
    } catch (e) {
      return { error: `Не удалось безопасно проверить ${label}: ${e.message}` };
    }
  }
  // Помечаем пути вне активной рабочей папки сессии, чтобы не «лазить» в чужие
  // MCP-папки без предупреждения. Работает на всех платформах, включая ПК.
  if (CONFIG.workspaceLock) {
    const outside = !isPathInside(resolved, WORKSPACE_ROOT);
    if (outside) return { path: resolved, outsideWorkspace: true, outsideOf: WORKSPACE_ROOT };
  }
  return { path: resolved, outsideWorkspace: false };
}
// Возвращает предупреждение/ошибку, если путь вне активной рабочей папки.
// used for write/modify operations that must stay inside the session workspace.
function workspaceBoundaryCheck(resolved, label = 'path') {
  if (!CONFIG.workspaceLock || !resolved || !resolved.outsideWorkspace) return { ok: true };
  return {
    ok: false,
    error: `${label} вне активной рабочей папки сессии.\nСессия привязана к: ${WORKSPACE_ROOT}\nПуть: ${resolved.path}\nСначала переключи рабочую папку: /workspace <путь> или /session <имя>.`,
    workspace: WORKSPACE_ROOT,
    outsideOf: resolved.outsideOf
  };
}

function workspaceInfo() {
  return {
    platform: PLATFORM.name,
    workspace: WORKSPACE_ROOT,
    project: CONFIG.activeProject || null,
    memoryFile: projectMemoryPath(),
    storageRoot: PLATFORM.isTermux ? TERMUX_SHARED_ROOT : null,
    relativePathsResolveTo: WORKSPACE_ROOT,
    policy: PLATFORM.isTermux
      ? 'MCP работает только с общей памятью Android (/storage/emulated/0). Внутренний $HOME Termux не используется для проектов.'
      : 'Относительные пути MCP разрешаются от рабочей папки агента.'
  };
}

// ═══════════════════════════════════════════════════════════════════
//  PROXY / VPN-AWARE NETWORK CONFIG
//  VPN itself is managed by Android. This setting routes agent curl traffic
//  through an HTTP(S) or SOCKS proxy when Wi-Fi blocks the direct route.
// ═══════════════════════════════════════════════════════════════════
const NETWORK_CONFIG_FILE = path.join(os.homedir(), '.zen_network.json');

function maskProxy(proxy) {
  if (!proxy) return 'выключен (прямое подключение)';
  try {
    const u = new URL(proxy);
    if (u.username || u.password) {
      const auth = u.username ? `${decodeURIComponent(u.username)}:***@` : '';
      return `${u.protocol}//${auth}${u.host}`;
    }
    return proxy;
  } catch { return proxy.replace(/:\/\/([^:@/]+):[^@/]+@/, '://$1:***@'); }
}

const PROXY_STATS = new Map();

function validProxyUrl(value) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!/^(https?|socks4a?|socks5h?):\/\/[^\s]+$/i.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (!parsed.hostname || (parsed.port && (Number(parsed.port) < 1 || Number(parsed.port) > 65535))) return null;
    return raw;
  } catch { return null; }
}
function uniqueProxyPool(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(validProxyUrl).filter(Boolean))];
}
function activeProxy() {
  const pool = uniqueProxyPool(CONFIG.proxyPool);
  CONFIG.proxyPool = pool;
  if (pool.length) {
    CONFIG.proxyActiveIndex = ((Number(CONFIG.proxyActiveIndex) || 0) % pool.length + pool.length) % pool.length;
    CONFIG.proxy = pool[CONFIG.proxyActiveIndex];
  }
  return CONFIG.proxy || '';
}
function proxyCandidates() {
  const pool = uniqueProxyPool(CONFIG.proxyPool);
  if (!CONFIG.proxyFailover || pool.length < 2) return [activeProxy()];
  const start = ((Number(CONFIG.proxyActiveIndex) || 0) % pool.length + pool.length) % pool.length;
  return pool.slice(start).concat(pool.slice(0, start));
}
function proxyStats(proxy) {
  if (!proxy) return { proxy: '', label: 'прямое соединение', attempts: 0, failures: 0, slow: 0, lastMs: null };
  const current = PROXY_STATS.get(proxy) || { attempts: 0, failures: 0, slow: 0, lastMs: null };
  return { proxy, label: maskProxy(proxy), ...current };
}
function notifyProxySwitch(previous, next, reason) {
  const from = previous ? maskProxy(previous) : 'прямое соединение';
  const to = next ? maskProxy(next) : 'прямое соединение';
  const message = `🔁 Прокси переключён: ${from} → ${to}. Причина: ${reason}`;
  console.log(c(message, 'yellow'));
  try { webRunEvent('proxy_switched', { from, to, reason }); } catch {}
  try { auditEvent('proxy_switched', { from, to, reason }); } catch {}
}
function rotateProxy(reason = 'предыдущий прокси не ответил') {
  const pool = uniqueProxyPool(CONFIG.proxyPool);
  if (pool.length < 2) return false;
  const previous = activeProxy();
  const current = ((Number(CONFIG.proxyActiveIndex) || 0) % pool.length + pool.length) % pool.length;
  CONFIG.proxyActiveIndex = (current + 1) % pool.length;
  CONFIG.proxy = pool[CONFIG.proxyActiveIndex];
  saveNetworkConfig();
  notifyProxySwitch(previous, CONFIG.proxy, reason);
  return true;
}
function markProxyResult(proxy, elapsedMs, ok, error = '') {
  if (!proxy) return;
  const item = PROXY_STATS.get(proxy) || { attempts: 0, failures: 0, slow: 0, lastMs: null };
  item.attempts++;
  item.lastMs = Math.round(elapsedMs);
  const slow = elapsedMs >= CONFIG.proxySlowMs;
  if (!ok) item.failures++;
  if (slow) item.slow++;
  PROXY_STATS.set(proxy, item);
  if (proxy === activeProxy() && slow && CONFIG.proxyFailover && CONFIG.proxyPool.length > 1) {
    rotateProxy(`ответ занял ${Math.round(elapsedMs)} мс (порог ${CONFIG.proxySlowMs} мс)`);
  } else if (!ok && CONFIG.proxyFailover && CONFIG.proxyPool.length > 1 && proxy === activeProxy()) {
    const raw = String(error || '').toLowerCase();
    const reason = raw.includes('не начал') || raw.includes('медлен') ? 'медленный ответ' : raw.includes('timeout') || raw.includes('timed out') ? 'таймаут соединения' : raw.includes('rate') ? 'ограничение запроса' : 'ошибка подключения';
    rotateProxy(reason);
  }
}
function loadNetworkConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(NETWORK_CONFIG_FILE, 'utf8')) || {}; } catch {}
  const environmentPool = (process.env.ZEN_PROXY_POOL || '').split(',').map(item => item.trim()).filter(Boolean);
  CONFIG.proxyPool = uniqueProxyPool([...environmentPool, ...(saved.proxyPool || [])]);
  if (!process.env.ZEN_PROXY && !process.env.HTTP_PROXY && !process.env.HTTPS_PROXY && saved.proxy) {
    CONFIG.proxy = validProxyUrl(saved.proxy) || '';
  }
  if (Number.isInteger(saved.proxyActiveIndex)) CONFIG.proxyActiveIndex = saved.proxyActiveIndex;
  if (Number.isFinite(Number(saved.proxySlowMs))) CONFIG.proxySlowMs = Math.max(1000, Number(saved.proxySlowMs));
  if (typeof saved.proxyFailover === 'boolean' && process.env.ZEN_PROXY_FAILOVER === undefined) CONFIG.proxyFailover = saved.proxyFailover;
  const environmentProxy = validProxyUrl(process.env.ZEN_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY);
  if (environmentProxy) {
    CONFIG.proxy = environmentProxy;
    if (!CONFIG.proxyPool.includes(environmentProxy)) CONFIG.proxyPool.unshift(environmentProxy);
    CONFIG.proxyActiveIndex = CONFIG.proxyPool.indexOf(environmentProxy);
  } else if (CONFIG.proxyPool.length) activeProxy();
}
function saveNetworkConfig() {
  try {
    fs.writeFileSync(NETWORK_CONFIG_FILE, JSON.stringify({
      proxy: activeProxy(),
      proxyPool: uniqueProxyPool(CONFIG.proxyPool),
      proxyActiveIndex: CONFIG.proxyActiveIndex,
      proxyFailover: !!CONFIG.proxyFailover,
      proxySlowMs: CONFIG.proxySlowMs,
      updated: new Date().toISOString()
    }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(NETWORK_CONFIG_FILE, 0o600); } catch {}
  } catch (e) { return { error: 'Не удалось сохранить прокси: ' + e.message }; }
  return { success: true };
}
function addProxy(value, persist = true) {
  const raw = validProxyUrl(value);
  if (!raw) return { error: 'Неверный адрес. Пример: socks5h://127.0.0.1:1080 или http://user:pass@host:port' };
  CONFIG.proxyPool = uniqueProxyPool([...(CONFIG.proxyPool || []), raw]);
  CONFIG.proxyActiveIndex = CONFIG.proxyPool.indexOf(raw);
  CONFIG.proxy = raw;
  const saved = persist ? saveNetworkConfig() : { success: true };
  return saved.error ? saved : { success: true, proxy: raw, pool: CONFIG.proxyPool.length, message: `Прокси добавлен и выбран активным: ${maskProxy(raw)}` };
}
function removeProxy(value, persist = true) {
  const raw = String(value || '').trim();
  let index = Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 1 || index > CONFIG.proxyPool.length) index = CONFIG.proxyPool.indexOf(validProxyUrl(raw)) + 1;
  if (index < 1 || index > CONFIG.proxyPool.length) return { error: 'Прокси не найден. Используй /proxy list.' };
  const removed = CONFIG.proxyPool.splice(index - 1, 1)[0];
  CONFIG.proxyActiveIndex = Math.max(0, Math.min(CONFIG.proxyActiveIndex, CONFIG.proxyPool.length - 1));
  CONFIG.proxy = CONFIG.proxyPool[CONFIG.proxyActiveIndex] || '';
  const saved = persist ? saveNetworkConfig() : { success: true };
  return saved.error ? saved : { success: true, removed: maskProxy(removed), pool: CONFIG.proxyPool.length };
}
function clearProxyPool(persist = true) {
  CONFIG.proxyPool = []; CONFIG.proxyActiveIndex = 0; CONFIG.proxy = '';
  const saved = persist ? saveNetworkConfig() : { success: true };
  return saved.error ? saved : { success: true, message: 'Пул прокси очищен. Используется прямое соединение.' };
}
function setProxy(value, persist = true) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw || /^(off|none|disable|выкл|нет)$/i.test(raw)) return clearProxyPool(persist);
  return addProxy(raw, persist);
}
function proxyStatus() {
  const pool = uniqueProxyPool(CONFIG.proxyPool);
  return {
    enabled: !!activeProxy(),
    proxy: activeProxy() ? maskProxy(activeProxy()) : '',
    activeIndex: pool.length ? CONFIG.proxyActiveIndex + 1 : 0,
    failover: !!CONFIG.proxyFailover,
    slowMs: CONFIG.proxySlowMs,
    pool: pool.map((item, index) => ({ index: index + 1, active: index === CONFIG.proxyActiveIndex, ...proxyStats(item) })),
    source: (process.env.ZEN_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY) ? 'environment' : 'saved',
    note: activeProxy()
      ? `Пул прокси применяется к Zen/curl. При ошибке или задержке свыше ${CONFIG.proxySlowMs} мс агент автоматически выберет следующий.`
      : 'Прокси не задан. Android VPN всё равно может работать системно, если Termux не исключён из VPN.'
  };
}

loadNetworkConfig();

async function testProxyPool() {
  const candidates = proxyCandidates();
  const rows = [];
  for (const proxy of candidates) {
    const started = Date.now();
    try {
      const testUrl = zenApiModelsUrl()[0] || 'https://opencode.ai/zen/v1/models';
      const args = ['-sS', '--connect-timeout', '5', '--max-time', '12', '-o', '/dev/null', '-w', '%{http_code}', ...curlProxyArgs(proxy), testUrl];
      const code = execFileSync(curlPath(), args, { encoding: 'utf8', timeout: 15000 }).trim();
      const ms = Date.now() - started;
      const ok = /^[2-5]\d\d$/.test(code);
      markProxyResult(proxy, ms, ok, ok ? '' : `HTTP ${code || '000'}`);
      rows.push({ proxy: proxy ? maskProxy(proxy) : 'прямое соединение', ok, status: code || '000', ms, slow: ms >= CONFIG.proxySlowMs });
    } catch (error) {
      const ms = Date.now() - started;
      markProxyResult(proxy, ms, false, 'ошибка подключения');
      rows.push({ proxy: proxy ? maskProxy(proxy) : 'прямое соединение', ok: false, status: 'ошибка', ms, error: redactSecrets(String(error?.message || error)).slice(0, 160) });
    }
  }
  const healthy = rows.find(row => row.ok && !row.slow) || rows.find(row => row.ok);
  if (healthy) {
    const raw = candidates[rows.indexOf(healthy)] || '';
    const index = CONFIG.proxyPool.indexOf(raw);
    if (index >= 0) { CONFIG.proxyActiveIndex = index; CONFIG.proxy = raw; saveNetworkConfig(); }
  }
  return { success: !!healthy, slowMs: CONFIG.proxySlowMs, rows };
}

function findWorkspaceEntries(query, options = {}) {
  const baseResult = resolveWorkspacePath(options.path || '.');
  if (baseResult.error) return baseResult;
  const base = baseResult.path;
  const needle = String(query || '').toLowerCase();
  const wildcard = needle.includes('*') || needle.includes('?');
  const namePattern = wildcard ? new RegExp('^' + needle.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
  const maxDepth = Math.min(Math.max(parseInt(options.max_depth || options.maxDepth || 3, 10) || 3, 0), 6);
  const limit = Math.min(Math.max(parseInt(options.limit || 80, 10) || 80, 1), 300);
  const directoriesOnly = !!options.directories_only;
  const result = [];
  const skip = new Set(['node_modules', '.git', '.cache', 'Android', 'DCIM', 'Pictures', 'Movies', 'Music']);

  function walk(dir, depth) {
    if (result.length >= limit || depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (result.length >= limit) return;
      const full = path.join(dir, entry.name);
      const matches = !needle || (namePattern ? namePattern.test(entry.name) : entry.name.toLowerCase().includes(needle));
      if (matches && (!directoriesOnly || entry.isDirectory())) {
        result.push({ name: entry.name, path: full, type: entry.isDirectory() ? 'directory' : 'file' });
      }
      if (entry.isDirectory() && depth < maxDepth && !skip.has(entry.name)) walk(full, depth + 1);
    }
  }
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return { error: 'Папка не найдена: ' + base };
  walk(base, 0);
  return { workspace: WORKSPACE_ROOT, searched: base, matches: result, truncated: result.length >= limit };
}

// ═══════════════════════════════════════════════════════════════════
//  curl helper
// ═══════════════════════════════════════════════════════════════════
function curlPath() {
  if (process.platform === 'win32') {
    const fsPath = 'C:\\Windows\\System32\\curl.exe';
    return fs.existsSync(fsPath) ? fsPath : 'curl';
  }
  return 'curl';
}

function curlProxyArgs(proxy = activeProxy()) {
  const args = [];
  if (proxy) args.push('-x', proxy);
  if (CONFIG.curlIpv4) args.push('--ipv4');
  return args;
}

function isRateLimit(s) {
  return /FreeUsageLimitError|FreeUsageLimit|Rate limit exceeded|rate.?limit|quota.?exceeded|HTTP\s*429/i.test(s || '');
}
// Провайдерская ошибка сервера/апстрима (503/502/5xx и т.п.): модель временно
// недоступна, и бесполезно ретраить её дальше — лучше перейти на другую модель.
function isServerError(s) {
  return /(?:^|\D)(5\d\d)\b|server_error|server error|upstream|temporarily|service unavailable|HTTP 50/i.test(s || '');
}
function rateLimitReason(s) {
  const text = String(s || '');
  if (/FreeUsageLimit/i.test(text)) return 'исчерпан бесплатный лимит Zen для этой модели';
  if (/quota/i.test(text)) return 'исчерпана квота провайдера';
  if (/429|rate.?limit/i.test(text)) return 'провайдер временно ограничил частоту запросов';
  return 'провайдер отклонил запрос по лимиту';
}


// ═══════════════════════════════════════════════════════════════════
//  EMBEDDED MCP SERVER + ZEN PROXY (no external server.js needed)
// ═══════════════════════════════════════════════════════════════════
const MCP_TOOLS = {
  workspace_info: 'Показать текущую рабочую папку MCP и правила путей',
  set_workspace: 'Сменить рабочую папку проекта в общей памяти Android',
  project_inspect: 'Проверить package.json, скрипты, зависимости и файлы проекта',
  project_list: 'Показать зарегистрированные проекты и активный проект',
  project_register: 'Зарегистрировать папку проекта под коротким именем',
  project_use: 'Переключить активный проект по короткому имени',
  project_remove: 'Удалить имя проекта из реестра без удаления папки',
  project_memory: 'Прочитать, дополнить или очистить память активного проекта',
  onnx_status: 'Проверить локальную ONNX-модель, runtime и knowledge memory',
  onnx_set_model: 'Подключить локальный .onnx-файл',
  onnx_memory_list: 'Показать JSON-файлы локальной ONNX knowledge memory',
  onnx_memory_add: 'Добавить проверенный материал в локальную knowledge memory',
  onnx_memory_search: 'Искать знания в локальной ONNX knowledge memory',
  onnx_run: 'Запустить локальную ONNX-модель с явно заданными входами',
  termux_info: 'Проверить среду Termux, Node, npm и доступ к общей памяти',
  network_check: 'Проверить доступ к серверу моделей через текущую сеть/VPN',
  tree_dir: 'Показать дерево папки с ограничением глубины',
  search_text: 'Найти текст в файлах проекта без shell grep',
  file_info: 'Размер, даты и SHA-256 файла',
  list_dir: 'Список файлов и папок в рабочей папке',
  find_files: 'Поиск файлов и папок только внутри рабочей папки',
  read_file: 'Прочитать содержимое файла',
  write_file: 'Записать / создать файл',
  edit_file: 'Точечное редактирование',
  delete_file: 'Удалить файл или папку',
  append_file: 'Добавить текст в конец файла',
  file_backup: 'Создать резервную копию файла в папке проекта',
  file_diff: 'Показать различия файла и его резервной копии',
  mkdir: 'Создать папку в рабочем проекте',
  copy_file: 'Скопировать файл или папку внутри общей памяти',
  move_file: 'Переместить или переименовать файл/папку',
  archive_create: 'Создать tar.gz-архив проекта',
  archive_extract: 'Распаковать tar.gz-архив',
  download_file: 'Скачать файл по URL',
  execute_command: 'Выполнить shell-команду из рабочей папки проекта',
  process_start: 'Запустить именованный процесс в фоне с отдельным логом',
  process_status: 'Проверить только процессы, запущенные этим агентом',
  process_logs: 'Прочитать или кратко отслеживать лог управляемого процесса',
  process_stop: 'Безопасно остановить именованный процесс агента',
  monitor_start: 'Следить за процессом/health URL и при необходимости перезапускать',
  monitor_list: 'Список локальных health-мониторов',
  monitor_logs: 'Лог проверок health-монитора',
  monitor_stop: 'Остановить health-монитор',
  terminal_create: 'Создать постоянную локальную shell-сессию',
  terminal_write: 'Отправить текст или команду в постоянную shell-сессию',
  terminal_read: 'Прочитать накопленный вывод постоянной shell-сессии',
  terminal_list: 'Список текущих terminal-сессий',
  terminal_close: 'Закрыть terminal-сессию',
  http_request: 'Отправить HTTP-запрос и показать статус, заголовки и тело',
  health_check: 'HTTP-проверка доступности локального сервера',
  websocket_test: 'Проверить обычный WebSocket или Socket.IO-соединение',
  npm_install: 'Установить npm-пакеты с видимыми логами',
  npm_run: 'Запустить npm script с видимыми логами',
  sqlite_info: 'Проверить локальную доступность SQLite',
  sqlite_query: 'Выполнить SQL-запрос к SQLite-файлу проекта',
  sqlite_schema: 'Показать SQLite-схему',
  sqlite_backup: 'Создать SQLite backup без внешнего сервиса',
  env_list: 'Показать ключи .env без раскрытия значений',
  env_set: 'Создать или изменить переменную .env',
  env_delete: 'Удалить переменную из .env',
  run_tests: 'Запустить npm test или указанный тестовый script',
  run_lint: 'Запустить npm lint или указанный lint script',
  code_check: 'Проверить синтаксис JavaScript-файла',
  dependency_audit: 'Выполнить npm audit без автоматических исправлений',
  git_status: 'Статус Git-репозитория',
  git_diff: 'Показать Git diff',
  git_branch: 'Показать текущую и доступные Git-ветки',
  git_log: 'Последние Git-коммиты',
  git_init: 'Инициализировать Git-репозиторий',
  git_commit: 'Добавить изменения и создать Git-коммит',
  git_push: 'Отправить локальные коммиты в GitHub/Git remote',
  github_repo_info: 'Показать сведения о GitHub-репозитории',
  github_read_file: 'Прочитать файл GitHub-репозитория удалённо (без клонирования)',
  github_list_dir: 'Список файлов/папок в GitHub-репозитории удалённо',
  github_write_file: 'Записать/обновить файл GitHub-репозитория удалённо и закоммитить',
  github_readme: 'Прочитать README GitHub-репозитория',
  github_commits: 'Показать коммиты GitHub-репозитория через API',
  github_builds: 'Показать сборки GitHub Actions и их статусы',
  github_watch_build: 'Наблюдать за сборкой GitHub Actions до завершения',
  github_download_apk: 'Скачать APK из GitHub Actions artifact или GitHub Release',
  open_url: 'Открыть URL через Android/Termux',
  clipboard_read: 'Прочитать буфер обмена Android',
  clipboard_write: 'Записать текст в буфер обмена Android',
  notify: 'Показать Android-уведомление через Termux:API',
  termux_api_status: 'Проверить доступные команды Termux:API',
  termux_battery: 'Прочитать состояние батареи Android через Termux:API',
  termux_wifi: 'Прочитать Wi-Fi connection info через Termux:API',
  termux_toast: 'Показать короткое Android toast-сообщение',
  termux_vibrate: 'Вибрация Android через Termux:API',
  termux_share: 'Открыть Android share sheet для текста или файла',
  termux_volume: 'Установить громкость Android stream через Termux:API',
  termux_location: 'Запросить location Android через Termux:API',
  todo_list: 'Показать задачи агента для текущего проекта (рекурсивное дерево со статусами)',
  todo_add: 'Добавить задачу в список проекта (parent — id родительской задачи для иерархии)',
  todo_start: 'Отметить задачу как выполняемую (in_progress)',
  todo_done: 'Отметить задачу выполненной',
  todo_fail: 'Отметить задачу проваленной (status=failed) с причиной',
  todo_remove: 'Удалить задачу (и её подзадачи)',
  web_search: 'Поиск в интернете',
  image_info: 'Локальные metadata, размер, dimensions и SHA-256 изображения',
  ocr_image: 'Локально распознать текст на изображении через Tesseract',
  vision_analyze: 'Vision-анализ одного изображения через выбранную OpenRouter vision-модель',
  analyze_image: 'Псевдоним vision_analyze для совместимости',
  vision_ui_audit: 'Найти UI/UX-проблемы на скриншоте',
  vision_compare: 'Visual compare двух скриншотов через vision-модель',
  pollinations_generate: 'Сгенерировать изображение через Pollinations и сохранить в проект',
  pollinations_models: 'Получить доступные Pollinations image models',
  custom_tool_list: 'Показать локальные custom tools из .zen-agent/custom-tools',
  custom_tool_create: 'Создать и подключить локальный custom tool в специальной папке',
  custom_tool_inspect: 'Прочитать manifest и код custom tool',
  custom_tool_run: 'Запустить подключённый custom tool в ограниченном API-контексте',
  custom_tool_delete: 'Удалить локальный custom tool',
  subagent_list: 'Показать встроенные и локальные subagents',
  subagent_create: 'Создать локального subagent с ролью и isolated prompt',
  subagent_task: 'Поручить read-only аналитическую подзадачу одному subagent',
  subagent_batch: 'Запустить несколько subagent параллельно (каждый может со своей моделью); автосмена модели при сбое',
  subagent_background: 'Запустить subagent в фоне, вернуть id задачи (результат через subagent_status)',
  subagent_status: 'Статус фоновой задачи subagent (id или "all")',
  subagent_delete: 'Удалить локального subagent',
  plugin_list: 'Показать локальные lifecycle plugins',
  plugin_create: 'Создать локальный plugin с hooks/tools/provider definitions',
  plugin_inspect: 'Прочитать manifest и код plugin',
  plugin_delete: 'Удалить локальный plugin',
  plugin_tool_list: 'Показать tools, зарегистрированные plugins',
  plugin_tool_run: 'Запустить tool из подключённого plugin',
  plugin_provider_list: 'Показать providers, зарегистрированные plugins',
  read_image: 'Прочитать изображение как base64 (технический инструмент)'
};

function mcpPathOrError(input, label = 'path', mustExist = false, directoryOnly = false) {
  const resolved = resolveWorkspacePath(input, label);
  if (resolved.error) return resolved;
  try {
    if (mustExist && !fs.existsSync(resolved.path)) return { error: `${label} не найден: ${resolved.path}` };
    if (directoryOnly && (!fs.existsSync(resolved.path) || !fs.statSync(resolved.path).isDirectory())) {
      return { error: `${label} не является папкой: ${resolved.path}` };
    }
  } catch (e) { return { error: `Не удалось проверить ${label}: ${e.message}` }; }
  return resolved;
}

function printMcpTrace(lines) {
  if (!CONFIG.liveToolLogs) return;
  for (const line of lines) console.log(c('  [MCP] ', 'magenta') + line);
}

function appendCommandOutput(previous, chunk, max = 10 * 1024 * 1024) {
  if (previous.length >= max) return previous;
  const remaining = max - previous.length;
  return previous + chunk.slice(0, remaining);
}

function printLiveCommandChunk(stream, chunk) {
  const labels = { stdout: 'вывод', stderr: 'ошибки', 'process-log': 'лог процесса', monitor: 'монитор', terminal: 'терминал' };
  const label = Object.entries(labels).find(([key]) => String(stream).startsWith(key))?.[1] || String(stream);
  const color = stream === 'stderr' ? 'brightYellow' : 'brightCyan';
  const text = redactSecrets(chunk.toString('utf8'));
  try { if (WEB_AGENT_RUN_CONTEXT) webRunEvent('terminal_output', { stream: label, text }); } catch {}
  // Это прямой поток дочернего процесса. Секреты маскируются до вывода.
  const prefix = c(`  [${label}] `, color);
  const rendered = text.replace(/\n(?!$)/g, '\n' + prefix);
  process.stdout.write(prefix + rendered);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

function runCommandWithLiveLogs(command, runCwd, opts) {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeout;
    const childEnv = opts.env;
    const isWin = process.platform === 'win32';
    const executable = isWin ? 'powershell.exe' : (process.env.SHELL || 'sh');
    const childArgs = isWin
      ? ['-NoProfile', '-Command', String(command)]
      : ['-lc', String(command)];
    let stdout = '', stderr = '', settled = false, timedOut = false;
    let proc, forceTimer;

    printMcpTrace([
      c('ВЫВОД В РЕАЛЬНОМ ВРЕМЕНИ — процесс запущен', 'brightGreen'),
      `${c('папка:', 'gray')} ${runCwd}`,
      `${c('$', 'gray')} ${command}`
    ]);

    const finish = (exit, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) stderr = appendCommandOutput(stderr, error);
      console.log(c(`  [MCP] процесс завершён: exit=${typeof exit === 'number' ? exit : 1}${timedOut ? ' (timeout)' : ''}`, timedOut || exit ? 'yellow' : 'green'));
      resolve({
        stdout,
        stderr,
        exit: typeof exit === 'number' ? exit : 1,
        cwd: runCwd,
        workspace: WORKSPACE_ROOT,
        live: true,
        timedOut
      });
    };

    let timer;
    try {
      proc = spawn(executable, childArgs, { cwd: runCwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stdout = appendCommandOutput(stdout, text);
        printLiveCommandChunk('stdout', chunk);
      });
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr = appendCommandOutput(stderr, text);
        printLiveCommandChunk('stderr', chunk);
      });
      proc.on('error', err => finish(1, err.message || String(err)));
      proc.on('close', code => finish(code));
      timer = setTimeout(() => {
        timedOut = true;
        console.log(c(`  [MCP] достигнут лимит ${timeoutMs}ms; отправляю SIGTERM процессу.`, 'yellow'));
        try { proc.kill('SIGTERM'); } catch {}
        // A command may ignore SIGTERM. Never leave the agent promise hanging.
        forceTimer = setTimeout(() => { try { if (!settled) proc.kill('SIGKILL'); } catch {} }, 2000);
        forceTimer.unref?.();
      }, timeoutMs);
    } catch (e) { finish(1, e.message || String(e)); }
  });
}


// ═══════════════════════════════════════════════════════════════════
//  TERMUX PROJECT OPERATIONS: processes, HTTP, packages and checks
// ═══════════════════════════════════════════════════════════════════
const PROCESS_REGISTRY_FILE = path.join(os.homedir(), '.zen_managed_processes.json');

function commandEnvironment() {
  return {
    ...process.env,
    ZEN_WORKSPACE: WORKSPACE_ROOT,
    MCP_WORKSPACE: WORKSPACE_ROOT,
    ...(CONFIG.proxy ? {
      HTTP_PROXY: CONFIG.proxy, HTTPS_PROXY: CONFIG.proxy, ALL_PROXY: CONFIG.proxy,
      http_proxy: CONFIG.proxy, https_proxy: CONFIG.proxy, all_proxy: CONFIG.proxy,
      NO_PROXY: [process.env.NO_PROXY, 'localhost,127.0.0.1,::1'].filter(Boolean).join(','),
      no_proxy: [process.env.no_proxy, 'localhost,127.0.0.1,::1'].filter(Boolean).join(',')
    } : {})
  };
}

function readProcessRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(PROCESS_REGISTRY_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
function writeProcessRegistry(registry) {
  try {
    fs.writeFileSync(PROCESS_REGISTRY_FILE, JSON.stringify(registry, null, 2), { mode: 0o600 });
    try { fs.chmodSync(PROCESS_REGISTRY_FILE, 0o600); } catch {}
    return true;
  } catch { return false; }
}
function safeProcessName(name) {
  const value = String(name || '').trim();
  // Разрешаем русские и другие Unicode-буквы, но не пробелы, слеши и shell-символы.
  return /^[\p{L}\p{N}._-]{1,64}$/u.test(value) ? value : null;
}
function managedProcessLogPath(name) {
  const dir = path.join(WORKSPACE_ROOT, '.zen-agent', 'processes');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.log`);
}
function processIsAlive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try { process.kill(number, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}
function tailFile(filePath, maxLines = 120) {
  try {
    const stat = fs.statSync(filePath);
    const take = Math.min(Math.max(Number(maxLines) || 120, 1), 1000);
    // Logs are untrusted, potentially unbounded files. Read only the last 2 MiB.
    const maxBytes = 2 * 1024 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    const content = buffer.toString('utf8');
    const lines = content.split('\n');
    const sliced = lines.slice(-take).join('\n');
    return { content: (start ? '… (начало лога пропущено) …\n' : '') + sliced, totalLines: Math.max(0, lines.length - 1) };
  } catch (e) { return { error: 'Не удалось прочитать лог: ' + e.message }; }
}
function startManagedProcess(args) {
  const name = safeProcessName(args.name);
  if (!name) return { error: 'name: только латинские буквы, цифры, точка, подчёркивание или дефис (до 64 символов).' };
  const cwdResult = mcpPathOrError(args.cwd || '.', 'cwd', true, true);
  if (cwdResult.error) return cwdResult;
  const command = String(args.command || '').trim();
  if (!command) return { error: 'Для process_start нужна command.' };
  const registry = readProcessRegistry();
  const existing = registry[name];
  if (existing && processIsAlive(existing.pid)) return { error: `Процесс '${name}' уже запущен (PID ${existing.pid}). Используй process_status, process_logs или process_stop.` };
  const logPath = managedProcessLogPath(name);
  const logFd = fs.openSync(logPath, 'a');
  const isWin = process.platform === 'win32';
  const executable = isWin ? 'powershell.exe' : (process.env.SHELL || 'sh');
  const childArgs = isWin ? ['-NoProfile', '-Command', command] : ['-lc', command];
  try {
    const child = spawn(executable, childArgs, {
      cwd: cwdResult.path,
      env: commandEnvironment(),
      detached: !isWin,
      stdio: ['ignore', logFd, logFd]
    });
    child.once('error', err => {
      try { fs.appendFileSync(logPath, `\n[agent] Не удалось запустить процесс: ${err.message}\n`); } catch {}
    });
    child.unref();
    fs.closeSync(logFd);
    registry[name] = {
      name, pid: child.pid, command, cwd: cwdResult.path, logPath,
      startedAt: new Date().toISOString(), workspace: WORKSPACE_ROOT
    };
    writeProcessRegistry(registry);
    return { success: true, name, pid: child.pid, cwd: cwdResult.path, logPath, workspace: WORKSPACE_ROOT,
      message: 'Процесс запущен в фоне. Для реальных логов вызови process_logs.' };
  } catch (e) {
    try { fs.closeSync(logFd); } catch {}
    return { error: 'Не удалось запустить процесс: ' + e.message };
  }
}
function managedProcessStatus(name) {
  const registry = readProcessRegistry();
  const names = name ? [name] : Object.keys(registry);
  const processes = names.map(processName => {
    const p = registry[processName];
    if (!p) return { name: processName, found: false };
    const running = processIsAlive(p.pid);
    const status = { ...p, found: true, running };
    // Если сервер упал, причина обычно уже записана в его лог. Показываем хвост,
    // чтобы модель не гадала по порту и не путала проект с MCP-сервером.
    if (!running && p.logPath) {
      const tail = tailFile(p.logPath, 30);
      if (!tail.error) status.lastLog = tail.content;
    }
    return status;
  });
  return { workspace: WORKSPACE_ROOT, processes };
}
function stopManagedProcess(name, force = false) {
  const valid = safeProcessName(name);
  if (!valid) return { error: 'Укажи корректное имя процесса.' };
  const registry = readProcessRegistry();
  const item = registry[valid];
  if (!item) return { error: `Процесс '${valid}' не зарегистрирован.` };
  if (!processIsAlive(item.pid)) {
    delete registry[valid]; writeProcessRegistry(registry);
    return { success: true, name: valid, alreadyStopped: true, message: 'Процесс уже не запущен; запись очищена.' };
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    // detached-процесс — лидер отдельной группы; завершаем только эту группу, не все node-процессы.
    if (process.platform !== 'win32') process.kill(-Number(item.pid), signal);
    else process.kill(Number(item.pid), signal);
  } catch (e) {
    try { process.kill(Number(item.pid), signal); }
    catch (inner) { return { error: 'Не удалось остановить процесс: ' + inner.message }; }
  }
  item.stoppedAt = new Date().toISOString(); item.lastSignal = signal;
  registry[valid] = item; writeProcessRegistry(registry);
  return { success: true, name: valid, pid: item.pid, signal, logPath: item.logPath, message: 'Сигнал отправлен только управляемому процессу.' };
}
async function followManagedLog(item, args) {
  const seconds = Math.min(Math.max(Number(args.follow_seconds || args.followSeconds || 0), 0), 30);
  const first = tailFile(item.logPath, args.lines || 120);
  if (first.error || !seconds) return { path: item.logPath, ...first, following: false };
  let offset = 0;
  try { offset = fs.statSync(item.logPath).size; } catch {}
  const added = await new Promise(resolve => {
    let collected = '';
    const readNew = () => {
      try {
        const size = fs.statSync(item.logPath).size;
        if (size < offset) offset = 0; // лог был очищен / пересоздан
        if (size <= offset) return;
        const fd = fs.openSync(item.logPath, 'r');
        const buffer = Buffer.alloc(size - offset);
        fs.readSync(fd, buffer, 0, buffer.length, offset);
        fs.closeSync(fd);
        offset = size;
        const text = buffer.toString('utf8');
        collected += text;
        // В CLI новые строки появляются сразу, а не после окончания follow_seconds.
        if (args.__cliLive && text) printLiveCommandChunk('process-log', Buffer.from(text));
      } catch {}
    };
    const interval = setInterval(readNew, 250);
    setTimeout(() => {
      clearInterval(interval);
      readNew();
      resolve(collected);
    }, seconds * 1000);
  });
  return { path: item.logPath, content: (first.content || '') + (added ? `\n--- новые строки за ${seconds}s ---\n${added}` : ''), totalLines: first.totalLines, following: true, followSeconds: seconds };
}
function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function safeNpmTokens(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const tokens = values.map(x => String(x).trim()).filter(Boolean);
  if (!tokens.length) return { error: 'Не указаны npm-пакеты.' };
  if (tokens.some(x => /[;&|`$<>()\\]/.test(x))) return { error: 'Недопустимые символы в имени npm-пакета.' };
  return { tokens };
}
function inspectProject(root) {
  const resolved = mcpPathOrError(root || '.', 'path', true, true);
  if (resolved.error) return resolved;
  const project = resolved.path;
  const packagePath = path.join(project, 'package.json');
  let pkg = null, packageError = null;
  try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')); } catch (e) { packageError = e.message; }
  let entries = [];
  try { entries = fs.readdirSync(project, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })); } catch {}
  const source = entries.filter(e => /\.(js|mjs|cjs|ts|tsx|jsx|html|css|json)$/i.test(e.name)).map(e => e.name).slice(0, 80);
  return {
    workspace: WORKSPACE_ROOT, path: project, packageJson: fs.existsSync(packagePath) ? packagePath : null,
    packageError, name: pkg?.name || null, version: pkg?.version || null,
    scripts: pkg?.scripts || {}, dependencies: Object.keys(pkg?.dependencies || {}), devDependencies: Object.keys(pkg?.devDependencies || {}),
    nodeModules: fs.existsSync(path.join(project, 'node_modules')), entries: entries.slice(0, 120), sourceFiles: source
  };
}
function backupFile(args) {
  const source = mcpPathOrError(args.path, 'path', true);
  if (source.error) return source;
  try {
    const dir = path.join(WORKSPACE_ROOT, '.zen-agent', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dir, `${path.basename(source.path)}.${stamp}.bak`);
    fs.copyFileSync(source.path, backupPath);
    return { success: true, path: source.path, backupPath, size: fs.statSync(backupPath).size };
  } catch (e) { return { error: 'Не удалось создать резервную копию: ' + e.message }; }
}
function simpleFileDiff(args) {
  const current = mcpPathOrError(args.path, 'path', true);
  if (current.error) return current;
  const previous = mcpPathOrError(args.backup || args.other_path, 'backup', true);
  if (previous.error) return previous;
  try {
    const before = fs.readFileSync(previous.path, 'utf8').split('\n');
    const after = fs.readFileSync(current.path, 'utf8').split('\n');
    let head = 0; while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0; while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    if (head === before.length && head === after.length) return { equal: true, path: current.path, backup: previous.path, diff: 'Файлы идентичны.' };
    const removed = before.slice(head, before.length - tail).slice(0, 250);
    const added = after.slice(head, after.length - tail).slice(0, 250);
    const diff = [`--- ${previous.path}`, `+++ ${current.path}`, `@@ строка ${head + 1} @@`, ...removed.map(x => '- ' + x), ...added.map(x => '+ ' + x)].join('\n');
    return { equal: false, path: current.path, backup: previous.path, changedAtLine: head + 1, truncated: removed.length < before.length - head - tail || added.length < after.length - head - tail, diff };
  } catch (e) { return { error: 'Не удалось сравнить файлы: ' + e.message }; }
}
function termuxInfoTool() {
  let storage = { path: PLATFORM.isTermux ? TERMUX_SHARED_ROOT : null, accessible: false };
  try { if (storage.path) storage.accessible = fs.existsSync(storage.path) && fs.statSync(storage.path).isDirectory(); } catch {}
  let npmVersion = null;
  try { npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch {}
  return { platform: PLATFORM, workspace: WORKSPACE_ROOT, storage, node: process.version, npm: npmVersion, shell: process.env.SHELL || null, curl: curlPath(), proxy: proxyStatus() };
}
function networkCheckTool() {
  const args = ['-s', '--connect-timeout', '5', '--max-time', '10', '-o', '/dev/null', '-w', '%{http_code}', ...(CONFIG.proxy ? ['-x', CONFIG.proxy] : []), 'https://opencode.ai/zen/v1/models'];
  try {
    const code = execFileSync(curlPath(), args, { encoding: 'utf8', timeout: 12000 }).trim();
    return { reachable: /^2|^3|^4/.test(code), httpStatus: code, proxy: proxyStatus(), hint: 'Проверка выполнена через текущую системную сеть Android/VPN.' };
  } catch (e) { return { reachable: false, error: (e.stderr || e.message || '').toString().slice(0, 500), proxy: proxyStatus(), hint: 'Если Wi‑Fi блокирует сервер моделей, включи Android VPN и убедись, что Termux не исключён из VPN.' }; }
}
function normalizeHttpUrl(value) {
  let raw = String(value || '').trim();
  // Модели иногда передают Markdown-ссылку вместо URL: [label](http://127.0.0.1:3000/).
  const markdown = raw.match(/^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/i);
  if (markdown) raw = markdown[1];
  return raw.replace(/^<|>$/g, '');
}
function httpRequestTool(args) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(normalizeHttpUrl(args.url)); } catch { resolve({ error: 'Нужен корректный URL без Markdown. Пример: http://127.0.0.1:3000/' }); return; }
    if (!/^https?:$/.test(parsed.protocol)) { resolve({ error: 'http_request поддерживает только http:// и https://.' }); return; }
    const client = parsed.protocol === 'https:' ? https : http;
    const method = String(args.method || 'GET').toUpperCase();
    const body = args.body === undefined ? null : (typeof args.body === 'string' ? args.body : JSON.stringify(args.body));
    const headers = { ...(args.headers && typeof args.headers === 'object' ? args.headers : {}) };
    if (body && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(body);
    const started = Date.now(); let responseBody = ''; let completed = false;
    const finish = result => { if (!completed) { completed = true; resolve({ url: parsed.toString(), method, ms: Date.now() - started, ...result }); } };
    const req = client.request(parsed, { method, headers, timeout: Math.min(Math.max(Number(args.timeout || 8000), 1000), 30000) }, res => {
      res.setEncoding('utf8');
      res.on('data', chunk => { if (responseBody.length < 1024 * 1024) responseBody += chunk; });
      res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('timeout', () => { req.destroy(new Error('HTTP timeout')); });
    req.on('error', err => finish({ ok: false, error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}
async function websocketTestTool(args) {
  const url = String(args.url || '').trim();
  if (!/^wss?:\/\//i.test(url)) return { error: 'Нужен ws:// или wss:// URL.' };
  const timeout = Math.min(Math.max(Number(args.timeout || 8000), 1000), 30000);
  const payload = args.payload === undefined ? 'ping' : (typeof args.payload === 'string' ? args.payload : JSON.stringify(args.payload));
  if (String(args.protocol || '').toLowerCase() === 'socket.io') {
    let io;
    try { io = require(require.resolve('socket.io-client', { paths: [WORKSPACE_ROOT] })); }
    catch { return { error: 'Для Socket.IO-теста установи socket.io-client через npm_install. Для обычного WebSocket protocol не указывай socket.io.' }; }
    return await new Promise(resolve => {
      const socket = io(url, { transports: ['websocket'], timeout }); let done = false;
      const finish = result => { if (!done) { done = true; try { socket.close(); } catch {} resolve(result); } };
      const timer = setTimeout(() => finish({ ok: false, error: 'Socket.IO timeout' }), timeout);
      socket.on('connect_error', err => { clearTimeout(timer); finish({ ok: false, error: err.message }); });
      socket.on('connect', () => {
        const event = String(args.event || 'message');
        socket.emit(event, args.payload === undefined ? 'ping' : args.payload);
        if (!args.expect_event) { clearTimeout(timer); finish({ ok: true, protocol: 'socket.io', connected: true, sentEvent: event }); }
      });
      if (args.expect_event) socket.on(String(args.expect_event), data => { clearTimeout(timer); finish({ ok: true, protocol: 'socket.io', receivedEvent: args.expect_event, data }); });
    });
  }
  const WS = globalThis.WebSocket;
  if (!WS) return { error: 'В этой версии Node нет WebSocket-клиента. Установи ws через npm_install или используй Socket.IO-клиент.' };
  return await new Promise(resolve => {
    let done = false; let socket;
    const finish = result => { if (!done) { done = true; clearTimeout(timer); try { socket?.close(); } catch {} resolve(result); } };
    const timer = setTimeout(() => finish({ ok: false, error: 'WebSocket timeout' }), timeout);
    try {
      socket = new WS(url);
      socket.addEventListener('open', () => { socket.send(payload); if (!args.wait_for_message) finish({ ok: true, protocol: 'websocket', sent: payload }); });
      socket.addEventListener('message', event => finish({ ok: true, protocol: 'websocket', received: String(event.data) }));
      socket.addEventListener('error', () => finish({ ok: false, error: 'WebSocket error' }));
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}


// ═══════════════════════════════════════════════════════════════════
//  FIRST-CLASS PROJECT WORKFLOW: filesystem, Git, QA, archives, Android
// ═══════════════════════════════════════════════════════════════════
function boundedInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
function treeDirectory(args) {
  const base = mcpPathOrError(args.path || '.', 'path', true, true);
  if (base.error) return base;
  const maxDepth = boundedInt(args.max_depth || args.maxDepth, 3, 0, 8);
  const limit = boundedInt(args.limit, 300, 1, 2000);
  const entries = []; const skip = new Set(['node_modules', '.git', '.cache', '.zen-agent']);
  function walk(dir, depth) {
    if (entries.length >= limit || depth > maxDepth) return;
    let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of list) {
      if (entries.length >= limit) return;
      const full = path.join(dir, entry.name);
      entries.push({ depth, name: entry.name, path: full, type: entry.isDirectory() ? 'directory' : 'file' });
      if (entry.isDirectory() && depth < maxDepth && !skip.has(entry.name)) walk(full, depth + 1);
    }
  }
  walk(base.path, 0);
  return { path: base.path, maxDepth, entries, truncated: entries.length >= limit };
}
function searchTextInFiles(args) {
  const base = mcpPathOrError(args.path || '.', 'path', true, true);
  if (base.error) return base;
  const query = String(args.query || args.text || '');
  if (!query) return { error: 'Для search_text нужен query.' };
  const caseSensitive = !!args.case_sensitive;
  const needle = caseSensitive ? query : query.toLowerCase();
  const maxFiles = boundedInt(args.max_files || args.maxFiles, 50, 1, 200);
  const maxMatches = boundedInt(args.max_matches || args.maxMatches, 200, 1, 1000);
  const maxDepth = boundedInt(args.max_depth || args.maxDepth, 4, 0, 8);
  const matches = []; let filesScanned = 0;
  const skip = new Set(['node_modules', '.git', '.cache', '.zen-agent']);
  function walk(dir, depth) {
    if (matches.length >= maxMatches || depth > maxDepth || filesScanned >= maxFiles) return;
    let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of list) {
      if (matches.length >= maxMatches || filesScanned >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(full, depth + 1); continue; }
      let stat; try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > 2 * 1024 * 1024) continue;
      let content; try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (content.includes('\u0000')) continue;
      filesScanned++;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        const subject = caseSensitive ? lines[i] : lines[i].toLowerCase();
        if (subject.includes(needle)) matches.push({ path: full, line: i + 1, text: lines[i].slice(0, 500) });
      }
    }
  }
  walk(base.path, 0);
  return { path: base.path, query, filesScanned, matches, truncated: matches.length >= maxMatches || filesScanned >= maxFiles };
}
function fileInfoTool(args) {
  const target = mcpPathOrError(args.path, 'path', true);
  if (target.error) return target;
  try {
    const stat = fs.statSync(target.path);
    const info = { path: target.path, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, modified: stat.mtime.toISOString(), created: stat.birthtime.toISOString() };
    if (stat.isFile() && stat.size <= 100 * 1024 * 1024 && args.hash !== false) {
      const hash = crypto.createHash(String(args.algorithm || 'sha256').toLowerCase());
      hash.update(fs.readFileSync(target.path)); info.hash = { algorithm: String(args.algorithm || 'sha256').toLowerCase(), value: hash.digest('hex') };
    } else if (stat.isFile() && stat.size > 100 * 1024 * 1024) info.hashNote = 'Хеш пропущен: файл больше 100 MiB.';
    return info;
  } catch (e) { return { error: 'Не удалось получить сведения: ' + e.message }; }
}
function mkdirTool(args) {
  const target = mcpPathOrError(args.path, 'path');
  if (target.error) return target;
  try { fs.mkdirSync(target.path, { recursive: args.recursive !== false }); return { success: true, path: target.path }; }
  catch (e) { return { error: 'Не удалось создать папку: ' + e.message }; }
}
function copyOrMoveTool(args, move = false) {
  const source = mcpPathOrError(args.source || args.from, 'source', true);
  if (source.error) return source;
  const target = mcpPathOrError(args.destination || args.to, 'destination');
  if (target.error) return target;
  if (source.path === target.path) return { error: 'Исходный и целевой путь совпадают.' };
  try {
    if (fs.statSync(source.path).isDirectory() && isPathInside(target.path, source.path)) {
      return { error: 'Нельзя копировать или перемещать папку внутрь неё самой.' };
    }
  } catch {}
  if (fs.existsSync(target.path) && !args.overwrite) return { error: 'Целевой путь уже существует. Передай overwrite:true, если уверен.' };
  try {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    if (move) {
      try { fs.renameSync(source.path, target.path); }
      catch { fs.cpSync(source.path, target.path, { recursive: true, force: !!args.overwrite }); fs.rmSync(source.path, { recursive: true, force: true }); }
    } else fs.cpSync(source.path, target.path, { recursive: true, force: !!args.overwrite, errorOnExist: !args.overwrite });
    return { success: true, operation: move ? 'move' : 'copy', source: source.path, destination: target.path };
  } catch (e) { return { error: `Не удалось ${move ? 'переместить' : 'скопировать'}: ` + e.message }; }
}
function archiveCreateTool(args) {
  const source = mcpPathOrError(args.source || args.path || '.', 'source', true, true);
  if (source.error) return source;
  const destination = mcpPathOrError(args.destination || args.output, 'destination');
  if (destination.error) return destination;
  if (!/\.(tar\.gz|tgz)$/i.test(destination.path)) return { error: 'archive_create поддерживает .tar.gz или .tgz.' };
  if (fs.existsSync(destination.path) && !args.overwrite) return { error: 'Архив уже существует. Передай overwrite:true, если уверен.' };
  try {
    fs.mkdirSync(path.dirname(destination.path), { recursive: true });
    // Создаём архив вне исходной папки: иначе tar пытается читать файл, который сам же дописывает.
    const temporary = path.join(os.tmpdir(), `zen_archive_${Date.now()}_${Math.random().toString(36).slice(2)}.tar.gz`);
    try {
      execFileSync('tar', ['-czf', temporary, '-C', source.path, '.'], { timeout: safeCommandTimeout(args.timeout, 120000), stdio: ['ignore', 'pipe', 'pipe'] });
      try { fs.renameSync(temporary, destination.path); }
      catch { fs.copyFileSync(temporary, destination.path); fs.unlinkSync(temporary); }
    } finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {} }
    return { success: true, source: source.path, archive: destination.path, size: fs.statSync(destination.path).size };
  } catch (e) { return { error: 'Не удалось создать tar.gz: ' + (e.stderr || e.message || '').toString() }; }
}
function validateArchiveEntries(archivePath) {
  try {
    const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    const unsafe = listing.split(/\r?\n/).filter(Boolean).find(entry => {
      const name = entry.replace(/\\/g, '/');
      return name.startsWith('/') || name === '..' || name.startsWith('../') || name.includes('/../');
    });
    return unsafe ? { error: `Архив содержит небезопасный путь: ${unsafe}` } : { ok: true };
  } catch (e) { return { error: 'Не удалось проверить содержимое архива: ' + (e.stderr || e.message || '').toString().slice(0, 300) }; }
}
function archiveExtractTool(args) {
  const archive = mcpPathOrError(args.archive || args.path, 'archive', true);
  if (archive.error) return archive;
  const destination = mcpPathOrError(args.destination || args.output || '.', 'destination');
  if (destination.error) return destination;
  if (!/\.(tar\.gz|tgz)$/i.test(archive.path)) return { error: 'archive_extract поддерживает .tar.gz или .tgz.' };
  const archiveCheck = validateArchiveEntries(archive.path);
  if (archiveCheck.error) return archiveCheck;
  try {
    fs.mkdirSync(destination.path, { recursive: true });
    execFileSync('tar', ['-xzf', archive.path, '-C', destination.path], { timeout: safeCommandTimeout(args.timeout, 120000), stdio: ['ignore', 'pipe', 'pipe'] });
    return { success: true, archive: archive.path, destination: destination.path };
  } catch (e) { return { error: 'Не удалось распаковать архив: ' + (e.stderr || e.message || '').toString() }; }
}
function gitCwd(args) { return mcpPathOrError(args.cwd || '.', 'cwd', true, true); }
async function gitLiveTool(command, cwdResult, args) {
  const opts = { cwd: cwdResult.path, timeout: safeCommandTimeout(args.timeout, 30000), env: commandEnvironment() };
  if (args.__cliLive && CONFIG.liveToolLogs) return await runCommandWithLiveLogs(command, cwdResult.path, opts);
  try { return { success: true, cwd: cwdResult.path, stdout: execSync(command, { ...opts, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }) }; }
  catch (e) { return { error: (e.stderr || e.message || '').toString() }; }
}
const GITHUB_TOKEN_FILE = path.join(os.homedir(), '.zen_github_token.json');
const GITHUB_CONFIG_FILE = path.join(os.homedir(), '.zen_github_config.json');
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (CONFIG.githubToken) return CONFIG.githubToken;
  try {
    const saved = JSON.parse(fs.readFileSync(GITHUB_TOKEN_FILE, 'utf8'));
    if (saved && typeof saved.token === 'string' && saved.token.trim()) { CONFIG.githubToken = saved.token.trim(); return CONFIG.githubToken; }
  } catch {}
  return '';
}
function looksLikeGitHubToken(value) {
  const raw = String(value || '').trim().replace(/^set\s+/i, '');
  return /^(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|[A-Za-z0-9_-]{30,})$/.test(raw);
}
function maskGitHubToken(token) {
  const raw = String(token || '');
  return raw.length >= 12 ? `${raw.slice(0, 6)}…${raw.slice(-4)}` : (raw ? '***' : 'не задан');
}
function saveGitHubToken(value) {
  const token = String(value || '').trim().replace(/^set\s+/i, '').replace(/[\r\n]/g, '');
  if (!looksLikeGitHubToken(token)) return { error: 'Нужен GitHub token: ghp_..., github_pat_... или совместимый токен длиной не менее 30 символов.' };
  try {
    fs.writeFileSync(GITHUB_TOKEN_FILE, JSON.stringify({ token, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(GITHUB_TOKEN_FILE, 0o600); } catch {}
    CONFIG.githubToken = token;
    return { success: true, masked: maskGitHubToken(token), source: 'локальный защищённый файл' };
  } catch (e) { return { error: 'Не удалось сохранить GitHub token: ' + e.message }; }
}
function clearGitHubToken() {
  CONFIG.githubToken = '';
  try { fs.unlinkSync(GITHUB_TOKEN_FILE); } catch {}
  return { success: true, environmentStillSet: !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN) };
}
function githubTokenStatus() {
  const token = githubToken();
  return { configured: !!token, masked: maskGitHubToken(token), source: process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? 'окружение' : (fs.existsSync(GITHUB_TOKEN_FILE) ? 'локальный защищённый файл' : 'нет') };
}
function openGitHubSecretInput() {
  if (!PLATFORM.isTermux) return false;
  try {
    const raw = execFileSync('termux-dialog', ['-t', 'password', '-i', 'GitHub token'], { encoding: 'utf8', timeout: 120000 });
    const result = JSON.parse(raw || '{}');
    if (result.code !== undefined && Number(result.code) !== 0) { console.log(c('Ввод GitHub token отменён.', 'gray')); return true; }
    const token = String(result.text || '').trim();
    if (!token) { console.log(c('Token не введён.', 'gray')); return true; }
    const saved = saveGitHubToken(token);
    console.log(saved.error ? c('✗ ' + saved.error, 'red') : c(`✓ GitHub token сохранён: ${saved.masked}`, 'green'));
    return true;
  } catch { return false; }
}
function loadGitHubConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(GITHUB_CONFIG_FILE, 'utf8'));
    if (saved && typeof saved.repo === 'string' && saved.repo.trim()) CONFIG.githubRepo = saved.repo.trim();
  } catch {}
}
function saveGitHubConfig() {
  try { fs.writeFileSync(GITHUB_CONFIG_FILE, JSON.stringify({ repo: CONFIG.githubRepo || '', updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 }); return { success: true }; }
  catch (e) { return { error: 'Не удалось сохранить GitHub-репозиторий: ' + e.message }; }
}
function safeGitHubPart(value) { return /^[A-Za-z0-9_.-]{1,100}$/.test(String(value || '')); }
function githubRepoArgs(args = {}) {
  if (!CONFIG.githubRepo) loadGitHubConfig();
  let raw = String(args.repo || args.repository || CONFIG.githubRepo || '').trim();
  if (!raw && args.owner && args.project) raw = `${args.owner}/${args.project}`;
  const match = raw.match(/^([^/]+)\/([^/]+)$/);
  if (!match || !safeGitHubPart(match[1]) || !safeGitHubPart(match[2])) return { error: 'Укажи GitHub-репозиторий в формате owner/repository или настрой /git repo owner/repository.' };
  return { owner: match[1], repo: match[2], full: `${match[1]}/${match[2]}` };
}
function githubApiPath(repo, suffix) { return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${suffix}`; }
function githubApiRequest(method, apiPath, body = undefined) {
  return new Promise((resolve, reject) => {
    let base, target;
    try { base = new URL(CONFIG.githubApiBaseUrl); target = new URL(apiPath, base); }
    catch (e) { reject(new Error('Некорректный GitHub API URL: ' + e.message)); return; }
    if (target.protocol !== 'https:') { reject(new Error('GitHub API должен использовать HTTPS.')); return; }
    const payload = body === undefined ? null : JSON.stringify(body);
    const token = githubToken();
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Zen-Agent', 'X-GitHub-Api-Version': '2022-11-28' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = https.request(target, { method, timeout: 30000, headers }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size <= 16 * 1024 * 1024) chunks.push(chunk); else res.destroy(new Error('GitHub response exceeds 16 MiB')); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); let data = null;
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = null; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = data?.message || raw.slice(0, 400) || `HTTP ${res.statusCode}`;
          reject(new Error(`GitHub API HTTP ${res.statusCode}: ${message}`)); return;
        }
        if (data === null) { reject(new Error('GitHub API вернул не-JSON ответ.')); return; }
        resolve(data);
      });
    });
    req.on('error', error => reject(new Error(redactSecrets(error.message || String(error)))));
    req.on('timeout', () => req.destroy(new Error('GitHub API timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
function githubDownloadToFile(url, destination, redirect = 0) {
  return new Promise((resolve, reject) => {
    if (redirect > 5) { reject(new Error('Слишком много перенаправлений GitHub download.')); return; }
    let target; try { target = new URL(url); } catch (e) { reject(new Error('Некорректный URL GitHub download.')); return; }
    if (!['https:', 'http:'].includes(target.protocol)) { reject(new Error('GitHub download разрешает только HTTP(S).')); return; }
    const headers = { 'User-Agent': 'Zen-Agent', Accept: 'application/octet-stream' };
    // Never forward the token to a different host after GitHub redirects to a CDN.
    if (githubToken() && /(^|\.)api\.github\.com$|(^|\.)github\.com$/i.test(target.hostname)) headers.Authorization = `Bearer ${githubToken()}`;
    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(target, { headers, timeout: 60000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); githubDownloadToFile(new URL(res.headers.location, target).toString(), destination, redirect + 1).then(resolve, reject); return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`GitHub download HTTP ${res.statusCode}`)); return; }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const stream = fs.createWriteStream(destination, { flags: 'w' }); let size = 0; let failed = false;
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024 * 1024 && !failed) { failed = true; req.destroy(new Error('Загрузка больше 1 GiB запрещена.')); stream.destroy(); try { fs.unlinkSync(destination); } catch {} reject(new Error('Загрузка больше 1 GiB запрещена.')); } });
      res.on('error', error => { if (!failed) { failed = true; stream.destroy(); try { fs.unlinkSync(destination); } catch {} reject(error); } });
      stream.on('error', error => { if (!failed) { failed = true; req.destroy(); try { fs.unlinkSync(destination); } catch {} reject(error); } });
      stream.on('finish', () => { if (!failed) resolve({ path: destination, size }); });
      res.pipe(stream);
    });
    req.on('error', error => { try { fs.unlinkSync(destination); } catch {} reject(new Error(redactSecrets(error.message || String(error)))); });
    req.on('timeout', () => req.destroy(new Error('GitHub download timeout')));
  });
}
function githubRepoInfoTool(args) {
  const repo = githubRepoArgs(args); if (repo.error) return repo;
  return githubApiRequest('GET', githubApiPath(repo, ''))
    .then(data => ({ full: repo.full, name: data.full_name, private: !!data.private, defaultBranch: data.default_branch, description: data.description || '', stars: data.stargazers_count, forks: data.forks_count, openIssues: data.open_issues_count, updatedAt: data.updated_at, url: data.html_url }))
    .catch(error => ({ error: redactSecrets(error.message || String(error)) }));
}
function githubCommitsTool(args) {
  const repo = githubRepoArgs(args); if (repo.error) return repo;
  const perPage = boundedInt(args.limit || args.per_page, 10, 1, 100);
  const page = boundedInt(args.page, 1, 1, 1000);
  return githubApiRequest('GET', githubApiPath(repo, `/commits?per_page=${perPage}&page=${page}`))
    .then(data => ({ repository: repo.full, commits: (Array.isArray(data) ? data : []).map(item => ({ sha: item.sha, shortSha: String(item.sha || '').slice(0, 7), message: String(item.commit?.message || '').split('\n')[0], author: item.author?.login || item.commit?.author?.name || 'unknown', date: item.commit?.author?.date || null, url: item.html_url })) }))
    .catch(error => ({ error: redactSecrets(error.message || String(error)) }));
}
// ── Удалённая работа с файлами GitHub (без клонирования) ──────────────────
// Через GitHub Contents API можно читать/писать файлы прямо в репозитории.
function githubContentsPath(repo, filePath) {
  const clean = String(filePath || '').replace(/^\/+/, '').split('?')[0];
  return githubApiPath(repo, clean ? `/contents/${clean.split('/').map(encodeURIComponent).join('/')}` : '/contents');
}
function githubReadFileTool(args) {
  const repo = githubRepoArgs(args); if (repo.error) return repo;
  const path = String(args.path || args.file || '').trim();
  if (!path) return { error: 'Для github_read_file нужен path (путь в репозитории).' };
  const ref = args.branch || args.ref ? `?ref=${encodeURIComponent(String(args.branch || args.ref))}` : '';
  return githubApiRequest('GET', githubContentsPath(repo, path) + ref)
    .then(data => {
      // Папка — вернётся массив элементов.
      if (Array.isArray(data)) {
        return { repository: repo.full, path, directory: true, items: data.map(it => ({ name: it.name, path: it.path, type: it.type, size: it.size || 0 })) };
      }
      if (data.type === 'dir') {
        return { repository: repo.full, path, directory: true, items: [] };
      }
      const content = (data.content && data.encoding === 'base64') ? Buffer.from(data.content, 'base64').toString('utf8') : '';
      return { repository: repo.full, path, size: data.size, sha: data.sha, content, truncated: data.size > 1024 * 1024 };
    })
    .catch(error => ({ error: redactSecrets(error.message || String(error)) }));
}
function githubListDirTool(args) {
  const repo = githubRepoArgs(args); if (repo.error) return repo;
  const path = String(args.path || args.dir || '').trim().replace(/^\/+/, '');
  const ref = args.branch || args.ref ? `?ref=${encodeURIComponent(String(args.branch || args.ref))}` : '';
  return githubApiRequest('GET', githubContentsPath(repo, path) + ref)
    .then(data => {
      const items = Array.isArray(data)
        ? data.map(it => ({ name: it.name, path: it.path, type: it.type, size: it.size || 0, sha: it.sha }))
        : (data.type === 'file' ? [{ name: data.name, path: data.path, type: 'file', size: data.size || 0, sha: data.sha }] : []);
      return { repository: repo.full, path: path || '/', directory: true, items, truncated: items.length >= 100 };
    })
    .catch(error => ({ error: redactSecrets(error.message || String(error)) }));
}
function githubWriteFileTool(args) {
  const repo = githubRepoArgs(args); if (repo.error) return repo;
  const path = String(args.path || args.file || '').trim();
  if (!path) return { error: 'Для github_write_file нужен path (путь в репозитории).' };
  const content = String(args.content === undefined ? '' : args.content);
  const message = String(args.message || `Update ${path}`).slice(0, 200);
  const body = { message, content: Buffer.from(content, 'utf8').toString('base64') };
  if (args.branch) body.branch = String(args.branch);
  if (args.sha) body.sha = String(args.sha); // для обновления существующего файла
  return githubApiRequest('PUT', githubContentsPath(repo, path), body)
    .then(data => ({ success: true, repository: repo.full, path, commit: data.commit?.sha || null, commitMessage: data.commit?.message || message, branch: body.branch || 'default' }))
    .catch(error => ({ error: redactSecrets(error.message || String(error)) }));
}
function githubReadmeTool(args) {
  const repo = githubRepoArgs(args); if (repo.error) return repo;
  const ref = args.branch ? `?ref=${encodeURIComponent(String(args.branch))}` : '';
  return githubApiRequest('GET', githubApiPath(repo, '/readme') + ref)
    .then(data => ({ repository: repo.full, path: data.path, size: data.size, sha: data.sha, content: data.content && data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : '' }))
    .catch(error => ({ error: redactSecrets(error.message || String(error)) }));
}
function githubBuildsTool(args) {
  const repo = githubRepoArgs(args); if (repo.error) return repo;
  const perPage = boundedInt(args.limit || args.per_page, 20, 1, 100);
  const query = args.branch ? `&branch=${encodeURIComponent(String(args.branch))}` : '';
  return githubApiRequest('GET', githubApiPath(repo, `/actions/runs?per_page=${perPage}${query}`))
    .then(data => ({ repository: repo.full, runs: (data.workflow_runs || []).map(run => ({ id: run.id, name: run.name, workflow: run.workflow_id, status: run.status, conclusion: run.conclusion, branch: run.head_branch, commit: run.head_sha, createdAt: run.created_at, updatedAt: run.updated_at, url: run.html_url })) }))
    .catch(error => ({ error: redactSecrets(error.message || String(error)) }));
}
async function githubWatchBuildTool(args) {
  const repo = githubRepoArgs(args); if (repo.error) return repo;
  const runId = Number(args.run_id || args.runId);
  if (!Number.isSafeInteger(runId) || runId <= 0) return { error: 'Для github_watch_build нужен корректный run_id.' };
  const interval = boundedInt(args.interval_seconds || args.interval, 10, 3, 120);
  const maxSeconds = boundedInt(args.timeout_seconds || args.timeout, CONFIG.longTaskMode ? 3600 : 600, 10, 3600);
  const started = Date.now(); let last = null;
  while (Date.now() - started <= maxSeconds * 1000) {
    if (abortRequested) return { error: 'Наблюдение за сборкой остановлено пользователем.' };
    try {
      const run = await githubApiRequest('GET', githubApiPath(repo, `/actions/runs/${runId}`));
      last = { id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, branch: run.head_branch, commit: run.head_sha, url: run.html_url, updatedAt: run.updated_at };
      console.log(c(`🔨 GitHub сборка ${runId}: ${run.status}${run.conclusion ? ' • ' + run.conclusion : ''}`, run.conclusion === 'success' ? 'green' : run.conclusion === 'failure' ? 'red' : 'yellow'));
      if (run.status === 'completed') return { success: run.conclusion === 'success', repository: repo.full, run: last, elapsedSeconds: Math.round((Date.now() - started) / 1000) };
    } catch (error) { return { error: redactSecrets(error.message || String(error)), last }; }
    await zenSleep(interval * 1000);
  }
  return { error: `Время наблюдения истекло (${maxSeconds} с).`, repository: repo.full, run: last, timedOut: true };
}
function safeZipEntry(entry) {
  const name = String(entry || '').replace(/\\/g, '/');
  return !!name && !name.startsWith('/') && name !== '..' && !name.startsWith('../') && !name.includes('/../');
}
async function githubDownloadApkTool(args) {
  const repo = githubRepoArgs(args); if (repo.error) return repo;
  const source = String(args.source || 'actions').toLowerCase();
  if (source === 'release') {
    try {
      const releasePath = args.tag ? `/releases/tags/${encodeURIComponent(String(args.tag))}` : '/releases/latest';
      const release = await githubApiRequest('GET', githubApiPath(repo, releasePath));
      const asset = (release.assets || []).find(item => /\.apk$/i.test(item.name));
      if (!asset) return { error: `В релизе ${release.tag_name || 'latest'} нет APK-файла.` };
      const destination = mcpPathOrError(args.path || args.output || `downloads/${asset.name}`, 'path'); if (destination.error) return destination;
      const saved = await githubDownloadToFile(asset.browser_download_url, destination.path);
      return { success: true, source: 'release', repository: repo.full, release: release.tag_name, asset: asset.name, path: saved.path, size: saved.size, url: asset.browser_download_url };
    } catch (error) { return { error: redactSecrets(error.message || String(error)) }; }
  }
  let runId = Number(args.run_id || args.runId) || 0;
  try {
    if (!runId) {
      const runs = await githubApiRequest('GET', githubApiPath(repo, '/actions/runs?status=completed&per_page=30'));
      const run = (runs.workflow_runs || []).find(item => item.conclusion === 'success');
      if (!run) return { error: 'У репозитория нет успешной завершённой сборки.' };
      runId = run.id;
    }
    const artifacts = await githubApiRequest('GET', githubApiPath(repo, `/actions/runs/${runId}/artifacts?per_page=100`));
    const wanted = String(args.artifact_name || args.artifact || '').trim().toLowerCase();
    const artifact = (artifacts.artifacts || []).find(item => wanted ? item.name.toLowerCase() === wanted : /apk|android|release/i.test(item.name)) || (artifacts.artifacts || [])[0];
    if (!artifact) return { error: `У сборки ${runId} нет доступных артефактов.` };
    const temporary = path.join(os.tmpdir(), `zen_github_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.zip`);
    try {
      const zip = await githubDownloadToFile(artifact.archive_download_url, temporary);
      const entries = execFileSync('unzip', ['-Z1', temporary], { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
      const unsafe = entries.find(entry => !safeZipEntry(entry));
      if (unsafe) return { error: `Артефакт содержит небезопасный путь: ${unsafe}` };
      const apkEntry = entries.find(entry => /\.apk$/i.test(entry));
      const requestedPath = String(args.path || args.output || '').trim();
      const keepZip = args.extract === false || !apkEntry;
      const zipDestination = mcpPathOrError(requestedPath && /\.zip$/i.test(requestedPath) ? requestedPath : `downloads/${artifact.name}.zip`, 'path'); if (zipDestination.error) return zipDestination;
      if (keepZip) {
        fs.copyFileSync(temporary, zipDestination.path);
        return { success: true, source: 'actions', repository: repo.full, runId, artifact: artifact.name, archive: zipDestination.path, size: fs.statSync(zipDestination.path).size, apkFound: !!apkEntry };
      }
      const apkName = path.basename(apkEntry);
      const apkDestination = mcpPathOrError(requestedPath && !/\.zip$/i.test(requestedPath) ? requestedPath : `downloads/${apkName}`, 'path'); if (apkDestination.error) return apkDestination;
      const apk = execFileSync('unzip', ['-p', temporary, apkEntry], { encoding: null, timeout: 120000, maxBuffer: 512 * 1024 * 1024 });
      fs.mkdirSync(path.dirname(apkDestination.path), { recursive: true }); fs.writeFileSync(apkDestination.path, apk);
      return { success: true, source: 'actions', repository: repo.full, runId, artifact: artifact.name, apk: apkDestination.path, size: apk.length, entry: apkEntry };
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  } catch (error) { return { error: redactSecrets(error.message || String(error)) }; }
}
async function gitPushTool(args) {
  const cwdResult = gitCwd(args); if (cwdResult.error) return cwdResult;
  const remote = String(args.remote || 'origin').trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(remote)) return { error: 'Некорректное имя Git remote.' };
  const branch = args.branch ? safeGitRef(args.branch) : null;
  if (args.branch && !branch) return { error: 'Некорректное имя ветки.' };
  let remoteUrl = '';
  try { remoteUrl = execFileSync('git', ['remote', 'get-url', remote], { cwd: cwdResult.path, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return { error: 'Не удалось получить Git remote: ' + (e.stderr || e.message || '').toString().slice(0, 300) }; }
  const token = githubToken();
  if (/^https?:\/\//i.test(remoteUrl) && /github\.com/i.test(remoteUrl) && !token) return { error: 'Для GitHub push задай token через /git key или GITHUB_TOKEN.' };
  const env = { ...commandEnvironment(), GIT_TERMINAL_PROMPT: '0' };
  let askpass = null;
  try {
    if (token) {
      if (process.platform === 'win32') {
        askpass = path.join(os.tmpdir(), `zen_git_askpass_${Date.now()}.cmd`);
        fs.writeFileSync(askpass, '@echo off\r\necho %* | findstr /I "Username" >nul\r\nif not errorlevel 1 (echo x-access-token) else (echo %GITHUB_TOKEN%)\r\n', { mode: 0o700 });
      } else {
        askpass = path.join(os.tmpdir(), `zen_git_askpass_${Date.now()}.sh`);
        fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "$GITHUB_TOKEN" ;; esac\n', { mode: 0o700 });
        fs.chmodSync(askpass, 0o700);
      }
      env.GIT_ASKPASS = askpass; env.GITHUB_TOKEN = token; env.GIT_USERNAME = 'x-access-token';
    }
    const command = `git push${args.set_upstream ? ' --set-upstream' : ''} ${shellQuote(remote)}${branch ? ' ' + shellQuote(branch) : ''}`;
    const options = { cwd: cwdResult.path, timeout: safeCommandTimeout(args.timeout, 120000), env };
    const result = args.__cliLive && CONFIG.liveToolLogs ? await runCommandWithLiveLogs(command, cwdResult.path, options) : (() => { try { return { success: true, cwd: cwdResult.path, stdout: execSync(command, { ...options, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }) }; } catch (e) { return { error: redactSecrets((e.stderr || e.stdout || e.message || '').toString()) }; } })();
    if (result.error) return result;
    return { ...result, success: result.exit === undefined ? true : result.exit === 0, remote, branch: branch || null, cwd: cwdResult.path };
  } finally { if (askpass) { try { fs.unlinkSync(askpass); } catch {} } }
}

function safeGitRef(ref) { return /^[a-zA-Z0-9._/-]{1,120}$/.test(String(ref || '')) ? String(ref) : null; }
function codeCheckCommand(args) {
  const file = mcpPathOrError(args.path, 'path', true);
  if (file.error) return file;
  const extension = path.extname(file.path).toLowerCase();
  if (!['.js', '.mjs', '.cjs'].includes(extension)) return { error: 'code_check пока поддерживает JS-файлы: .js, .mjs, .cjs.' };
  return { file, command: `${shellQuote(process.execPath)} --check ${shellQuote(file.path)}` };
}
function decodeHtml(value) { return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function stripHtml(value) { return decodeHtml(String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()); }
function webSearchTool(args) {
  const query = String(args.query || '').trim();
  if (!query) return { error: 'Для web_search нужен query.' };
  const limit = boundedInt(args.limit, 5, 1, 10);
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  try {
    const html = execFileSync(curlPath(), ['-L', '-s', '--connect-timeout', '8', '--max-time', '20', ...(CONFIG.proxy ? ['-x', CONFIG.proxy] : []), url], { encoding: 'utf8', timeout: 25000 });
    const results = []; const rx = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi; let match;
    while ((match = rx.exec(html)) && results.length < limit) results.push({ title: stripHtml(match[2]), url: decodeHtml(match[1]) });
    return { query, results, provider: 'DuckDuckGo HTML', note: results.length ? null : 'Поиск не вернул результатов: возможно, сеть/VPN или разметка провайдера изменилась.' };
  } catch (e) { return { error: 'Ошибка веб-поиска: ' + (e.stderr || e.message || '').toString().slice(0, 500) }; }
}
function runTermuxApi(command, values = []) {
  if (!PLATFORM.isTermux) return { error: 'Этот инструмент доступен только в Termux/Android.' };
  try { return { success: true, output: execFileSync(command, values, { encoding: 'utf8', timeout: 15000 }).trim() }; }
  catch (e) { return { error: `Не удалось выполнить ${command}. Установи Termux:API и соответствующее Android-приложение. ` + (e.stderr || e.message || '').toString().slice(0, 300) }; }
}
function termuxApiStatus() {
  if (!PLATFORM.isTermux) return { available: false, platform: PLATFORM.name, error: 'Termux:API доступен только когда Core запущен внутри Termux.' };
  const bin = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin') : '';
  const commands = ['termux-battery-status','termux-wifi-connectioninfo','termux-clipboard-get','termux-clipboard-set','termux-notification','termux-toast','termux-vibrate','termux-share','termux-volume','termux-location'];
  const available = commands.filter(name => bin && fs.existsSync(path.join(bin, name)));
  return { available: available.length > 0, platform: PLATFORM.name, prefix: process.env.PREFIX || null, commands: available, missing: commands.filter(name => !available.includes(name)), installHint: available.length ? null : 'Установи пакет Termux:API в Termux и Android-приложение Termux:API.' };
}



// ═══════════════════════════════════════════════════════════════════
//  VISION / OCR / POLLINATIONS
//  Local tools work with every text model; visual reasoning is routed
//  only to a vision-capable OpenRouter model.
// ═══════════════════════════════════════════════════════════════════
function detectImageMime(buffer, filePath = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/\.gif$/i.test(filePath)) return 'image/gif';
  return null;
}
function imageDimensions(buffer, mime) {
  try {
    if (mime === 'image/png' && buffer.length >= 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) { i++; continue; }
        const marker = buffer[i + 1]; const length = buffer.readUInt16BE(i + 2);
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
        i += 2 + length;
      }
    }
    if (mime === 'image/webp' && buffer.length >= 30 && buffer.subarray(12,16).toString() === 'VP8X') return { width: 1 + buffer.readUIntLE(24,3), height: 1 + buffer.readUIntLE(27,3) };
  } catch {}
  return { width: null, height: null };
}
function resolveImageFile(rawPath) {
  const image = mcpPathOrError(rawPath, 'path', true);
  if (image.error) return image;
  try {
    const stat = fs.statSync(image.path);
    if (!stat.isFile()) return { error: 'Это не файл изображения: ' + image.path };
    if (stat.size > 12 * 1024 * 1024) return { error: 'Изображение больше 12 MiB. Сожми его перед vision-анализом.' };
    const buffer = fs.readFileSync(image.path); const mime = detectImageMime(buffer, image.path);
    if (!mime) return { error: 'Поддерживаются PNG, JPEG, WebP и GIF.' };
    return { path: image.path, buffer, mime, stat, dimensions: imageDimensions(buffer, mime) };
  } catch (e) { return { error: 'Не удалось прочитать изображение: ' + e.message }; }
}
function imageInfoTool(args) {
  const image = resolveImageFile(args.path); if (image.error) return image;
  return { path: image.path, mime: image.mime, size: image.stat.size, modified: image.stat.mtime.toISOString(), dimensions: image.dimensions, sha256: crypto.createHash('sha256').update(image.buffer).digest('hex') };
}
function ocrImageTool(args) {
  const image = resolveImageFile(args.path); if (image.error) return image;
  const language = String(args.language || 'eng+rus').replace(/[^a-zA-Z+_]/g, '') || 'eng';
  const psm = Math.min(Math.max(Number(args.psm || 6), 3), 13);
  try {
    const text = execFileSync('tesseract', [image.path, 'stdout', '-l', language, '--psm', String(psm)], { encoding: 'utf8', timeout: 90000, maxBuffer: 5 * 1024 * 1024 });
    return { path: image.path, mime: image.mime, dimensions: image.dimensions, language, text };
  } catch (e) { return { error: 'OCR недоступен. Установи локально: pkg install tesseract tesseract-data-rus. ' + (e.stderr || e.message || '').toString().slice(0, 300) }; }
}
async function openRouterVision(images, prompt, model) {
  const key = openRouterKey();
  if (!key) return { error: 'Для visual analysis нужен OpenRouter key. Добавь его командой /key.' };
  const selectedModel = model || CONFIG.visionModel;
  const content = [{ type: 'text', text: String(prompt || 'Опиши изображение подробно и только по видимым фактам.') }];
  for (const image of images) content.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.buffer.toString('base64')}` } });
  try {
    const json = await openRouterRequest({ model: selectedModel, messages: [{ role: 'user', content }], max_tokens: 3000, temperature: 0.2, stream: false });
    const message = json.choices?.[0]?.message || {}; const analysis = Array.isArray(message.content) ? message.content.map(x => x.text || '').join('') : (message.content || '');
    return { model: json.model || selectedModel, analysis, usage: json.usage || {}, images: images.map(i => ({ path: i.path, mime: i.mime, dimensions: i.dimensions })) };
  } catch (e) { return { error: 'Vision model не ответила: ' + (e.message || e) + '. Выбери vision-модель: /vision MODEL_ID' }; }
}
async function visionAnalyzeTool(args) {
  const image = resolveImageFile(args.path); if (image.error) return image;
  return await openRouterVision([image], args.prompt || args.question || 'Опиши скриншот: текст, элементы интерфейса, ошибки и важные детали.', args.model);
}
async function visionUiAuditTool(args) {
  const prompt = `Проведи UI-аудит скриншота. Найди: переполнение/перенос текста, неработающие подсказки, проблемы контраста, доступность, мобильную компоновку, визуальные ошибки. Дай список с приоритетами. ${args.prompt || ''}`;
  return await visionAnalyzeTool({ ...args, prompt });
}
async function visionCompareTool(args) {
  const first = resolveImageFile(args.path || args.first); if (first.error) return first;
  const second = resolveImageFile(args.path2 || args.second); if (second.error) return second;
  const prompt = args.prompt || 'Сравни два изображения. Назови видимые изменения, регрессии интерфейса и совпадающие элементы.';
  return await openRouterVision([first, second], prompt, args.model);
}
function pollinationsImageUrl(prompt, args = {}) {
  const base = `https://gen.pollinations.ai/image/${encodeURIComponent(String(prompt))}`;
  const params = new URLSearchParams();
  if (args.model) params.set('model', String(args.model));
  if (args.width) params.set('width', String(Math.min(Math.max(Number(args.width), 128), 2048)));
  if (args.height) params.set('height', String(Math.min(Math.max(Number(args.height), 128), 2048)));
  if (args.seed !== undefined) params.set('seed', String(args.seed));
  if (args.enhance) params.set('enhance', 'true');
  if (args.safe !== false) params.set('safe', 'true');
  if (CONFIG.pollinationsApiKey) params.set('key', CONFIG.pollinationsApiKey);
  return params.toString() ? `${base}?${params}` : base;
}
function pollinationsGenerateTool(args) {
  const prompt = String(args.prompt || '').trim(); if (!prompt) return { error: 'Для pollinations_generate нужен prompt.' };
  const target = mcpPathOrError(args.path || args.output || `generated/pollinations-${Date.now()}.jpg`, 'path');
  if (target.error) return target;
  if (fs.existsSync(target.path) && !args.overwrite) return { error: 'Файл уже существует. Передай overwrite:true.' };
  const url = pollinationsImageUrl(prompt, args);
  try {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    execFileSync(curlPath(), ['-L', '--fail', '--max-time', '120', ...(CONFIG.proxy ? ['-x', CONFIG.proxy] : []), '-o', target.path, url], { timeout: 125000, stdio: ['ignore', 'pipe', 'pipe'] });
    const image = resolveImageFile(target.path);
    return image.error ? { success: true, path: target.path, url, size: fs.statSync(target.path).size } : { success: true, path: target.path, url, size: image.stat.size, mime: image.mime, dimensions: image.dimensions };
  } catch (e) { return { error: 'Ошибка генерации изображения: ' + (e.stderr || e.message || '').toString().slice(0, 500) }; }
}
async function pollinationsModelsTool() {
  try {
    const raw = execFileSync(curlPath(), ['-L', '-s', '--fail', '--connect-timeout', '8', '--max-time', '20', ...curlProxyArgs(), 'https://gen.pollinations.ai/image/models'], { encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
    try { return { models: JSON.parse(raw) }; }
    catch { return { raw: raw.slice(0, 1000) }; }
  } catch (e) { return { error: 'Ошибка получения моделей изображений: ' + (e.stderr || e.message || '').toString().slice(0, 500) }; }
}



// ═══════════════════════════════════════════════════════════════════
//  LOCAL SELF-EXTENDING CUSTOM TOOLS
//  Each plugin lives under .zen-agent/custom-tools in the active workspace.
// ═══════════════════════════════════════════════════════════════════
function customToolDirectory() {
  const dir = path.join(WORKSPACE_ROOT, '.zen-agent', 'custom-tools');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function customToolRegistryPath() { return path.join(customToolDirectory(), 'registry.json'); }
function safeCustomToolName(name) {
  const value = String(name || '').trim();
  return /^[a-z][a-z0-9_]{2,48}$/i.test(value) ? value : null;
}
function readCustomToolRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(customToolRegistryPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function writeCustomToolRegistry(registry) {
  fs.writeFileSync(customToolRegistryPath(), JSON.stringify(registry, null, 2), 'utf8');
}
function customToolListTool() {
  const registry = readCustomToolRegistry();
  return { directory: customToolDirectory(), tools: Object.values(registry) };
}
function customToolCreateTool(args) {
  const name = safeCustomToolName(args.name);
  if (!name) return { error: 'Имя custom tool: 3–48 символов, латиница/цифры/_, начинается с буквы.' };
  const description = String(args.description || '').trim();
  const code = String(args.code || '');
  if (!description || !code.trim()) return { error: 'Для custom_tool_create нужны description и code.' };
  if (code.length > 60000) return { error: 'Код custom tool больше 60 000 символов.' };
  // Plugin gets only api; direct process/require escapes are rejected before storage.
  if (/\brequire\s*\(|\bprocess\b|child_process|\bimport\s*\(|\beval\s*\(|\bFunction\s*\(/.test(code)) {
    return { error: 'Custom tool не может использовать require/process/import/eval. Используй переданный api.readText/api.writeText/api.list/api.httpGet.' };
  }
  const registry = readCustomToolRegistry();
  if (registry[name] && !args.overwrite) return { error: `Custom tool '${name}' уже существует. Передай overwrite:true для замены.` };
  const file = path.join(customToolDirectory(), `${name}.js`);
  try {
    fs.writeFileSync(file, code, 'utf8');
    registry[name] = {
      name,
      description,
      file,
      parameters: args.parameters && typeof args.parameters === 'object' ? args.parameters : {},
      createdAt: registry[name]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeCustomToolRegistry(registry);
    return { success: true, name, file, directory: customToolDirectory(), message: 'Custom tool создан и подключён. Запускай через custom_tool_run.' };
  } catch (e) { return { error: 'Не удалось создать custom tool: ' + e.message }; }
}
function customToolInspectTool(args) {
  const name = safeCustomToolName(args.name); if (!name) return { error: 'Укажи name.' };
  const item = readCustomToolRegistry()[name]; if (!item) return { error: `Custom tool '${name}' не найден.` };
  try { return { ...item, code: fs.readFileSync(item.file, 'utf8') }; }
  catch (e) { return { error: 'Не удалось прочитать plugin: ' + e.message }; }
}
function customToolDeleteTool(args) {
  const name = safeCustomToolName(args.name); if (!name) return { error: 'Укажи name.' };
  const registry = readCustomToolRegistry(); const item = registry[name];
  if (!item) return { error: `Custom tool '${name}' не найден.` };
  try { fs.unlinkSync(item.file); } catch {}
  delete registry[name]; writeCustomToolRegistry(registry);
  return { success: true, name, directory: customToolDirectory() };
}
function customToolApi() {
  return Object.freeze({
    workspace: WORKSPACE_ROOT,
    async readText(relativePath) {
      const target = mcpPathOrError(relativePath, 'path', true);
      if (target.error) throw new Error(target.error);
      const stat = fs.statSync(target.path); if (stat.size > 1024 * 1024) throw new Error('readText limit: 1 MiB');
      return fs.readFileSync(target.path, 'utf8');
    },
    async writeText(relativePath, text) {
      const target = mcpPathOrError(relativePath, 'path');
      if (target.error) throw new Error(target.error);
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      fs.writeFileSync(target.path, String(text), 'utf8');
      return { path: target.path, bytes: Buffer.byteLength(String(text), 'utf8') };
    },
    async list(relativePath = '.') {
      const target = mcpPathOrError(relativePath, 'path', true, true);
      if (target.error) throw new Error(target.error);
      return fs.readdirSync(target.path, { withFileTypes: true }).map(x => ({ name: x.name, type: x.isDirectory() ? 'directory' : 'file' }));
    },
    async httpGet(url) {
      const result = await httpRequestTool({ url, method: 'GET', timeout: 15000 });
      if (result.error) throw new Error(result.error);
      return result;
    },
    async imageInfo(relativePath) {
      const result = imageInfoTool({ path: relativePath });
      if (result.error) throw new Error(result.error);
      return result;
    }
  });
}
async function customToolRunTool(args) {
  const name = safeCustomToolName(args.name); if (!name) return { error: 'Укажи name.' };
  const item = readCustomToolRegistry()[name]; if (!item) return { error: `Custom tool '${name}' не найден. Сначала custom_tool_list или custom_tool_create.` };
  let source;
  try { source = fs.readFileSync(item.file, 'utf8'); } catch (e) { return { error: 'Не удалось загрузить custom tool: ' + e.message }; }
  const logs = [];
  const sandbox = {
    module: { exports: {} }, exports: {},
    console: Object.freeze({ log: (...parts) => logs.push(parts.map(String).join(' ')) }),
    JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Promise,
    setTimeout, clearTimeout
  };
  try {
    vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(`"use strict";\n${source}`, { filename: item.file }).runInContext(sandbox, { timeout: 1000 });
    const plugin = sandbox.module.exports?.default || sandbox.module.exports;
    if (typeof plugin !== 'function') return { error: 'Custom tool должен экспортировать async function(args, api): module.exports = async (args, api) => ({...});' };
    let timeoutId = null;
    const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('Custom tool timeout (15s)')), 15000); timeoutId.unref?.(); });
    const result = await Promise.race([Promise.resolve(plugin(args.tool_args || args.args || {}, customToolApi())), timeout]);
    if (timeoutId) clearTimeout(timeoutId);
    return { success: true, name, result, logs, file: item.file };
  } catch (e) { return { error: `Custom tool '${name}' failed: ${e.message || e}`, logs, file: item.file }; }
}



// ═══════════════════════════════════════════════════════════════════
//  LIFECYCLE PLUGINS — OpenCode-inspired hooks in a single-file agent
// ═══════════════════════════════════════════════════════════════════
function pluginDirectory() { const dir = path.join(WORKSPACE_ROOT, '.zen-agent', 'plugins'); fs.mkdirSync(dir, { recursive: true }); return dir; }
function pluginRegistryPath() { return path.join(pluginDirectory(), 'registry.json'); }
function safePluginName(name) { const value = String(name || '').trim(); return /^[a-z][a-z0-9_-]{2,48}$/i.test(value) ? value : null; }
function readPluginRegistry() { try { const x = JSON.parse(fs.readFileSync(pluginRegistryPath(), 'utf8')); return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; } catch { return {}; } }
function writePluginRegistry(registry) { fs.writeFileSync(pluginRegistryPath(), JSON.stringify(registry, null, 2), 'utf8'); }
function pluginListTool() { const registry = readPluginRegistry(); return { directory: pluginDirectory(), plugins: Object.values(registry) }; }
function pluginCreateTool(args) {
  const name = safePluginName(args.name); if (!name) return { error: 'Имя plugin: 3–48 символов, латиница/цифры/_/-, начинается с буквы.' };
  const description = String(args.description || '').trim(); const code = String(args.code || '');
  if (!description || !code.trim()) return { error: 'Для plugin_create нужны description и code.' };
  if (code.length > 80000) return { error: 'Код plugin больше 80 000 символов.' };
  if (/\brequire\s*\(|\bprocess\b|child_process|\bimport\s*\(|\beval\s*\(|\bFunction\s*\(/.test(code)) return { error: 'Plugin не может использовать require/process/import/eval. Используй api из plugin context.' };
  const registry = readPluginRegistry(); if (registry[name] && !args.overwrite) return { error: `Plugin '${name}' уже существует. Передай overwrite:true для замены.` };
  const file = path.join(pluginDirectory(), `${name}.js`);
  try {
    fs.writeFileSync(file, code, 'utf8');
    registry[name] = { name, description, file, enabled: args.enabled !== false, createdAt: registry[name]?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    writePluginRegistry(registry); return { success: true, plugin: registry[name], directory: pluginDirectory(), message: 'Plugin создан и автоматически подключается в следующем lifecycle event.' };
  } catch (e) { return { error: 'Не удалось создать plugin: ' + e.message }; }
}
function pluginInspectTool(args) { const name = safePluginName(args.name); if (!name) return { error: 'Укажи name.' }; const item = readPluginRegistry()[name]; if (!item) return { error: `Plugin '${name}' не найден.` }; try { return { ...item, code: fs.readFileSync(item.file, 'utf8') }; } catch (e) { return { error: e.message }; } }
function pluginDeleteTool(args) { const name = safePluginName(args.name); if (!name) return { error: 'Укажи name.' }; const registry = readPluginRegistry(); const item = registry[name]; if (!item) return { error: `Plugin '${name}' не найден.` }; try { fs.unlinkSync(item.file); } catch {} delete registry[name]; writePluginRegistry(registry); return { success: true, name }; }
function pluginApi() {
  const api = customToolApi();
  return Object.freeze({ ...api, emit: (event, data = {}) => auditEvent(`plugin_event:${event}`, { data }) });
}
function loadPlugins() {
  const registry = readPluginRegistry(); const loaded = [];
  for (const item of Object.values(registry)) {
    if (!item.enabled) continue;
    try {
      const source = fs.readFileSync(item.file, 'utf8');
      const sandbox = { module: { exports: {} }, exports: {}, console: Object.freeze({ log: () => {} }), JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Promise };
      vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
      new vm.Script(`"use strict";\n${source}`, { filename: item.file }).runInContext(sandbox, { timeout: 1000 });
      const factory = sandbox.module.exports?.default || sandbox.module.exports;
      if (typeof factory !== 'function') throw new Error('Plugin must export function(context) => hooks');
      const descriptor = factory(Object.freeze({ name: item.name, workspace: WORKSPACE_ROOT, api: pluginApi() }));
      if (descriptor && typeof descriptor.then === 'function') throw new Error('Plugin factory must be synchronous; hooks may be async.');
      if (!descriptor || typeof descriptor !== 'object') throw new Error('Plugin factory must return object.');
      loaded.push({ item, descriptor });
    } catch (e) { auditEvent('plugin_load_error', { plugin: item.name, error: String(e.message || e) }); }
  }
  return loaded;
}
async function pluginHook(hook, payload) {
  let current = payload;
  for (const { item, descriptor } of loadPlugins()) {
    const fn = descriptor[hook] || descriptor.hooks?.[hook];
    if (typeof fn !== 'function') continue;
    try {
      const timeout = new Promise((_, reject) => { const id = setTimeout(() => reject(new Error('plugin hook timeout')), 5000); id.unref?.(); });
      const result = await Promise.race([Promise.resolve(fn(current, pluginApi())), timeout]);
      if (result && typeof result === 'object') current = { ...current, ...result };
      auditEvent('plugin_hook', { plugin: item.name, hook });
    } catch (e) { auditEvent('plugin_hook_error', { plugin: item.name, hook, error: String(e.message || e) }); }
  }
  return current;
}
function pluginSystemPrompts() {
  return loadPlugins().map(({ descriptor }) => descriptor.systemPrompt).filter(value => typeof value === 'string' && value.trim()).join('\n\n');
}
async function pluginPermission(call) {
  let decision = null;
  for (const { item, descriptor } of loadPlugins()) {
    const fn = descriptor.permission || descriptor.hooks?.permission;
    if (typeof fn !== 'function') continue;
    try {
      const result = await Promise.resolve(fn(call, pluginApi()));
      if (['allow', 'ask', 'deny'].includes(result)) { decision = result; auditEvent('plugin_permission', { plugin: item.name, tool: call.name, decision }); }
    } catch (e) { auditEvent('plugin_permission_error', { plugin: item.name, error: String(e.message || e) }); }
  }
  return decision;
}
function pluginToolListTool() {
  const tools = [];
  for (const { item, descriptor } of loadPlugins()) {
    for (const [name, tool] of Object.entries(descriptor.tools || {})) if (tool && typeof tool.run === 'function') tools.push({ plugin: item.name, name, description: tool.description || '' });
  }
  return { directory: pluginDirectory(), tools };
}
async function pluginToolRunTool(args) {
  const pluginName = safePluginName(args.plugin); const toolName = safeCustomToolName(args.name || args.tool);
  if (!pluginName || !toolName) return { error: 'Нужны plugin и name/tool.' };
  const plugin = loadPlugins().find(x => x.item.name === pluginName);
  if (!plugin) return { error: `Plugin '${pluginName}' не найден/выключен.` };
  const tool = plugin.descriptor.tools?.[toolName]; if (!tool || typeof tool.run !== 'function') return { error: `Tool '${toolName}' в plugin '${pluginName}' не найден.` };
  try {
    const timeout = new Promise((_, reject) => { const id = setTimeout(() => reject(new Error('plugin tool timeout (15s)')), 15000); id.unref?.(); });
    const result = await Promise.race([Promise.resolve(tool.run(args.tool_args || args.args || {}, pluginApi())), timeout]);
    return { success: true, plugin: pluginName, tool: toolName, result };
  } catch (e) { return { error: `Plugin tool failed: ${e.message || e}` }; }
}
function pluginProviderListTool() {
  const providers = [];
  for (const { item, descriptor } of loadPlugins()) {
    for (const [id, provider] of Object.entries(descriptor.providers || {})) if (provider && typeof provider === 'object') providers.push({ plugin: item.name, id, description: provider.description || '', endpoint: provider.endpoint || '', apiKeyEnv: provider.apiKeyEnv || '' });
  }
  return { providers };
}
function findPluginProvider(id) {
  return pluginProviderListTool().providers.find(provider => provider.id === id) || null;
}

async function callPluginProvider(messages, model, provider) {
  const endpoint = String(provider.endpoint || '').trim();
  const apiKeyEnv = String(provider.apiKeyEnv || '').trim();
  if (!endpoint.startsWith('https://')) throw new Error(`Plugin provider '${provider.id}' requires HTTPS endpoint.`);
  if (!apiKeyEnv || !process.env[apiKeyEnv]) throw new Error(`Plugin provider '${provider.id}' needs environment variable ${apiKeyEnv}.`);
  const url = new URL(endpoint);
  const payload = JSON.stringify({ model: model || provider.defaultModel, messages, tools: buildNativeToolDefinitions(), tool_choice: 'auto', max_tokens: CONFIG.maxTokens, temperature: CONFIG.temperature, stream: false });
  return await new Promise((resolve, reject) => {
    const req = https.request({ hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'POST', timeout: 90000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${process.env[apiKeyEnv]}` } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => {
        let json; try { json = JSON.parse(body); } catch { reject(new Error(`Plugin provider returned non-JSON: ${body.slice(0, 300)}`)); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`Plugin provider HTTP ${res.statusCode}: ${json.error?.message || body.slice(0, 300)}`)); return; }
        const msg = json.choices?.[0]?.message || {}; const text = Array.isArray(msg.content) ? msg.content.map(x => x.text || '').join('') : (msg.content || '');
        resolve({ text, toolCalls: msg.tool_calls || [], model: json.model || model || provider.defaultModel, usage: json.usage || {}, outputShown: false, provider: provider.id });
      });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Plugin provider timeout'))); req.write(payload); req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════
//  SUBAGENTS — isolated role prompts and separate short-lived contexts
// ═══════════════════════════════════════════════════════════════════
const BUILTIN_SUBAGENTS = {
  explore: { description: 'Read-only исследователь: анализирует структуру, логи и риски, не предлагает изменений как выполненные.', mode: 'explore' },
  general: { description: 'Независимый аналитик: даёт второе мнение, проверяет план и крайние случаи.', mode: 'plan' },
  reviewer: { description: 'Ревьюер: ищет ошибки, риски безопасности и недостающие проверки.', mode: 'plan' }
};
function subagentDirectory() { const dir = path.join(WORKSPACE_ROOT, '.zen-agent', 'subagents'); fs.mkdirSync(dir, { recursive: true }); return dir; }
function subagentRegistryPath() { return path.join(subagentDirectory(), 'registry.json'); }
function safeSubagentName(name) { const value = String(name || '').trim(); return /^[a-z][a-z0-9_-]{2,48}$/i.test(value) ? value : null; }
function readSubagentRegistry() { try { const x = JSON.parse(fs.readFileSync(subagentRegistryPath(), 'utf8')); return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; } catch { return {}; } }
function writeSubagentRegistry(registry) { fs.writeFileSync(subagentRegistryPath(), JSON.stringify(registry, null, 2), 'utf8'); }
function subagentListTool() { const custom = readSubagentRegistry(); return { directory: subagentDirectory(), builtins: BUILTIN_SUBAGENTS, custom: Object.values(custom) }; }
function subagentCreateTool(args) {
  const name = safeSubagentName(args.name); if (!name) return { error: 'Имя subagent: 3–48 символов, латиница/цифры/_/-, начинается с буквы.' };
  const prompt = String(args.prompt || '').trim(); const description = String(args.description || '').trim();
  if (!prompt || !description) return { error: 'Для subagent_create нужны description и prompt.' };
  const mode = ['build', 'plan', 'explore'].includes(args.mode) ? args.mode : 'plan';
  const registry = readSubagentRegistry();
  if (registry[name] && !args.overwrite) return { error: `Subagent '${name}' уже существует. Передай overwrite:true для замены.` };
  registry[name] = { name, description, prompt, mode, model: args.model || null, createdAt: registry[name]?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  writeSubagentRegistry(registry); return { success: true, agent: registry[name], directory: subagentDirectory() };
}
function subagentDeleteTool(args) {
  const name = safeSubagentName(args.name); if (!name) return { error: 'Укажи name.' };
  const registry = readSubagentRegistry(); if (!registry[name]) return { error: `Custom subagent '${name}' не найден.` };
  delete registry[name]; writeSubagentRegistry(registry); return { success: true, name };
}
function resolveSubagent(name) { return BUILTIN_SUBAGENTS[name] ? { name, ...BUILTIN_SUBAGENTS[name], builtin: true } : readSubagentRegistry()[name] || null; }
// ── Subagent engine: параллельные субагенты, автосмена модели, фон ─────────
// Главный агент — это текущий agentLoop (он ведёт диалог с пользователем и сам
// выполняет инструменты). Он может делегировать подзадачи субагентам: один или
// несколько сразу (subagent_batch), синхронно или в фоне (subagent_background),
// а результаты — проверять (subagent_status). Каждый субагент при сбое модели
// автоматически переключается на следующую модель провайдера.
const SUBAGENT_JOBS = new Map(); // фоновые задачи: id -> {status,result,...}

function subagentSystemFor(agent, task) {
  return [
    'Ты — изолированный субагент. Не выполняй изменения и не утверждай, что что-то изменил.',
    `Роль: ${agent.description}`,
    `Режим: ${agent.mode}.`,
    agent.prompt || '',
    `Рабочая папка: ${WORKSPACE_ROOT}.`,
    'Дай краткий проверяемый отчёт: факты, неопределённости, следующий безопасный шаг.'
  ].join('\n');
}
// Единый вызов модели субагента с автосменой модели при сбое/лимите/ошибке.
async function subagentCallWithFailover(messages, requestedModel, provider = currentProvider) {
  const cat = await listModelsForProvider(provider).catch(() => ({ free: [], paid: [] }));
  const seen = new Set();
  const candidates = [];
  const push = m => { if (m && !seen.has(m)) { seen.add(m); candidates.push(m); } };
  push(requestedModel);
  for (const m of [...cat.free, ...cat.paid]) push(m.id);
  // запасной список моделей, если каталог пуст/недоступен
  if (candidates.length === 0) {
    if (provider === 'zen') ZEN_MODELS.forEach(m => push(m.id));
    else if (provider === 'openrouter') openRouterFreeModels.forEach(m => push(m.id));
  }
  const tries = candidates.slice(0, 6);
  let lastErr = null;
  for (const cand of tries) {
    try {
      let result;
      if (provider === 'openrouter') result = await callOpenRouter(messages, cand);
      else if (provider === 'github' || provider === 'huggingface') result = await callCompatibleProvider(provider, messages, cand);
      else result = await callZenDirect(messages, cand, false);
      return { result, usedModel: cand };
    } catch (e) {
      lastErr = e;
      console.log(c(`   ⚠️ Субагент на модели ${cand}: ${providerErrorSummary(e)}. Пробую следующую...`, 'yellow'));
    }
  }
  throw lastErr || new Error('Субагент: ни одна модель провайдера не ответила');
}
async function runSubagent(agent, task, requestedModel) {
  const messages = [
    { role: 'system', content: subagentSystemFor(agent, task) },
    { role: 'user', content: task }
  ];
  const model = requestedModel || agent.model || currentModel;
  const { result, usedModel } = await subagentCallWithFailover(messages, model);
  return { success: true, agent: agent.name, model: usedModel || result.model, output: result.text || '', usage: result.usage || {}, mode: agent.mode };
}
async function subagentTaskTool(args) {
  const name = String(args.agent || args.name || 'explore'); const agent = resolveSubagent(name);
  if (!agent) return { error: `Subagent '${name}' не найден. Используй subagent_list.` };
  const task = String(args.prompt || args.task || '').trim(); if (!task) return { error: 'Для subagent_task нужен prompt или task.' };
  try {
    return await runSubagent(agent, task, args.model);
  } catch (e) { return { error: `Subagent '${name}' failed: ${e.message || e}` }; }
}
// Запуск нескольких субагентов параллельно (разные модели можно задать каждому).
async function subagentBatchTool(args) {
  const specs = Array.isArray(args.agents) ? args.agents : [];
  if (!specs.length) return { error: 'Для subagent_batch нужен agents: [{agent, prompt, model?}, ...].' };
  const tasks = specs.map((s, i) => {
    const agent = resolveSubagent(String(s.agent || s.name || 'explore'));
    if (!agent) return Promise.resolve({ index: i, success: false, error: `Subagent '${s.agent || s.name}' не найден.` });
    const task = String(s.prompt || s.task || '').trim();
    if (!task) return Promise.resolve({ index: i, success: false, error: 'нет prompt у задачи.' });
    return runSubagent(agent, task, s.model)
      .then(r => ({ index: i, ...r }))
      .catch(e => ({ index: i, success: false, error: e.message || String(e) }));
  });
  const results = await Promise.allSettled(tasks).then(rs => rs.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message || 'failed' }));
  results.sort((a, b) => a.index - b.index);
  return { success: true, parallel: true, total: results.length, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, tasks: results };
}
// Фоновый субагент: возвращает id сразу, результат копится в SUBAGENT_JOBS.
function subagentBackgroundTool(args) {
  const agent = resolveSubagent(String(args.agent || args.name || 'explore'));
  if (!agent) return { error: 'Subagent не найден. Используй subagent_list.' };
  const task = String(args.prompt || args.task || '').trim(); if (!task) return { error: 'Для фоновой задачи нужен prompt.' };
  const id = 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  SUBAGENT_JOBS.set(id, { id, agent: agent.name, task, status: 'running', model: args.model || agent.model || null, createdAt: new Date().toISOString(), finishedAt: null, result: null });
  setImmediate(() => {
    runSubagent(agent, task, args.model)
      .then(r => { const j = SUBAGENT_JOBS.get(id); if (!j) return; j.status = r.success ? 'done' : 'failed'; j.result = r; j.finishedAt = new Date().toISOString(); })
      .catch(e => { const j = SUBAGENT_JOBS.get(id); if (!j) return; j.status = 'failed'; j.result = { success: false, error: e.message || String(e) }; j.finishedAt = new Date().toISOString(); });
  });
  return { success: true, id, status: 'running', agent: agent.name, note: 'Результат проверяй через subagent_status.' };
}
function subagentStatusTool(args) {
  const id = String(args.id || '').trim();
  if (id === 'all') return { success: true, jobs: [...SUBAGENT_JOBS.values()] };
  const j = SUBAGENT_JOBS.get(id);
  if (!j) return { error: 'Фоновая задача не найдена: ' + id };
  return { success: true, id: j.id, agent: j.agent, status: j.status, running: j.status === 'running', createdAt: j.createdAt, finishedAt: j.finishedAt, result: j.result || null };
}
function subagentJobsCleanup() {
  for (const id of SUBAGENT_JOBS.keys()) {
    const j = SUBAGENT_JOBS.get(id);
    if (j && j.status !== 'running') SUBAGENT_JOBS.delete(id);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  LOCAL AGENT RUNTIME: terminal sessions, SQLite, monitors, .env
// ═══════════════════════════════════════════════════════════════════
const TERMINAL_SESSIONS = new Map();
const PROCESS_MONITORS = new Map();

function appendTerminalOutput(session, stream, chunk) {
  const text = chunk.toString('utf8');
  session.output += text;
  const max = 2 * 1024 * 1024;
  if (session.output.length > max) {
    const removed = session.output.length - max;
    session.output = session.output.slice(removed);
    session.baseCursor += removed;
    if (session.readCursor < session.baseCursor) session.readCursor = session.baseCursor;
  }
  if (session.live) printLiveCommandChunk(`terminal:${session.id}:${stream}`, chunk);
}
function terminalCreateTool(args) {
  const cwd = mcpPathOrError(args.cwd || '.', 'cwd', true, true);
  if (cwd.error) return cwd;
  const id = safeProcessName(args.id || `term-${crypto.randomBytes(4).toString('hex')}`);
  if (!id) return { error: 'Некорректный id терминала.' };
  if (TERMINAL_SESSIONS.has(id)) return { error: `Терминал '${id}' уже существует.` };
  const isWin = process.platform === 'win32';
  const executable = args.shell || (isWin ? 'powershell.exe' : (process.env.SHELL || 'sh'));
  const shellArgs = isWin ? ['-NoLogo', '-NoExit'] : ['-i'];
  try {
    const proc = spawn(executable, shellArgs, { cwd: cwd.path, env: commandEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const session = { id, proc, cwd: cwd.path, createdAt: new Date().toISOString(), output: '', baseCursor: 0, readCursor: 0, live: !!args.__cliLive, closed: false };
    TERMINAL_SESSIONS.set(id, session);
    proc.stdout.on('data', chunk => appendTerminalOutput(session, 'stdout', chunk));
    proc.stderr.on('data', chunk => appendTerminalOutput(session, 'stderr', chunk));
    proc.on('close', (code, signal) => { session.closed = true; session.exit = { code, signal, at: new Date().toISOString() }; });
    proc.on('error', err => { session.closed = true; session.error = err.message; });
    if (args.initial_command) proc.stdin.write(String(args.initial_command) + '\n');
    return { success: true, id, cwd: cwd.path, shell: executable, note: 'Постоянная shell-сессия создана. Используй terminal_write и terminal_read.' };
  } catch (e) { return { error: 'Не удалось создать терминал: ' + e.message }; }
}
function terminalWriteTool(args) {
  const id = String(args.id || ''); const session = TERMINAL_SESSIONS.get(id);
  if (!session) return { error: `Терминал '${id}' не найден.` };
  if (session.closed || !session.proc.stdin.writable) return { error: `Терминал '${id}' уже закрыт.` };
  const input = String(args.input ?? args.command ?? '');
  if (!input) return { error: 'Для terminal_write нужен input или command.' };
  try { session.proc.stdin.write(input + (args.newline === false ? '' : '\n')); return { success: true, id, bytes: Buffer.byteLength(input, 'utf8') }; }
  catch (e) { return { error: 'Не удалось отправить текст в терминал: ' + e.message }; }
}
function terminalReadTool(args) {
  const id = String(args.id || ''); const session = TERMINAL_SESSIONS.get(id);
  if (!session) return { error: `Терминал '${id}' не найден.` };
  const requested = args.cursor === undefined ? session.readCursor : Number(args.cursor);
  const cursor = Number.isFinite(requested) ? Math.max(requested, session.baseCursor) : session.readCursor;
  const offset = cursor - session.baseCursor;
  const content = session.output.slice(Math.max(0, offset));
  const nextCursor = session.baseCursor + session.output.length;
  if (args.cursor === undefined) session.readCursor = nextCursor;
  return { id, cwd: session.cwd, closed: session.closed, exit: session.exit || null, error: session.error || null, cursor, nextCursor, content };
}
function terminalListTool() {
  return { sessions: [...TERMINAL_SESSIONS.values()].map(s => ({ id: s.id, cwd: s.cwd, createdAt: s.createdAt, closed: s.closed, exit: s.exit || null, error: s.error || null })) };
}
function terminalCloseTool(args) {
  const id = String(args.id || ''); const session = TERMINAL_SESSIONS.get(id);
  if (!session) return { error: `Терминал '${id}' не найден.` };
  try {
    if (!session.closed) {
      // Interactive shells могут игнорировать SIGTERM; сначала просим штатно выйти,
      // затем гарантированно завершаем только этот дочерний процесс.
      try { session.proc.stdin.write('exit\n'); session.proc.stdin.end(); } catch {}
      try { session.proc.kill(args.force ? 'SIGKILL' : 'SIGTERM'); } catch {}
      const forceTimer = setTimeout(() => { try { if (!session.closed) session.proc.kill('SIGKILL'); } catch {} }, 500);
      forceTimer.unref();
      try { session.proc.stdout.destroy(); session.proc.stderr.destroy(); } catch {}
    }
  } catch (e) { return { error: 'Не удалось закрыть терминал: ' + e.message }; }
  TERMINAL_SESSIONS.delete(id);
  return { success: true, id, message: 'Терминальная сессия закрыта.' };
}

function sqliteAvailable() {
  try { return { available: true, version: execFileSync('sqlite3', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim() }; }
  catch { return { available: false, hint: 'Установи локально: pkg install sqlite' }; }
}
function sqliteQueryTool(args) {
  const database = mcpPathOrError(args.database || args.path, 'database');
  if (database.error) return database;
  const sql = String(args.sql || args.query || '').trim();
  if (!sql) return { error: 'Для sqlite_query нужен sql.' };
  const available = sqliteAvailable(); if (!available.available) return { error: 'sqlite3 недоступен.', ...available };
  try {
    fs.mkdirSync(path.dirname(database.path), { recursive: true });
    const output = execFileSync('sqlite3', ['-json', database.path, sql], { encoding: 'utf8', timeout: safeCommandTimeout(args.timeout, 30000), maxBuffer: 10 * 1024 * 1024 });
    let rows = null; try { rows = output.trim() ? JSON.parse(output) : []; } catch {}
    return { success: true, database: database.path, rows, output: rows === null ? output : undefined };
  } catch (e) { return { error: 'SQLite error: ' + (e.stderr || e.message || '').toString() }; }
}
function sqliteSchemaTool(args) {
  return sqliteQueryTool({ ...args, sql: "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index','view','trigger') ORDER BY type, name;" });
}
function sqliteBackupTool(args) {
  const source = mcpPathOrError(args.database || args.path, 'database', true);
  if (source.error) return source;
  const destination = mcpPathOrError(args.destination || args.output, 'destination');
  if (destination.error) return destination;
  const available = sqliteAvailable(); if (!available.available) return { error: 'sqlite3 недоступен.', ...available };
  if (fs.existsSync(destination.path) && !args.overwrite) return { error: 'Файл backup уже существует. Передай overwrite:true, если уверен.' };
  try {
    fs.mkdirSync(path.dirname(destination.path), { recursive: true });
    execFileSync('sqlite3', [source.path, `.backup '${destination.path.replace(/'/g, "''")}'`], { encoding: 'utf8', timeout: 60000 });
    return { success: true, source: source.path, backup: destination.path, size: fs.statSync(destination.path).size };
  } catch (e) { return { error: 'SQLite backup error: ' + (e.stderr || e.message || '').toString() }; }
}

function envFilePath(args, mustExist = false) {
  const raw = args.path || '.env';
  const resolved = mcpPathOrError(raw, 'path', false);
  if (resolved.error) return resolved;
  try {
    if (fs.existsSync(resolved.path) && fs.statSync(resolved.path).isDirectory()) {
      const envPath = path.join(resolved.path, '.env');
      if (mustExist && !fs.existsSync(envPath)) return { error: 'Файл .env не найден: ' + envPath };
      return { path: envPath };
    }
    if (mustExist && !fs.existsSync(resolved.path)) return { error: 'Файл .env не найден: ' + resolved.path };
  } catch (e) { return { error: 'Не удалось проверить .env: ' + e.message }; }
  return resolved;
}
function parseEnvText(text) {
  const values = []; const lines = String(text || '').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values.push({ key: match[1], value: match[2], line: index + 1 });
  }
  return values;
}
function envListTool(args) {
  const file = envFilePath(args, true); if (file.error) return file;
  try { return { path: file.path, variables: parseEnvText(fs.readFileSync(file.path, 'utf8')).map(x => ({ key: x.key, value: x.value ? '***' : '', line: x.line })) }; }
  catch (e) { return { error: 'Не удалось прочитать .env: ' + e.message }; }
}
function envSetTool(args) {
  const file = envFilePath(args, false); if (file.error) return file;
  const key = String(args.key || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { error: 'Некорректное имя переменной окружения.' };
  if (key === 'OPENROUTER_API_KEY') return { error: 'OpenRouter key хранится только через /key, не в .env проекта.' };
  if (args.value === undefined) return { error: 'Для env_set нужен value.' };
  const value = String(args.value).replace(/[\r\n]/g, '');
  try {
    let text = fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8') : '';
    const rx = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=).*$`, 'm');
    text = rx.test(text) ? text.replace(rx, `$1${value}`) : text + (text && !text.endsWith('\n') ? '\n' : '') + `${key}=${value}\n`;
    fs.mkdirSync(path.dirname(file.path), { recursive: true }); fs.writeFileSync(file.path, text, 'utf8');
    return { success: true, path: file.path, key, value: '***' };
  } catch (e) { return { error: 'Не удалось записать .env: ' + e.message }; }
}
function envDeleteTool(args) {
  const file = envFilePath(args, true); if (file.error) return file;
  const key = String(args.key || '').trim(); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { error: 'Некорректное имя переменной.' };
  try {
    const lines = fs.readFileSync(file.path, 'utf8').split('\n');
    const filtered = lines.filter(line => !new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(line));
    fs.writeFileSync(file.path, filtered.join('\n'), 'utf8'); return { success: true, path: file.path, key };
  } catch (e) { return { error: 'Не удалось удалить переменную: ' + e.message }; }
}

function monitorLogPath(id) { const dir = path.join(WORKSPACE_ROOT, '.zen-agent', 'monitors'); fs.mkdirSync(dir, { recursive: true }); return path.join(dir, `${id}.log`); }
function writeMonitorLog(monitor, text) { const line = `[${new Date().toISOString()}] ${text}\n`; try { fs.appendFileSync(monitor.logPath, line); } catch {} if (monitor.live) printLiveCommandChunk(`monitor:${monitor.id}`, Buffer.from(line)); }
async function runMonitorCheck(monitor) {
  if (monitor.busy) return; monitor.busy = true;
  try {
    const item = readProcessRegistry()[monitor.processName];
    if (!item) { writeMonitorLog(monitor, `Процесс ${monitor.processName} не зарегистрирован.`); return; }
    let healthy = processIsAlive(item.pid); let detail = healthy ? `PID ${item.pid} работает` : `PID ${item.pid} не работает`;
    if (healthy && monitor.url) {
      const check = await httpRequestTool({ url: monitor.url, timeout: monitor.timeout });
      healthy = !!check.ok; detail = healthy ? `HTTP ${check.status}` : `HTTP ошибка: ${check.error || check.status}`;
    }
    if (!healthy && monitor.restart) {
      writeMonitorLog(monitor, `${detail}; перезапуск разрешён.`);
      if (processIsAlive(item.pid)) stopManagedProcess(monitor.processName, false);
      const started = startManagedProcess({ name: monitor.processName, command: item.command, cwd: item.cwd });
      writeMonitorLog(monitor, started.success ? `Перезапущен PID ${started.pid}` : `Перезапуск не удался: ${started.error}`);
    } else writeMonitorLog(monitor, healthy ? `OK: ${detail}` : `FAIL: ${detail}`);
  } finally { monitor.busy = false; }
}
function monitorStartTool(args) {
  const processName = safeProcessName(args.process_name || args.process || args.name);
  if (!processName) return { error: 'Для monitor_start укажи process_name.' };
  const id = safeProcessName(args.id || processName); if (!id) return { error: 'Некорректный id монитора.' };
  if (PROCESS_MONITORS.has(id)) return { error: `Монитор '${id}' уже запущен.` };
  if (!readProcessRegistry()[processName]) return { error: `Управляемый процесс '${processName}' не найден. Сначала process_start.` };
  const intervalSeconds = boundedInt(args.interval_seconds || args.interval, 15, 3, 3600);
  const monitor = { id, processName, url: args.url || null, restart: args.restart !== false, timeout: boundedInt(args.timeout, 5000, 1000, 30000), intervalSeconds, createdAt: new Date().toISOString(), logPath: monitorLogPath(id), live: !!args.__cliLive, busy: false };
  monitor.timer = setInterval(() => { runMonitorCheck(monitor); }, intervalSeconds * 1000);
  PROCESS_MONITORS.set(id, monitor); runMonitorCheck(monitor);
  return { success: true, id, processName, url: monitor.url, restart: monitor.restart, intervalSeconds, logPath: monitor.logPath };
}
function monitorListTool() { return { monitors: [...PROCESS_MONITORS.values()].map(m => ({ id: m.id, processName: m.processName, url: m.url, restart: m.restart, intervalSeconds: m.intervalSeconds, logPath: m.logPath, createdAt: m.createdAt })) }; }
function monitorLogsTool(args) { const id = String(args.id || args.name || ''); const monitor = PROCESS_MONITORS.get(id); if (!monitor) return { error: `Монитор '${id}' не найден.` }; return { id, path: monitor.logPath, ...tailFile(monitor.logPath, args.lines || 120) }; }
function monitorStopTool(args) { const id = String(args.id || args.name || ''); const monitor = PROCESS_MONITORS.get(id); if (!monitor) return { error: `Монитор '${id}' не найден.` }; clearInterval(monitor.timer); PROCESS_MONITORS.delete(id); writeMonitorLog(monitor, 'Монитор остановлен.'); return { success: true, id }; }

async function handleMCPTool(tool, args = {}) {
  try {
    const location = args.path || args.cwd || args.source || args.destination || args.database || args.repo || '';
    rememberProjectEvent('visited', { tool, path: location });
  } catch {}
  // Защита от «блуждания»: модифицирующие инструменты обязаны работать внутри
  // активной рабочей папки сессии. Пути вне её блокируются с понятным сообщением.
  if (CONFIG.workspaceLock) {
    const pathKeys = ['path', 'cwd', 'source', 'destination', 'archive', 'database', 'backup'];
    const writing = new Set(['write_file', 'append_file', 'edit_file', 'delete_file', 'mkdir', 'copy_file', 'move_file', 'file_backup', 'archive_create', 'archive_extract', 'sqlite_query', 'sqlite_backup']);
    if (writing.has(tool)) {
      for (const key of pathKeys) {
        if (args[key] === undefined || args[key] === null) continue;
        const r = resolveWorkspacePath(args[key], key);
        if (r.error) return r;
        const bc = workspaceBoundaryCheck(r, key);
        if (!bc.ok) {
          console.log(c(`⛔ ${bc.error}`, 'red'));
          return { error: bc.error, workspace: WORKSPACE_ROOT, outsideOf: r.outsideOf };
        }
      }
    }
  }
  switch (tool) {
    case 'workspace_info':
      return workspaceInfo();

    case 'set_workspace':
      return setWorkspaceRoot(args.path || args.workspace);

    case 'project_inspect':
      return inspectProject(args.path || '.');

    case 'project_list':
      return projectListTool();

    case 'project_register':
      return registerProjectTool(args);

    case 'project_use':
      return useProjectTool(args);

    case 'project_remove':
      return removeProjectTool(args);

    case 'project_memory':
      return projectMemoryTool(args);

    case 'onnx_status':
      return await onnxStatusTool();

    case 'onnx_set_model':
      return await onnxSetModelTool(args);

    case 'onnx_memory_list':
      return onnxMemoryListTool();

    case 'onnx_memory_add':
      return onnxMemoryAddTool(args);

    case 'onnx_memory_search':
      return onnxMemorySearchTool(args);

    case 'onnx_run':
      return await onnxRunTool(args);

    case 'termux_info':
      return termuxInfoTool();

    case 'network_check':
      return networkCheckTool();

    case 'tree_dir':
      return treeDirectory(args);

    case 'search_text':
      return searchTextInFiles(args);

    case 'file_info':
      return fileInfoTool(args);

    case 'find_files':
      return findWorkspaceEntries(args.query || args.name || '', args);

    case 'list_dir': {
      const resolved = mcpPathOrError(args.path || '.', 'path', true, true);
      if (resolved.error) return resolved;
      try {
        const items = fs.readdirSync(resolved.path, { withFileTypes: true })
          .map(e => ({ name: e.name, path: path.join(resolved.path, e.name), type: e.isDirectory() ? 'directory' : 'file' }));
        return { workspace: WORKSPACE_ROOT, path: resolved.path, items };
      } catch (e) { return { error: 'Не удалось прочитать папку: ' + e.message }; }
    }

    case 'read_file': {
      const resolved = mcpPathOrError(args.path, 'path', true);
      if (resolved.error) return resolved;
      try {
        const stat = fs.statSync(resolved.path);
        if (!stat.isFile()) return { error: 'Это не файл: ' + resolved.path };
        const maxBytes = Math.min(Math.max(Number(args.max_bytes || 128 * 1024) || 128 * 1024, 1024), 2 * 1024 * 1024);
        const offset = Math.min(Math.max(Number(args.offset || 0) || 0, 0), stat.size);
        const length = Math.min(maxBytes, stat.size - offset);
        const fd = fs.openSync(resolved.path, 'r');
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, offset);
        fs.closeSync(fd);
        return { path: resolved.path, content: buffer.toString('utf8'), offset, bytes: length, size: stat.size, truncated: offset + length < stat.size, nextOffset: offset + length };
      }
      catch (e) { return { error: 'Не удалось прочитать файл: ' + e.message }; }
    }

    case 'write_file': {
      const resolved = mcpPathOrError(args.path, 'path');
      if (resolved.error) return resolved;
      try {
        fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
        const content = args.content === undefined || args.content === null ? '' : String(args.content);
        if (/OPENROUTER_API_KEY\s*=|sk-or-(?:v1-)?[A-Za-z0-9_-]{16,}/i.test(content)) {
          return { error: 'OpenRouter key нельзя записывать в проектный файл или .env. Используй интерфейсную команду /key.' };
        }
        fs.writeFileSync(resolved.path, content, 'utf8');
        return { success: true, path: resolved.path, size: Buffer.byteLength(content, 'utf8'), lines: content.split('\n').length, workspace: WORKSPACE_ROOT };
      } catch (e) { return { error: 'Не удалось записать файл: ' + e.message }; }
    }

    case 'edit_file': {
      const resolved = mcpPathOrError(args.path, 'path', true);
      if (resolved.error) return resolved;
      try {
        let content = fs.readFileSync(resolved.path, 'utf8');
        const op = args.operation || 'replace';
        if (op === 'replace') {
          const oldText = args.old || '';
          if (!oldText) return { error: 'Для replace обязательно передай непустой old.' };
          const at = content.indexOf(oldText);
          if (at < 0) return { error: 'Текст для замены не найден: ' + resolved.path };
          const replacement = args.new === undefined || args.new === null ? '' : String(args.new);
          content = args.replace_all
            ? content.split(oldText).join(replacement)
            : content.slice(0, at) + replacement + content.slice(at + oldText.length);
        } else if (op === 'insert') {
          const lines = content.split('\n');
          lines.splice(parseInt(args.line || '0', 10), 0, args.content || '');
          content = lines.join('\n');
        } else if (op === 'delete_lines') {
          const lines = content.split('\n');
          const range = (args.lines || '').split(',').map(Number);
          for (let i = range.length - 1; i >= 0; i--) if (range[i] >= 0 && range[i] < lines.length) lines.splice(range[i], 1);
          content = lines.join('\n');
        } else if (op === 'append') {
          content += (content.endsWith('\n') ? '' : '\n') + (args.content || '');
        } else return { error: 'Неизвестная операция edit_file: ' + op };
        fs.writeFileSync(resolved.path, content, 'utf8');
        return { success: true, path: resolved.path, workspace: WORKSPACE_ROOT };
      } catch (e) { return { error: 'Edit failed: ' + e.message }; }
    }

    case 'delete_file': {
      const resolved = mcpPathOrError(args.path, 'path', true);
      if (resolved.error) return resolved;
      try {
        if (path.resolve(resolved.path) === path.resolve(WORKSPACE_ROOT)) return { error: 'Нельзя удалить активную рабочую папку целиком.' };
        const stat = fs.statSync(resolved.path);
        if (stat.isDirectory()) fs.rmSync(resolved.path, { recursive: true, force: true });
        else fs.unlinkSync(resolved.path);
        return { success: true, path: resolved.path, workspace: WORKSPACE_ROOT };
      } catch (e) { return { error: 'Delete failed: ' + e.message }; }
    }

    case 'append_file': {
      const resolved = mcpPathOrError(args.path, 'path');
      if (resolved.error) return resolved;
      try {
        fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
        const content = args.content === undefined || args.content === null ? '' : String(args.content);
        if (/OPENROUTER_API_KEY\s*=|sk-or-(?:v1-)?[A-Za-z0-9_-]{16,}/i.test(content)) {
          return { error: 'OpenRouter key нельзя записывать в проектный файл. Используй интерфейсную команду /key.' };
        }
        fs.appendFileSync(resolved.path, content + '\n', 'utf8');
        return { success: true, path: resolved.path, workspace: WORKSPACE_ROOT };
      } catch (e) { return { error: 'Append failed: ' + e.message }; }
    }

    case 'file_backup':
      return backupFile(args);

    case 'file_diff':
      return simpleFileDiff(args);

    case 'mkdir':
      return mkdirTool(args);

    case 'copy_file':
      return copyOrMoveTool(args, false);

    case 'move_file':
      return copyOrMoveTool(args, true);

    case 'archive_create':
      return archiveCreateTool(args);

    case 'archive_extract':
      return archiveExtractTool(args);

    case 'download_file': {
      const resolved = mcpPathOrError(args.path, 'path');
      if (resolved.error) return resolved;
      if (!args.url) return { error: 'Для download_file нужен url.' };
      let downloadUrl;
      try { downloadUrl = new URL(String(args.url)); }
      catch { return { error: 'download_file принимает корректный URL.' }; }
      if (!['http:', 'https:'].includes(downloadUrl.protocol)) return { error: 'download_file поддерживает только http:// и https://.' };
      try {
        fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
        execFileSync(curlPath(), ['-L', '--fail', '--max-time', '60', ...(CONFIG.proxy ? ['-x', CONFIG.proxy] : []), '-o', resolved.path, downloadUrl.toString()], {
          cwd: WORKSPACE_ROOT, timeout: 65000, stdio: ['ignore', 'pipe', 'pipe']
        });
        return { success: true, path: resolved.path, size: fs.statSync(resolved.path).size, workspace: WORKSPACE_ROOT };
      } catch (e) { return { error: 'Не удалось скачать файл: ' + (e.stderr || e.message || '').toString() }; }
    }

    case 'execute_command': {
      const cwdResult = mcpPathOrError(args.cwd || '.', 'cwd', true, true);
      if (cwdResult.error) return cwdResult;
      const runCwd = cwdResult.path;
      if (!args.command || !String(args.command).trim()) return { error: 'Для execute_command нужна command.' };
      const commandText = String(args.command).trim();
      // Фоновый сервер через «&» теряет управляемый PID и делает логи ненадёжными.
      if (/(^|[^&])&\s*$/.test(commandText) || /\bnohup\b|\bdisown\b/.test(commandText)) {
        return { error: 'Не запускай фоновые процессы через execute_command. Используй process_start с name, command и cwd — тогда будут PID, process_logs и безопасный process_stop.' };
      }
      const opts = {
        cwd: runCwd,
        timeout: safeCommandTimeout(args.timeout, 18000),
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          ZEN_WORKSPACE: WORKSPACE_ROOT,
          MCP_WORKSPACE: WORKSPACE_ROOT,
          ...(CONFIG.proxy ? {
            HTTP_PROXY: CONFIG.proxy, HTTPS_PROXY: CONFIG.proxy, ALL_PROXY: CONFIG.proxy,
            http_proxy: CONFIG.proxy, https_proxy: CONFIG.proxy, all_proxy: CONFIG.proxy,
            // Локальный сервер MCP/Node никогда не должен уходить в удалённый прокси.
            NO_PROXY: [process.env.NO_PROXY, 'localhost,127.0.0.1,::1'].filter(Boolean).join(','),
            no_proxy: [process.env.no_proxy, 'localhost,127.0.0.1,::1'].filter(Boolean).join(',')
          } : {})
        }
      };

      // В CLI используем потоковый режим: stdout/stderr видны сразу, а не после спиннера.
      if (args.__cliLive && CONFIG.liveToolLogs) {
        return await runCommandWithLiveLogs(args.command, runCwd, opts);
      }

      const isWin = process.platform === 'win32';
      if (isWin) {
        opts.shell = 'powershell.exe'; opts.encoding = 'utf8';
        const psCmd = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; " + args.command;
        try { const out = execSync(psCmd, opts); return { stdout: out, stderr: '', exit: 0, cwd: runCwd, workspace: WORKSPACE_ROOT, live: false }; }
        catch (e) { return { stdout: (e.stdout || '').toString(), stderr: (e.stderr || e.message || '').toString(), exit: typeof e.status === 'number' ? e.status : 1, cwd: runCwd, workspace: WORKSPACE_ROOT, live: false }; }
      }
      try { const out = execSync(args.command, { ...opts, encoding: 'utf8' }); return { stdout: out, stderr: '', exit: 0, cwd: runCwd, workspace: WORKSPACE_ROOT, live: false }; }
      catch (e) { return { stdout: (e.stdout || '').toString(), stderr: (e.stderr || e.message || '').toString(), exit: typeof e.status === 'number' ? e.status : 1, cwd: runCwd, workspace: WORKSPACE_ROOT, live: false }; }
    }

    case 'process_start':
      return startManagedProcess(args);

    case 'process_status':
      return managedProcessStatus(args.name ? safeProcessName(args.name) || args.name : null);

    case 'process_logs': {
      const name = safeProcessName(args.name);
      if (!name) return { error: 'Для process_logs нужно имя name.' };
      const item = readProcessRegistry()[name];
      if (!item) return { error: `Процесс '${name}' не зарегистрирован.` };
      return await followManagedLog(item, args);
    }

    case 'process_stop':
      return stopManagedProcess(args.name, !!args.force);

    case 'monitor_start':
      return monitorStartTool(args);

    case 'monitor_list':
      return monitorListTool();

    case 'monitor_logs':
      return monitorLogsTool(args);

    case 'monitor_stop':
      return monitorStopTool(args);

    case 'terminal_create':
      return terminalCreateTool(args);

    case 'terminal_write':
      return terminalWriteTool(args);

    case 'terminal_read':
      return terminalReadTool(args);

    case 'terminal_list':
      return terminalListTool();

    case 'terminal_close':
      return terminalCloseTool(args);

    case 'http_request':
    case 'health_check':
      return await httpRequestTool(args);

    case 'websocket_test':
      return await websocketTestTool(args);

    case 'npm_install': {
      const cwdResult = mcpPathOrError(args.cwd || '.', 'cwd', true, true);
      if (cwdResult.error) return cwdResult;
      const packages = safeNpmTokens(args.packages || args.package);
      if (packages.error) return packages;
      const command = `npm install ${packages.tokens.map(shellQuote).join(' ')}`;
      const opts = { cwd: cwdResult.path, timeout: safeCommandTimeout(args.timeout, 120000), env: commandEnvironment() };
      if (args.__cliLive && CONFIG.liveToolLogs) return await runCommandWithLiveLogs(command, cwdResult.path, opts);
      try {
        const out = execSync(command, { ...opts, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
        return { success: true, command, cwd: cwdResult.path, stdout: out, workspace: WORKSPACE_ROOT };
      } catch (e) { return { error: 'npm install failed: ' + (e.stderr || e.message || '').toString() }; }
    }

    case 'npm_run': {
      const cwdResult = mcpPathOrError(args.cwd || '.', 'cwd', true, true);
      if (cwdResult.error) return cwdResult;
      const script = String(args.script || '').trim();
      if (!/^[a-zA-Z0-9:_-]+$/.test(script)) return { error: 'Для npm_run укажи безопасное имя script из package.json.' };
      const extra = args.args ? safeNpmTokens(args.args) : { tokens: [] };
      if (extra.error) return extra;
      const command = `npm run ${shellQuote(script)}${extra.tokens.length ? ' -- ' + extra.tokens.map(shellQuote).join(' ') : ''}`;
      const opts = { cwd: cwdResult.path, timeout: safeCommandTimeout(args.timeout, 120000), env: commandEnvironment() };
      if (args.__cliLive && CONFIG.liveToolLogs) return await runCommandWithLiveLogs(command, cwdResult.path, opts);
      try {
        const out = execSync(command, { ...opts, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
        return { success: true, command, cwd: cwdResult.path, stdout: out, workspace: WORKSPACE_ROOT };
      } catch (e) { return { error: 'npm run failed: ' + (e.stderr || e.message || '').toString() }; }
    }

    case 'sqlite_info':
      return sqliteAvailable();

    case 'sqlite_query':
      return sqliteQueryTool(args);

    case 'sqlite_schema':
      return sqliteSchemaTool(args);

    case 'sqlite_backup':
      return sqliteBackupTool(args);

    case 'env_list':
      return envListTool(args);

    case 'env_set':
      return envSetTool(args);

    case 'env_delete':
      return envDeleteTool(args);

    case 'run_tests':
      return await handleMCPTool('npm_run', { ...args, script: args.script || 'test' });

    case 'run_lint':
      return await handleMCPTool('npm_run', { ...args, script: args.script || 'lint' });

    case 'code_check': {
      const check = codeCheckCommand(args);
      if (check.error) return check;
      return await gitLiveTool(check.command, { path: path.dirname(check.file.path) }, args);
    }

    case 'dependency_audit': {
      const cwdResult = gitCwd(args); if (cwdResult.error) return cwdResult;
      return await gitLiveTool('npm audit --json', cwdResult, args);
    }

    case 'git_status': {
      const cwdResult = gitCwd(args); if (cwdResult.error) return cwdResult;
      return await gitLiveTool('git status --short --branch', cwdResult, args);
    }

    case 'git_diff': {
      const cwdResult = gitCwd(args); if (cwdResult.error) return cwdResult;
      const target = args.path ? safeGitRef(args.path) : null;
      if (args.path && !target) return { error: 'Для git_diff path допускаются только безопасные относительные Git-пути.' };
      return await gitLiveTool(`git diff${args.staged ? ' --staged' : ''}${target ? ' -- ' + shellQuote(target) : ''}`, cwdResult, args);
    }

    case 'git_branch': {
      const cwdResult = gitCwd(args); if (cwdResult.error) return cwdResult;
      return await gitLiveTool('git branch --show-current && git branch --all', cwdResult, args);
    }

    case 'git_log': {
      const cwdResult = gitCwd(args); if (cwdResult.error) return cwdResult;
      const limit = boundedInt(args.limit, 10, 1, 100);
      return await gitLiveTool(`git log --oneline -n ${limit}`, cwdResult, args);
    }

    case 'git_init': {
      const cwdResult = gitCwd(args); if (cwdResult.error) return cwdResult;
      return await gitLiveTool('git init', cwdResult, args);
    }

    case 'git_commit': {
      const cwdResult = gitCwd(args); if (cwdResult.error) return cwdResult;
      const message = String(args.message || '').trim();
      if (!message) return { error: 'Для git_commit нужен message.' };
      return await gitLiveTool(`git add -A && git commit -m ${shellQuote(message)}`, cwdResult, args);
    }

    case 'git_push':
      return await gitPushTool(args);

    case 'github_repo_info':
      return await githubRepoInfoTool(args);

    case 'github_read_file':
      return await githubReadFileTool(args);

    case 'github_list_dir':
      return await githubListDirTool(args);

    case 'github_write_file':
      return await githubWriteFileTool(args);

    case 'github_readme':
      return await githubReadmeTool(args);

    case 'github_commits':
      return await githubCommitsTool(args);

    case 'github_builds':
      return await githubBuildsTool(args);

    case 'github_watch_build':
      return await githubWatchBuildTool(args);

    case 'github_download_apk':
      return await githubDownloadApkTool(args);

    case 'open_url': {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return { error: 'open_url принимает только http:// или https:// URL.' };
      return runTermuxApi('termux-open-url', [url]);
    }

    case 'clipboard_read':
      return runTermuxApi('termux-clipboard-get');

    case 'clipboard_write': {
      const text = String(args.text || args.content || '');
      if (!text) return { error: 'Для clipboard_write нужен text.' };
      return runTermuxApi('termux-clipboard-set', [text]);
    }

    case 'notify': {
      const title = String(args.title || 'Zen Agent');
      const content = String(args.content || args.text || '');
      if (!content) return { error: 'Для notify нужен content.' };
      return runTermuxApi('termux-notification', ['--title', title, '--content', content]);
    }

    case 'termux_api_status':
      return termuxApiStatus();

    case 'termux_battery':
      return runTermuxApi('termux-battery-status');

    case 'termux_wifi':
      return runTermuxApi('termux-wifi-connectioninfo');

    case 'termux_toast': {
      const text = String(args.text || args.content || ''); if (!text) return { error: 'Для termux_toast нужен text.' };
      return runTermuxApi('termux-toast', [text]);
    }

    case 'termux_vibrate':
      return runTermuxApi('termux-vibrate', args.duration ? ['-d', String(Math.max(1, Math.min(10000, Number(args.duration) || 200)))] : []);

    case 'termux_share': {
      const file = String(args.file || args.path || '').trim();
      if (!file) return { error: 'termux_share принимает только существующий file/path. Для текста используй clipboard_write.' };
      const resolved = mcpPathOrError(file, 'file', true); if (resolved.error) return resolved;
      return runTermuxApi('termux-share', [resolved.path]);
    }

    case 'termux_volume': {
      const stream = String(args.stream || 'music'); const volume = Math.max(0, Math.min(15, Number(args.volume)));
      if (!Number.isFinite(volume)) return { error: 'Для termux_volume укажи volume от 0 до 15.' };
      return runTermuxApi('termux-volume', [stream, String(volume)]);
    }

    case 'termux_location':
      return runTermuxApi('termux-location', args.provider ? ['-p', String(args.provider)] : []);

    case 'todo_list': {
      loadTodos();
      const tree = todosRecursive(WORKSPACE_ROOT).map(({ t, depth }) => ({ id: t.id, text: t.text, status: t.status, done: t.done, parent: t.parent, depth, result: t.result || null }));
      return { workspace: WORKSPACE_ROOT, summary: todoSummary(WORKSPACE_ROOT), todos: tree };
    }

    case 'todo_add': {
      const text = String(args.text || args.content || '').trim();
      if (!text) return { error: 'Для todo_add нужен text.' };
      const parent = args.parent === undefined || args.parent === null ? null : parseInt(args.parent, 10);
      const id = addTodo(text, { workspace: WORKSPACE_ROOT, source: 'mcp', parent: Number.isNaN(parent) ? null : parent });
      return { success: true, id, parent: parent || null, workspace: WORKSPACE_ROOT };
    }

    case 'todo_start': {
      const id = parseInt(args.id, 10);
      return startTodo(id, WORKSPACE_ROOT) ? { success: true, id, status: 'in_progress', workspace: WORKSPACE_ROOT } : { error: 'Задача не найдена в текущем проекте: #' + args.id };
    }

    case 'todo_done': {
      const id = parseInt(args.id, 10);
      return doneTodo(id, WORKSPACE_ROOT) ? { success: true, id, status: 'done', workspace: WORKSPACE_ROOT } : { error: 'Задача не найдена в текущем проекте: #' + args.id };
    }

    case 'todo_fail': {
      const id = parseInt(args.id, 10);
      const reason = String(args.reason || args.error || '').slice(0, 2000);
      return failTodo(id, reason, WORKSPACE_ROOT) ? { success: true, id, status: 'failed', reason, workspace: WORKSPACE_ROOT } : { error: 'Задача не найдена в текущем проекте: #' + args.id };
    }

    case 'todo_remove': {
      const id = parseInt(args.id, 10);
      return removeTodo(id, WORKSPACE_ROOT) ? { success: true, id, workspace: WORKSPACE_ROOT } : { error: 'Задача не найдена в текущем проекте: #' + args.id };
    }

    case 'web_search': return webSearchTool(args);

    case 'read_image': {
      const resolved = mcpPathOrError(args.path, 'path', true);
      if (resolved.error) return resolved;
      try {
        const ext = path.extname(resolved.path).slice(1) || 'png';
        const base64 = fs.readFileSync(resolved.path).toString('base64');
        return { path: resolved.path, base64, mime: `image/${ext}` };
      } catch (e) { return { error: 'Не удалось прочитать изображение: ' + e.message }; }
    }

    case 'image_info':
      return imageInfoTool(args);

    case 'ocr_image':
      return ocrImageTool(args);

    case 'vision_analyze':
    case 'analyze_image':
      return await visionAnalyzeTool(args);

    case 'vision_ui_audit':
      return await visionUiAuditTool(args);

    case 'vision_compare':
      return await visionCompareTool(args);

    case 'pollinations_generate':
      return pollinationsGenerateTool(args);

    case 'pollinations_models':
      return await pollinationsModelsTool();

    case 'custom_tool_list':
      return customToolListTool();

    case 'custom_tool_create':
      return customToolCreateTool(args);

    case 'custom_tool_inspect':
      return customToolInspectTool(args);

    case 'custom_tool_run':
      return await customToolRunTool(args);

    case 'custom_tool_delete':
      return customToolDeleteTool(args);

    case 'subagent_list':
      return subagentListTool();

    case 'subagent_create':
      return subagentCreateTool(args);

    case 'subagent_task':
      return await subagentTaskTool(args);

    case 'subagent_batch':
      return await subagentBatchTool(args);

    case 'subagent_background':
      return subagentBackgroundTool(args);

    case 'subagent_status':
      return subagentStatusTool(args);

    case 'subagent_delete':
      return subagentDeleteTool(args);

    case 'plugin_list':
      return pluginListTool();

    case 'plugin_create':
      return pluginCreateTool(args);

    case 'plugin_inspect':
      return pluginInspectTool(args);

    case 'plugin_delete':
      return pluginDeleteTool(args);

    case 'plugin_tool_list':
      return pluginToolListTool();

    case 'plugin_tool_run':
      return await pluginToolRunTool(args);

    case 'plugin_provider_list':
      return pluginProviderListTool();
    default: return { error: `Unknown tool: ${tool}` };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  EMBEDDED ZEN PROXY
// ═══════════════════════════════════════════════════════════════════
function zenSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function zenChatOnce(body) {
  const source = Array.isArray(body.messages) ? body.messages : [];
  const messages = source.map(item => ({ role: item.role, content: item.content }));
  if (!messages.length || messages[0].role !== 'system') messages.unshift({ role: 'system', content: buildSystemPrompt() });
  const payload = { model: body.model || CONFIG.defaultModel, messages, max_tokens: body.max_tokens || CONFIG.maxTokens, temperature: body.temperature || CONFIG.temperature, stream: false };
  if (CONFIG.reasoningEffort && !body.siteMode) payload.reasoning_effort = CONFIG.reasoningEffort;
  const tmpFile = path.join(os.tmpdir(), 'zen_req_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf8');
  const urls = zenApiChatUrl();
  let lastError;
  try {
    for (const url of urls) {
      try {
        const result = await zenChatSingleAttempt(tmpFile, url);
        if (result && result.__rateLimit) throw new Error('Zen rate limit: ' + String(result.raw || '').slice(0, 200));
        return result;
      } catch (e) {
        lastError = e;
        if (isRateLimit(e.message)) throw e;
      }
    }
    throw lastError || new Error('Zen: все эндпоинты недоступны');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function zenChatSingleAttempt(tmpFile, url) {
  return new Promise((resolve, reject) => {
    const isTunnel = url.startsWith('http://127.0.0.1:') && url.includes('/proxy/');
    const args = ['-s', '--connect-timeout', '10', '--max-time', '60', ...(CONFIG.proxy ? ['-x', CONFIG.proxy] : []), ...(CONFIG.curlIpv4 ? ['--ipv4'] : []), '-X', 'POST', url, '-H', 'Content-Type: application/json', '-d', '@' + tmpFile];
    if (isTunnel) console.log(`[zen] Using tunnel: ${url.slice(0, 60)}...`);
    const proc = spawn(curlPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} finish(new Error('Zen request timeout (65s)')); }, 65000);
    proc.stdout.on('data', chunk => stdout += chunk.toString());
    proc.stderr.on('data', chunk => stderr += chunk.toString());
    proc.on('error', err => finish(new Error('Zen request failed: ' + err.message)));
    proc.on('close', code => {
      if (settled) return;
      if (code !== 0) { const msg = stderr || `curl exit ${code}`; if (isRateLimit(msg)) { finish(null, { __rateLimit: true, raw: msg }); return; } finish(new Error('Zen request failed: ' + msg.slice(0, 300))); return; }
      try {
        const json = JSON.parse(stdout);
        if (json.type === 'error' || json.error || isRateLimit(stdout)) { finish(null, { __rateLimit: true, raw: stdout }); return; }
        finish(null, json);
      } catch {
        if (isRateLimit(stdout)) { finish(null, { __rateLimit: true, raw: stdout }); return; }
        finish(new Error('Zen parse error: ' + stdout.slice(0, 400)));
      }
    });
  });
}

async function proxyZenChat(body) {
  let model = body.model || CONFIG.defaultModel;
  let lastErr;
  for (let i = 0; i < ZEN_MODELS.length; i++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const json = await zenChatOnce({ ...body, model });
        if (json && json.__rateLimit) { if (attempt < 1) { await zenSleep(1500); continue; } break; }
        json._model = model; return json;
      } catch (e) {
        lastErr = e;
        if (isRateLimit(e.message)) { if (attempt < 1) { await zenSleep(1500); continue; } break; }
        throw e;
      }
    }
    if (i < ZEN_MODELS.length - 1) { model = nextModel(model); await zenSleep(1500); }
    else throw lastErr || new Error('Zen rate limit: лимит исчерпан на всех моделях.');
  }
  throw lastErr;
}

function streamOnce(body, res) {
  return new Promise((resolve) => {
    const messages = Array.isArray(body.messages) ? body.messages.map(item => ({ role: item.role, content: item.content })) : [];
    if (!messages.length || messages[0].role !== 'system') messages.unshift({ role: 'system', content: buildSystemPrompt() });
    const payload = { model: body.model || CONFIG.defaultModel, messages, max_tokens: body.max_tokens || CONFIG.maxTokens, temperature: body.temperature || CONFIG.temperature, stream: true };
    if (CONFIG.reasoningEffort && !body.siteMode) payload.reasoning_effort = CONFIG.reasoningEffort;
    const data = JSON.stringify(payload);
    const tmpFile = path.join(os.tmpdir(), 'zen_req_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(tmpFile, data, 'utf8');
    const urls = zenApiChatUrl();
    let urlIndex = 0;
    function tryNextUrl() {
      if (urlIndex >= urls.length) {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        if (!res.writableEnded) { res.write('data: {"error":"Zen: все эндпоинты недоступны"}\n\n'); res.end(); }
        resolve(false);
        return;
      }
      const url = urls[urlIndex++];
      let flushed = false, buffer = '', cleanedUp = false, done = false;
      const cleanup = () => { if (!cleanedUp) { cleanedUp = true; try { fs.unlinkSync(tmpFile); } catch {} } };
      const safeResolve = (v) => { if (!done) { done = true; resolve(v); } };
      const endWith = (msg) => {
        if (done) return;
        try { if (curlProc && !curlProc.killed) curlProc.kill(); } catch {}
        cleanup();
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        if (!res.writableEnded) { res.write('data: {"error":"' + String(msg || 'Zen error').replace(/"/g, "'") + '"}\n\n'); res.end(); }
        safeResolve(false);
      };
      const curlArgs = ['-s', '--no-buffer', '--connect-timeout', '10', '--max-time', '60'];
      if (CONFIG.proxy) { curlArgs.push('-x', CONFIG.proxy); }
      if (CONFIG.curlIpv4) { curlArgs.push('--ipv4'); }
      curlArgs.push('-X', 'POST', url, '-H', 'Content-Type: application/json', '-d', '@' + tmpFile);
      const curlProc = spawn(curlPath(), curlArgs);
      const hardCap = setTimeout(() => endWith('Zen proxy timeout (75s)'), 75000);
      let connectionFailed = false;
      curlProc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        if (!flushed) {
          if (isRateLimit(buffer)) { try { curlProc.kill(); } catch {} cleanup(); clearTimeout(hardCap); safeResolve(true); return; }
          if (buffer.includes('data: ') && !/data:\s*\{\s*"type"\s*:\s*"error"/.test(buffer)) {
            flushed = true;
            if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            res.write(buffer); buffer = '';
          }
        } else { res.write(chunk); }
      });
      curlProc.on('error', (err) => { clearTimeout(hardCap); cleanup(); connectionFailed = true; tryNextUrl(); });
      curlProc.on('close', (code) => {
        clearTimeout(hardCap); cleanup();
        if (connectionFailed) return;
        if (!flushed) {
          if (isRateLimit(buffer)) { safeResolve(true); return; }
          if (done) return;
          if (code !== 0) { tryNextUrl(); return; }
          if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          if (!res.writableEnded) { res.write(buffer || 'data: {"error":"Zen stream closed unexpectedly"}\n\n'); res.end(); }
          safeResolve(false); return;
        }
        if (!res.writableEnded) res.end();
        safeResolve(false);
      });
    }
    tryNextUrl();
  });
}

async function proxyZenStream(body, res) {
  let model = body.model || CONFIG.defaultModel;
  for (let i = 0; i < ZEN_MODELS.length; i++) {
    const rateLimited = await streamOnce({ ...body, model }, res);
    if (!rateLimited) return;
    if (i < ZEN_MODELS.length - 1) { model = nextModel(model); await zenSleep(700); }
    else if (!res.writableEnded) { res.write('data: {"error":"Zen rate limit: лимит исчерпан на всех моделях."}\n\n'); res.end(); }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  EMBEDDED HTTP SERVER
// ═══════════════════════════════════════════════════════════════════
let embeddedServer = null;

// One self-contained local web app. It intentionally has no CDN, external
// stylesheet, external font or second site: the same page exposes chat, files,
// tools, sessions and runtime status through the authenticated local API.
function singleSiteHtml() {
  return String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Zen Agent Console</title>
<style>
:root{--bg:#070b14;--bg2:#0d1422;--panel:#111b2d;--panel2:#16243a;--line:#263a58;--text:#ecf4ff;--muted:#8fa2bd;--cyan:#63ddff;--blue:#5095ff;--violet:#a78bfa;--green:#69e5a2;--yellow:#ffd166;--red:#ff7184;--shadow:0 22px 70px #0008}*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 500px at 15% -5%,#173d64 0,#070b14 62%);color:var(--text);font:14px/1.5 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh}button,input,textarea,select{font:inherit;color:inherit}button{border:1px solid var(--line);background:var(--panel2);border-radius:10px;padding:9px 12px;cursor:pointer;transition:.16s}button:hover{border-color:var(--cyan);transform:translateY(-1px)}button.primary{background:linear-gradient(135deg,#177da8,#3156b3);border-color:#62dbff;font-weight:700}button.good{border-color:#3c9f78;color:var(--green)}button.warn{border-color:#9c7d2e;color:var(--yellow)}button.danger{border-color:#9e4054;color:#ffacb8}input,textarea,select{background:#091221;border:1px solid var(--line);border-radius:10px;padding:10px 12px;outline:0;width:100%}input:focus,textarea:focus,select:focus{border-color:var(--cyan);box-shadow:0 0 0 3px #63ddff1b}textarea{resize:vertical;min-height:90px}.app{display:grid;grid-template-columns:245px minmax(0,1fr);min-height:100vh}.side{border-right:1px solid var(--line);background:#0b111eeb;padding:18px 13px;display:flex;flex-direction:column;gap:18px}.brand{display:flex;gap:10px;align-items:center;padding:3px 7px}.logo{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(135deg,#54dfff,#7959ff);font-size:22px;box-shadow:0 10px 32px #42c9ff42}.brand strong{font-size:16px;letter-spacing:.02em}.brand small{display:block;color:var(--muted);font-size:11px}.nav{display:flex;flex-direction:column;gap:6px}.nav button{text-align:left;background:transparent;border-color:transparent;color:var(--muted)}.nav button.active{background:linear-gradient(90deg,#173a5a,#15233a);border-color:#2d76a0;color:var(--text)}.nav kbd{float:right;color:#58728e;font-size:11px}.side-card{border:1px solid var(--line);background:#101a2a;border-radius:13px;padding:12px}.side-card h3{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 10px}.mini-row{display:flex;justify-content:space-between;gap:8px;margin:7px 0;color:var(--muted);font-size:12px}.mini-row span:last-child{color:var(--text);text-align:right;overflow-wrap:anywhere}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--yellow);margin-right:6px}.dot.ok{background:var(--green);box-shadow:0 0 12px #69e5a288}.dot.bad{background:var(--red)}.main{min-width:0;padding:18px 20px 28px}.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.topbar h1{font-size:20px;margin:0}.topbar p{margin:2px 0 0;color:var(--muted);font-size:12px}.top-actions{display:flex;align-items:center;gap:8px}.pill{border:1px solid var(--line);background:#101a2b;border-radius:999px;padding:6px 10px;color:var(--muted);font-size:12px}.pill strong{color:var(--text)}.view{display:none}.view.active{display:block}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.toolbar>*{width:auto}.toolbar .grow{flex:1;min-width:180px}.card{background:linear-gradient(180deg,#132139f5,#0d1728f5);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:16px}.grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px}.chat-card{min-height:710px;display:flex;flex-direction:column}.eyebrow{color:var(--cyan);font-size:11px;letter-spacing:.12em;text-transform:uppercase}.hero{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:15px}.hero h2{margin:3px 0 0;font-size:23px}.hero p{color:var(--muted);margin:5px 0 0}.phase{border:1px solid #315a7a;background:#10263a;border-radius:12px;padding:9px 11px;min-width:190px;color:var(--cyan);font-size:12px;text-align:right}.messages{flex:1;min-height:410px;max-height:57vh;overflow:auto;border-top:1px solid #20304a;border-bottom:1px solid #20304a;padding:12px 4px}.msg{max-width:88%;padding:11px 13px;margin:9px 0;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}.msg.user{margin-left:auto;background:#16446b;border:1px solid #287baa}.msg.assistant{background:#142238;border:1px solid #29415f}.msg.system{background:#2d2431;border:1px solid #63445e;color:#e6cdea}.msg .meta{color:var(--muted);font-size:11px;margin-bottom:4px}.composer{display:flex;gap:9px;align-items:stretch;margin-top:13px}.composer textarea{min-height:62px;max-height:180px}.composer button{min-width:112px}.quick{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}.quick button{font-size:12px;color:var(--muted);padding:7px 9px}.approval{display:none;border:1px solid #9d7d2e;background:#342b13;border-radius:12px;padding:12px;margin-top:10px}.approval.show{display:block}.approval strong{color:var(--yellow)}.muted{color:var(--muted)}.green{color:var(--green)}.yellow{color:var(--yellow)}.red{color:var(--red)}.cyan{color:var(--cyan)}.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.stat{border:1px solid var(--line);background:#0d1728;border-radius:11px;padding:10px}.stat b{display:block;font-size:17px}.stat small{color:var(--muted)}.control-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field label{display:block;color:var(--muted);font-size:12px;margin-bottom:5px}.section-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.section-title h2{font-size:17px;margin:0}.list{display:flex;flex-direction:column;gap:8px;max-height:500px;overflow:auto}.item{border:1px solid var(--line);background:#0c1627;border-radius:11px;padding:10px}.item strong{display:block}.item small{display:block;color:var(--muted);overflow-wrap:anywhere}.session{cursor:pointer}.session.active{border-color:var(--cyan);background:#14334e}.workspace-grid{display:grid;grid-template-columns:270px minmax(0,1fr);gap:13px}.files{max-height:650px}.file{cursor:pointer}.file:hover{border-color:var(--cyan)}.file.dir strong{color:var(--cyan)}.editor{min-height:590px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.github-grid,.proxy-grid{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:14px}.commit,.run,.proxy-item{border:1px solid var(--line);background:#0c1627;border-radius:11px;padding:10px;margin-bottom:8px}.commit code{color:var(--yellow);margin-right:8px}.run.status-success{border-color:#2f8d68}.run.status-failure{border-color:#984456}.run .run-top{display:flex;justify-content:space-between;gap:8px}.proxy-item.active{border-color:var(--cyan);background:#123049}.proxy-item .proxy-line{display:flex;justify-content:space-between;gap:8px}.tools{display:grid;grid-template-columns:repeat(auto-fill,minmax(245px,1fr));gap:9px}.tool{border:1px solid var(--line);background:#0c1627;border-radius:11px;padding:11px}.tool b{color:var(--cyan)}.tool p{color:var(--muted);font-size:12px;margin:5px 0 0}.logs{font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;max-height:650px;overflow:auto;background:#080e19;border:1px solid var(--line);border-radius:11px;padding:12px}.notice{border:1px dashed #31506c;color:var(--muted);border-radius:11px;padding:10px;font-size:12px}.footer-note{color:#69809a;font-size:11px;margin-top:auto;line-height:1.45}.toast{position:fixed;right:18px;bottom:18px;z-index:5;display:none;max-width:min(430px,90vw);background:#16243a;border:1px solid var(--line);border-radius:11px;padding:11px 13px;box-shadow:var(--shadow)}.toast.show{display:block}.toast.bad{border-color:#9e4054;color:#ffb1bd}@media(max-width:1050px){.app{grid-template-columns:205px 1fr}.grid,.github-grid,.proxy-grid{grid-template-columns:1fr}.side-card.runtime{display:none}}@media(max-width:720px){.app{display:block}.side{border-right:0;border-bottom:1px solid var(--line);padding:10px;display:block}.brand{display:inline-flex}.nav{display:grid;grid-template-columns:repeat(3,1fr);margin-top:10px}.nav button{font-size:12px;padding:8px}.footer-note{display:none}.main{padding:12px}.workspace-grid{grid-template-columns:1fr}.files{max-height:260px}.hero{display:block}.phase{margin-top:10px;text-align:left}.composer{display:block}.composer button{width:100%;margin-top:8px}.messages{max-height:none}.control-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="app">
<aside class="side">
  <div class="brand"><div class="logo">ZA</div><div><strong>Zen Agent</strong><small>CLI Control Center</small></div></div>
  <nav class="nav">
    <button class="active" data-view="chat">💬 Чат <kbd>1</kbd></button>
    <button data-view="workspace">📁 Проект <kbd>2</kbd></button>
    <button data-view="github">🐙 GitHub <kbd>3</kbd></button>
    <button data-view="proxy">🔁 Прокси <kbd>4</kbd></button>
    <button data-view="tools">🧰 Инструменты <kbd>5</kbd></button>
    <button data-view="logs">📜 Журнал <kbd>6</kbd></button>
  </nav>
  <div class="side-card runtime"><h3>Состояние ядра</h3><div class="mini-row"><span>Сервис</span><span id="serviceState"><i class="dot"></i>проверка</span></div><div class="mini-row"><span>Провайдер</span><span id="sideProvider">—</span></div><div class="mini-row"><span>Модель</span><span id="sideModel">—</span></div><div class="mini-row"><span>MCP</span><span id="sideMcp">—</span></div><div class="mini-row"><span>Прокси</span><span id="sideProxy">—</span></div><div class="mini-row"><span>GitHub</span><span id="sideGithub">—</span></div></div>
  <div class="footer-note">Двойной Esc останавливает текущую задачу.<br>Секреты не принимаются через этот сайт.</div>
</aside>
<main class="main">
  <header class="topbar"><div><h1 id="pageTitle">Рабочий чат</h1><p id="workspaceLabel">рабочая папка: —</p></div><div class="top-actions"><span class="pill"><span id="topDot" class="dot"></span><strong id="topState">онлайн</strong></span><button id="reloadBtn">Обновить</button></div></header>

  <section id="view-chat" class="view active"><div class="grid"><div class="card chat-card"><div class="hero"><div><div class="eyebrow">единый исполнитель задач</div><h2>Что нужно сделать?</h2><p>Команды, файлы, тесты, GitHub и сборки — через один интерфейс.</p></div><div id="phase" class="phase">▣ управление у вас</div></div><div id="messages" class="messages"></div><div id="approval" class="approval"><strong>Требуется подтверждение</strong><div id="approvalText" class="muted" style="margin-top:4px"></div><div class="toolbar" style="margin-top:9px"><button id="allowBtn" class="primary">Разрешить</button><button id="denyBtn" class="danger">Отклонить</button><button id="abortBtn" class="warn">Остановить</button></div></div><div id="liveOutput" class="logs" style="display:none;max-height:240px;margin-top:10px"></div><div class="quick"><button data-quick="Проверь структуру текущего проекта и запусти безопасные тесты, не изменяя файлы.">Проверить проект</button><button data-quick="Покажи статус Git и последние коммиты текущего проекта.">Проверить Git</button><button data-quick="Найди ошибки синтаксиса в JavaScript-файлах текущего проекта.">Проверить JS</button></div><div class="composer"><textarea id="input" placeholder="Опишите задачу… Ctrl+Enter — отправить"></textarea><button id="sendBtn" class="primary">▶ Запустить</button></div><div class="notice" style="margin-top:10px">Для остановки нажмите Esc два раза. После остановки можно написать исправление, замечание или новую задачу.</div></div><aside class="card"><div class="section-title"><h2>Контекст</h2><span id="sessionBadge" class="pill">default</span></div><div class="control-grid"><div class="field"><label>Провайдер</label><select id="provider"></select></div><div class="field"><label>Модель</label><select id="model"></select></div></div><div class="stat-grid"><div class="stat"><b id="stepStat">0</b><small>шагов</small></div><div class="stat"><b id="toolStat">0</b><small>инструментов</small></div><div class="stat"><b id="tokenStat">—</b><small>токены</small></div><div class="stat"><b id="timeStat">0 с</b><small>время</small></div></div><div class="section-title" style="margin-top:18px"><h2>Сессии</h2><button id="newSession">＋</button></div><div id="sessions" class="list"></div></aside></div></section>

  <section id="view-workspace" class="view"><div class="card"><div class="section-title"><h2>Рабочая папка проекта</h2><span class="pill">MCP workspace</span></div><div class="toolbar"><select id="projectSelect" class="grow"><option>Проекты загружаются…</option></select><button id="projectUse" class="primary">Открыть проект</button><input id="projectAlias" placeholder="короткое имя"><button id="projectRegister" class="good">Привязать эту папку</button></div><div class="toolbar" style="margin-top:9px"><input id="filePath" class="grow" value="." placeholder="Путь внутри рабочей папки"><button id="browseBtn" class="primary">Открыть</button><button id="upBtn">↑ Выше</button></div><div class="workspace-grid" style="margin-top:12px"><div id="fileList" class="list files"></div><div><textarea id="editor" class="editor" placeholder="Выберите текстовый файл…"></textarea><div class="toolbar" style="margin-top:9px"><button id="saveFile" class="primary">Сохранить</button><span id="fileInfo" class="muted"></span></div></div></div></div></section>

  <section id="view-github" class="view"><div class="github-grid"><div class="card"><div class="section-title"><h2>GitHub репозиторий</h2><span id="githubTokenBadge" class="pill">token: проверка</span></div><div class="toolbar"><input id="repoInput" class="grow" placeholder="owner/repository"><button id="repoSave" class="good">Сохранить</button></div><div class="toolbar" style="margin-top:10px"><button id="repoInfoBtn">Информация</button><button id="commitsBtn" class="primary">Коммиты</button><button id="buildsBtn">Сборки</button><button id="watchBtn">Наблюдать</button></div><div id="githubOutput" class="logs" style="margin-top:12px;min-height:250px">Выберите действие.</div></div><aside class="card"><h2 style="margin-top:0">APK и Git</h2><div class="field"><label>GitHub token (не отображается)</label><input id="githubToken" type="password" placeholder="ghp_… или github_pat_…"></div><button id="githubTokenSave" class="good" style="width:100%;margin-top:8px">Сохранить token</button><div id="githubAccount" class="notice" style="margin-top:9px">Аккаунт не привязан.</div><div class="field" style="margin-top:14px"><label>Источник APK</label><select id="apkSource"><option value="actions">GitHub Actions artifact</option><option value="release">Последний Release</option></select></div><div class="field" style="margin-top:9px"><label>Run ID или tag, необязательно</label><input id="apkRef" placeholder="например 123456789 или v1.0.0"></div><div class="field" style="margin-top:9px"><label>Путь сохранения</label><input id="apkPath" placeholder="downloads/app.apk"></div><button id="apkBtn" class="primary" style="width:100%;margin-top:10px">Скачать APK</button><div class="notice" style="margin-top:12px">Push всегда требует подтверждение. Token можно задать через /git key или в поле выше. GitHub Models имеют бесплатную квоту, но она зависит от аккаунта и не безлимитна.</div></aside></div></section>

  <section id="view-proxy" class="view"><div class="proxy-grid"><div class="card"><div class="section-title"><h2>Пул прокси</h2><button id="proxyTest" class="primary">Проверить все</button></div><div class="toolbar"><input id="proxyInput" class="grow" placeholder="socks5h://host:1080 или http://host:8080"><button id="proxyAdd" class="good">Добавить</button></div><div id="proxyList" style="margin-top:13px"></div></div><aside class="card"><h2 style="margin-top:0">Автопереключение</h2><div class="mini-row"><span>Статус</span><span id="proxyActive">—</span></div><label class="toolbar" style="margin-top:12px"><input id="proxyAuto" type="checkbox" style="width:auto"><span>Переключать при ошибке</span></label><div class="field" style="margin-top:12px"><label>Порог медленного ответа, мс</label><input id="proxySlow" type="number" min="1000" max="120000" step="1000"></div><button id="proxyApply" class="primary" style="width:100%;margin-top:10px">Применить</button><div class="notice" style="margin-top:12px">При переключении уведомление попадёт в журнал выполнения.</div></aside></div></section>

  <section id="view-tools" class="view"><div class="card"><div class="section-title"><h2>Инструменты агента</h2><input id="toolFilter" style="max-width:300px" placeholder="Фильтр по имени…"></div><div id="toolList" class="tools"></div></div></section>
  <section id="view-logs" class="view"><div class="card"><div class="section-title"><h2>Журнал событий</h2><button id="logsRefresh">Обновить</button></div><div id="logsOutput" class="logs">Загрузка…</div></div></section>
</main></div><div id="toast" class="toast"></div>
<script>
(function(){
'use strict';
var state={view:'chat',workspace:'—',projects:[],mcp:false,settings:null,models:[],tools:[],sessions:[],activeSession:'default',initialized:false,run:null,poll:null,events:[],proxy:null,github:null};
var $=function(id){return document.getElementById(id)};
var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var toast=function(msg,bad){var e=$('toast');e.textContent=msg;e.className='toast show'+(bad?' bad':'');clearTimeout(toast.t);toast.t=setTimeout(function(){e.className='toast'},4000)};
async function api(url,opts){var res=await fetch(url,opts||{}),data;try{data=await res.json()}catch(e){data={error:'Сервер вернул некорректный JSON'}}if(!res.ok||data.error)throw Error(data.error||('HTTP '+res.status));return data}
var post=function(body){return {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}};
function setView(name){state.view=name;document.querySelectorAll('.nav button').forEach(function(b){b.classList.toggle('active',b.dataset.view===name)});document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('active',v.id==='view-'+name)});var titles={chat:'Рабочий чат',workspace:'Рабочая папка',github:'GitHub и сборки',proxy:'Пул прокси',tools:'Инструменты',logs:'Журнал событий'};$('pageTitle').textContent=titles[name]||'Zen Agent';if(name==='workspace')browse();if(name==='proxy')loadProxy();if(name==='github')loadGithub();if(name==='logs')loadLogs()}
function addMessage(role,text){if(!text)return;var e=document.createElement('div');e.className='msg '+role;e.innerHTML='<div class="meta">'+esc(role==='user'?'Вы':role==='assistant'?'Zen Agent':'Система')+'</div>'+esc(text);$('messages').appendChild(e);$('messages').scrollTop=$('messages').scrollHeight}
function renderMessages(items){$('messages').innerHTML='';(items||[]).forEach(function(m){addMessage(m.role,m.content)})}
function renderSessions(){var box=$('sessions');box.innerHTML='';(state.sessions||[]).forEach(function(x){var e=document.createElement('div');e.className='item session '+(x.name===state.activeSession?'active':'');e.innerHTML='<strong>'+esc(x.title||x.name)+'</strong><small>'+esc(String(x.messages||0))+' сообщений • '+esc(x.provider||'zen')+' • '+esc(x.model||'')+'</small>';e.onclick=function(){selectSession(x.name)};box.appendChild(e)});if(!state.sessions.length)box.innerHTML='<span class="muted">Нет сессий.</span>'}
async function loadSessions(){var d=await api('/api/agent/sessions');state.sessions=d.sessions||[];var keep=state.initialized&&state.sessions.some(function(x){return x.name===state.activeSession});state.activeSession=keep?state.activeSession:(d.active||'default');state.initialized=true;$('sessionBadge').textContent=state.activeSession;renderSessions();var current=state.sessions.find(function(x){return x.name===state.activeSession});if(current){var detail=await api('/api/agent/sessions/'+encodeURIComponent(state.activeSession));renderMessages(detail.session.messages)}}
async function selectSession(name){if(state.run)return;try{await api('/api/agent/sessions/select',post({name:name}));state.activeSession=name;$('sessionBadge').textContent=name;var d=await api('/api/agent/sessions/'+encodeURIComponent(name));renderMessages(d.session.messages);await loadSessions();toast('Сессия переключена: '+name)}catch(e){toast(e.message,true)}}
function renderModels(){var settings=state.settings||{};var p=$('provider');var providers=['zen','openrouter','github','huggingface'];p.innerHTML=providers.map(function(x){return '<option value="'+x+'">'+x+'</option>'}).join('');p.value=settings.provider||'zen';var list=p.value==='github'?(settings.githubModels||[]):p.value==='huggingface'?(settings.huggingFaceModels||[]):p.value==='openrouter'?state.models:(settings.zenModels||[]);var m=$('model');m.innerHTML=list.map(function(x){var id=x.id||x;return '<option value="'+esc(id)+'">'+esc(id)+'</option>'}).join('');if(settings.model&&!Array.from(m.options).some(function(o){return o.value===settings.model}))m.innerHTML+='<option value="'+esc(settings.model)+'">'+esc(settings.model)+'</option>';m.value=settings.model||list[0]?.id||'';p.onchange=function(){saveSettings()};m.onchange=function(){saveSettings()};$('sideProvider').textContent=p.value;$('sideModel').textContent=m.value}
async function saveSettings(){try{var d=await api('/api/agent/settings',post({provider:$('provider').value,model:$('model').value}));state.settings=Object.assign({},state.settings||{},d);renderModels();toast('Настройки сохранены')}catch(e){toast(e.message,true)}}
function renderTools(){var filter=($('toolFilter').value||'').toLowerCase();var list=state.tools.filter(function(x){return !filter||x.name.toLowerCase().includes(filter)||String(x.description||'').toLowerCase().includes(filter)});$('toolList').innerHTML=list.map(function(x){return '<div class="tool"><b>'+esc(x.name)+'</b><p>'+esc(x.description||'')+'</p></div>'}).join('')||'<div class="muted">Ничего не найдено.</div>'}
function renderRun(){var r=state.run;var phase=r?(r.status==='awaiting_approval'?'⚠ нужно подтверждение':r.status==='running'?'⠿ агент выполняет задачу':r.status):'▣ управление у вас';$('phase').textContent=phase;$('sendBtn').disabled=!!r;var approval=r&&r.approval;if(approval){$('approval').className='approval show';$('approvalText').textContent=approval.tool+' • '+JSON.stringify(approval.args||{})}else $('approval').className='approval';if(r&&r.events){state.events=r.events;renderEvents()}}
function renderEvents(){var r=state.run;var events=state.events||[];$('stepStat').textContent=r&&r.events?events.filter(function(x){return x.type==='tool_started'||x.type==='model_request'}).length:'0';$('toolStat').textContent=events.filter(function(x){return String(x.type||'').includes('tool')}).length;$('tokenStat').textContent='—';$('timeStat').textContent=r&&r.createdAt?Math.max(0,Math.round((Date.now()-Date.parse(r.createdAt))/1000))+' с':'0 с';var live=events.filter(function(x){return ['terminal_output','model_output','tool_output','phase'].includes(x.type)}).slice(-80);var liveBox=$('liveOutput');if(live.length){liveBox.style.display='block';liveBox.textContent=live.map(function(x){return '['+(x.at||'')+'] '+(x.type==='terminal_output'?'терминал':x.type==='model_output'?'модель':x.type==='tool_output'?(x.tool||'инструмент'):'этап')+': '+(x.text||x.result||x.detail||x.phase||'')}).join('\n');liveBox.scrollTop=liveBox.scrollHeight}else{liveBox.style.display='none';liveBox.textContent=''}if(state.view==='logs')$('logsOutput').textContent=events.map(function(x){return '['+(x.at||'')+'] '+(x.type||'')+' '+(x.tool||x.text||x.result||'')}).join('\n')||'Событий пока нет.'}
async function pollRun(){if(!state.run)return;try{var d=await api('/api/agent/run/'+state.run.id);state.run=d.run;state.events=state.run.events||[];renderRun();if(state.run.status==='completed'||state.run.status==='error'){clearInterval(state.poll);state.poll=null;var answer=state.run.answer||state.run.error||'Задача завершена.';addMessage('assistant',answer);state.run=null;renderRun();await loadSessions();toast('Задача завершена')}}catch(e){clearInterval(state.poll);state.poll=null;state.run=null;renderRun();toast(e.message,true)}}
async function send(){var text=$('input').value.trim();if(!text||state.run)return;$('input').value='';addMessage('user',text);try{var d=await api('/api/agent/run',post({input:text,session:state.activeSession,provider:$('provider').value,model:$('model').value}));state.run=d.run;state.events=d.run.events||[];renderRun();state.poll=setInterval(pollRun,700);await pollRun()}catch(e){addMessage('system','Ошибка: '+e.message);toast(e.message,true);$('sendBtn').disabled=false}}
async function approve(yes){if(!state.run)return;try{await api('/api/agent/run/'+state.run.id+'/approve',post({decision:yes?'allow':'deny'}));await pollRun()}catch(e){toast(e.message,true)}}
async function abort(){if(!state.run)return;try{await api('/api/agent/run/'+state.run.id+'/abort',post({}));toast('Остановка запрошена')}catch(e){toast(e.message,true)}}
async function newSession(){var name=window.prompt('Имя новой сессии');if(!name)return;try{await api('/api/agent/sessions',post({name:name}));await selectSession(name)}catch(e){toast(e.message,true)}}
async function loadProjects(){try{var d=await api('/api/projects');state.projects=d.projects||[];var select=$('projectSelect');select.innerHTML=state.projects.map(function(x){return '<option value="'+esc(x.alias)+'" '+(x.active?'selected':'')+'>'+esc(x.alias)+' — '+esc(x.path)+'</option>'}).join('')||'<option value="">Нет привязанных проектов</option>'}catch(e){toast(e.message,true)}}
async function useProject(){var alias=$('projectSelect').value;if(!alias)return;try{await api('/api/projects',post({action:'use',alias:alias}));toast('Проект переключён: '+alias);await refresh();setView('workspace')}catch(e){toast(e.message,true)}}
async function registerProject(){var alias=$('projectAlias').value.trim();if(!alias){toast('Введите короткое имя проекта',true);return}try{await api('/api/projects',post({action:'register',alias:alias,path:state.workspace}));$('projectAlias').value='';await loadProjects();toast('Проект привязан: '+alias)}catch(e){toast(e.message,true)}}
async function browse(){var raw=$('filePath').value.trim()||'.';try{var d=await api('/api/browse?backend=local&path='+encodeURIComponent(raw));$('filePath').value=d.path;$('fileList').innerHTML=(d.items||[]).map(function(x){return '<div class="item file '+(x.isDir?'dir':'')+'" data-path="'+esc(x.path)+'" data-dir="'+(x.isDir?'1':'0')+'"><strong>'+(x.isDir?'📁 ':'📄 ')+esc(x.name)+'</strong><small>'+esc(x.isDir?'папка':String(x.size||0)+' байт')+'</small></div>'}).join('')||'<span class="muted">Папка пуста.</span>';document.querySelectorAll('.file').forEach(function(e){e.onclick=function(){if(e.dataset.dir==='1'){$('filePath').value=e.dataset.path;browse()}else readFile(e.dataset.path)}})}catch(e){toast(e.message,true)}}
async function readFile(file){try{var d=await api('/api/fs/read',post({path:file}));$('filePath').value=file;$('editor').value=d.content||'';$('fileInfo').textContent=file}catch(e){toast(e.message,true)}}
async function saveFile(){var file=$('filePath').value.trim();if(!$('fileInfo').textContent||$('fileInfo').textContent!==file){toast('Сначала выберите файл',true);return}try{await api('/api/fs/write',post({path:file,content:$('editor').value}));toast('Файл сохранён')}catch(e){toast(e.message,true)}}
function repoValue(){return $('repoInput').value.trim()||((state.github||{}).repo||'')}
async function loadGithub(){try{var d=await api('/api/github/status');state.github=d;$('repoInput').value=d.repo||'';$('githubTokenBadge').textContent=d.token.configured?'token: '+d.token.masked:'token: не задан';$('sideGithub').textContent=d.account?'@'+d.account.login:(d.token.configured?'token есть':'нет');$('githubAccount').textContent=d.account?'Привязан аккаунт: @'+d.account.login+(d.account.name&&d.account.name!==d.account.login?' • '+d.account.name:''):'Аккаунт не привязан.'}catch(e){toast(e.message,true)}}
async function saveGithubToken(){var token=$('githubToken').value.trim();if(!token){toast('Введите GitHub token',true);return}try{var d=await api('/api/github/token',post({token:token}));$('githubToken').value='';state.github=d;await loadGithub();toast('GitHub аккаунт привязан: @'+(d.account?d.account.login:'неизвестен'))}catch(e){toast(e.message,true)}}
async function saveRepo(){try{var d=await api('/api/github/repo',post({repo:$('repoInput').value.trim()}));state.github=Object.assign({},state.github||{},d);toast('Репозиторий сохранён')}catch(e){toast(e.message,true)}}
async function githubTool(tool,args){try{var d=await api('/mcp/call',post({tool:tool,args:args}));if(!d.success)throw Error(d.error||'GitHub tool error');return d.result}catch(e){toast(e.message,true);throw e}}
async function showInfo(){var d=await githubTool('github_repo_info',{repo:repoValue()});$('githubOutput').textContent=JSON.stringify(d,null,2)}
async function showCommits(){var d=await githubTool('github_commits',{repo:repoValue(),limit:20});$('githubOutput').innerHTML=(d.commits||[]).map(function(x){return '<div class="commit"><code>'+esc(x.shortSha)+'</code><strong>'+esc(x.message)+'</strong><small>'+esc(x.author||'')+' • '+esc(x.date||'')+'</small></div>'}).join('')||'Коммитов нет.'}
async function showBuilds(){var d=await githubTool('github_builds',{repo:repoValue(),limit:20});$('githubOutput').innerHTML=(d.runs||[]).map(function(x){var cls=x.conclusion==='success'?'status-success':x.conclusion==='failure'?'status-failure':'';return '<div class="run '+cls+'"><div class="run-top"><strong>#'+esc(x.id)+' '+esc(x.name)+'</strong><span>'+esc(x.conclusion||x.status||'')+'</span></div><small>'+esc(x.branch||'')+' • '+esc(x.updatedAt||'')+'</small></div>'}).join('')||'Сборок нет.'}
async function watchBuild(){var id=window.prompt('Run ID');if(!id)return;var d=await githubTool('github_watch_build',{repo:repoValue(),run_id:Number(id),interval_seconds:10});$('githubOutput').textContent=JSON.stringify(d,null,2)}
async function downloadApk(){var source=$('apkSource').value;var ref=$('apkRef').value.trim();var args={repo:repoValue(),source:source};if(source==='release'&&ref&&ref!=='latest')args.tag=ref;if(source==='actions'&&/^\\d+$/.test(ref))args.run_id=Number(ref);if($('apkPath').value.trim())args.path=$('apkPath').value.trim();var d=await githubTool('github_download_apk',args);$('githubOutput').textContent=JSON.stringify(d,null,2);toast(d.apk||d.path||d.archive?'APK скачан':'Готово')}
function renderProxy(){var p=state.proxy;if(!p)return;$('proxyAuto').checked=!!p.failover;$('proxySlow').value=p.slowMs||12000;$('proxyActive').textContent=p.proxy||'прямое соединение';$('sideProxy').textContent=p.proxy||'прямое';$('proxyList').innerHTML=(p.pool||[]).map(function(x){return '<div class="proxy-item '+(x.active?'active':'')+'"><div class="proxy-line"><strong>'+(x.active?'● ':'○ ')+esc(x.label)+'</strong><span class="muted">'+(x.active?'активный':'№ '+x.index)+'</span></div><small>попытки: '+x.attempts+' • ошибки: '+x.failures+' • медленные: '+x.slow+'</small></div>'}).join('')||'<div class="notice">Пул пуст. Добавьте прокси или используйте VPN.</div>'}
async function loadProxy(){try{state.proxy=await api('/api/proxy/status');renderProxy()}catch(e){toast(e.message,true)}}
async function proxyAction(action,extra){try{var d=await api('/api/proxy',post(Object.assign({action:action},extra||{})));state.proxy=d.result||d;await loadProxy();toast(action==='test'?'Проверка завершена':'Настройки прокси обновлены')}catch(e){toast(e.message,true)}}
async function loadLogs(){try{var d=await api('/api/audit?limit=120');$('logsOutput').textContent=(d.records||[]).map(function(x){return '['+x.at+'] '+x.event+(x.tool?' • '+x.tool:'')+(x.error?' • '+x.error:'')}).join('\n')||'Журнал пока пуст.'}catch(e){toast(e.message,true)}}
async function refresh(){try{var d=await Promise.all([api('/mcp/status'),api('/api/agent/settings'),api('/api/models/full'),api('/api/proxy/status'),api('/api/github/status'),api('/api/projects')]);var m=d[0];state.settings=d[1];state.models=(d[2].models||[]).map(function(x){return x.id||x});state.tools=m.tools||[];state.workspace=m.workspace||'—';state.mcp=true;$('workspaceLabel').textContent='рабочая папка: '+state.workspace;$('sideMcp').innerHTML='<span class="green">подключён</span>';$('serviceState').innerHTML='<i class="dot ok"></i>онлайн';$('topState').textContent='онлайн';$('topDot').className='dot ok';renderModels();renderTools();state.proxy=d[3];state.github=d[4];state.projects=d[5].projects||[];var projectSelect=$('projectSelect');projectSelect.innerHTML=state.projects.map(function(x){return '<option value="'+esc(x.alias)+'" '+(x.active?'selected':'')+'>'+esc(x.alias)+' — '+esc(x.path)+'</option>'}).join('')||'<option value="">Нет привязанных проектов</option>';renderProxy();$('repoInput').value=state.github.repo||'';$('githubTokenBadge').textContent=state.github.token.configured?'token: '+state.github.token.masked:'token: не задан';$('sideGithub').textContent=state.github.account?'@'+state.github.account.login:(state.github.token.configured?'token есть':'нет');$('githubAccount').textContent=state.github.account?'Привязан аккаунт: @'+state.github.account.login+(state.github.account.name&&state.github.account.name!==state.github.account.login?' • '+state.github.account.name:''):'Аккаунт не привязан.';await loadSessions()}catch(e){$('topState').textContent='ошибка';$('topDot').className='dot bad';$('serviceState').innerHTML='<i class="dot bad"></i>ошибка';toast(e.message,true)}}
document.querySelectorAll('.nav button').forEach(function(b){b.onclick=function(){setView(b.dataset.view)}});document.querySelectorAll('[data-quick]').forEach(function(b){b.onclick=function(){$('input').value=b.dataset.quick;$('input').focus()}});$('sendBtn').onclick=send;$('input').addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='Enter')send()});$('allowBtn').onclick=function(){approve(true)};$('denyBtn').onclick=function(){approve(false)};$('abortBtn').onclick=abort;$('newSession').onclick=newSession;$('reloadBtn').onclick=refresh;$('projectUse').onclick=useProject;$('projectRegister').onclick=registerProject;$('browseBtn').onclick=browse;$('upBtn').onclick=function(){var x=$('filePath').value.replace(/[\\/]+$/,'');$('filePath').value=x.split(/[\\/]/).slice(0,-1).join('/')||'.';browse()};$('saveFile').onclick=saveFile;$('repoSave').onclick=saveRepo;$('githubTokenSave').onclick=saveGithubToken;$('repoInfoBtn').onclick=showInfo;$('commitsBtn').onclick=showCommits;$('buildsBtn').onclick=showBuilds;$('watchBtn').onclick=watchBuild;$('apkBtn').onclick=downloadApk;$('proxyAdd').onclick=function(){var x=$('proxyInput').value.trim();if(x)proxyAction('add',{proxy:x})};$('proxyTest').onclick=function(){proxyAction('test')};$('proxyApply').onclick=async function(){await proxyAction('auto',{enabled:$('proxyAuto').checked});await proxyAction('slow',{ms:Number($('proxySlow').value)})};$('toolFilter').oninput=renderTools;$('logsRefresh').onclick=loadLogs;
setInterval(function(){if(state.run){pollRun();renderEvents()}},1000);setInterval(function(){if(!state.run)refresh()},12000);refresh();
})();
</script>
</body></html>`;
}


function startEmbeddedServer() {
  if (embeddedServer) return;

  const HUB_BIND_HOST = process.env.ZEN_BIND_HOST || '0.0.0.0';
  const HUB_REMOTE_TOKEN = String(process.env.ZEN_REMOTE_TOKEN || '');
  const HUB_ALLOW_UNAUTH = process.env.ZEN_ALLOW_UNAUTH === '1';
  // Collection mode keeps agent/MCP in Core and serves AIN from an external UI tree.
  const CORE_ONLY = process.env.ZEN_CORE_ONLY === '1';
  const HUB_STATE_FILE = path.join(os.homedir(), '.zen_agent_hub_state.json');
  const HUB_PTY_SESSIONS = new Map();
  const HUB_WEB_RUNS = new Map();
  const HUB_PTY_TTL_MS = Math.max(60_000, parseInt(process.env.ZEN_PTY_TTL_MS || '600000', 10) || 600000);
  // Open the full Hub only once after this Node process has successfully bound a port.
  // Disable for headless/automated use with ZEN_OPEN_BROWSER=0.
  const HUB_AUTO_OPEN_BROWSER = process.env.ZEN_OPEN_BROWSER === '1';
  let hubBrowserOpenAttempted = false;
  const openHubInBrowser = targetUrl => {
    if (!HUB_AUTO_OPEN_BROWSER || hubBrowserOpenAttempted) return;
    hubBrowserOpenAttempted = true;
    let command, args;
    if (PLATFORM.isTermux) { command = 'termux-open-url'; args = [targetUrl]; }
    else if (process.platform === 'win32') { command = process.env.COMSPEC || 'cmd.exe'; args = ['/c', 'start', '', targetUrl]; }
    else if (process.platform === 'darwin') { command = 'open'; args = [targetUrl]; }
    else { command = 'xdg-open'; args = [targetUrl]; }
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      child.on('error', () => console.log(c(`ℹ️ Не удалось автоматически открыть браузер. Открой: ${targetUrl}`, 'gray')));
    } catch { console.log(c(`ℹ️ Открой браузер вручную: ${targetUrl}`, 'gray')); }
  };
  const HUB_TOOL_DEFS = [
    { id: '_terminal', name: 'Terminal', cmd: '', color: '#58a6ff', icon: '>_', installed: true },
    { id: 'opencode', name: 'OpenCode', cmd: 'opencode', color: '#00d4aa', icon: 'OC' },
    { id: 'ccb', name: 'Claude Code', cmd: 'ccb', color: '#d97706', icon: 'CB' },
    { id: 'koda', name: 'Koda', cmd: 'koda', color: '#8b5cf6', icon: 'KD' },
    { id: 'openclaude', name: 'OpenClaude', cmd: 'openclaude', color: '#06b6d4', icon: 'OC' },
    { id: 'openrouter', name: 'OpenRouter CLI', cmd: 'openrouter', color: '#6366f1', icon: 'OR' },
    { id: 'qwen', name: 'Qwen Code', cmd: 'qwen', color: '#ef4444', icon: 'QW' },
    { id: 'http-server', name: 'HTTP Server', cmd: 'http-server', color: '#22c55e', icon: 'HS' },
    // This is intentionally a route, not a second child copy of this agent.
    { id: 'agent-web', name: 'AIN Agent', cmd: '', color: '#f59e0b', icon: 'AI', installed: true, launch: 'web' }
  ];

  const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1', ''].includes(String(address || ''));
  const parseCookies = raw => Object.fromEntries(String(raw || '').split(';').map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf('=');
    if (i < 0) return [x, ''];
    let value = x.slice(i + 1); try { value = decodeURIComponent(value); } catch {}
    return [x.slice(0, i), value];
  }));
  const equalToken = value => {
    const a = Buffer.from(String(value || '')); const b = Buffer.from(HUB_REMOTE_TOKEN);
    return !!HUB_REMOTE_TOKEN && a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const hubAccess = (req, url) => {
    const local = isLoopback(req.socket && req.socket.remoteAddress);
    const cookies = parseCookies(req.headers.cookie);
    const supplied = req.headers['x-zen-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '') || cookies.zen_remote_token || url.searchParams.get('token');
    const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    const origin = String(req.headers.origin || '');
    // Arena's live preview is a same-site e2b.app request. It must work even
    // though the preview proxy is not a loopback socket inside the sandbox.
    const previewRequest = /(?:^|[.:])e2b\.app(?::\d+)?$/i.test(forwardedHost) || /https?:\/\/[^/]*e2b\.app(?:[:/]|$)/i.test(origin);
    const authorized = local || equalToken(supplied) || (!HUB_REMOTE_TOKEN && (HUB_ALLOW_UNAUTH || previewRequest));
    return { local, authorized, suppliedByQuery: !local && equalToken(url.searchParams.get('token')) };
  };
  const json = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };
  const text = (res, status, body, type = 'text/plain; charset=utf-8', headers = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers }); res.end(body);
  };
  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', part => { size += part.length; if (size > 8 * 1024 * 1024) { reject(new Error('Request body exceeds 8 MB')); req.destroy(); return; } parts.push(part); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
  const readJson = async req => {
    const raw = await readBody(req); if (!raw.length) return {};
    try { return JSON.parse(raw.toString('utf8')); } catch { throw new Error('Invalid JSON body'); }
  };
  const loadHubState = () => { try { return JSON.parse(fs.readFileSync(HUB_STATE_FILE, 'utf8')); } catch { return { lastDirs: {}, recentPaths: [] }; } };
  const saveHubState = value => { try { fs.writeFileSync(HUB_STATE_FILE, JSON.stringify(value, null, 2), { mode: 0o600 }); } catch {} };
  const hubPath = raw => {
    const root = path.resolve(WORKSPACE_ROOT);
    const supplied = String(raw || '.').trim() || '.';
    if (supplied.includes('\0')) return { error: 'Path contains a forbidden NUL character.' };
    const target = path.resolve(path.isAbsolute(supplied) ? supplied : path.join(root, supplied));
    const rel = path.relative(root, target);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return { error: 'Hub file manager is limited to the active agent workspace.' };
    try {
      let probe = target;
      while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe); if (parent === probe) break; probe = parent;
      }
      const realRoot = fs.realpathSync.native(root);
      const realProbe = fs.realpathSync.native(probe);
      if (!isPathInside(realProbe, realRoot)) return { error: 'Path escapes the active agent workspace through a symlink.' };
    } catch (e) { return { error: 'Unable to validate path safely: ' + e.message }; }
    return { path: target };
  };
  const installed = cmd => {
    if (!cmd) return true;
    try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', timeout: 2500 }); return true; } catch { return false; }
  };
  const getHubModels = () => {
    const rows = [];
    for (const m of ZEN_MODELS) rows.push({ id: m.id, name: m.name || m.id, ctx: m.ctx, out: 32000, desc: 'OpenCode Zen', free: true, providerId: 'zen', providerName: 'OpenCode Zen', providerIcon: '🟢', selected: m.id === currentModel });
    for (const m of GITHUB_MODELS) rows.push({ id: m.id, name: m.name || m.id, ctx: m.ctx, out: 16000, desc: 'GitHub Models', free: true, providerId: 'github', providerName: 'GitHub Models', providerIcon: '🐙', selected: m.id === currentModel });
    for (const m of HUGGINGFACE_MODELS) rows.push({ id: m.id, name: m.name || m.id, ctx: m.ctx, out: 16000, desc: 'Hugging Face', free: true, providerId: 'huggingface', providerName: 'Hugging Face', providerIcon: '🤗', selected: m.id === currentModel });
    for (const m of OPENROUTER_PAID_FALLBACK) rows.push({ id: m.id, name: m.name || m.id, ctx: m.ctx, out: 16000, desc: 'OpenRouter paid', free: false, providerId: 'openrouter', providerName: 'OpenRouter', providerIcon: '🟣', selected: m.id === currentModel });
    for (const m of openRouterFreeModels) if (!rows.some(x => x.id === m.id)) rows.push({ id: m.id, name: m.name || m.id, ctx: m.ctx || 'free', out: 16000, desc: 'OpenRouter free', free: true, providerId: 'openrouter', providerName: 'OpenRouter', providerIcon: '🟣', selected: m.id === currentModel });
    if (currentModel && !rows.some(m => m.id === currentModel)) rows.unshift({ id: currentModel, name: currentModel, ctx: '—', out: 16000, desc: 'Custom (current)', free: false, providerId: currentProvider, providerName: currentProvider, providerIcon: '🔧', selected: true });
    return rows;
  };
  const safeTerminalId = value => /^[A-Za-z0-9_.-]{1,80}$/.test(String(value || '')) ? String(value) : null;
  const ptySend = (session, message) => {
    const payload = JSON.stringify(message);
    for (const client of [...session.clients]) {
      if (client.readyState === 1) client.send(payload); else session.clients.delete(client);
    }
  };
  const schedulePtyClose = session => {
    if (!session || session.clients.size) return;
    if (session.closeTimer) clearTimeout(session.closeTimer);
    session.closeTimer = setTimeout(() => {
      if (session.clients.size) return;
      try { session.pty.kill(); } catch {}
      HUB_PTY_SESSIONS.delete(session.id);
    }, HUB_PTY_TTL_MS);
    session.closeTimer.unref?.();
  };
  const detachPtyClient = (session, ws) => {
    if (!session) return;
    session.clients.delete(ws); schedulePtyClose(session);
  };
  const attachPtyClient = (session, ws) => {
    if (session.closeTimer) { clearTimeout(session.closeTimer); session.closeTimer = null; }
    session.clients.add(ws);
    ws.send(JSON.stringify({ type: 'opened', id: session.id, resumed: !!session.resumed }));
    if (session.output) ws.send(JSON.stringify({ type: 'output', id: session.id, data: session.output, replay: true }));
  };
  const addWebLog = (name, role, content) => {
    const session = sessionStore.sessions[name] || (sessionStore.sessions[name] = { history: [], createdAt: new Date().toISOString() });
    session.webLog ||= [];
    session.webLog.push({ id: crypto.randomUUID(), role, content: String(content || ''), ts: Date.now() });
    if (session.webLog.length > 500) session.webLog = session.webLog.slice(-500);
    session.updatedAt = new Date().toISOString();
  };
  const displayHistory = session => {
    if (Array.isArray(session?.webLog) && session.webLog.length) return session.webLog;
    const source = Array.isArray(session?.history) ? session.history : [];
    return source.filter(m => (m.role === 'user' || m.role === 'assistant') && !/^Результат инструмента /i.test(String(m.content || '')))
      .map((m, index) => ({ id: `legacy_${index}`, role: m.role, content: String(m.content || '').replace(/\n?TOOL_JSON\s*:\s*\{[\s\S]*$/i, '').trim(), ts: Date.parse(session.updatedAt || session.createdAt || '') || Date.now() }))
      .filter(m => m.content);
  };
  const sessionView = name => {
    const valid = safeSessionName(name); const data = valid && sessionStore.sessions[valid];
    if (!data) return null;
    return { id: valid, title: data.title || valid, active: valid === activeSession, ts: Date.parse(data.updatedAt || data.createdAt || '') || Date.now(), model: data.model || currentModel, provider: data.provider || currentProvider, messages: displayHistory(data) };
  };
  const ensureSession = name => {
    const valid = safeSessionName(name); if (!valid) return { error: 'Session name may contain up to 48 letters, digits, _, - and .' };
    if (!sessionStore.sessions[valid]) sessionStore.sessions[valid] = { history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), provider: currentProvider, model: currentModel, workspace: WORKSPACE_ROOT, title: valid, webLog: [] };
    return { name: valid, data: sessionStore.sessions[valid] };
  };
  const safeWebModel = value => {
    const v = String(value || '').trim(); return /^[A-Za-z0-9._:/-]{1,160}$/.test(v) ? v : null;
  };
  const safeWebProvider = value => ['zen', 'openrouter', 'github', 'huggingface'].includes(String(value || '').trim()) ? String(value).trim() : null;
  const webRunSummary = run => ({ id: run.id, session: run.session, status: run.status, createdAt: run.createdAt, finishedAt: run.finishedAt || null, answer: run.answer || null, error: run.error || null, approval: run.approval || null, events: (run.events || []).slice(-300) });
  const launchWebRun = (sessionName, input, requestedModel, requestedProvider) => {
    const run = { id: 'run_' + crypto.randomUUID(), session: sessionName, status: 'queued', createdAt: new Date().toISOString(), answer: null, error: null, approval: null, resolveApproval: null, events: [] };
    HUB_WEB_RUNS.set(run.id, run);
    setImmediate(async () => {
      const oldStreamMode = CONFIG.streamMode;
      try {
        run.status = 'running';
        run.events.push({ id: 'evt_start', type: 'task_started', at: new Date().toISOString(), input: redactSecrets(String(input)).slice(0, 500) });
        const switched = switchSession(sessionName);
        if (switched.error) throw new Error(switched.error);
        if (requestedProvider) currentProvider = requestedProvider;
        if (requestedModel) currentModel = requestedModel;
        if (requestedProvider || requestedModel) saveHistory();
        addWebLog(sessionName, 'user', input); saveSessionStore();
        CONFIG.streamMode = false;
        WEB_AGENT_RUN_CONTEXT = run;
        const answer = await agentLoop(input);
        run.answer = String(answer || 'Задача завершена. Подробности сохранены в сессии.');
        addWebLog(sessionName, 'assistant', run.answer); saveSessionStore();
        run.status = 'completed';
        run.events.push({ id: 'evt_done', type: 'report', at: new Date().toISOString(), text: redactSecrets(run.answer).slice(0, 4000) });
      } catch (e) {
        run.error = redactSecrets(String(e && e.message || e)); run.status = 'error';
        run.events.push({ id: 'evt_error', type: 'error', at: new Date().toISOString(), text: run.error });
        try { addWebLog(sessionName, 'assistant', 'Ошибка: ' + run.error); saveSessionStore(); } catch {}
      } finally {
        CONFIG.streamMode = oldStreamMode;
        if (WEB_AGENT_RUN_CONTEXT === run) WEB_AGENT_RUN_CONTEXT = null;
        run.approval = null; run.resolveApproval = null; run.finishedAt = new Date().toISOString();
      }
    });
    return run;
  };

  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // A file:// copy of the standalone UI has origin "null". Allow CORS only
    // for its local, text-only Zen bridge; no MCP, files, PTY or agent controls.
    const fileStandaloneZen = url.pathname.startsWith('/api/site/zen') && req.headers.origin === 'null';
    if (req.method === 'OPTIONS' && fileStandaloneZen) {
      res.writeHead(204, { 'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', 'Vary': 'Origin' });
      res.end(); return;
    }
    const access = hubAccess(req, url);
    if (!access.authorized) { json(res, 401, { error: 'Unauthorized. LAN use requires ZEN_REMOTE_TOKEN.' }); return; }
    if (fileStandaloneZen) { res.setHeader('Access-Control-Allow-Origin', 'null'); res.setHeader('Vary', 'Origin'); }
    if (access.suppliedByQuery && req.method === 'GET' && url.searchParams.has('token')) {
      // Store the token in a same-origin HttpOnly cookie, then remove it from
      // the visible URL so it is not retained in browser history/referrers.
      url.searchParams.delete('token');
      res.writeHead(302, { 'Set-Cookie': `zen_remote_token=${encodeURIComponent(HUB_REMOTE_TOKEN)}; Path=/; HttpOnly; SameSite=Strict`, 'Location': url.pathname + (url.search || '') });
      res.end(); return;
    }
    if (access.suppliedByQuery) res.setHeader('Set-Cookie', `zen_remote_token=${encodeURIComponent(HUB_REMOTE_TOKEN)}; Path=/; HttpOnly; SameSite=Strict`);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Zen-Token,Authorization' }); res.end(); return; }

    try {
      if (url.pathname === '/healthz' && req.method === 'GET') { json(res, 200, { ok: true, service: 'zen-agent', site: 'single', workspace: WORKSPACE_ROOT }); return; }
      // Core collection mode serves only AIN and its decomposed assets.
      // Hub and standalone have their own servers and proxy only their required APIs here.
      if (CORE_ONLY && req.method === 'GET' && url.pathname === '/collection-config.js') {
        text(res, 200, `window.ZEN_COLLECTION={corePort:${UI_PORT},hubPort:${parseInt(process.env.HUB_PORT || '8766', 10) || 8766},sitePort:${parseInt(process.env.SITE_PORT || '8767', 10) || 8767}};`, 'application/javascript; charset=utf-8'); return;
      }
      // All legacy page URLs intentionally resolve to the same single local app.
      // This keeps old bookmarks working while removing the former hub/agent/site
      // split and the missing external UI-tree dependency.
      const pageAliases = new Set(['/', '/index.html', '/hub', '/hub/', '/agent', '/agent/', '/ain.html', '/site', '/site/', '/standalone.html']);
      if (req.method === 'GET' && pageAliases.has(url.pathname)) {
        text(res, 200, singleSiteHtml(), 'text/html; charset=utf-8'); return;
      }

      if (url.pathname === '/mcp/status' && req.method === 'GET') { json(res, 200, { tools: Object.keys(MCP_TOOLS).map(k => ({ name: k, description: MCP_TOOLS[k] })), connectedClients: 1, platform: PLATFORM, models: ZEN_MODELS, workspace: WORKSPACE_ROOT }); return; }
      if (url.pathname === '/mcp/call' && req.method === 'POST') {
        const body = await readJson(req); const result = await handleMCPTool(body.tool, body.args || {}); json(res, 200, { success: !(result && result.error), result, error: result?.error || undefined }); return;
      }
      // Narrow bridge for standalone/index.html. It deliberately exposes
      // Zen text chat only and accepts no tool calls, workspace paths or keys.
      if (url.pathname === '/api/site/zen/models' && req.method === 'GET') {
        json(res, 200, { success: true, models: ZEN_MODELS }); return;
      }
      if (url.pathname === '/api/site/zen' && req.method === 'POST') {
        const body = await readJson(req);
        const requested = String(body.model || '').trim();
        const model = ZEN_MODELS.some(m => m.id === requested) ? requested : CONFIG.defaultModel;
        const source = Array.isArray(body.messages) ? body.messages : [];
        const messages = source.slice(-24).map(item => ({
          role: ['system', 'user', 'assistant'].includes(item?.role) ? item.role : 'user',
          content: String(item?.content || '').slice(0, 100000)
        })).filter(item => item.content);
        if (!messages.length) { json(res, 400, { error: 'messages are required' }); return; }
        // Reasoning-capable Zen models can consume a tiny budget before emitting
        // any visible answer. Keep Site requests large enough for a final response.
        const maxTokens = Math.max(512, Math.min(8192, parseInt(body.max_tokens || '4096', 10) || 4096));
        const temperature = Math.max(0, Math.min(2, Number(body.temperature ?? 0.7) || 0.7));
        if (body.stream) { await proxyZenStream({ model, messages, max_tokens: maxTokens, temperature, siteMode: true }, res); return; }
        const result = await proxyZenChat({ model, messages, max_tokens: maxTokens, temperature, siteMode: true });
        const textResult = result?.choices?.[0]?.message?.content || '';
        if (!textResult) throw new Error('Zen returned an empty response');
        json(res, 200, { success: true, text: textResult, model: result?._model || model, usage: result?.usage || {} }); return;
      }
      // Compatibility endpoint for clients that intentionally need plain Zen chat.
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const data = await readJson(req);
        if (data.stream) await proxyZenStream(data, res);
        else json(res, 200, await proxyZenChat(data));
        return;
      }

      // ── Termux:API capability status for the hybrid APK/Site. ──
      if (url.pathname === '/api/termux/status' && req.method === 'GET') { json(res, 200, { success: true, ...termuxApiStatus() }); return; }
      // ── Optional online voice through Hugging Face. Browser pages never see HF_TOKEN. ──
      if (url.pathname === '/api/voice/status' && req.method === 'GET') { json(res, 200, { success: true, huggingFaceConfigured: !!huggingFaceToken(), sttModel: 'openai/whisper-large-v3', ttsModel: 'facebook/mms-tts-rus' }); return; }
      if (url.pathname === '/api/voice/stt' && req.method === 'POST') {
        if (!huggingFaceToken()) { json(res, 400, { error: 'Online STT requires HF_TOKEN or HUGGINGFACE_TOKEN in Core environment.' }); return; }
        const body = await readJson(req); const encoded=String(body.audioBase64 || ''); if (!encoded || encoded.length > 6 * 1024 * 1024) { json(res, 400, { error: 'audioBase64 is required and must be at most 6 MB' }); return; }
        const audio=Buffer.from(encoded, 'base64'); const result=await huggingFaceStt(audio, String(body.mime || 'audio/webm'), safeWebModel(body.model) || 'openai/whisper-large-v3'); json(res, 200, { success: true, ...result }); return;
      }
      if (url.pathname === '/api/voice/tts' && req.method === 'POST') {
        if (!huggingFaceToken()) { json(res, 400, { error: 'Online TTS requires HF_TOKEN or HUGGINGFACE_TOKEN in Core environment.' }); return; }
        const body = await readJson(req); const textValue=String(body.text || '').trim(); if (!textValue || textValue.length > 4000) { json(res, 400, { error: 'text is required and must be at most 4000 characters' }); return; }
        const result=await huggingFaceTts(textValue, safeWebModel(body.model) || 'facebook/mms-tts-rus'); json(res, 200, { success: true, ...result }); return;
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') { json(res, 200, { success: true, ...projectListTool(), workspace: WORKSPACE_ROOT, memoryFile: projectMemoryPath() }); return; }
      if (url.pathname === '/api/projects' && req.method === 'POST') {
        const body = await readJson(req); const action = String(body.action || '').toLowerCase(); let result;
        if (action === 'register' || action === 'add') result = registerProjectTool({ alias: body.alias, path: body.path, title: body.title });
        else if (action === 'use' || action === 'open') result = useProjectTool({ alias: body.alias });
        else if (action === 'remove') result = removeProjectTool({ alias: body.alias });
        else result = { error: 'Операция проекта: register, use или remove.' };
        json(res, result?.error ? 400 : 200, { success: !result?.error, result, error: result?.error || undefined }); return;
      }
      // ── Unified console state: proxy pool, GitHub status and audit trail. ──
      if (url.pathname === '/api/proxy/status' && req.method === 'GET') { json(res, 200, { success: true, ...proxyStatus() }); return; }
      if (url.pathname === '/api/proxy' && req.method === 'POST') {
        const body = await readJson(req); const action = String(body.action || '').toLowerCase(); let result;
        if (action === 'add') result = addProxy(body.proxy || body.url);
        else if (action === 'remove') result = removeProxy(body.proxy || body.index);
        else if (action === 'clear') result = clearProxyPool();
        else if (action === 'auto') { CONFIG.proxyFailover = body.enabled !== false; saveNetworkConfig(); result = { success: true, failover: CONFIG.proxyFailover }; }
        else if (action === 'slow') { const ms = Number(body.ms); result = Number.isInteger(ms) && ms >= 1000 && ms <= 120000 ? (CONFIG.proxySlowMs = ms, saveNetworkConfig(), { success: true, slowMs: ms }) : { error: 'Порог должен быть от 1000 до 120000 мс.' }; }
        else if (action === 'test') result = await testProxyPool();
        else result = { error: 'Неизвестная операция прокси.' };
        const failed = !!result?.error || result?.success === false;
        json(res, failed ? 400 : 200, { success: !failed, result, error: result?.error || (result?.success === false ? 'Ни один прокси не ответил.' : undefined) }); return;
      }
      if (url.pathname === '/api/github/status' && req.method === 'GET') {
        const tokenStatus = githubTokenStatus(); let account = null;
        if (tokenStatus.configured) { try { const user = await githubApiRequest('GET', '/user'); account = { login: user.login, name: user.name || user.login, avatar: user.avatar_url || '', url: user.html_url || '' }; } catch {} }
        json(res, 200, { success: true, token: tokenStatus, account, repo: CONFIG.githubRepo || '' }); return;
      }
      if (url.pathname === '/api/github/token' && req.method === 'POST') {
        const body = await readJson(req); const token = String(body.token || '').trim();
        if (!token) { json(res, 400, { success: false, error: 'Token не введён.' }); return; }
        const saved = saveGitHubToken(token);
        if (saved.error) { json(res, 400, { success: false, error: saved.error }); return; }
        let account = null; try { const user = await githubApiRequest('GET', '/user'); account = { login: user.login, name: user.name || user.login, avatar: user.avatar_url || '', url: user.html_url || '' }; } catch (e) { json(res, 400, { success: false, error: 'Token сохранён, но GitHub не подтвердил аккаунт: ' + redactSecrets(e.message || String(e)), token: githubTokenStatus() }); return; }
        json(res, 200, { success: true, token: githubTokenStatus(), account }); return;
      }
      if (url.pathname === '/api/github/repo' && req.method === 'POST') {
        const body = await readJson(req); const checked = githubRepoArgs({ repo: body.repo });
        if (checked.error) { json(res, 400, { success: false, error: checked.error }); return; }
        CONFIG.githubRepo = checked.full; const saved = saveGitHubConfig(); json(res, saved.error ? 500 : 200, { success: !saved.error, repo: CONFIG.githubRepo, error: saved.error || undefined }); return;
      }
      if (url.pathname === '/api/audit' && req.method === 'GET') { json(res, 200, { success: true, records: readAudit(url.searchParams.get('limit') || 80) }); return; }
      // ── Agent Console provider state. Keys are intentionally never accepted here. ──
      if (url.pathname === '/api/agent/settings' && req.method === 'GET') {
        json(res, 200, { success: true, provider: currentProvider, model: currentModel, openRouterConfigured: !!openRouterKey(), githubConfigured: !!githubModelsToken(), huggingFaceConfigured: !!huggingFaceToken(), githubRetiresOn: null, zenModels: ZEN_MODELS, githubModels: ['openai/gpt-4.1', 'openai/gpt-4o', 'meta/llama-3.3-70b-instruct'], githubFreeModels: ['openai/gpt-4.1', 'openai/gpt-4o', 'meta/llama-3.3-70b-instruct'], githubFreeNote: 'GitHub Models предоставляет бесплатную квоту, но она зависит от аккаунта и не является безлимитной.', huggingFaceModels: ['openai/gpt-oss-120b:cerebras', 'google/gemma-4-31B-it:cerebras', 'deepseek-ai/DeepSeek-R1:fastest'] }); return;
      }
      if (url.pathname === '/api/agent/settings' && req.method === 'POST') {
        const body = await readJson(req); const provider = safeWebProvider(body.provider); const model = body.model ? safeWebModel(body.model) : null;
        if (!provider) { json(res, 400, { error: 'provider must be zen, openrouter, github or huggingface' }); return; }
        if (provider === 'openrouter' && !openRouterKey()) { json(res, 400, { error: 'OpenRouter key is not configured. Set it locally with the CLI command /key; never paste it into this web console.' }); return; }
        if (provider === 'github' && !githubModelsToken()) { json(res, 400, { error: 'GitHub Models token is not configured. Set GITHUB_TOKEN or GITHUB_MODELS_TOKEN in the Core environment; never paste it into this web console.' }); return; }
        if (provider === 'huggingface' && !huggingFaceToken()) { json(res, 400, { error: 'Hugging Face token is not configured. Set HF_TOKEN or HUGGINGFACE_TOKEN in the Core environment; never paste it into this web console.' }); return; }
        currentProvider = provider; if (model) currentModel = model; saveHistory();
        json(res, 200, { success: true, provider: currentProvider, model: currentModel, openRouterConfigured: !!openRouterKey() }); return;
      }
      // ── AIN web-agent session API: same persistent store as the CLI agent. ──
      if (url.pathname === '/api/agent/sessions' && req.method === 'GET') {
        loadSessionStore();
        const sessions = listSessions().map(row => { const view = sessionView(row.name); return { ...row, id: row.name, title: view?.title || row.name, ts: view?.ts || Date.now(), webMessages: view?.messages?.length || 0 }; });
        json(res, 200, { success: true, active: activeSession, sessions }); return;
      }
      if (url.pathname === '/api/agent/sessions/select' && req.method === 'POST') {
        const body = await readJson(req); const switched = switchSession(body.name || body.id);
        if (switched.error) { json(res, 400, { success: false, error: switched.error }); return; }
        json(res, 200, { success: true, session: sessionView(switched.name), active: switched.name }); return;
      }
      if (url.pathname === '/api/agent/sessions' && req.method === 'POST') {
        const body = await readJson(req); const ensured = ensureSession(body.name || body.id || crypto.randomUUID());
        if (ensured.error) { json(res, 400, ensured); return; }
        if (body.title) ensured.data.title = String(body.title).slice(0, 120);
        saveSessionStore(); json(res, 201, { success: true, session: sessionView(ensured.name) }); return;
      }
      const sessionMatch = url.pathname.match(/^\/api\/agent\/sessions\/([A-Za-z0-9а-яА-ЯёЁ._-]{1,48})$/);
      if (sessionMatch && req.method === 'GET') { loadSessionStore(); const view = sessionView(decodeURIComponent(sessionMatch[1])); view ? json(res, 200, { success: true, session: view }) : json(res, 404, { error: 'Session not found' }); return; }
      if (sessionMatch && req.method === 'DELETE') {
        const name = decodeURIComponent(sessionMatch[1]); loadSessionStore();
        if (!sessionStore.sessions[name]) { json(res, 404, { error: 'Session not found' }); return; }
        if (name === activeSession || agentBusy) { json(res, 409, { error: 'Cannot delete the active or running session' }); return; }
        delete sessionStore.sessions[name]; saveSessionStore(); json(res, 200, { success: true }); return;
      }
      if (url.pathname === '/api/agent/run' && req.method === 'POST') {
        const body = await readJson(req); const input = String(body.input || body.message || '').trim();
        if (!input) { json(res, 400, { error: 'input is required' }); return; }
        if (agentBusy || [...HUB_WEB_RUNS.values()].some(r => ['queued', 'running', 'awaiting_approval'].includes(r.status))) { json(res, 409, { error: 'The agent is already busy. Continue/correct the active task first.' }); return; }
        const ensured = ensureSession(body.session || body.sessionId || activeSession || 'default');
        if (ensured.error) { json(res, 400, ensured); return; }
        const model = body.model ? safeWebModel(body.model) : null;
        const provider = body.provider ? safeWebProvider(body.provider) : currentProvider;
        if (body.model && !model) { json(res, 400, { error: 'Invalid model id' }); return; }
        if (!provider) { json(res, 400, { error: 'Invalid provider' }); return; }
        if (provider === 'openrouter' && !openRouterKey()) { json(res, 400, { error: 'OpenRouter key is not configured. Set it locally with the CLI command /key; never paste it into this web console.' }); return; }
        if (provider === 'github' && !githubModelsToken()) { json(res, 400, { error: 'GitHub Models token is not configured. Set GITHUB_TOKEN or GITHUB_MODELS_TOKEN in the Core environment; never paste it into this web console.' }); return; }
        if (provider === 'huggingface' && !huggingFaceToken()) { json(res, 400, { error: 'Hugging Face token is not configured. Set HF_TOKEN or HUGGINGFACE_TOKEN in the Core environment; never paste it into this web console.' }); return; }
        const run = launchWebRun(ensured.name, input, model, provider); json(res, 202, { success: true, run: webRunSummary(run) }); return;
      }
      const runMatch = url.pathname.match(/^\/api\/agent\/run\/(run_[A-Za-z0-9-]+)(?:\/(approve|abort))?$/);
      if (runMatch) {
        const run = HUB_WEB_RUNS.get(runMatch[1]); if (!run) { json(res, 404, { error: 'Run not found or expired' }); return; }
        if (!runMatch[2] && req.method === 'GET') { json(res, 200, { success: true, run: webRunSummary(run) }); return; }
        if (runMatch[2] === 'approve' && req.method === 'POST') {
          const body = await readJson(req); if (run.status !== 'awaiting_approval' || typeof run.resolveApproval !== 'function') { json(res, 409, { error: 'No approval is pending' }); return; }
          const allow = body.decision === 'allow'; const resolve = run.resolveApproval; run.resolveApproval = null; run.approval = null; run.status = 'running'; resolve(allow ? 'yes' : 'no'); json(res, 200, { success: true, decision: allow ? 'allow' : 'deny' }); return;
        }
        if (runMatch[2] === 'abort' && req.method === 'POST') {
          abortRequested = true; try { activeProviderAbort?.(); } catch {}
          if (run.resolveApproval) { const resolve = run.resolveApproval; run.resolveApproval = null; resolve('no'); }
          json(res, 200, { success: true }); return;
        }
      }

      // ── Hub dashboard / workspace-only file manager endpoints. ──
      if (url.pathname === '/api/tools' && req.method === 'GET') { json(res, 200, { success: true, tools: HUB_TOOL_DEFS.filter(t => t.id !== '_terminal').map(t => ({ ...t, installed: t.launch ? true : installed(t.cmd), version: null })) }); return; }
      if (url.pathname === '/api/info' && req.method === 'GET') {
        const state = loadHubState(); const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        json(res, 200, { home: WORKSPACE_ROOT, workspace: WORKSPACE_ROOT, platform: process.platform, mode: access.local ? 'local' : 'remote', ip: address, state, terminalAvailable: !!nodePty && !!WebSocketServer, terminalTtlMs: HUB_PTY_TTL_MS }); return;
      }
      if (url.pathname === '/api/path-history' && req.method === 'GET') { const state = loadHubState(); json(res, 200, { success: true, recentPaths: state.recentPaths || [] }); return; }
      if (url.pathname === '/api/path-history' && req.method === 'POST') { const body = await readJson(req); const p = hubPath(body.p); if (p.error) { json(res, 400, p); return; } const state = loadHubState(); state.recentPaths = [p.path, ...(state.recentPaths || []).filter(x => x !== p.path)].slice(0, 50); saveHubState(state); json(res, 200, { success: true, recentPaths: state.recentPaths }); return; }
      const lastDirMatch = url.pathname.match(/^\/api\/last-dir(?:\/([^/]+))?$/);
      if (lastDirMatch && req.method === 'GET') { const state = loadHubState(); json(res, 200, { success: true, dir: state.lastDirs?.[decodeURIComponent(lastDirMatch[1] || '')] || WORKSPACE_ROOT }); return; }
      if (url.pathname === '/api/last-dir' && req.method === 'POST') { const body = await readJson(req); const p = hubPath(body.dir); if (p.error) { json(res, 400, p); return; } const state = loadHubState(); state.lastDirs ||= {}; state.lastDirs[String(body.toolId || '_terminal').slice(0, 80)] = p.path; saveHubState(state); json(res, 200, { success: true }); return; }
      if (url.pathname === '/api/storages' && req.method === 'GET') { json(res, 200, { success: true, storages: [{ id: 'local', name: 'Agent workspace', icon: '📁', root: WORKSPACE_ROOT }] }); return; }
      if (url.pathname === '/api/devices' && req.method === 'GET') { json(res, 200, { success: true, devices: [{ type: 'workspace', id: WORKSPACE_ROOT, name: 'Agent workspace', icon: '📁' }] }); return; }
      if ((url.pathname === '/api/storages/add' || url.pathname.startsWith('/api/adb/')) && ['POST', 'GET'].includes(req.method)) { json(res, 501, { success: false, error: 'Remote storage and ADB from the old Hub were not imported: this unified build deliberately exposes only the active agent workspace.' }); return; }
      if (url.pathname === '/api/browse' && req.method === 'GET') {
        if ((url.searchParams.get('backend') || 'local') !== 'local') { json(res, 400, { success: false, error: 'Only local agent workspace is available' }); return; }
        const target = hubPath(url.searchParams.get('path') || '.'); if (target.error) { json(res, 400, { success: false, error: target.error }); return; }
        const stat = fs.statSync(target.path); if (!stat.isDirectory()) throw new Error('Not a directory');
        const items = fs.readdirSync(target.path, { withFileTypes: true }).filter(e => e.name !== 'node_modules').map(e => {
          const full = path.join(target.path, e.name); let s = null; try { s = fs.statSync(full); } catch {}
          return { name: e.name, path: full, isDir: e.isDirectory(), size: s?.isFile() ? s.size : 0, mtime: s?.mtime || null };
        }).sort((a,b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);
        json(res, 200, { success: true, backend: 'local', path: target.path, parent: path.dirname(target.path), items }); return;
      }
      if (url.pathname === '/api/fs/upload' && req.method === 'POST') {
        // Do not claim success for a multipart format that this single-file runtime
        // cannot parse. The UI uses /api/fs/write, which is fully validated below.
        await readBody(req); json(res, 501, { success: false, error: 'Multipart upload is not supported. Use /api/fs/write with JSON content.' }); return;
      }
      if (url.pathname.startsWith('/api/fs/') && req.method === 'POST') {
        const op = url.pathname.slice('/api/fs/'.length); const body = await readJson(req);
        if ((body.backend || 'local') !== 'local') { json(res, 400, { success: false, error: 'Only local agent workspace is available' }); return; }
        const target = hubPath(body.path || body.oldPath); if (target.error) { json(res, 400, { success: false, error: target.error }); return; }
        const isWorkspaceRoot = path.resolve(target.path) === path.resolve(WORKSPACE_ROOT);
        if (op === 'mkdir') fs.mkdirSync(target.path, { recursive: true });
        else if (op === 'delete') { if (isWorkspaceRoot) { json(res, 400, { success: false, error: 'Cannot delete the active workspace.' }); return; } fs.rmSync(target.path, { recursive: true, force: true }); }
        else if (op === 'rename') { if (isWorkspaceRoot) { json(res, 400, { success: false, error: 'Cannot rename the active workspace.' }); return; } const next = hubPath(body.newPath); if (next.error) { json(res, 400, { success: false, error: next.error }); return; } fs.renameSync(target.path, next.path); }
        else if (op === 'read') {
          if (/(^|[\\/])(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(target.path)) { json(res, 403, { success: false, error: 'Secret files are not readable in the web editor. Use env_list or the local CLI.' }); return; }
          const stat = fs.statSync(target.path); if (!stat.isFile()) throw new Error('Not a file');
          if (stat.size > 8 * 1024 * 1024) throw new Error('File exceeds 8 MiB');
          json(res, 200, { success: true, content: fs.readFileSync(target.path, 'utf8') }); return;
        }
        else if (op === 'write') {
          const content = String(body.content || '');
          if (content.length > 8 * 1024 * 1024) throw new Error('File exceeds 8 MiB');
          if (/OPENROUTER_API_KEY\s*=|sk-or-(?:v1-)?[A-Za-z0-9_-]{16,}/i.test(content)) throw new Error('API keys cannot be written to project files.');
          fs.mkdirSync(path.dirname(target.path), { recursive: true }); fs.writeFileSync(target.path, content, 'utf8');
        }
        else { json(res, 404, { success: false, error: 'Unknown file operation' }); return; }
        json(res, 200, { success: true }); return;
      }
      if (url.pathname === '/api/fs/download' && req.method === 'GET') { const target = hubPath(url.searchParams.get('path')); if (target.error) { json(res, 400, { error: target.error }); return; } const fileName = path.basename(target.path).replace(/[\r\n"]/g, '_'); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${fileName}"` }); fs.createReadStream(target.path).pipe(res); return; }
      if (url.pathname === '/api/models' && req.method === 'GET') { json(res, 200, { success: true, models: getHubModels(), selected: currentModel, provider: currentProvider }); return; }
      if (url.pathname === '/api/models/full' && req.method === 'GET') { const allModels = getHubModels(); json(res, 200, { success: true, models: allModels, providers: MODEL_PROVIDERS.map(p => ({ id: p.id, name: p.name, icon: p.icon, free: !!p.free, configured: providerReady(p.id).ok, keyRequired: !!p.keyRequired, modelCount: allModels.filter(m => m.providerId === p.id).length })).concat(pluginProviderListTool().providers.map(pp => ({ id: pp.id, name: 'Plugin: ' + pp.id, icon: '🧩', free: true, configured: true, keyRequired: false, modelCount: 1 }))), selected: currentModel, provider: currentProvider }); return; }
      if (url.pathname === '/api/models/select' && req.method === 'POST') { const body = await readJson(req); const model = safeWebModel(body.modelId); if (!model) { json(res, 400, { error: 'Invalid model id' }); return; } currentModel = model; const pid = String(body.providerId || body.provider || '').trim(); if (MODEL_PROVIDERS.some(p => p.id === pid) || pluginProviderListTool().providers.some(pp => pp.id === pid)) currentProvider = pid; saveHistory(); json(res, 200, { success: true, selected: currentModel, provider: currentProvider }); return; }
      if (url.pathname === '/api/models/current' && req.method === 'GET') { json(res, 200, { success: true, model: currentModel, provider: currentProvider, apiKeyConfigured: !!openRouterKey() }); return; }
      if ((url.pathname === '/api/models/key' || url.pathname === '/api/models/apikey') && req.method === 'POST') { json(res, 400, { success: false, error: 'API keys are not accepted over the Hub web form. Use the local CLI command /key or a secure environment variable.' }); return; }

      json(res, 404, { error: 'Not found', path: url.pathname });
    } catch (e) { json(res, 500, { error: redactSecrets(String(e && e.message || e)) }); }
  });

  if (WebSocketServer && nodePty) {
    const wss = new WebSocketServer({ server: srv, path: '/ws', verifyClient: info => {
      try { const u = new URL(info.req.url, `http://${info.req.headers.host || 'localhost'}`); return hubAccess(info.req, u).authorized; } catch { return false; }
    } });
    wss.on('connection', ws => {
      let session = null;
      ws.on('message', raw => {
        let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
        try {
          if (msg.type === 'open') {
            const id = safeTerminalId(msg.sessionId) || `term_${Date.now()}`;
            const existing = HUB_PTY_SESSIONS.get(id);
            if (existing) { session = existing; session.resumed = true; attachPtyClient(session, ws); return; }
            const cwd = hubPath(msg.cwd || '.'); if (cwd.error || !fs.existsSync(cwd.path) || !fs.statSync(cwd.path).isDirectory()) throw new Error(cwd.error || 'Terminal working directory does not exist');
            const tool = HUB_TOOL_DEFS.find(t => t.id === msg.toolId);
            if (tool?.launch === 'web') { ws.send(JSON.stringify({ type: 'route', target: '/agent' })); return; }
            const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
            const proc = nodePty.spawn(shell, [], { name: 'xterm-256color', cols: Math.max(20, Math.min(500, Number(msg.cols) || 120)), rows: Math.max(5, Math.min(200, Number(msg.rows) || 30)), cwd: cwd.path, env: { ...process.env, TERM: 'xterm-256color' } });
            session = { id, pty: proc, cwd: cwd.path, clients: new Set(), output: '', closeTimer: null, resumed: false };
            HUB_PTY_SESSIONS.set(id, session);
            proc.onData(data => { session.output = (session.output + data).slice(-262144); ptySend(session, { type: 'output', id: session.id, data }); });
            proc.onExit(({ exitCode }) => { ptySend(session, { type: 'exit', id: session.id, code: exitCode }); HUB_PTY_SESSIONS.delete(session.id); });
            attachPtyClient(session, ws);
            if (tool && tool.cmd) setTimeout(() => { try { proc.write(tool.cmd + '\r'); } catch {} }, 120);
            return;
          }
          if (!session) return;
          if (msg.type === 'input') { const data = String(msg.data || ''); if (data.length <= 32768) session.pty.write(data); }
          else if (msg.type === 'resize') session.pty.resize(Math.max(20, Math.min(500, Number(msg.cols) || 120)), Math.max(5, Math.min(200, Number(msg.rows) || 30)));
          else if (msg.type === 'close') detachPtyClient(session, ws);
        } catch (e) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', error: redactSecrets(String(e.message || e)) })); }
      });
      ws.on('close', () => detachPtyClient(session, ws));
    });
  } else console.log(c('⚠️ Hub xterm disabled: run npm install to install ws and node-pty.', 'yellow'));

  let portAttempts = 0;
  const listenMcp = () => srv.listen(UI_PORT, HUB_BIND_HOST, () => {
    console.log(c(`\n🌐 Unified Agent Site: http://${HUB_BIND_HOST}:${UI_PORT}`, 'green'));
    console.log(c(`   Один сайт: / | MCP: /mcp/call | старые /hub /agent /site ведут сюда | Terminal WS: ${WebSocketServer && nodePty ? '/ws' : 'disabled'}`, 'gray'));
    console.log(c(`   Workspace: ${WORKSPACE_ROOT} | bind: ${HUB_BIND_HOST}`, 'gray'));
    if (!isLoopback(HUB_BIND_HOST) && !HUB_REMOTE_TOKEN) console.log(c(HUB_ALLOW_UNAUTH ? '⚠️ Site доступен без токена: это допустимо только в доверенной локальной сети.' : '🔒 Удалённый доступ закрыт: установи ZEN_REMOTE_TOKEN или ZEN_ALLOW_UNAUTH=1 для доверенной сети.', 'yellow'));
    openHubInBrowser(`http://127.0.0.1:${UI_PORT}/`);
  });
  srv.on('error', err => {
    if (!CORE_ONLY && err.code === 'EADDRINUSE' && portAttempts++ < 10) { const oldPort = UI_PORT; UI_PORT++; console.log(c(`⚠️ MCP-порт ${oldPort} занят; пробую ${UI_PORT}.`, 'yellow')); setTimeout(listenMcp, 20); }
    else { console.log(c('⚠️ MCP server error: ' + err.message, 'yellow')); if (CORE_ONLY) process.exitCode = 1; }
  });
  listenMcp();
  embeddedServer = srv;
}

// ═══════════════════════════════════════════════════════════════════
//  NETWORK DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════
async function checkNetwork() {
  console.log(c('🔍 Проверка сети...', 'gray'));
  const checks = [];
  const allUrls = zenApiModelsUrl();
  const probe = async (url, extra = []) => {
    let parsed = null;
    try { parsed = new URL(url); } catch { return ''; }
    const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || parsed.hostname.endsWith('.localhost');
    if (local && !extra.length) {
      return await new Promise(resolve => {
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.get(parsed, { timeout: 8000 }, response => {
          response.resume();
          response.on('end', () => resolve(String(response.statusCode || '')));
        });
        req.on('error', () => resolve(''));
        req.on('timeout', () => { req.destroy(); resolve(''); });
      });
    }
    const networkArgs = local ? ['--noproxy', '*'] : curlProxyArgs();
    const args = ['-sS', '--connect-timeout', '5', '--max-time', '8', '-o', '/dev/null', '-w', '%{http_code}', ...networkArgs, ...extra, url];
    try { return execFileSync(curlPath(), args, { encoding: 'utf8', timeout: 10000 }).trim(); }
    catch { return ''; }
  };
  const isReachableCode = code => /^[2-5]\d\d$/.test(String(code || ''));

  let reachable = false;
  let activeUrl = null;
  for (const url of allUrls) {
    try {
      const t0 = Date.now();
      const code = await probe(url);
      if (isReachableCode(code)) {
        const label = url.includes('opencode.ai') ? 'opencode.ai' : new URL(url).hostname;
        checks.push(`${c('●', 'green')} ${label} доступен (${code}, ${Date.now() - t0}ms)`);
        reachable = true; activeUrl = url; break;
      }
    } catch {}
  }
  if (!reachable && CONFIG.curlIpv4) {
    const oldIpv4 = CONFIG.curlIpv4;
    CONFIG.curlIpv4 = false;
    try {
      for (const url of allUrls) {
        try {
          const code = await probe(url);
          if (isReachableCode(code)) {
            const label = url.includes('opencode.ai') ? 'opencode.ai' : new URL(url).hostname;
            checks.push(`${c('●', 'green')} ${label} доступен без принудительного IPv4 (${code})`);
            reachable = true; activeUrl = url; break;
          }
        } catch {}
      }
    } finally {
      if (!reachable) CONFIG.curlIpv4 = oldIpv4;
    }
  }

  if (!reachable) {
    checks.push(`${c('○', 'red')} Zen API не ответил — проверяю DNS через DoH...`);
    try {
      const dohResult = await resolveWithDoH('opencode.ai');
      if (dohResult?.ip) {
        checks.push(`${c('●', 'green')} DNS (DoH): opencode.ai → ${dohResult.ip}${dohResult.server ? ` (${dohResult.server})` : ''}`);
        try {
          const t0 = Date.now();
          const code = await probe('https://opencode.ai/zen/v1/models', ['--resolve', `opencode.ai:443:${dohResult.ip}`]);
          if (isReachableCode(code)) {
            checks.push(`${c('●', 'green')} opencode.ai доступен через DoH (${code}, ${Date.now() - t0}ms)`);
            reachable = true; activeUrl = 'https://opencode.ai/zen/v1/models';
          }
        } catch {}
      } else checks.push(`${c('○', 'yellow')} DoH не смог разрешить opencode.ai.`);
    } catch (e) { checks.push(`${c('○', 'yellow')} DoH ошибка: ${String(e.message || e).slice(0, 200)}`); }
  }

  if (!reachable && CONFIG.tunnelEnabled === false) {
    checks.push(`${c('💡', 'yellow')} Сеть моделей недоступна. Включи Android VPN или задай /proxy; автоматический туннель не запускаю без явного запроса.`);
  }
  if (tunnelServer?.listening) checks.push(`${c('●', 'green')} Локальный туннель активен: порт ${CONFIG.tunnelPort}`);
  if (activeUrl && !activeUrl.includes('opencode.ai')) {
    try { CONFIG.zenApiBaseUrl = activeUrl.replace(/\/models\/?$/, '/v1'); } catch {}
    checks.push(`  ${c('🔗', 'cyan')} Активный API: ${activeUrl}`);
  }
  if (CONFIG.proxy) checks.push(`${c('🔗', 'cyan')} Прокси: ${maskProxy(CONFIG.proxy)}`);
  const w = Math.min(68, Math.max(36, termWidth() - 4));
  box(checks.length ? checks : [c('Проверка не вернула данных.', 'yellow')], { width: w, title: ' Сеть ', style: 'single', color: 'gray' }).forEach(l => console.log(l));
  return { reachable, activeUrl, checks: checks.map(stripAnsi) };
}

const SYSTEM_PROMPT = `Ты — AI-ассистент с доступом к файлам и командам только через MCP-инструменты.

ОСОБЫЙ РЕЖИМ TERMUX / ANDROID:
- Рабочая папка MCP находится в общей памяти Android: /storage/emulated/0/...
- Внутренний каталог Termux ($HOME, обычно /data/data/com.termux/files/home) НЕ является папкой проекта. Никогда не ищи там файлы пользователя и не используй его как исходную директорию.
- Все ОТНОСИТЕЛЬНЫЕ пути инструментов автоматически относятся к текущему активному проекту. Не предполагая его имя, сначала вызови workspace_info. Если пользователь явно попросил другую папку, используй абсолютный путь инструмента и не меняй активный проект без необходимости.
- У каждого зарегистрированного проекта есть отдельная память .zen-agent/memory.json с лимитом 50 MiB на JSON-файл. Не записывай туда секреты; используй project_memory только для проверяемых фактов и кратких заметок.
- Для поиска файлов используй list_dir или find_files. Не используй pwd, ls, find, pgrep или grep для поиска проекта во внутренней папке Termux.
- Если пользователь назвал путь /storage/emulated/0/..., передай его инструменту явно. Если нужного проекта нет в текущей папке, используй find_files с path:/storage/emulated/0 и ограниченной глубиной, затем set_workspace с найденной папкой.
- Для проекта Node сначала используй project_inspect. Для сервера используй process_start/process_logs/process_status/process_stop, а для HTTP — health_check или http_request. process_start всегда требует name, command и cwd. Никогда не запускай сервер через node server.js с символом &: такой вызов будет отклонён; также не используй nohup или disown. Для долгой работы используй monitor_start, а не бесконечный polling shell-командами.
- Встроенный MCP-сервер агента по умолчанию работает на 8765, а порт 3000 оставлен проекту. Если process_status показывает running:false, сначала вызови process_logs и прочитай lastLog. Не делай вывод о EADDRINUSE, работающем приложении или его API только по 404: проверяй body и точный ответ.
- Для SQLite используй sqlite_*; для постоянной интерактивной shell-сессии используй terminal_*; для .env используй env_list/env_set/env_delete и никогда не печатай секретные значения в финальном ответе.
- Никогда не используй fuser, lsof, netstat, pgrep/ps|grep или массовое завершение процессов для проверки порта: Android может блокировать /proc. Проверяй только процессы, зарегистрированные через process_start, и реальный HTTP-ответ.
- Для запуска остальных команд используй execute_command только после определения папки проекта. Всегда передавай ARG:cwd:абсолютный_путь_проекта или используй текущую рабочую папку MCP.
- Сеть: Android VPN работает ниже уровня Termux и не требует URL или настройки в агенте. Если сеть моделей недоступна, сообщи, что пользователь должен включить своё VPN-приложение Android и убрать Termux из исключений VPN. Пул прокси управляется командами /proxy add URL и /proxy test; при медленном ответе или ошибке автоматически переключайся на следующий и сообщай об этом.
- НИКОГДА не проси API key в обычном сообщении, не повторяй его, не записывай в .env/файлы проекта и не передавай в custom tools. Для OpenRouter key существует только UI-команда /key. Если ключ уже настроен, просто используй vision_analyze без упоминания секрета.
- Не применяй pkill node, killall node или другие массовые команды уничтожения процессов. Не объявляй сервер запущенным без реальной проверки ответа.
- Не оборачивай URL в Markdown. В shell-командах URL должен быть обычным текстом: http://127.0.0.1:3000/.

ДОСТУПНЫЕ MCP-ИНСТРУМЕНТЫ:
- workspace_info() — показать активную папку, активный проект и память
- set_workspace(path) — выбрать папку проекта в общей памяти Android
- project_list(), project_register(alias, path), project_use(alias), project_remove(alias), project_memory(action, note) — короткие имена проектов и отдельная память каждого проекта
- onnx_status(), onnx_set_model(path), onnx_memory_list(), onnx_memory_add(text), onnx_memory_search(query), onnx_run(inputs) — локальный ONNX и knowledge memory; JSON memory не является автоматическим обучением весов
- project_inspect(path) — сначала проверь package.json, скрипты, зависимости и структуру проекта
- termux_info(), network_check() — диагностика Termux и доступа к серверу моделей через Android VPN
- tree_dir(path), list_dir(path), find_files(query, path), search_text(query, path), file_info(path)
- read_file(path, offset, max_bytes), write_file(path, content), edit_file(path, old, new), append_file(path, content), delete_file(path), mkdir(path), copy_file(source, destination), move_file(source, destination)
- file_backup(path), file_diff(path, backup), archive_create(source, destination), archive_extract(archive, destination)
- process_start(name, command, cwd), process_status(name), process_logs(name, lines, follow_seconds), process_stop(name) — управляемые фоновые серверы и их реальные логи
- monitor_start(process_name, url, interval_seconds), monitor_list(), monitor_logs(id), monitor_stop(id) — локальный health-monitor и автоперезапуск
- terminal_create(id, cwd), terminal_write(id, input), terminal_read(id), terminal_list(), terminal_close(id) — постоянные локальные shell-сессии
- http_request(url, method), health_check(url), websocket_test(url, protocol, event, payload) — реальные HTTP/WebSocket-проверки
- npm_install(packages, cwd), npm_run(script, cwd), run_tests(), run_lint(), code_check(path), dependency_audit()
- sqlite_info(), sqlite_query(database, sql), sqlite_schema(database), sqlite_backup(database, destination) — локальная SQLite
- env_list(path), env_set(key, value), env_delete(key) — .env без показа секретных значений
- git_status(), git_diff(), git_branch(), git_log(), git_init(), git_commit(message), git_push(remote, branch) — Git без угадывания состояния; push только после подтверждения
- github_repo_info(repo), github_commits(repo), github_builds(repo), github_watch_build(repo, run_id), github_download_apk(repo, source, run_id/artifact_name, path) — GitHub API, Actions и APK; token хранится только через локальную команду /git key
- image_info(path), ocr_image(path), vision_analyze(path, prompt, model), vision_ui_audit(path), vision_compare(path, path2) — изображения и скриншоты
- pollinations_generate(prompt, path, model, width, height), pollinations_models() — генерация изображений Pollinations
- custom_tool_list(), custom_tool_create(name, description, code), custom_tool_inspect(name), custom_tool_run(name, tool_args), custom_tool_delete(name) — локальные само-созданные plugins
- subagent_list(), subagent_create(name, description, prompt), subagent_task(agent, prompt), subagent_delete(name) — isolated second-opinion subagents
- plugin_list(), plugin_create(name, description, code), plugin_inspect(name), plugin_tool_list(), plugin_tool_run(plugin, name, tool_args), plugin_provider_list(), plugin_delete(name) — lifecycle plugins
- web_search(query), open_url(url), clipboard_read(), clipboard_write(text), notify(title, content) — сеть и Android Termux:API
- execute_command(command, cwd, timeout) — только для команд, которым нет специального инструмента
- todo_list(), todo_add(text), todo_done(id), todo_remove(id) — постоянный план задач, привязанный к проекту

ФОРМАТ ВЫЗОВА:
- В режиме OpenRouter тебе переданы нативные function tools. Вызывай их через API tool_calls; не печатай TOOL_JSON в обычном тексте.
- В режиме Zen используй строгий текстовый JSON fallback:
  TOOL_JSON:{"tool":"имя_инструмента","args":{"ключ":"значение"}}

Пример Zen fallback:
TOOL_JSON:{"tool":"workspace_info","args":{}}

Для многострочного content, объектов headers, массивов packages и булевых значений используй только TOOL_JSON. Старый формат TOOL:/ARG: поддерживается только для простых аргументов.

ПРИМЕР ПЕРЕД РАБОТОЙ:
TOOL_JSON:{"tool":"workspace_info","args":{}}

ПРИМЕР СМЕНЫ ПРОЕКТА:
TOOL_JSON:{"tool":"set_workspace","args":{"path":"/storage/emulated/0/Alarms/месенджер"}}

ПРИМЕР БЕЗОПАСНОЙ ПРОВЕРКИ:
TOOL_JSON:{"tool":"health_check","args":{"url":"http://127.0.0.1:3000/","timeout":5000}}

ПЛАН И TODO:
- Ты — ГЛАВНЫЙ агент. Для задачи из нескольких действий сначала вызови todo_list, затем todo_add для коротких реальных шагов. Используй рекурсивную иерархию: создай корневую задачу, затем подзадачи через parent:<id>.
- Отмечай статус честно: todo_start — в работе, todo_done — успех, todo_fail — провал (с причиной). Не отмечай задачу готовой без реального результата инструмента. В конце подведи итог: что успешно, что провалилось.
- Перед изменением файла сначала прочитай его; после изменения проверь нужный результат.

ДЕЛЕГИРОВАНИЕ СУБАГЕНТАМ:
- Для нескольких независимых задач запускай субагентов параллельно через subagent_batch с массивом agents:[{agent, prompt, model?}]. Для одной долгой фоновой задачи используй subagent_background и проверяй результат через subagent_status.
- Каждый субагент при сбое модели сам переключится на следующую модель провайдера — ты не обязан указывать model.
- Ты главный и можешь как сам выполнять инструменты, так и обсуждать с пользователем, что добавить/изменить; субагенты — только второе мнение/параллельные подзадачи, они не меняют файлы.

ПРАВИЛА РАБОТЫ:
- Используй MCP-инструменты для файлов и команд, а не догадки.
- Если отсутствует критичное требование (цель приложения, путь проекта, технология, формат данных, риск удаления/перезаписи), сначала задай 1–3 коротких уточняющих вопроса. Не начинай инструменты, пока ответ меняет результат. Не спрашивай очевидное, если текущая MCP-папка и запрос уже однозначны.
- Для нетривиальной задачи сначала дай пользователю короткий публичный блок «🗒 План» из 2–4 шагов и явно назови допущение. После каждого важного результата сообщай короткое наблюдение или решение. Не раскрывай скрытые внутренние рассуждения: показывай только проверяемый план, факты и решения.
- Выполняй одну диагностическую операцию за раз. Проверяй код завершения, вывод и ошибки перед следующим шагом.
- Никогда не утверждай, что прочитал package.json, знаешь зависимости, точку входа, порт или состояние сервера, пока текущая сессия не получила реальный результат соответствующего MCP-инструмента.
- Не ври про сделанное: пиши/изменяй файлы ТОЛЬКО в активной рабочей папке сессии (поле «Активная рабочая папка» в контексте ниже). Если инструмент вернул ошибку или ты не получил успешный результат — не утверждай, что действие выполнено, а честно скажи об ошибке.
- Не лезь в другие MCP-папки и не используй абсолютные пути вне активной рабочей папки без явного запроса пользователя. Запись вне рабочей папки заблокирована и вернёт ошибку.
- Работай с GitHub удалённо через github_read_file / github_list_dir / github_readme / github_write_file — клонировать репозиторий на устройство не требуется.
- Не выдумывай содержимое скриншота. Сначала вызови image_info/ocr_image для локальных фактов либо vision_analyze/vision_ui_audit для visual-анализа. Текстовая модель без vision не видит изображение. Если встроенных инструментов недостаточно, создай изолированный custom tool через custom_tool_create.
- Если пользователь явно просит сохранить проверенное знание для локальной модели, после проверки источника добавь краткий материал через onnx_memory_add. Не сохраняй туда секреты, неподтверждённые догадки или весь необработанный интернет.
- Если ты выводишь JSON-объект с полями tool и args, это обязательно вызов инструмента, а не финальный ответ: после него дождись результата и продолжай задачу.
- Если путь не существует, не продолжай команду через && и не утверждай, что запуск удался.
- Если существующего инструмента действительно недостаточно, сначала вызови custom_tool_list. Затем создай local tool только через custom_tool_create. Код tool должен экспортировать module.exports = async (args, api) => ({...}) и использовать только api.readText/api.writeText/api.list/api.httpGet/api.imageInfo; require/process/import/eval запрещены. После создания вызови custom_tool_run и проверь результат.
- Для lifecycle поведения используй plugin_create. Plugin экспортирует синхронную factory module.exports = (context) => ({ systemPrompt, beforeModel, afterModel, beforeTool, afterTool, permission, event, tools, providers }). Hooks могут быть async, но factory — нет. Plugin не имеет require/process/import/eval. Не создавай plugin, если есть подходящий built-in tool.
- Для больших проектов создавай реальные законченные файлы; не оставляй заглушки, TODO, "реализовать позже" или оборванный код.
- Сначала inspect/read существующий файл. Для изменения используй точечный edit_file; не переписывай весь проект или весь файл без явной необходимости (новый файл, повреждённый файл или прямое требование пользователя).
- В web-console показывай только публичный краткий план, todo, блоки инструментов и финальный отчёт. Не выводи скрытые рассуждения.
- Пиши TOOL: и ARG: как есть, без Markdown.
- Отвечай на русском, кратко объясняя фактический результат.`;

function buildSystemPrompt() {
  const providerRule = currentProvider === 'openrouter'
    ? 'Провайдер OpenRouter: используй только переданные нативные function tools/tool_calls. Инструментальный JSON в тексте не нужен.'
    : currentProvider === 'github'
      ? 'Провайдер GitHub Models: используй переданные нативные function tools/tool_calls, если выбранная модель их поддерживает; иначе дай текстовый ответ без фейкового вызова.'
      : currentProvider === 'huggingface'
        ? 'Провайдер Hugging Face Inference Providers: используй нативные function tools/tool_calls только если модель/маршрутизатор их вернул; иначе дай текстовый ответ без фейкового вызова.'
        : 'Провайдер Zen: нативные tools могут быть недоступны; используй TOOL_JSON fallback строго по схеме.';
  const clarifyRule = CONFIG.askClarifyingQuestions
    ? 'Уточнения включены: при критичной неоднозначности задай короткие вопросы до инструментов. В начале задачи максимум 10 вопросов суммарно; затем зафиксируй допущения и действуй.'
    : 'Уточнения выключены: действуй по разумным допущениям и явно перечисли их в публичном плане.';
  const modeRule = CONFIG.agentMode === 'build'
    ? 'Режим Build: можно выполнять изменения после permission/подтверждения.'
    : `Режим ${AGENT_MODES[CONFIG.agentMode].label}: только анализ, вопросы и план. Изменяющие tools заблокированы permission engine.`;
  const pluginPrompt = pluginSystemPrompts();
  const longRule = CONFIG.longTaskMode
    ? `Долгая задача включена: разрешено до ${agentStepLimit()} шагов и длительные команды. Для серверов используй process_start/process_logs, регулярно давай checkpoint и принимай /correct или /abort.`
    : 'Обычный лимит задачи: используй короткие безопасные шаги; для многочасовой работы пользователь включает /long on.';
  return SYSTEM_PROMPT + `\n\nТЕКУЩИЙ КОНТЕКСТ MCP:\n- Платформа: ${PLATFORM.name}\n- Провайдер: ${currentProvider}\n- Модель: ${currentModel}\n- Режим: ${CONFIG.agentMode}\n- Активная AI-сессия: ${activeSession}\n- Активный проект: ${CONFIG.activeProject || 'не зарегистрирован'}\n- Активная рабочая папка: ${WORKSPACE_ROOT}\n- Файл памяти проекта: ${projectMemoryPath()}\n- ${providerRule}\n- ${clarifyRule}\n- ${modeRule}\n- ${longRule}\n- Относительные пути разрешаются от неё; внутренняя папка Termux не используется.${pluginPrompt ? `\n\nPLUGIN SYSTEM INSTRUCTIONS:\n${pluginPrompt}` : ''}`;
}

// ═══════════════════════════════════════════════════════════════════
//  ZEN API (curl-based)
// ═══════════════════════════════════════════════════════════════════
async function callZenDirectSingle(messages, model = currentModel, stream = false, proxyOverride = undefined) {
  if (proxyOverride !== undefined) CONFIG.proxy = proxyOverride || '';
  const payload = {
    model,
    messages,
    max_tokens: CONFIG.maxTokens,
    temperature: CONFIG.temperature,
    stream: !!stream
  };
  if (CONFIG.reasoningEffort) payload.reasoning_effort = CONFIG.reasoningEffort;

  const data = JSON.stringify(payload);

  if (stream) {
    return new Promise((resolve, reject) => {
      let outputShown = false, fullText = '', usage = {}, thinking = '', sseBuffer = '', settled = false, softTimer = null;
      const tmpFile = path.join(os.tmpdir(), 'zen_cli_req_' + Date.now() + '.json');
      fs.writeFileSync(tmpFile, data, 'utf8');
      startAiStream('Zen', model);
      const curlProc = spawn(curlPath(), [
        '-s', '--no-buffer', '--connect-timeout', '10', '--max-time', '60',
        ...(CONFIG.proxy ? ['-x', CONFIG.proxy] : []), ...(CONFIG.curlIpv4 ? ['--ipv4'] : []),
        '-X', 'POST', (zenApiChatUrl()[0] || 'https://opencode.ai/zen/v1/chat/completions'),
        '-H', 'Content-Type: application/json', '-d', '@' + tmpFile
      ]);
      const abortThis = () => { try { curlProc.kill('SIGTERM'); } catch {}; finish(new Error('Zen stream aborted by user')); };
      activeProviderAbort = abortThis;
      const finish = (error = null) => {
        if (settled) return; settled = true;
        if (softTimer) clearTimeout(softTimer);
        if (activeProviderAbort === abortThis) activeProviderAbort = null;
        try { fs.unlinkSync(tmpFile); } catch {}
        if (error) { finishAiStream('error'); reject(error); }
        else { finishAiStream('completed'); resolve({ text: fullText, model, usage, thinking, outputShown, provider: 'zen' }); }
      };
      const consumeEvent = event => {
        for (const line of event.replace(/\r/g, '').split('\n')) {
          if (!line.startsWith('data:')) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;
          try {
            const j = JSON.parse(jsonStr); const delta = j.choices?.[0]?.delta;
            if (delta?.content) { fullText += delta.content; writeAiStreamText(delta.content); outputShown = true; }
            if (delta?.reasoning_content || delta?.reasoning) thinking += (delta.reasoning_content || delta.reasoning);
            if (j.usage) usage = j.usage;
          } catch {}
        }
      };
      curlProc.stdout.on('data', chunk => {
        if (softTimer) { clearTimeout(softTimer); softTimer = null; }
        sseBuffer += chunk.toString();
        const events = sseBuffer.split(/\r?\n\r?\n/); sseBuffer = events.pop() || '';
        events.forEach(consumeEvent);
      });
      let stderr = '';
      curlProc.stderr.on('data', chunk => stderr += chunk.toString());
      if (proxyOverride && CONFIG.proxyFailover && CONFIG.proxyPool.length > 1) {
        softTimer = setTimeout(() => { try { curlProc.kill('SIGTERM'); } catch {}; finish(new Error(`Прокси не начал отвечать за ${CONFIG.proxySlowMs} мс`)); }, CONFIG.proxySlowMs);
        softTimer.unref?.();
      }
      curlProc.on('close', code => { if (sseBuffer) consumeEvent(sseBuffer); if (code !== 0) finish(new Error(('Zen stream failed: ' + (stderr || `curl exit ${code}`)).slice(0, 300))); else finish(); });
      curlProc.on('error', err => finish(err));
    });
  } else {
    const tmpFile = path.join(os.tmpdir(), 'zen_cli_req_' + Date.now() + '.json');
    fs.writeFileSync(tmpFile, data, 'utf8');
    // Не execSync: event loop остаётся живым, поэтому индикатор, /correct и /abort не «зависают».
    return await new Promise((resolve, reject) => {
      const curlArgs = [
        '-s', '--connect-timeout', '10', '--max-time', '60',
        ...(CONFIG.proxy ? ['-x', CONFIG.proxy] : []),
        ...(CONFIG.curlIpv4 ? ['--ipv4'] : []),
        '-X', 'POST', (zenApiChatUrl()[0] || 'https://opencode.ai/zen/v1/chat/completions'),
        '-H', 'Content-Type: application/json', '-d', '@' + tmpFile
      ];
      let output = '', stderr = '', settled = false, abortThis = null, timeout = null, softTimer = null;
      const finish = (error, value) => {
        if (settled) return; settled = true; if (timeout) clearTimeout(timeout); if (softTimer) clearTimeout(softTimer);
        if (activeProviderAbort === abortThis) activeProviderAbort = null;
        try { fs.unlinkSync(tmpFile); } catch {}
        if (error) reject(error); else resolve(value);
      };
      const proc = spawn(curlPath(), curlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      abortThis = () => { try { proc.kill('SIGTERM'); } catch {}; finish(new Error('Zen request aborted by user')); };
      activeProviderAbort = abortThis;
      timeout = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {}; finish(new Error('Zen request timeout (65s)')); }, 65000);
      proc.stdout.on('data', chunk => { if (softTimer) { clearTimeout(softTimer); softTimer = null; } output += chunk.toString(); });
      proc.stderr.on('data', chunk => stderr += chunk.toString());
      if (proxyOverride && CONFIG.proxyFailover && CONFIG.proxyPool.length > 1) {
        softTimer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {}; finish(new Error(`Прокси не начал отвечать за ${CONFIG.proxySlowMs} мс`)); }, CONFIG.proxySlowMs);
        softTimer.unref?.();
      }
      proc.on('error', err => finish(new Error('Zen request failed: ' + err.message)));
      proc.on('close', code => {
        if (settled) return;
        if (code !== 0) { finish(new Error('Zen request failed: ' + (stderr || `curl exit ${code}`).slice(0, 300))); return; }
        if (isRateLimit(output)) { finish(new Error('Rate limit: ' + output.slice(0, 200))); return; }
        try {
          const json = JSON.parse(output);
          if (json.error || json.type === 'error' || isRateLimit(output)) { finish(new Error('Zen API error: ' + (json.error?.message || json.message || output.slice(0, 300)))); return; }
          const choice = json.choices?.[0] || {};
          const msg = choice.message || {};
          let text = msg.content || '';
          const reasoning = msg.reasoning_content || msg.reasoning || '';
          if (!text && reasoning) text = reasoning;
          finish(null, { text, reasoning: reasoning || null, model: json.model || model, usage: json.usage || {}, thinking: '', outputShown: false, provider: 'zen' });
        } catch (e) {
          const cm = output.match(/"content"\s*:\s*"([\s\S]*?)"\s*,\s*"refusal"/);
          if (cm) finish(null, { text: cm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'), reasoning: null, model, usage: {}, outputShown: false, provider: 'zen' });
          else finish(new Error('Zen parse error: ' + output.slice(0, 300)));
        }
      });
    });
  }
}

async function callZenDirect(messages, model = currentModel, stream = false) {
  const candidates = proxyCandidates();
  let lastError = null;
  for (let index = 0; index < candidates.length; index++) {
    const proxy = candidates[index] || '';
    const started = Date.now();
    try {
      const result = await callZenDirectSingle(messages, model, stream, proxy);
      markProxyResult(proxy, Date.now() - started, true);
      return result;
    } catch (error) {
      lastError = error;
      markProxyResult(proxy, Date.now() - started, false, error?.message || String(error));
      if (!CONFIG.proxyFailover || index >= candidates.length - 1) break;
      // markProxyResult rotates the active proxy and prints a Russian notice.
    }
  }
  throw lastError || new Error('Zen API: все доступные прокси не ответили');
}

function nextModel(model) {
  const idx = ZEN_MODELS.findIndex(m => m.id === model);
  return ZEN_MODELS[(idx + 1) % ZEN_MODELS.length].id;
}

async function callZenWithRetry(messages, model = currentModel, maxAttempts = CONFIG.maxProviderRetries, stream = false) {
  let lastErr = new Error('Неизвестная ошибка Zen API');
  let usedModel = model;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (typeof TELEMETRY === 'object') TELEMETRY.model = usedModel;
    if (agentBusy) setRunPhase('model', `Zen • ${usedModel} • попытка ${attempt}/${maxAttempts}`);
    try {
      const res = await callZenDirect(messages, usedModel, stream);
      if (usedModel !== model) {
        currentModel = usedModel;
        console.log(`\n${c('✅ Переключено на модель: ' + usedModel, 'green')}`);
      }
      return res;
    } catch (e) {
      lastErr = e;
      const rateLimited = isRateLimit(e.message);
      // Если провайдер/апстрим вернул 5xx — модель сейчас недоступна, переходим
      // на следующую сразу (не мучаем пользователя тремя бесполезными ретраями).
      const serverDown = isServerError(e.message);
      if (attempt < maxAttempts) {
        if (rateLimited || serverDown) {
          const prev = usedModel;
          usedModel = nextModel(usedModel);
          const reason = rateLimited
            ? rateLimitReason(e.message)
            : 'провайдер вернул ошибку сервера (модель сейчас недоступна)';
          console.log(`\n${c('⚠️ ' + reason + ' на ' + prev + '. Переключаюсь на ' + usedModel + '...', 'yellow')}`);
          await new Promise(r => setTimeout(r, 700));
        } else {
          const wait = 650 * attempt;
          console.log(`\n${c('⚠️ Попытка ' + attempt + '/' + maxAttempts + ' не удалась: ' + providerErrorSummary(e) + '. Повтор через ' + (wait / 1000) + ' с...', 'yellow')}`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }
  }
  throw lastErr;
}


// ═══════════════════════════════════════════════════════════════════
//  OPENROUTER PROVIDER — native function/tool calling when available
// ═══════════════════════════════════════════════════════════════════
// Актуальные free-модели OpenRouter, сверены с /api/v1/models (авг 2026).
// Старые id (gemma-3-27b-it:free, llama-3.3-70b-instruct:free, qwen3-30b-a3b:free)
// удалены: OpenRouter вернул на них 404 "Model not found".
const OPENROUTER_FREE_FALLBACK = [
  { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B IT', ctx: '262K', vision: true },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B', ctx: '1000K' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B', ctx: '262K' },
  { id: 'openai/gpt-oss-20b:free', name: 'GPT-OSS 20B', ctx: '131K' },
  { id: 'cohere/north-mini-code:free', name: 'North Mini Code', ctx: '256K' }
];
let openRouterFreeModels = [...OPENROUTER_FREE_FALLBACK];

const OPENROUTER_KEY_FILE = path.join(os.homedir(), '.zen_openrouter_key.json');
function looksLikeOpenRouterKey(value) {
  return /^sk-or-(?:v1-)?[A-Za-z0-9_-]{16,}$/i.test(String(value || '').trim());
}
function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/sk-or-(?:v1-)?[A-Za-z0-9_-]{16,}/gi, '[OPENROUTER_KEY_REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[GITHUB_TOKEN_REDACTED]')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:^|[\s;])(?:[A-Za-z_][A-Za-z0-9_]*?(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET)|API[_-]?KEY|TOKEN|PASSWORD|SECRET)\s*[=:]\s*)[^\s,;]+/gim, '$1[SECRET_REDACTED]');
}
function scrubHistorySecrets() {
  for (const message of history || []) {
    if (typeof message.content === 'string') message.content = redactSecrets(message.content);
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) if (typeof call?.function?.arguments === 'string') call.function.arguments = redactSecrets(call.function.arguments);
    }
  }
}
function saveKeyFromCommand(value) {
  const raw = String(value || '').trim().replace(/^set\s+/i, '');
  if (!looksLikeOpenRouterKey(raw)) return { error: 'Нужен OpenRouter key формата sk-or-... Используй /key без аргумента для Android password-dialog.' };
  const result = saveOpenRouterKey(raw);
  scrubHistorySecrets();
  return result;
}
function maskOpenRouterKey(key) {
  const value = String(key || '');
  return value.length >= 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : (value ? '***' : 'не задан');
}
function loadOpenRouterKey() {
  // Явная переменная окружения всегда имеет приоритет над локальным секретом.
  if (process.env.OPENROUTER_API_KEY) { CONFIG.openRouterApiKey = process.env.OPENROUTER_API_KEY; return; }
  try {
    const saved = JSON.parse(fs.readFileSync(OPENROUTER_KEY_FILE, 'utf8'));
    if (saved && typeof saved.key === 'string' && saved.key.trim()) CONFIG.openRouterApiKey = saved.key.trim();
  } catch {}
}
function saveOpenRouterKey(key) {
  const value = String(key || '').trim().replace(/[\r\n]/g, '');
  if (value.length < 8) return { error: 'Ключ слишком короткий.' };
  try {
    fs.writeFileSync(OPENROUTER_KEY_FILE, JSON.stringify({ key: value, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(OPENROUTER_KEY_FILE, 0o600); } catch {}
    CONFIG.openRouterApiKey = value;
    return { success: true, masked: maskOpenRouterKey(value), source: 'local secure file' };
  } catch (e) { return { error: 'Не удалось сохранить ключ: ' + e.message }; }
}
function clearOpenRouterKey() {
  CONFIG.openRouterApiKey = '';
  try { fs.unlinkSync(OPENROUTER_KEY_FILE); } catch {}
  return { success: true, environmentStillSet: !!process.env.OPENROUTER_API_KEY };
}
function openRouterKeyStatus() {
  const key = openRouterKey();
  return { configured: !!key, masked: maskOpenRouterKey(key), source: process.env.OPENROUTER_API_KEY ? 'environment' : (fs.existsSync(OPENROUTER_KEY_FILE) ? 'local secure file' : 'none') };
}
function openSecretKeyInput() {
  // termux-dialog password показывает системное Android password-поле, а не TTY.
  // Поэтому ключ не попадает ни в scrollback, ни в историю shell.
  if (!PLATFORM.isTermux) return false;
  try {
    const raw = execFileSync('termux-dialog', ['-t', 'password', '-i', 'OpenRouter API key'], { encoding: 'utf8', timeout: 120000 });
    const result = JSON.parse(raw || '{}');
    if (result.code !== undefined && Number(result.code) !== 0) { console.log(c('Ввод ключа отменён.', 'gray')); return true; }
    const key = String(result.text || '').trim();
    if (!key) { console.log(c('Ключ не введён.', 'gray')); return true; }
    const saved = saveOpenRouterKey(key);
    console.log(saved.error ? c('✗ ' + saved.error, 'red') : c(`✓ OpenRouter key сохранён: ${saved.masked}`, 'green'));
    return true;
  } catch {
    return false;
  }
}
function openRouterKey() { return CONFIG.openRouterApiKey || process.env.OPENROUTER_API_KEY || ''; }
function openRouterRequest(payload) {
  return new Promise((resolve, reject) => {
    const key = openRouterKey();
    if (!key) { reject(new Error('Не задан OPENROUTER_API_KEY. В Termux: export OPENROUTER_API_KEY="..."')); return; }
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'openrouter.ai', port: 443, path: '/api/v1/chat/completions', method: 'POST', timeout: 90000,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${key}`, 'HTTP-Referer': 'https://termux-local-agent', 'X-Title': 'Termux MCP Agent'
      }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', part => raw += part);
      res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = parsed?.error?.message || raw.slice(0, 500) || `HTTP ${res.statusCode}`;
          reject(new Error(`OpenRouter HTTP ${res.statusCode}: ${message}`)); return;
        }
        if (!parsed) { reject(new Error('OpenRouter вернул не-JSON ответ.')); return; }
        resolve(parsed);
      });
    });
    const abortThisRequest = () => req.destroy(new Error('OpenRouter request aborted by user'));
    activeProviderAbort = abortThisRequest;
    req.on('error', err => { if (activeProviderAbort === abortThisRequest) activeProviderAbort = null; reject(err); });
    req.on('timeout', () => req.destroy(new Error('OpenRouter timeout')));
    req.on('close', () => { if (activeProviderAbort === abortThisRequest) activeProviderAbort = null; });
    req.write(body); req.end();
  });
}

async function fetchOpenRouterFreeModels() {
  return await new Promise(resolve => {
    const req = https.request({ hostname: 'openrouter.ai', port: 443, path: '/api/v1/models', method: 'GET', timeout: 15000, headers: openRouterKey() ? { Authorization: `Bearer ${openRouterKey()}` } : {} }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', part => raw += part);
      res.on('end', () => {
        try {
          const all = JSON.parse(raw).data || [];
          const free = all.filter(model => String(model.id || '').endsWith(':free') || model.id === 'openrouter/free')
            .map(model => ({ id: model.id, name: model.name || model.id, ctx: model.context_length ? String(model.context_length) : 'free' }));
          if (free.length) openRouterFreeModels = free;
        } catch {}
        resolve(openRouterFreeModels);
      });
    });
    req.on('error', () => resolve(openRouterFreeModels));
    req.on('timeout', () => { req.destroy(); resolve(openRouterFreeModels); });
    req.end();
  });
}

function githubModelsToken() { return process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || githubToken(); }
const HF_TOKEN_FILE = path.join(os.homedir(), '.zen_hf_token.json');
function huggingFaceToken() {
  if (process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN) return process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  try { const saved = JSON.parse(fs.readFileSync(HF_TOKEN_FILE, 'utf8')); if (saved && typeof saved.token === 'string' && saved.token.trim()) return saved.token.trim(); } catch {}
  return '';
}
function saveHfToken(value) {
  const token = String(value || '').trim().replace(/^set\s+/i, '').replace(/[\r\n]/g, '');
  if (!/^hf_[A-Za-z0-9]{10,}$/.test(token)) return { error: 'Нужен Hugging Face token: hf_...' };
  try {
    fs.writeFileSync(HF_TOKEN_FILE, JSON.stringify({ token, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(HF_TOKEN_FILE, 0o600); } catch {}
    return { success: true, masked: token.slice(0, 4) + '…' + token.slice(-4), source: 'локальный защищённый файл' };
  } catch (e) { return { error: 'Не удалось сохранить HF token: ' + e.message }; }
}
function clearHfToken() {
  try { fs.unlinkSync(HF_TOKEN_FILE); } catch {}
  return { success: true, environmentStillSet: !!(process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN) };
}
const COMPATIBLE_PROVIDERS = {
  // GitHub Models: официальный endpoint. ВАЖНО: принимает ТОЛЬКО fine-grained
  // токен (github_pat_...) с правом Models:Read. Классический ghp_ не работает.
  github: { label: 'GitHub Models', hostname: 'models.github.ai', path: '/inference/chat/completions', key: githubModelsToken, defaultModel: 'openai/gpt-4.1', headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } },
  huggingface: { label: 'Hugging Face Inference Providers', hostname: 'router.huggingface.co', path: '/v1/chat/completions', key: huggingFaceToken, defaultModel: 'openai/gpt-oss-120b:cerebras', headers: {} }
};

// ═══════════════════════════════════════════════════════════════════
//  MODEL CATALOG — единый реестр провайдеров и моделей.
//  Провайдеры можно совмещать (как плагины): zen (без ключа), openrouter
//  (free+paid), github / huggingface (по токену), плюс lifecycle-plugin
//  провайдеры, которые уже регистрируются через pluginProviderListTool().
// ═══════════════════════════════════════════════════════════════════
const MODEL_PROVIDERS = [
  { id: 'zen', name: 'OpenCode Zen', icon: '🟢', free: true, keyRequired: false, keyHint: 'ключ не нужен', defaultModel: 'deepseek-v4-flash-free', tag: 'встроенный, без ключа' },
  { id: 'openrouter', name: 'OpenRouter', icon: '🟣', free: true, keyRequired: true, keyHint: 'OPENROUTER_API_KEY или /key', defaultModel: 'google/gemma-4-31b-it:free', dynamic: true, tag: 'free + платные' },
  { id: 'github', name: 'GitHub Models', icon: '🐙', free: true, keyRequired: true, keyHint: 'GITHUB_TOKEN или GITHUB_MODELS_TOKEN', defaultModel: 'openai/gpt-4.1', tag: 'бесплатная квота по токену' },
  { id: 'huggingface', name: 'Hugging Face', icon: '🤗', free: true, keyRequired: true, keyHint: 'HF_TOKEN или HUGGINGFACE_TOKEN', defaultModel: 'openai/gpt-oss-120b:cerebras', tag: 'inference providers' }
];

// Free-модели GitHub Models (бесплатная квота; токен GITHUB_TOKEN / GITHUB_MODELS_TOKEN).
const GITHUB_MODELS = [
  { id: 'openai/gpt-4.1', name: 'GPT-4.1', ctx: '200K', tier: 'free' },
  { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini', ctx: '1M', tier: 'free' },
  { id: 'openai/gpt-4.1-nano', name: 'GPT-4.1 Nano', ctx: '1M', tier: 'free' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', ctx: '128K', tier: 'free' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', ctx: '128K', tier: 'free' },
  { id: 'openai/o4-mini', name: 'o4-mini', ctx: '200K', tier: 'free', reasoning: true },
  { id: 'openai/o3-mini', name: 'o3-mini', ctx: '200K', tier: 'free', reasoning: true },
  { id: 'deepseek-ai/deepseek-r1', name: 'DeepSeek R1', ctx: '64K', tier: 'free', reasoning: true },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', ctx: '128K', tier: 'free' },
  { id: 'microsoft/phi-4', name: 'Phi-4', ctx: '16K', tier: 'free' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large', ctx: '128K', tier: 'free' },
  { id: 'cohere/command-r-plus', name: 'Command R+', ctx: '128K', tier: 'free' }
];

// Hugging Face Inference Providers (нужен HF_TOKEN / HUGGINGFACE_TOKEN).
// Модели проверены через router.huggingface.co (авг 2026). Устаревшие id
// (gpt-oss-120b:cerebras без проверки и т.п.) заменены на реально работающие.
const HUGGINGFACE_MODELS = [
  { id: 'openai/gpt-oss-120b:cerebras', name: 'GPT-OSS 120B', ctx: '131K', tier: 'free' },
  { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', name: 'Qwen3 235B', ctx: '131K', tier: 'free' },
  { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', name: 'Qwen3 Coder 480B', ctx: '131K', tier: 'free' },
  { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', ctx: '128K', tier: 'free' },
  { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', name: 'Llama 4 Scout 17B', ctx: '128K', tier: 'free' },
  { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B', ctx: '128K', tier: 'free' },
  { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', name: 'Qwen2.5 Coder 32B', ctx: '128K', tier: 'free' },
  { id: 'microsoft/phi-4', name: 'Phi-4', ctx: '16K', tier: 'free' }
];

// Курируемый список платных OpenRouter-моделей (для отдельного списка /models).
const OPENROUTER_PAID_FALLBACK = [
  { id: 'openai/gpt-5', name: 'GPT-5', ctx: '272K', tier: 'paid' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', ctx: '128K', tier: 'paid' },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', ctx: '200K', tier: 'paid' },
  { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', ctx: '200K', tier: 'paid' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', ctx: '1M', tier: 'paid' },
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', ctx: '1M', tier: 'paid' },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', ctx: '64K', tier: 'paid', reasoning: true },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', ctx: '128K', tier: 'paid' },
  { id: 'qwen/qwen3-30b-a3b', name: 'Qwen3 30B A3B', ctx: '32K', tier: 'paid' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large', ctx: '128K', tier: 'paid' }
];

// Другие CLI-агенты, которые можно установить/запустить через npx или npm
// (на ПК/Linux/Termux). Каждая запись: package (npm), npx (команда запуска),
// как ставится, откуда (бинарник из npm). Терминал агента и execute_command
// могут вызвать их; установка — через /install-agent <package>.
const HUB_AGENTS = [
  { name: 'Claude Code', pkg: '@anthropic-ai/claude-code', npx: 'claude', install: 'npm i -g @anthropic-ai/claude-code', key: 'ANTHROPIC_API_KEY', desc: 'Anthropic CLI (Termux-совместим), мощный агент для кода' },
  { name: 'Codex CLI', pkg: '@openai/codex', npx: 'codex', install: 'npm i -g @openai/codex', key: 'OPENAI_API_KEY', desc: 'OpenAI-агент в терминале' },
  { name: 'Aider', pkg: 'aider-chat', npx: 'aider', install: 'pip install aider-chat  (или npm?)', key: 'OPENAI_API_KEY', desc: 'Парный AI-программист (Python/pip)' },
  { name: 'OpenCode', pkg: 'opencode-ai', npx: 'opencode', install: 'npm i -g opencode-ai', key: 'ANTHROPIC_API_KEY', desc: 'Терминальный AI-агент, есть и CLI' },
  { name: 'Grok CLI', pkg: '@xai/grok', npx: 'grok', install: 'npm i -g @xai/grok', key: 'XAI_API_KEY', desc: 'xAI Grok в терминале' },
  { name: 'Gemini CLI', pkg: '@google/gemini-cli', npx: '@google/gemini-cli', install: 'npm i -g @google/gemini-cli', key: 'GEMINI_API_KEY', desc: 'Google Gemini агент' },
  { name: 'Amp', pkg: '@ax-llm/amp', npx: 'amp', install: 'npm i -g @ax-llm/amp', key: 'ANTHROPIC_API_KEY', desc: 'AI-агент от Sourcegraph' }
];
function agentNpxCmd(agent) {
  return `npx -y ${agent.npx || agent.pkg} --help`;
}
function providerMeta(id) {
  return MODEL_PROVIDERS.find(p => p.id === id) || null;
}
function providerKeyRequired(id) {
  return MODEL_PROVIDERS.find(p => p.id === id)?.keyRequired ?? false;
}
function providerReady(id) {
  if (id === 'zen') return { ok: true, reason: null };
  if (id === 'openrouter') return openRouterKey() ? { ok: true, reason: null } : { ok: false, reason: 'нет OpenRouter ключа: /key' };
  if (id === 'github') {
    const t = githubModelsToken();
    if (!t) return { ok: false, reason: 'нет GitHub Models токена: GITHUB_MODELS_TOKEN (fine-grained, Models:Read)' };
    if (/^ghp_/i.test(t)) return { ok: false, reason: 'классический ghp_ токен не работает для GitHub Models — нужен fine-grained github_pat_... с правом Models:Read' };
    return { ok: true, reason: null };
  }
  if (id === 'huggingface') return huggingFaceToken() ? { ok: true, reason: null } : { ok: false, reason: 'нет HF_TOKEN/HUGGINGFACE_TOKEN' };
  return { ok: true, reason: null };
}
function staticModelsFor(id) {
  if (id === 'zen') return ZEN_MODELS.map(m => ({ id: m.id, name: m.name, ctx: m.ctx, tier: 'free', provider: 'zen' }));
  if (id === 'github') return GITHUB_MODELS.map(m => ({ ...m, provider: 'github' }));
  if (id === 'huggingface') return HUGGINGFACE_MODELS.map(m => ({ ...m, provider: 'huggingface' }));
  return [];
}
function openRouterModelsCached() {
  return {
    free: openRouterFreeModels.map(m => ({ id: m.id, name: m.name, ctx: m.ctx, tier: 'free', provider: 'openrouter' })),
    paid: OPENROUTER_PAID_FALLBACK.map(m => ({ ...m, provider: 'openrouter' }))
  };
}
async function fetchOpenRouterCatalog() {
  const live = await new Promise(resolve => {
    const req = https.request({ hostname: 'openrouter.ai', port: 443, path: '/api/v1/models', method: 'GET', timeout: 15000, headers: openRouterKey() ? { Authorization: `Bearer ${openRouterKey()}` } : {} }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const all = JSON.parse(raw).data || [];
          const free = all.filter(m => String(m.id || '').endsWith(':free'))
            .map(m => ({ id: m.id, name: m.name || m.id, ctx: m.context_length ? String(m.context_length) : 'free', tier: 'free', provider: 'openrouter' }));
          // Платные — только если ключ задан (иначе списка толком нет).
          const paid = all.filter(m => !String(m.id || '').endsWith(':free'))
            .slice(0, 40)
            .map(m => ({ id: m.id, name: m.name || m.id, ctx: m.context_length ? String(m.context_length) : '', tier: 'paid', provider: 'openrouter' }));
          if (free.length) openRouterFreeModels = free.map(({ name, ctx, ...m }) => ({ id: m.id, name, ctx }));
          resolve({ free: free.length ? free : openRouterModelsCached().free, paid: paid.length ? paid : OPENROUTER_PAID_FALLBACK });
        } catch { resolve(openRouterModelsCached()); }
      });
    });
    req.on('error', () => resolve(openRouterModelsCached()));
    req.on('timeout', () => { req.destroy(); resolve(openRouterModelsCached()); });
    req.end();
  });
  return live;
}
// Полный список моделей выбранного провайдера (free и paid раздельно).
async function listModelsForProvider(id = currentProvider) {
  if (id === 'openrouter') return await fetchOpenRouterCatalog();
  return { free: staticModelsFor(id), paid: [] };
}
// Провайдеры для меню (встроенные + lifecycle-plugin провайдеры).
function allProvidersMenu() {
  const builtins = MODEL_PROVIDERS.map(p => ({ id: p.id, label: p.name, icon: p.icon, description: `${p.tag}${p.keyRequired ? ` • ${p.keyHint}` : ''}`, meta: p }));
  const plugins = pluginProviderListTool().providers.map(p => ({ id: p.id, label: `Plugin: ${p.id}`, icon: '🧩', description: p.description || p.endpoint || '', meta: { plugin: true } }));
  return [...builtins, ...plugins];
}
async function callCompatibleProvider(providerId, messages, model = currentModel) {
  const provider = COMPATIBLE_PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown compatible provider '${providerId}'.`);
  const key = provider.key();
  if (!key) throw new Error(`${provider.label} token is not configured in Core environment.`);
  const payload = JSON.stringify({ model: model || provider.defaultModel, messages, tools: buildNativeToolDefinitions(), tool_choice: 'auto', max_tokens: CONFIG.maxTokens, temperature: CONFIG.temperature, stream: false });
  return await new Promise((resolve, reject) => {
    const req = https.request({ hostname: provider.hostname, port: 443, path: provider.path, method: 'POST', timeout: 90000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${key}`, ...(provider.headers || {}) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => {
        let json; try { json = JSON.parse(body); } catch { reject(new Error(`${provider.label} returned non-JSON: ${body.slice(0, 300)}`)); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`${provider.label} HTTP ${res.statusCode}: ${json.error?.message || body.slice(0, 300)}`)); return; }
        const msg = json.choices?.[0]?.message || {}; const content = Array.isArray(msg.content) ? msg.content.map(item => item.text || '').join('') : (msg.content || '');
        resolve({ text: content, toolCalls: msg.tool_calls || [], model: json.model || model || provider.defaultModel, usage: json.usage || {}, reasoning: msg.reasoning || null, outputShown: false, provider: providerId });
      });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error(`${provider.label} timeout`))); req.write(payload); req.end();
  });
}

async function hfInferenceBinary(model, payload, contentType, accept) {
  const token = huggingFaceToken();
  if (!token) throw new Error('Hugging Face token is not configured in Core environment. Set HF_TOKEN or HUGGINGFACE_TOKEN.');
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'router.huggingface.co', port: 443, path: '/hf-inference/models/' + model.split('/').map(encodeURIComponent).join('/'), method: 'POST', timeout: 90000, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': contentType, 'Accept': accept, 'Content-Length': body.length } }, res => {
      const parts=[];res.on('data',chunk=>parts.push(chunk));res.on('end',()=>{const data=Buffer.concat(parts);if(res.statusCode<200||res.statusCode>=300){let message=data.toString('utf8').slice(0,500);try{message=JSON.parse(message).error||message;}catch{}reject(new Error(`Hugging Face inference HTTP ${res.statusCode}: ${message}`));return;}resolve({ data, contentType: res.headers['content-type'] || '' });});
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Hugging Face inference timeout')));req.write(body);req.end();
  });
}
async function huggingFaceStt(audio, mime, model = 'openai/whisper-large-v3') {
  const result=await hfInferenceBinary(model, audio, mime || 'audio/webm', 'application/json');let json;try{json=JSON.parse(result.data.toString('utf8'));}catch{throw new Error('Hugging Face STT returned non-JSON');}const text=String(json.text||json.generated_text||'').trim();if(!text)throw new Error('Hugging Face STT returned empty transcript');return { text, model };
}
async function huggingFaceTts(text, model = 'facebook/mms-tts-rus') {
  const result=await hfInferenceBinary(model, JSON.stringify({ inputs: text }), 'application/json', 'audio/wav, audio/mpeg, audio/*');if(!result.data.length)throw new Error('Hugging Face TTS returned empty audio');return { base64: result.data.toString('base64'), mime: String(result.contentType).split(';')[0] || 'audio/wav', model };
}

async function callOpenRouter(messages, model = currentModel) {
  const payload = {
    model,
    messages,
    tools: buildNativeToolDefinitions(),
    tool_choice: 'auto',
    max_tokens: CONFIG.maxTokens,
    temperature: CONFIG.temperature,
    stream: false
  };
  const json = await openRouterRequest(payload);
  const msg = json.choices?.[0]?.message || {};
  const content = Array.isArray(msg.content) ? msg.content.map(x => x.text || '').join('') : (msg.content || '');
  return { text: content, toolCalls: msg.tool_calls || [], model: json.model || model, usage: json.usage || {}, reasoning: msg.reasoning || null, outputShown: false, provider: 'openrouter' };
}

async function callOpenRouterStream(messages, model = currentModel) {
  const key = openRouterKey();
  if (!key) throw new Error('Не задан OpenRouter key. Используй /key.');
  const payload = JSON.stringify({ model, messages, tools: buildNativeToolDefinitions(), tool_choice: 'auto', max_tokens: CONFIG.maxTokens, temperature: CONFIG.temperature, stream: true });
  return await new Promise((resolve, reject) => {
    let buffer = '', text = '', usage = {}, settled = false; const toolCalls = new Map();
    startAiStream('OpenRouter', model);
    const req = https.request({
      hostname: 'openrouter.ai', port: 443, path: '/api/v1/chat/completions', method: 'POST', timeout: 90000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${key}`, 'HTTP-Referer': 'https://termux-local-agent', 'X-Title': 'Termux MCP Agent' }
    });
    const abortThis = () => { req.destroy(new Error('OpenRouter stream aborted by user')); };
    activeProviderAbort = abortThis;
    const finish = error => {
      if (settled) return; settled = true; if (activeProviderAbort === abortThis) activeProviderAbort = null;
      if (error) { finishAiStream('error'); reject(error); return; }
      const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
      finishAiStream('completed'); resolve({ text: text || '', toolCalls: calls, model, usage, outputShown: text.length > 0, provider: 'openrouter' });
    };
    const consume = event => {
      for (const line of event.replace(/\r/g, '').split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data); const choice = json.choices?.[0] || {}; const delta = choice.delta || {};
          const content = Array.isArray(delta.content) ? delta.content.map(x => x.text || '').join('') : (delta.content || '');
          if (content) { text += content; writeAiStreamText(content); }
          for (const part of delta.tool_calls || []) {
            const index = Number(part.index ?? 0); const current = toolCalls.get(index) || { id: part.id || '', type: 'function', function: { name: '', arguments: '' } };
            if (part.id) current.id = part.id;
            if (part.function?.name) current.function.name += part.function.name;
            if (part.function?.arguments) current.function.arguments += part.function.arguments;
            toolCalls.set(index, current);
          }
          if (json.usage) usage = json.usage;
        } catch {}
      }
    };
    req.on('response', res => {
      let statusError = ''; res.setEncoding('utf8');
      res.on('data', chunk => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) { statusError += chunk; return; }
        buffer += chunk; const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || ''; events.forEach(consume);
      });
      res.on('end', () => { if (buffer) consume(buffer); if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) finish(new Error(`OpenRouter HTTP ${res.statusCode}: ${statusError.slice(0, 300)}`)); else finish(); });
    });
    req.on('error', finish); req.on('timeout', () => req.destroy(new Error('OpenRouter stream timeout')));
    req.write(payload); req.end();
  });
}

async function callOpenRouterWithRetry(messages, model = currentModel) {
  let lastError = null;
  const candidates = [model, ...openRouterFreeModels.map(m => m.id).filter(id => id !== model)].slice(0, 5);
  for (const candidate of candidates) {
    try {
      const result = CONFIG.streamMode ? await callOpenRouterStream(messages, candidate) : await callOpenRouter(messages, candidate);
      if (candidate !== currentModel) {
        currentModel = candidate;
        console.log(c(`✅ OpenRouter переключён на: ${candidate}`, 'green'));
      }
      return result;
    } catch (e) {
      lastError = e;
      if (!/429|rate|limit|503|502/i.test(e.message || '')) break;
    }
  }
  throw lastError || new Error('OpenRouter request failed');
}

function messagesForProvider() {
  scrubHistorySecrets();
  const base = { role: 'system', content: buildSystemPrompt() };
  if (currentProvider !== 'zen') return [base, ...history.slice(-CONFIG.maxHistory)];
  // Zen не гарантирует поддержку role:tool/tool_calls; превращаем результаты в обычный контекст.
  const normalized = history.slice(-CONFIG.maxHistory).map(message => {
    if (message.role === 'tool') return { role: 'user', content: `Результат MCP-инструмента:\n${message.content}` };
    if (message.role === 'assistant' && message.tool_calls) return { role: 'assistant', content: message.content || 'Вызваны MCP-инструменты.' };
    return { role: message.role, content: message.content || '' };
  });
  return [base, ...normalized];
}

async function callCurrentProvider() {
  let request = await pluginHook('beforeModel', { provider: currentProvider, model: currentModel, messages: messagesForProvider(), temperature: CONFIG.temperature, maxTokens: CONFIG.maxTokens });
  const provider = request.provider || currentProvider;
  const model = request.model || currentModel;
  let result;
  if (provider === 'openrouter') result = await callOpenRouterWithRetry(request.messages, model);
  else if (provider === 'zen') result = await callZenWithRetry(request.messages, model, undefined, CONFIG.streamMode);
  else if (provider === 'github' || provider === 'huggingface') result = await callCompatibleProvider(provider, request.messages, model);
  else {
    const customProvider = findPluginProvider(provider);
    if (!customProvider) throw new Error(`Unknown provider '${provider}'. Use /provider to select zen, openrouter or a plugin provider.`);
    result = await callPluginProvider(request.messages, model, customProvider);
  }
  result = await pluginHook('afterModel', { provider, model, request, result });
  return result.result || result;
}

// ═══════════════════════════════════════════════════════════════════
//  MCP
// ═══════════════════════════════════════════════════════════════════
let mcpAvailable = false;
async function callMCP(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ tool, args });
    const req = http.request({
      hostname: 'localhost',
      port: UI_PORT,
      path: '/mcp/call',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j.success ? j.result : { error: j.error || 'MCP error' });
        } catch { reject(new Error('Bad MCP response')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function checkMCP() {
  // If we have an embedded server, it's always available
  if (embeddedServer && embeddedServer.listening) { mcpAvailable = true; return true; }
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${UI_PORT}/mcp/status`, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { const st = JSON.parse(body); mcpAvailable = !!(st && st.tools && st.tools.length > 0); }
        catch { mcpAvailable = false; }
        resolve(mcpAvailable);
      });
    });
    req.on('error', () => { mcpAvailable = false; resolve(false); });
    req.setTimeout(2000, () => req.destroy());
  });
}

const WRITE_TOOLS = new Set([
  'write_file', 'execute_command', 'delete_file', 'append_file', 'edit_file', 'file_backup', 'mkdir', 'copy_file', 'move_file', 'archive_create', 'archive_extract',
  'set_workspace', 'project_register', 'project_use', 'project_remove', 'project_memory', 'onnx_set_model', 'onnx_memory_add', 'process_start', 'process_stop', 'monitor_start', 'monitor_stop', 'terminal_create', 'terminal_write', 'terminal_close',
  'npm_install', 'npm_run', 'sqlite_query', 'sqlite_backup', 'env_set', 'env_delete', 'git_init', 'git_commit', 'git_push', 'github_download_apk', 'github_write_file',
  'open_url', 'clipboard_write', 'notify', 'termux_toast', 'termux_vibrate', 'termux_share', 'termux_volume', 'termux_location', 'pollinations_generate', 'custom_tool_create', 'custom_tool_run', 'custom_tool_delete', 'plugin_create', 'plugin_delete', 'plugin_tool_run', 'subagent_create', 'subagent_delete', 'subagent_background', 'subagent_batch', 'todo_add', 'todo_start', 'todo_done', 'todo_fail', 'todo_remove'
]);
function toolPermissionDecision(name, args = {}) {
  const mode = normalizedAgentMode(CONFIG.agentMode);
  const planningSafe = new Set(['todo_list', 'todo_add', 'todo_done', 'todo_remove', 'custom_tool_list', 'custom_tool_inspect']);
  if ((mode === 'plan' || mode === 'explore') && WRITE_TOOLS.has(name) && !planningSafe.has(name)) {
    return { action: 'deny', reason: `${AGENT_MODES[mode].label}: изменения, процессы и внешние действия запрещены. Переключись: /mode build` };
  }
  if (mode === 'explore' && ['custom_tool_run', 'vision_analyze', 'vision_ui_audit', 'vision_compare', 'pollinations_generate'].includes(name)) {
    return { action: 'deny', reason: '🔎 Explore: разрешены только встроенные read/search/diagnostic tools.' };
  }
  if (WRITE_TOOLS.has(name)) return { action: CONFIG.autoApprove ? 'allow' : 'ask', reason: 'изменяющее действие' };
  return { action: 'allow', reason: 'read-only действие' };
}

const COMMAND_RESULT_TOOLS = new Set([
  'execute_command', 'npm_install', 'npm_run', 'run_tests', 'run_lint', 'code_check', 'dependency_audit',
  'git_status', 'git_diff', 'git_branch', 'git_log', 'git_init', 'git_commit', 'git_push'
]);
const LIVE_OUTPUT_TOOLS = new Set([...COMMAND_RESULT_TOOLS, 'process_logs', 'terminal_create', 'terminal_write', 'monitor_start']);

async function useTool(name, args) {
  // Все операции идут через единый MCP-обработчик, даже когда HTTP недоступен.
  try {
    const toolArgs = LIVE_OUTPUT_TOOLS.has(name) ? { ...args, __cliLive: true } : args;
    const r = await handleMCPTool(name, toolArgs);
    if (typeof r === 'string') return r;
    if (r.error) return 'Ошибка: ' + r.error;
    if (COMMAND_RESULT_TOOLS.has(name)) {
      const mode = r.live ? 'Режим: реальное время — вывод и ошибки уже показаны выше.' : 'Режим: MCP HTTP/обычный — вывод получен после завершения.';
      return redactSecrets(`${mode}\nРабочая папка: ${r.cwd || WORKSPACE_ROOT}\nКод выхода: ${r.exit ?? (r.success ? 0 : 1)}${r.timedOut ? ' (таймаут)' : ''}\n\nвывод команды:\n${r.stdout || '(пусто)'}\n\nошибки и служебный вывод:\n${r.stderr || '(пусто)'}`);
    }
    if (r.content !== undefined) return redactSecrets(`Файл: ${r.path || args.path || ''}${r.truncated ? `\nФрагмент: байты ${r.offset}–${r.nextOffset} из ${r.size}. Для следующего фрагмента передай offset:${r.nextOffset}.` : ''}\n\n${r.content}`);
    if (name === 'ocr_image' && r.text !== undefined) return redactSecrets(`OCR: ${r.path || args.path || ''}\n\n${r.text}`);
    if (r.analysis !== undefined) return redactSecrets(`VISION • ${r.model || 'model'}\n\n${r.analysis}`);
    if (r.diff !== undefined) return redactSecrets(r.diff);
    if (r.output !== undefined) return redactSecrets(r.output || 'OK');
    if (['process_start', 'process_status', 'process_stop', 'monitor_start', 'monitor_list', 'monitor_stop', 'terminal_create', 'terminal_write', 'terminal_list', 'terminal_close', 'file_backup', 'termux_info', 'network_check', 'http_request', 'health_check', 'websocket_test', 'project_inspect', 'project_list', 'project_register', 'project_use', 'project_remove', 'project_memory', 'onnx_status', 'onnx_set_model', 'onnx_memory_list', 'onnx_memory_add', 'onnx_memory_search', 'onnx_run', 'tree_dir', 'search_text', 'file_info', 'copy_file', 'move_file', 'mkdir', 'archive_create', 'archive_extract', 'sqlite_info', 'sqlite_query', 'sqlite_schema', 'sqlite_backup', 'env_list', 'env_set', 'env_delete', 'image_info', 'vision_compare', 'vision_ui_audit', 'pollinations_generate', 'pollinations_models', 'custom_tool_list', 'custom_tool_create', 'custom_tool_inspect', 'custom_tool_run', 'custom_tool_delete', 'subagent_list', 'subagent_create', 'subagent_task', 'subagent_batch', 'subagent_background', 'subagent_status', 'subagent_delete', 'plugin_list', 'plugin_create', 'plugin_inspect', 'plugin_delete', 'plugin_tool_list', 'plugin_tool_run', 'plugin_provider_list', 'web_search', 'github_repo_info', 'github_read_file', 'github_list_dir', 'github_write_file', 'github_readme', 'github_commits', 'github_builds', 'github_watch_build', 'github_download_apk'].includes(name)) {
      return JSON.stringify(r, null, 2);
    }
    if (r.success) {
      let text = 'OK: ' + (r.path || r.workspace || name);
      if (r.size !== undefined) text += ` (${r.size} bytes, ${r.lines || 0} lines)`;
      if (r.workspace && name !== 'set_workspace') text += `\nMCP-папка: ${r.workspace}`;
      return text;
    }
    return JSON.stringify(r, null, 2);
  } catch (e) {
    return 'Ошибка вызова ' + name + ': ' + e.message;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════════════════
const log = (...a) => console.log(...a);
let currentProvider = CONFIG.provider || 'zen';
let currentModel = CONFIG.defaultModel;
let history = [];
let agentBusy = false;
let abortRequested = false;
let correctionQueue = [];
let activeProviderAbort = null;
let pendingConfirmation = null;
// When a task is launched from AIN, confirmation is delivered through the
// authenticated web API instead of silently auto-approving a write operation.
let WEB_AGENT_RUN_CONTEXT = null;
function webRunEvent(type, payload = {}) {
  const run = WEB_AGENT_RUN_CONTEXT;
  if (!run) return;
  run.events ||= [];
  const safe = {};
  for (const [key, value] of Object.entries(payload || {})) safe[key] = redactSecrets(String(value ?? '')).slice(0, 3200);
  run.events.push({ id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), type, at: new Date().toISOString(), ...safe });
  if (run.events.length > 300) run.events.splice(0, run.events.length - 300);
}
let activeArrowMenu = null;
let promptRenderer = () => {};
let rl = null;
let agentInputRaw = false;
let lastEscapeAt = 0;
let lastEscapeSignalAt = 0;
function setAgentInputRaw(active) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return;
  try {
    if (active && !agentInputRaw) { process.stdin.setRawMode(true); agentInputRaw = true; }
    else if (!active && agentInputRaw && !activeArrowMenu) { process.stdin.setRawMode(false); agentInputRaw = false; }
  } catch {}
}
function handleAgentKeypress(str, key) {
  if (!agentBusy || activeArrowMenu) return;
  const isEscape = key?.name === 'escape' || str === '\x1b';
  if (!isEscape) return;
  const now = Date.now();
  if (now - lastEscapeSignalAt < 35) return;
  lastEscapeSignalAt = now;
  if (now - lastEscapeAt <= 700) {
    lastEscapeAt = 0;
    abortRequested = true;
    setRunPhase('stopped', 'двойной Esc');
    try { activeProviderAbort?.(); } catch {}
    if (pendingConfirmation) {
      const pending = pendingConfirmation;
      pendingConfirmation = null;
      try { pending.resolve('no'); } catch {}
    }
    console.log(c('⏹ Двойной Esc: остановка запрошена. После возврата управления можно написать исправление или замечание.', 'yellow'));
  } else {
    lastEscapeAt = now;
    console.log(c('Нажмите Esc ещё раз в течение 0,7 секунды для остановки.', 'gray'));
  }
}
function handleAgentInputData(chunk) {
  if (!agentBusy || activeArrowMenu) return;
  const data = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== '\x1b') continue;
    // Ignore arrow/function-key escape sequences; accept standalone Esc bytes.
    const next = data[i + 1] || '';
    if (next !== '[' && next !== 'O') handleAgentKeypress('\x1b', { name: 'escape' });
  }
}

// Runtime telemetry: реальные usage от провайдера, когда он их возвращает,
// и помеченная оценка до получения ответа.
const TELEMETRY = {
  phase: 'user-control', detail: 'Ожидание ввода', startedAt: null, phaseStartedAt: Date.now(),
  inputChars: 0, outputChars: 0, toolCalls: 0, step: 0, usage: null, requestChars: 0,
  estimatedInputTokens: 0, provider: 'zen', model: CONFIG.defaultModel, stalled: false
};
let ACTIVE_STREAM = null;
function startAiStream(provider, model) {
  ACTIVE_STREAM = { provider, model, startedAt: Date.now(), firstTokenAt: null, chars: 0 };
  console.log(c(`\n▶ Поток ответа запущен • ${provider} • ${model}`, 'brightCyan'));
}
function writeAiStreamText(text) {
  if (!ACTIVE_STREAM) startAiStream(currentProvider, currentModel);
  if (!ACTIVE_STREAM.firstTokenAt) {
    ACTIVE_STREAM.firstTokenAt = Date.now();
    console.log(c(`⏱ Первый фрагмент ответа: ${((ACTIVE_STREAM.firstTokenAt - ACTIVE_STREAM.startedAt) / 1000).toFixed(1)} с`, 'gray'));
    process.stdout.write(c('│ ', 'cyan'));
  }
  ACTIVE_STREAM.chars += String(text || '').length;
  try { if (WEB_AGENT_RUN_CONTEXT) webRunEvent('model_output', { text }); } catch {}
  process.stdout.write(c(String(text || ''), 'brightCyan'));
}
function finishAiStream(status = 'completed') {
  if (!ACTIVE_STREAM) return;
  const now = Date.now();
  const total = ((now - ACTIVE_STREAM.startedAt) / 1000).toFixed(1);
  const first = ACTIVE_STREAM.firstTokenAt ? ((ACTIVE_STREAM.firstTokenAt - ACTIVE_STREAM.startedAt) / 1000).toFixed(1) : '—';
  if (ACTIVE_STREAM.firstTokenAt) process.stdout.write('\n');
  console.log(c(`■ Поток ответа ${status === 'completed' ? 'завершён' : 'остановлен'} • всего ${total} с • первый фрагмент ${first} с • ${ACTIVE_STREAM.chars} символов`, status === 'completed' ? 'green' : 'yellow'));
  ACTIVE_STREAM = null;
}

function estimateTokens(chars) { return Math.max(0, Math.ceil(Number(chars || 0) / 3.6)); }
function elapsedText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
function setRunPhase(phase, detail = '') {
  TELEMETRY.phase = phase; TELEMETRY.detail = detail; TELEMETRY.phaseStartedAt = Date.now();
  TELEMETRY.stalled = false;
  try { if (WEB_AGENT_RUN_CONTEXT) webRunEvent('phase', { phase, detail }); } catch {}
}
function phaseLabel() {
  const labels = {
    'user-control': '▣ управление у вас', model: '⠿ модель отвечает', tool: '⚙ инструмент выполняется',
    confirmation: '⚠ ждёт вашего подтверждения', correction: '✎ принята корректировка',
    stopped: '⏹ остановлено', error: '✖ ошибка', complete: '✓ задача завершена'
  };
  return labels[TELEMETRY.phase] || TELEMETRY.phase;
}
function telemetryLiveText() {
  const now = Date.now(); const total = TELEMETRY.startedAt ? elapsedText(now - TELEMETRY.startedAt) : '0s';
  const phase = elapsedText(now - TELEMETRY.phaseStartedAt);
  const actual = TELEMETRY.usage?.total_tokens;
  const tokens = actual ? `${actual} tok` : `≈${TELEMETRY.estimatedInputTokens + estimateTokens(TELEMETRY.outputChars)} tok`;
  const warning = (TELEMETRY.phase === 'model' && now - TELEMETRY.phaseStartedAt >= 20000) ? ' • ⚠ ожидание сети/модели' : '';
  return `${phaseLabel()}: ${TELEMETRY.detail || currentProvider} • ${total} • ${tokens} • ${TELEMETRY.inputChars + TELEMETRY.outputChars} симв.${warning}`;
}
function beginAgentTelemetry(input) {
  TELEMETRY.startedAt = Date.now(); TELEMETRY.inputChars = String(input || '').length; TELEMETRY.outputChars = 0;
  TELEMETRY.toolCalls = 0; TELEMETRY.step = 0; TELEMETRY.usage = null; TELEMETRY.provider = currentProvider; TELEMETRY.model = currentModel;
  TELEMETRY.requestChars = 0; TELEMETRY.estimatedInputTokens = estimateTokens(TELEMETRY.inputChars);
  setRunPhase('model', providerDisplayName());
}
function recordProviderResult(res) {
  if (!res) return;
  if (res.model) TELEMETRY.model = res.model;
  TELEMETRY.outputChars += String(res.text || '').length;
  if (res.usage && Object.keys(res.usage).length) TELEMETRY.usage = res.usage;
}
function startTelemetryTicker(spinner) {
  if (!spinner) return null;
  return setInterval(() => { spinner.text = telemetryLiveText(); }, 500);
}
function stopTelemetryTicker(timer) { if (timer) clearInterval(timer); }
function canUseArrowMenu() {
  return !!(rl && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function');
}
function openArrowMenu(title, options, onSelect, onCancel = null) {
  if (!canUseArrowMenu() || !options.length || activeArrowMenu) return false;
  const menu = { title, options, index: 0, rendered: false, lineCount: 0, onSelect, onCancel, handler: null };
  activeArrowMenu = menu;
  rl.pause();
  try { process.stdin.setRawMode(true); } catch { activeArrowMenu = null; rl.resume(); return false; }
  const render = () => {
    // Не допускаем visual wrap: иначе ↑/↓ перерисовывает не те строки на узком телефоне.
    const width = Math.max(34, Math.min(76, termWidth() - 2));
    const clip = text => text.length <= width ? text : text.slice(0, Math.max(1, width - 1)) + '…';
    const titleLine = `┌─ ${title} `;
    const lines = [c(clip(titleLine + '─'.repeat(Math.max(0, width - titleLine.length))), 'cyan')];
    options.forEach((option, i) => {
      const selected = i === menu.index;
      const plain = `${selected ? '▶' : ' '} ${option.label}${option.description ? ' — ' + option.description : ''}`;
      lines.push(selected ? c(clip(plain), 'brightCyan', 'bold') : c(clip(plain), 'white'));
    });
    lines.push(c(clip('↑/↓ — выбор • Enter — подтвердить • Esc/q/0 — отмена'), 'gray'));
    lines.push(c('└' + '─'.repeat(Math.max(0, width - 1)), 'cyan'));
    if (menu.rendered) {
      for (let i = 0; i < menu.lineCount; i++) { readline.moveCursor(process.stdout, 0, -1); readline.clearLine(process.stdout, 0); }
    }
    process.stdout.write((menu.rendered ? '' : '\n') + lines.join('\n') + '\n');
    menu.lineCount = lines.length; menu.rendered = true;
  };
  const close = async (selected = null) => {
    if (menu.closed) return;
    menu.closed = true;
    if (menu.timeout) clearTimeout(menu.timeout);
    process.stdin.off('data', menu.handler);
    try { process.stdin.setRawMode(false); } catch {}
    rl.resume(); activeArrowMenu = null;
    if (selected) await menu.onSelect(selected, menu.index);
    else if (menu.onCancel) await menu.onCancel();
    setTimeout(() => promptRenderer(), 0);
  };
  // Android extra-keyboard sends ESC [ A / ESC [ B directly. Обрабатываем байты
  // сами, а не keypress: readline в Termux иногда поглощает keypress-события.
  menu.handler = chunk => {
    const data = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (data === '\x1b[A' || data === '\x1bOA' || data === 'A') { menu.index = (menu.index - 1 + options.length) % options.length; render(); }
    else if (data === '\x1b[B' || data === '\x1bOB' || data === 'B') { menu.index = (menu.index + 1) % options.length; render(); }
    else if (data === '\r' || data === '\n') { void close(options[menu.index]); }
    else if (data === '\x1b' || data === '\x03' || data.toLowerCase() === 'q' || data === '0') { void close(); }
    else if (/^[1-9]$/.test(data)) { const i = Number(data) - 1; if (options[i]) { menu.index = i; render(); } }
  };
  process.stdin.on('data', menu.handler);
  // rl.pause() останавливает поток; raw-меню должно снова включить чтение байтов.
  process.stdin.resume();
  // Страховка от застревания в raw mode: через минуту меню отменится само.
  menu.timeout = setTimeout(() => { console.log(c('\n⌛ Меню закрыто по таймауту.', 'yellow')); void close(); }, 60000);
  render();
  return true;
}
function setIndicatorStyle(style) {
  if (!INDICATOR_THEMES[style]) return { error: 'Неизвестный индикатор: ' + style };
  CONFIG.indicatorStyle = style;
  saveHistory();
  return { success: true, style, label: INDICATOR_THEMES[style].label };
}

function auditFilePath() { return path.join(WORKSPACE_ROOT, '.zen-agent', 'audit.jsonl'); }
function redactAudit(value, key = '') {
  if (/password|secret|token|api[_-]?key|authorization/i.test(key)) return '***';
  if (Array.isArray(value)) return value.map(item => redactAudit(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAudit(v, k)]));
  if (typeof value === 'string') { const clean = redactSecrets(value); return clean.length > 500 ? clean.slice(0, 500) + '…' : clean; }
  return value;
}
function auditEvent(event, data = {}) {
  try {
    const file = auditFilePath(); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, provider: currentProvider, session: activeSession, ...redactAudit(data) }) + '\n', 'utf8');
  } catch {}
}
function readAudit(limit = 30) {
  try {
    const lines = fs.readFileSync(auditFilePath(), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.min(Math.max(Number(limit) || 30, 1), 200)).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function drawTelemetryPanel(title = ' Выполнение ') {
  const actual = TELEMETRY.usage || {};
  const actualTotal = actual.total_tokens || ((actual.prompt_tokens || 0) + (actual.completion_tokens || 0));
  const tokenLine = actualTotal
    ? `Токены: ${actual.prompt_tokens ?? '?'} вход • ${actual.completion_tokens ?? '?'} выход • ${actualTotal} всего (провайдер)`
    : `Токены: ≈${TELEMETRY.estimatedInputTokens + estimateTokens(TELEMETRY.outputChars)} (оценка по символам)`;
  const duration = TELEMETRY.startedAt ? elapsedText(Date.now() - TELEMETRY.startedAt) : '—';
  const lines = [
    `${phaseLabel()}${TELEMETRY.detail ? ' • ' + TELEMETRY.detail : ''}`,
    `Провайдер: ${TELEMETRY.provider} • Модель: ${TELEMETRY.model}`,
    tokenLine,
    `Символы: ${TELEMETRY.inputChars} вход • ${TELEMETRY.outputChars} выход • ${TELEMETRY.inputChars + TELEMETRY.outputChars} всего`,
    `Время: ${duration} • шагов: ${TELEMETRY.step}/${agentStepLimit()} • инструментов: ${TELEMETRY.toolCalls}`
  ];
  box(lines, { width: Math.min(84, termWidth() - 2), title, style: 'single', color: 'gray' }).forEach(line => console.log(line));
}

function previewTool(name, args) {
  const w = Math.min(68, termWidth() - 4);
  const lines = [
    `${c('MCP-папка:', 'gray')} ${c(WORKSPACE_ROOT, 'brightCyan')}`,
    c('Параметры:', 'gray')
  ];
  for (const [k, v] of Object.entries(args)) {
    const val = redactSecrets(String(v));
    lines.push(`  ${c('•', 'cyan')} ${c(k, 'yellow')}: ${val.length > 120 ? val.slice(0, 120) + '…' : val}`);
  }
  if (args.path) {
    const resolved = resolveWorkspacePath(args.path);
    lines.push(resolved.error ? c('  ✗ ' + resolved.error, 'red') : `${c('Полный путь:', 'gray')} ${resolved.path}`);
  }
  if (name === 'execute_command') {
    const resolved = resolveWorkspacePath(args.cwd || '.');
    lines.push(resolved.error ? c('  ✗ ' + resolved.error, 'red') : `${c('Запуск из:', 'gray')} ${resolved.path}`);
  }
  box(lines, { width: w, title: ' ' + name + ' ', style: 'single', color: 'yellow' }).forEach(l => console.log(l));
}

function askConfirm(tool, args = {}) {
  return new Promise((resolve) => {
    if (WEB_AGENT_RUN_CONTEXT) {
      const run = WEB_AGENT_RUN_CONTEXT;
      run.status = 'awaiting_approval';
      run.approval = {
        tool,
        // Arguments are shown for an informed decision, but known secrets are masked.
        args: Object.fromEntries(Object.entries(args || {}).map(([k, v]) => [k, redactSecrets(String(v))])),
        requestedAt: new Date().toISOString()
      };
      run.resolveApproval = resolve;
      webRunEvent('approval_required', { tool, args: JSON.stringify(run.approval.args) });
      setRunPhase('confirmation', tool);
      console.log(c(`\n⚠ Web Agent ждёт подтверждение: ${tool}.`, 'yellow'));
      return;
    }
    if (!rl || CONFIG.autoApprove) { resolve('yes'); return; }
    pendingConfirmation = { tool, resolve };
    setRunPhase('confirmation', tool);
    console.log(c(`\n⚠ Управление передано вам: подтвердите ${tool}.`, 'yellow'));
    process.stdout.write(c(`  Разрешить ${tool}? [y/N] `, 'yellow'));
  });
}

const SESSIONS_FILE = path.join(os.homedir(), '.zen_chat_sessions.json');
let activeSession = 'default';
let sessionStore = { active: 'default', sessions: {}, settings: {} };
function safeSessionName(name) {
  const value = String(name || '').trim();
  return /^[a-zA-Z0-9а-яА-ЯёЁ._-]{1,48}$/.test(value) ? value : null;
}
function loadSessionStore() {
  try {
    const stored = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (stored && stored.sessions && typeof stored.sessions === 'object') sessionStore = stored;
  } catch {}
  sessionStore.settings ||= {};
  if (typeof sessionStore.settings.autoApprove === 'boolean') CONFIG.autoApprove = sessionStore.settings.autoApprove;
  if (typeof sessionStore.settings.askClarifyingQuestions === 'boolean') CONFIG.askClarifyingQuestions = sessionStore.settings.askClarifyingQuestions;
  if (typeof sessionStore.settings.animatedIndicator === 'boolean') CONFIG.animatedIndicator = sessionStore.settings.animatedIndicator;
  if (typeof sessionStore.settings.indicatorStyle === 'string' && INDICATOR_THEMES[sessionStore.settings.indicatorStyle]) CONFIG.indicatorStyle = sessionStore.settings.indicatorStyle;
  if (typeof sessionStore.settings.visionModel === 'string' && sessionStore.settings.visionModel) CONFIG.visionModel = sessionStore.settings.visionModel;
  if (typeof sessionStore.settings.agentMode === 'string') CONFIG.agentMode = normalizedAgentMode(sessionStore.settings.agentMode);
  if (typeof sessionStore.settings.longTaskMode === 'boolean') CONFIG.longTaskMode = sessionStore.settings.longTaskMode;
  activeSession = safeSessionName(sessionStore.active) || 'default';
  if (!sessionStore.sessions[activeSession]) sessionStore.sessions[activeSession] = { history: [], createdAt: new Date().toISOString() };
}
function saveSessionStore() {
  try {
    sessionStore.active = activeSession;
    sessionStore.settings = { ...(sessionStore.settings || {}), autoApprove: CONFIG.autoApprove, askClarifyingQuestions: CONFIG.askClarifyingQuestions, animatedIndicator: CONFIG.animatedIndicator, indicatorStyle: CONFIG.indicatorStyle, visionModel: CONFIG.visionModel, agentMode: CONFIG.agentMode, longTaskMode: CONFIG.longTaskMode };
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionStore, null, 2), { mode: 0o600 });
    try { fs.chmodSync(SESSIONS_FILE, 0o600); } catch {}
  } catch {}
}
function saveHistory() {
  scrubHistorySecrets();
  if (!sessionStore.sessions) loadSessionStore();
  sessionStore.sessions[activeSession] = {
    ...(sessionStore.sessions[activeSession] || {}), history: history.slice(-CONFIG.sessionHistoryLimit),
    provider: currentProvider, model: currentModel, workspace: WORKSPACE_ROOT, updatedAt: new Date().toISOString()
  };
  saveSessionStore();
}
function loadHistory() {
  loadSessionStore();
  const selected = sessionStore.sessions[activeSession];
  if (selected && Array.isArray(selected.history)) {
    history = selected.history;
    if (typeof selected.provider === 'string' && selected.provider) currentProvider = selected.provider;
    if (typeof selected.model === 'string' && selected.model) currentModel = selected.model;
    return;
  }
  try { const legacy = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.oc_history.json'), 'utf8')); if (Array.isArray(legacy)) history = legacy; }
  catch {}
}
function listSessions() {
  loadSessionStore();
  return Object.entries(sessionStore.sessions).map(([name, data]) => ({ name, active: name === activeSession, messages: Array.isArray(data.history) ? data.history.length : 0, updatedAt: data.updatedAt || data.createdAt || null, provider: data.provider || 'zen', model: data.model || CONFIG.defaultModel, workspace: data.workspace || (name === activeSession ? WORKSPACE_ROOT : null) })).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
function switchSession(name) {
  const valid = safeSessionName(name); if (!valid) return { error: 'Имя сессии: до 48 букв/цифр, _, -, . .' };
  saveHistory(); loadSessionStore();
  if (!sessionStore.sessions[valid]) sessionStore.sessions[valid] = { history: [], createdAt: new Date().toISOString(), provider: currentProvider, model: currentModel, workspace: WORKSPACE_ROOT };
  activeSession = valid; sessionStore.active = valid;
  const data = sessionStore.sessions[valid]; history = Array.isArray(data.history) ? data.history : [];
  if (typeof data.provider === 'string' && data.provider) currentProvider = data.provider;
  if (data.model) currentModel = data.model;
  if (data.workspace && fs.existsSync(data.workspace) && isTermuxSharedPath(data.workspace)) { WORKSPACE_ROOT = data.workspace; CONFIG.workspaceRoot = data.workspace; }
  saveSessionStore(); return { success: true, name: valid, messages: history.length, provider: currentProvider, model: currentModel, workspace: WORKSPACE_ROOT };
}
function deleteSession(name) {
  const valid = safeSessionName(name); if (!valid) return { error: 'Некорректное имя сессии.' };
  if (valid === activeSession) return { error: 'Нельзя удалить активную сессию. Сначала переключись на другую.' };
  loadSessionStore(); if (!sessionStore.sessions[valid]) return { error: 'Сессия не найдена.' };
  delete sessionStore.sessions[valid]; saveSessionStore(); return { success: true, name: valid };
}

function sessionInfoTool(name = activeSession) {
  const valid = safeSessionName(name); if (!valid) return { error: 'Некорректное имя сессии.' };
  loadSessionStore(); const data = sessionStore.sessions[valid]; if (!data) return { error: 'Сессия не найдена.' };
  return { name: valid, active: valid === activeSession, title: data.title || valid, parent: data.parent || null, messages: Array.isArray(data.history) ? data.history.length : 0, createdAt: data.createdAt || null, updatedAt: data.updatedAt || null, provider: data.provider || 'zen', model: data.model || CONFIG.defaultModel, workspace: data.workspace || null };
}
function forkSession(name) {
  const valid = safeSessionName(name); if (!valid) return { error: 'Имя новой сессии некорректно.' };
  saveHistory(); loadSessionStore(); if (sessionStore.sessions[valid]) return { error: `Сессия '${valid}' уже существует.` };
  const source = sessionStore.sessions[activeSession] || {};
  const clone = JSON.parse(JSON.stringify(source));
  clone.parent = activeSession; clone.createdAt = new Date().toISOString(); clone.updatedAt = clone.createdAt; clone.title = valid;
  sessionStore.sessions[valid] = clone; activeSession = valid; sessionStore.active = valid; history = Array.isArray(clone.history) ? clone.history : [];
  saveSessionStore(); return { success: true, name: valid, parent: clone.parent, messages: history.length };
}
function renameSession(name) {
  const valid = safeSessionName(name); if (!valid) return { error: 'Новое имя сессии некорректно.' };
  loadSessionStore(); if (valid !== activeSession && sessionStore.sessions[valid]) return { error: `Сессия '${valid}' уже существует.` };
  const data = sessionStore.sessions[activeSession]; if (!data) return { error: 'Активная сессия не найдена.' };
  delete sessionStore.sessions[activeSession]; data.title = valid; data.updatedAt = new Date().toISOString(); sessionStore.sessions[valid] = data; activeSession = valid; sessionStore.active = valid;
  saveSessionStore(); return { success: true, name: valid };
}
function exportSession(filePath) {
  saveHistory();
  const target = mcpPathOrError(filePath || path.join('.zen-agent', 'sessions', `${activeSession}.json`), 'path');
  if (target.error) return target;
  try {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    const payload = { format: 'zen-agent-session-v1', exportedAt: new Date().toISOString(), active: activeSession, session: sessionStore.sessions[activeSession] };
    fs.writeFileSync(target.path, JSON.stringify(payload, null, 2), 'utf8'); return { success: true, path: target.path, session: activeSession };
  } catch (e) { return { error: 'Не удалось экспортировать сессию: ' + e.message }; }
}
function importSession(filePath, name) {
  const source = mcpPathOrError(filePath, 'path', true); if (source.error) return source;
  const valid = safeSessionName(name); if (!valid) return { error: 'Для import укажи новое имя сессии.' };
  try {
    const payload = JSON.parse(fs.readFileSync(source.path, 'utf8'));
    const data = payload.session || payload;
    if (!data || !Array.isArray(data.history)) return { error: 'Файл не похож на экспорт Zen Agent session.' };
    loadSessionStore(); if (sessionStore.sessions[valid]) return { error: `Сессия '${valid}' уже существует.` };
    data.title = valid; data.importedAt = new Date().toISOString(); data.updatedAt = data.importedAt; sessionStore.sessions[valid] = data;
    saveSessionStore(); return { success: true, name: valid, messages: data.history.length };
  } catch (e) { return { error: 'Не удалось импортировать сессию: ' + e.message }; }
}

// ═══════════════════════════════════════════════════════════════════
//  TODO SYSTEM
// ═══════════════════════════════════════════════════════════════════
const TODO_FILE = path.join(os.homedir(), '.zen_todo.json');
let todos = [];

function loadTodos() {
  try {
    const t = JSON.parse(fs.readFileSync(TODO_FILE, 'utf8'));
    if (Array.isArray(t)) todos = t;
  } catch { todos = []; }
}
function saveTodos() {
  try { fs.writeFileSync(TODO_FILE, JSON.stringify(todos, null, 2)); }
  catch {}
}
function projectTodos(workspace = WORKSPACE_ROOT) {
  loadTodos();
  return todos.filter(t => !t.workspace || t.workspace === workspace);
}
// Рекурсивный todo: иерархия (parent), статусы pending/in_progress/done/failed,
// поле result (успех/провал + пояснение). Главный агент ведёт дерево задач,
// отмечая что сделано, что в работе и что провалилось.
function addTodo(text, options = {}) {
  loadTodos();
  const id = todos.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1;
  const status = options.status === 'failed' ? 'failed' : options.status === 'in_progress' ? 'in_progress' : 'pending';
  todos.push({
    id,
    text: String(text).trim(),
    status,
    done: status === 'done' || status === 'failed',
    parent: options.parent ? Number(options.parent) : null,
    workspace: options.workspace || WORKSPACE_ROOT,
    source: options.source || 'cli',
    created: Date.now(),
    completed: null,
    result: options.result !== undefined ? String(options.result).slice(0, 2000) : null
  });
  saveTodos();
  return id;
}
function setTodoStatus(id, status, result, workspace = null) {
  loadTodos();
  const t = todos.find(x => x.id === id && (!workspace || !x.workspace || x.workspace === workspace));
  if (!t) return false;
  const norm = ['pending', 'in_progress', 'done', 'failed'].includes(status) ? status : 'pending';
  t.status = norm;
  t.done = norm === 'done' || norm === 'failed';
  if (result !== undefined && result !== null) t.result = String(result).slice(0, 2000);
  if (norm === 'done' || norm === 'failed') t.completed = Date.now();
  saveTodos();
  return true;
}
function doneTodo(id, workspace = null) { return setTodoStatus(id, 'done', null, workspace); }
function failTodo(id, reason, workspace = null) { return setTodoStatus(id, 'failed', reason, workspace); }
function startTodo(id, workspace = null) { return setTodoStatus(id, 'in_progress', null, workspace); }
function removeTodo(id, workspace = null) {
  loadTodos();
  const before = todos.length;
  // удаляем задачу и её подзадачи (рекурсивно)
  todos = todos.filter(x => !(x.id === id && (!workspace || !x.workspace || x.workspace === workspace)));
  const removedIds = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    todos = todos.filter(x => {
      if (x.parent !== null && removedIds.has(x.parent) && (!workspace || !x.workspace || x.workspace === workspace)) {
        removedIds.add(x.id); grew = true; return false;
      }
      return true;
    });
  }
  saveTodos();
  return before !== todos.length;
}
function clearTodos(workspace = WORKSPACE_ROOT) {
  loadTodos();
  todos = todos.filter(x => x.workspace && x.workspace !== workspace);
  saveTodos();
}
// Возвращает список задач в порядке дерева (глубина, id), начиная с корней.
function todosRecursive(workspace = WORKSPACE_ROOT) {
  loadTodos();
  const items = projectTodos(workspace);
  const byParent = {};
  for (const t of items) { const p = t.parent || 0; (byParent[p] = byParent[p] || []).push(t); }
  const ordered = [];
  const walk = (parent, depth) => {
    for (const t of (byParent[parent] || []).sort((a, b) => a.id - b.id)) {
      ordered.push({ t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(0, 0);
  return ordered;
}
function todoStatusChar(t) {
  if (t.status === 'done') return c('✓', 'green');
  if (t.status === 'failed') return c('✗', 'red');
  if (t.status === 'in_progress') return c('●', 'cyan');
  return c('○', 'gray');
}
function todoSummary(workspace = WORKSPACE_ROOT) {
  loadTodos();
  const items = projectTodos(workspace);
  return {
    total: items.length,
    done: items.filter(t => t.status === 'done').length,
    failed: items.filter(t => t.status === 'failed').length,
    inProgress: items.filter(t => t.status === 'in_progress').length,
    pending: items.filter(t => t.status === 'pending').length,
    success: items.filter(t => t.status === 'done').length,
    fail: items.filter(t => t.status === 'failed').length
  };
}
function drawTodos() {
  const activeTodos = projectTodos();
  const tw = termWidth();
  const w = Math.min(76, tw - 4);
  const sum = todoSummary();
  if (!activeTodos.length) {
    box([
      c('Нет задач в текущем проекте.', 'gray'),
      c('Добавь: /todo текст', 'gray'),
      c('Папка: ' + WORKSPACE_ROOT, 'gray')
    ], { width: w, title: ' TODO ', style: 'single', color: 'yellow' }).forEach(l => console.log(l));
    return;
  }
  const lines = [c('Проект: ' + WORKSPACE_ROOT, 'gray'), ''];
  for (const { t, depth } of todosRecursive()) {
    const indent = '  '.repeat(depth);
    const branch = depth === 0 ? '▸' : '·';
    const status = todoStatusChar(t);
    const text = t.status === 'done' ? c(t.text, 'gray') : t.status === 'failed' ? c(t.text, 'red') : t.status === 'in_progress' ? c(t.text, 'cyan') : c(t.text, 'white');
    const tag = t.status === 'done' ? c('(готово)', 'green') : t.status === 'failed' ? c('(провал)', 'red') : t.status === 'in_progress' ? c('(в работе)', 'cyan') : c('(в плане)', 'gray');
    lines.push(`${indent}${status} ${c('#' + t.id, 'yellow')} ${text} ${tag}`);
    if (t.result) lines.push(`${indent}${c('    ↳ ' + t.result.slice(0, 120), 'gray')}`);
  }
  lines.push('');
  const sumStr = `${c(sum.done, 'green')}✓ / ${c(sum.inProgress, 'cyan')}● / ${c(sum.pending, 'gray')}○ / ${c(sum.failed, 'red')}✗  (${sum.total} всего)`;
  box(lines, { width: w, title: ` TODO (${sumStr}) `, style: 'single', color: 'yellow' }).forEach(l => console.log(l));
}

// ═══════════════════════════════════════════════════════════════════
//  TOOL CALL HANDLER
// ═══════════════════════════════════════════════════════════════════
const TOOL_REQUIRED_ARGS = {
  set_workspace: ['path'], read_file: ['path'], write_file: ['path'], edit_file: ['path'], delete_file: ['path'], append_file: ['path'],
  file_backup: ['path'], file_diff: ['path', 'backup'], copy_file: ['source', 'destination'], move_file: ['source', 'destination'],
  archive_create: ['source', 'destination'], archive_extract: ['archive', 'destination'], download_file: ['url', 'path'],
  execute_command: ['command'], process_start: ['name', 'command'], process_logs: ['name'], process_stop: ['name'],
  monitor_start: ['process_name'], monitor_logs: ['id'], monitor_stop: ['id'], terminal_write: ['id'], terminal_read: ['id'], terminal_close: ['id'],
  http_request: ['url'], health_check: ['url'], websocket_test: ['url'], npm_install: ['packages'], npm_run: ['script'],
  sqlite_query: ['database', 'sql'], sqlite_backup: ['database', 'destination'], env_set: ['key', 'value'], env_delete: ['key'],
  code_check: ['path'], project_register: ['alias', 'path'], project_use: ['alias'], project_remove: ['alias'], onnx_set_model: ['path'], onnx_memory_add: ['text'], onnx_memory_search: ['query'], github_repo_info: ['repo'], github_read_file: ['repo', 'path'], github_list_dir: ['repo'], github_write_file: ['repo', 'path', 'content'], github_readme: ['repo'], github_commits: ['repo'], github_builds: ['repo'], github_watch_build: ['repo', 'run_id'], github_download_apk: ['repo'], open_url: ['url'], clipboard_write: ['text'], notify: ['content'], todo_add: ['text'], todo_start: ['id'], todo_done: ['id'], todo_fail: ['id'], todo_remove: ['id'], web_search: ['query'], search_text: ['query'],
  image_info: ['path'], ocr_image: ['path'], vision_analyze: ['path'], analyze_image: ['path'], vision_ui_audit: ['path'], vision_compare: ['path', 'path2'], pollinations_generate: ['prompt'],
  custom_tool_create: ['name', 'description', 'code'], custom_tool_inspect: ['name'], custom_tool_run: ['name'], custom_tool_delete: ['name'],
  subagent_create: ['name', 'description', 'prompt'], subagent_task: ['agent', 'prompt'], subagent_delete: ['name'],
  plugin_create: ['name', 'description', 'code'], plugin_inspect: ['name'], plugin_delete: ['name'], plugin_tool_run: ['plugin', 'name']
};
const NATIVE_TOOL_PROPERTIES = {
  path: { type: 'string' }, cwd: { type: 'string' }, dir: { type: 'string' }, query: { type: 'string' }, text: { type: 'string' }, content: { type: 'string' },
  old: { type: 'string' }, new: { type: 'string' }, operation: { type: 'string' }, line: { type: 'integer' }, lines: { type: 'string' }, offset: { type: 'integer' }, max_bytes: { type: 'integer' },
  source: { type: 'string' }, destination: { type: 'string' }, archive: { type: 'string' }, backup: { type: 'string' }, url: { type: 'string' }, method: { type: 'string' },
  command: { type: 'string' }, timeout: { type: 'integer' }, name: { type: 'string' }, id: { type: 'string' }, process_name: { type: 'string' },
  follow_seconds: { type: 'integer' }, interval_seconds: { type: 'integer' }, restart: { type: 'boolean' }, force: { type: 'boolean' },
  input: { type: 'string' }, initial_command: { type: 'string' }, shell: { type: 'string' }, cursor: { type: 'integer' }, newline: { type: 'boolean' },
  headers: { type: 'object', additionalProperties: true }, body: {}, payload: {}, protocol: { type: 'string' }, event: { type: 'string' }, expect_event: { type: 'string' },
  packages: { type: 'array', items: { type: 'string' } }, package: { type: 'string' }, script: { type: 'string' }, args: { type: 'string' },
  database: { type: 'string' }, sql: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' }, message: { type: 'string' }, title: { type: 'string' }, agent: { type: 'string' }, plugin: { type: 'string' }, description: { type: 'string' }, code: { type: 'string' }, alias: { type: 'string' }, note: { type: 'string' }, action: { type: 'string' }, inputs: { type: 'object', additionalProperties: true }, type: { type: 'string' }, dims: { type: 'array', items: { type: 'integer' } }, tags: { type: 'array', items: { type: 'string' } }, repo: { type: 'string' }, repository: { type: 'string' }, owner: { type: 'string' }, project: { type: 'string' }, branch: { type: 'string' }, remote: { type: 'string' }, run_id: { type: 'integer' }, runId: { type: 'integer' }, artifact_name: { type: 'string' }, artifact: { type: 'string' }, source: { type: 'string' }, tag: { type: 'string' }, zip_path: { type: 'string' }, set_upstream: { type: 'boolean' }, extract: { type: 'boolean' }, keep_zip: { type: 'boolean' }, tool_args: { type: 'object', additionalProperties: true }, parameters: { type: 'object', additionalProperties: true },
  path2: { type: 'string' }, first: { type: 'string' }, second: { type: 'string' }, question: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, language: { type: 'string' }, psm: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, seed: { type: 'integer' }, enhance: { type: 'boolean' }, safe: { type: 'boolean' }, output: { type: 'string' },
  limit: { type: 'integer' }, max_depth: { type: 'integer' }, recursive: { type: 'boolean' }, overwrite: { type: 'boolean' }, replace_all: { type: 'boolean' }, case_sensitive: { type: 'boolean' }
};
function buildNativeToolDefinitions() {
  return Object.entries(MCP_TOOLS).map(([name, description]) => ({
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: NATIVE_TOOL_PROPERTIES, required: TOOL_REQUIRED_ARGS[name] || [], additionalProperties: true }
    }
  }));
}

function extractBalancedJsonObject(text, startAt = 0) {
  const start = text.indexOf('{', startAt);
  if (start < 0) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}
function decodeXmlEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (full, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : full;
  });
}
function dsmlAttribute(attributes, name) {
  const match = String(attributes || '').match(new RegExp('\\b' + name + '\\s*=\\s*(["\\\'])(.*?)\\1', 'i'));
  return match ? decodeXmlEntities(match[2]) : '';
}
function parseDsmlToolCalls(text) {
  const source = String(text || '');
  const calls = [];
  const invokeRx = /<DSMLinvoke\b([^>]*)>([\s\S]*?)<\/DSMLinvoke>/gi;
  let invoke;
  while ((invoke = invokeRx.exec(source)) !== null) {
    const tool = dsmlAttribute(invoke[1], 'name').toLowerCase().trim();
    if (!tool) continue;
    const args = {};
    const paramRx = /<DSMLparameter\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/DSMLparameter>)/gi;
    let parameter;
    while ((parameter = paramRx.exec(invoke[2])) !== null) {
      const name = dsmlAttribute(parameter[1], 'name').trim();
      if (!name) continue;
      const value = decodeXmlEntities(String(parameter[2] || '').trim());
      const stringMode = /\bstring\s*=\s*["']true["']/i.test(parameter[1]);
      if (!stringMode && /^(true|false|null|-?\d+(?:\.\d+)?)$/i.test(value)) {
        try { args[name] = JSON.parse(value); } catch { args[name] = value; }
      } else if (!stringMode && (value.startsWith('{') || value.startsWith('['))) {
        try { args[name] = JSON.parse(value); } catch { args[name] = value; }
      } else args[name] = value;
    }
    calls.push({ tool, args });
  }
  return calls;
}

function parseJsonToolCall(text) {
  // Zen-модели иногда оборачивают корректный JSON tool call в ```json, хотя
  // системная инструкция просит TOOL_JSON. Принимаем только явный JSON-объект
  // с полем tool — обычное упоминание инструмента по-прежнему не запускается.
  const marker = text.search(/TOOL_JSON\s*:/i);
  let candidate = marker >= 0 ? extractBalancedJsonObject(text, marker) : null;
  if (!candidate) {
    const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      const body = fenced[1].trim();
      candidate = body.startsWith('{') ? extractBalancedJsonObject(body, 0) : null;
    }
  }
  if (!candidate) {
    const trimmed = String(text || '').trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidate = extractBalancedJsonObject(trimmed, 0);
  }
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed.tool !== 'string' || (parsed.args !== undefined && (typeof parsed.args !== 'object' || Array.isArray(parsed.args)))) return null;
    return { tool: parsed.tool.toLowerCase().trim(), args: parsed.args || {} };
  } catch { return null; }
}
function validateToolArguments(tool, args) {
  if (!MCP_TOOLS[tool]) return `Неизвестный MCP-инструмент: ${tool}`;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'args должен быть JSON-объектом.';
  const required = TOOL_REQUIRED_ARGS[tool] || [];
  for (const key of required) {
    // packages может быть массивом, всё остальное — непустой строкой/числом/булевым значением.
    if (args[key] === undefined || args[key] === null || args[key] === '') return `Не хватает обязательного аргумента '${key}' для ${tool}.`;
  }
  for (const key of ['path', 'path2', 'cwd', 'source', 'destination', 'archive', 'database', 'url', 'name', 'id', 'agent', 'plugin', 'command', 'model', 'description', 'code', 'repo', 'repository', 'owner', 'project', 'branch', 'remote', 'alias', 'note', 'action', 'artifact_name', 'artifact', 'tag', 'zip_path']) {
    if (args[key] !== undefined && typeof args[key] !== 'string') return `Аргумент '${key}' для ${tool} должен быть строкой.`;
  }
  return null;
}

async function handleToolCall(text, writtenFiles, suppressPublicNote = false) {
  const dsmlCalls = parseDsmlToolCalls(text);
  if (dsmlCalls.length > 1) {
    printPublicAssistantNote(text);
    let handled = false;
    for (const call of dsmlCalls) handled = (await handleToolCall(`TOOL_JSON:${JSON.stringify(call)}`, writtenFiles, true)) || handled;
    return handled;
  }
  const jsonCall = dsmlCalls[0] || parseJsonToolCall(text);
  // Не считаем простое упоминание имени инструмента вызовом. Иначе фраза
  // «использую execute_command» превращалась в пустую опасную команду.
  const toolMatch = jsonCall ? null : text.match(/^\s*TOOL:\s*([a-z_]+)/im);
  if (!jsonCall && !toolMatch) return false;

  const toolName = jsonCall ? jsonCall.tool : toolMatch[1].toLowerCase().trim();
  const args = jsonCall ? { ...jsonCall.args } : {};

  if (!jsonCall) {
    const argRegex = /ARG:([^:]+):([\s\S]*?)(?=\nARG:|\nTOOL:|$)/gi;
    let m;
    while ((m = argRegex.exec(text)) !== null) args[m[1].trim()] = m[2].trim();

    if (Object.keys(args).length === 0) {
      const pm = text.match(/PATH:\s*([^\n]+)/i);
      const cm = text.match(/CONTENT:\s*([\s\S]*?)(?:\n\n|TOOL:|$)/i);
      const cmd = text.match(/COMMAND:\s*([^\n]+)/i);
      if (pm) args.path = pm[1].trim();
      if (cm) args.content = cm[1].trim();
      if (cmd) args.command = cmd[1].trim();
    }
  }

  const validationError = validateToolArguments(toolName, args);
  if (validationError) {
    console.log(c(`⚠️ MCP schema: ${validationError}`, 'yellow'));
    history.push({ role: 'assistant', content: dsmlCalls.length ? `Вызван инструмент ${toolName}.` : redactSecrets(text) });
    history.push({ role: 'user', content: `Ошибка схемы инструмента: ${validationError}. Исправь вызов, используя TOOL_JSON.` });
    return true;
  }

  if (!suppressPublicNote) printPublicAssistantNote(text);
  const hookCall = await pluginHook('beforeTool', { name: toolName, args: { ...args } });
  if (hookCall?.args && typeof hookCall.args === 'object') Object.assign(args, hookCall.args);
  auditEvent('tool_requested', { tool: toolName, args });
  webRunEvent('tool_requested', { tool: toolName, args: JSON.stringify(args) });

  const iconMap = {
    list_dir: '📂', read_file: '📖', write_file: '✏️',
    edit_file: '📝', delete_file: '🗑️', append_file: '➕',
    execute_command: '⚙️', web_search: '🔍',
    image_info: '🖼️', ocr_image: '🔤', vision_analyze: '👁️', analyze_image: '👁️', vision_ui_audit: '🧩', vision_compare: '🆚', pollinations_generate: '🌸', pollinations_models: '🌸', custom_tool_list: '🧰', custom_tool_create: '🛠️', custom_tool_inspect: '🔎', custom_tool_run: '▶️', custom_tool_delete: '🗑️', subagent_list: '👥', subagent_create: '👤', subagent_task: '🤝', subagent_delete: '🗑️', plugin_list: '🧩', plugin_create: '🧩', plugin_inspect: '🔎', plugin_delete: '🗑️', plugin_tool_list: '🧰', plugin_tool_run: '▶️', plugin_provider_list: '🔌',
    workspace_info: '📍', set_workspace: '📍', project_inspect: '🧭', project_list: '📚', project_register: '➕', project_use: '📌', project_remove: '🗑️', project_memory: '🧠', onnx_status: '🧠', onnx_set_model: '📦', onnx_memory_list: '🗂️', onnx_memory_add: '➕', onnx_memory_search: '🔎', onnx_run: '▶️', termux_info: '📱', network_check: '🌐', tree_dir: '🌳', search_text: '🔎', file_info: 'ℹ️', find_files: '🔎',
    file_backup: '💾', file_diff: '🧩', mkdir: '📁', copy_file: '📋', move_file: '🚚', archive_create: '🗜️', archive_extract: '📦',
    process_start: '▶️', process_status: '📊', process_logs: '📜', process_stop: '⏹️', monitor_start: '🩺', monitor_list: '🩺', monitor_logs: '📜', monitor_stop: '⏹️',
    terminal_create: '💻', terminal_write: '⌨️', terminal_read: '📟', terminal_list: '💻', terminal_close: '⏹️',
    http_request: '🌐', health_check: '💓', websocket_test: '🔌', npm_install: '📦', npm_run: '▶️', sqlite_info: '🗃️', sqlite_query: '🗃️', sqlite_schema: '🗃️', sqlite_backup: '💾', env_list: '🔐', env_set: '🔐', env_delete: '🔐', run_tests: '🧪', run_lint: '🧹', code_check: '✅', dependency_audit: '🔐',
    git_status: '🌿', git_diff: '🌿', git_branch: '🌿', git_log: '🌿', git_init: '🌿', git_commit: '🌿', git_push: '⬆️', github_repo_info: '🐙', github_commits: '🐙', github_builds: '🏗️', github_watch_build: '⏱️', github_download_apk: '📱', open_url: '🌐', clipboard_read: '📋', clipboard_write: '📋', notify: '🔔',
    todo_list: '📋', todo_add: '➕', todo_done: '✅', todo_remove: '🗑️',
  };
  const icon = iconMap[toolName] || '🔧';

  console.log();
  console.log(c(`${icon} ${toolName.toUpperCase()}`, 'brightCyan'));

  let permission = toolPermissionDecision(toolName, args);
  const pluginDecision = await pluginPermission({ name: toolName, args, base: permission.action, mode: CONFIG.agentMode });
  if (pluginDecision) permission = { action: pluginDecision, reason: 'решение lifecycle plugin' };
  if (permission.action === 'deny') {
    const message = `Permission denied: ${permission.reason}`;
    console.log(c(`⛔ ${message}`, 'red'));
    auditEvent('tool_blocked', { tool: toolName, reason: permission.reason });
    webRunEvent('tool_blocked', { tool: toolName, reason: permission.reason });
    history.push({ role: 'assistant', content: text });
    history.push({ role: 'user', content: `Инструмент ${toolName} заблокирован. ${permission.reason}` });
    return true;
  }
  if (permission.action === 'ask') {
    previewTool(toolName, args);
    const decision = await askConfirm(toolName, args);
    if (decision === 'no') {
      auditEvent('tool_denied', { tool: toolName, args });
      webRunEvent('tool_denied', { tool: toolName });
      history.push({ role: 'assistant', content: text });
      history.push({ role: 'user', content: `Пользователь отклонил ${toolName}. Другой подход?` });
      return true;
    }
  }

  TELEMETRY.toolCalls++;
  setRunPhase('tool', toolName);
  const isLiveCommand = LIVE_OUTPUT_TOOLS.has(toolName) && CONFIG.liveToolLogs;
  if (CONFIG.liveToolLogs && !isLiveCommand) {
    const trace = [`${c('вызов:', 'gray')} ${toolName}`, `${c('MCP-папка:', 'gray')} ${WORKSPACE_ROOT}`];
    if (args.path) {
      const resolved = resolveWorkspacePath(args.path);
      trace.push(`${c('путь:', 'gray')} ${resolved.error || resolved.path}`);
    }
    printMcpTrace(trace);
  }
  // Спиннер специально отключён для команд: он не должен прятать живой stdout/stderr.
  const spinner = isLiveCommand ? null : new Spinner(telemetryLiveText(), 'dots');
  if (spinner) spinner.start();
  const telemetryTimer = startTelemetryTicker(spinner);
  const t0 = Date.now();
  webRunEvent('tool_started', { tool: toolName });
  const result = await useTool(toolName, args);
  webRunEvent('tool_output', { tool: toolName, result: String(result || '') });
  await pluginHook('afterTool', { name: toolName, args, result });
  TELEMETRY.outputChars += String(result || '').length;
  const ms = Date.now() - t0;
  auditEvent('tool_finished', { tool: toolName, durationMs: ms, result: String(result || '').slice(0, 500) });
  webRunEvent('tool_finished', { tool: toolName, durationMs: ms, result: String(result || '').slice(0, 1000) });
  stopTelemetryTicker(telemetryTimer);
  if (spinner) spinner.stop();

  if ((toolName === 'write_file' || toolName === 'append_file') && args.path) {
    const resolved = resolveWorkspacePath(args.path);
    if (!resolved.error) writtenFiles.add(resolved.path);
  }

  let sizeInfo = '';
  if (args.content) {
    sizeInfo = ` | ${Buffer.byteLength(args.content, 'utf8')} bytes, ${args.content.split('\n').length} lines`;
  } else if (args.command) {
    sizeInfo = ` | ${ms}ms`;
  }

  console.log(c(`  ⏱ ${ms}ms${sizeInfo}`, 'gray'));
  formatToolResult(toolName, result, args);

  history.push({ role: 'assistant', content: dsmlCalls.length ? `Вызван инструмент ${toolName}.` : redactSecrets(text) });
  history.push({ role: 'user', content: `Результат инструмента ${toolName}:\n${redactSecrets(String(result || ''))}` });
  return true;
}

function printPublicAssistantNote(text) {
  if (!CONFIG.showThinking) return;
  let note = redactSecrets(String(text || ''));
  // Убираем машинные части вызова, оставляя только публичный план/наблюдение.
  note = note
    .replace(/TOOL_JSON\s*:\s*\{[\s\S]*$/i, '')
    .replace(/```(?:json)?\s*\{\s*"tool"[\s\S]*?\}\s*```/i, '')
    .replace(/<DSMLtool_calls>[\s\S]*?<\/DSMLtool_calls>/gi, '')
    .replace(/<DSMLinvoke\b[\s\S]*?<\/DSMLinvoke>/gi, '')
    .replace(/<DSMLinvoke\b[\s\S]*$/gi, '')
    .replace(/^\s*TOOL:\s*[a-z_]+[\s\S]*$/im, '')
    .trim();
  if (!note || note.length < 3) return;
  const lines = note.split('\n').filter(Boolean).slice(0, 6).map(line => line.slice(0, 260));
  box(lines, { width: Math.min(82, termWidth() - 2), title: ' 🗒 План / наблюдение ', style: 'single', color: 'magenta' }).forEach(line => console.log(line));
}

async function handleNativeToolCalls(toolCalls, writtenFiles) {
  for (const call of toolCalls) {
    const toolName = String(call?.function?.name || '').toLowerCase().trim();
    let args = {};
    try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { args = {}; }
    const validation = validateToolArguments(toolName, args);
    if (validation) {
      const result = `Ошибка схемы native tool call: ${validation}`;
      console.log(c(`⚠️ ${result}`, 'yellow'));
      history.push({ role: 'tool', tool_call_id: call.id, name: toolName || 'unknown', content: result });
      continue;
    }
    console.log(`\n${c('🔧 Инструмент: ' + toolName, 'brightCyan')}`);
    const hookCall = await pluginHook('beforeTool', { name: toolName, args: { ...args } });
    if (hookCall?.args && typeof hookCall.args === 'object') Object.assign(args, hookCall.args);
    auditEvent('native_tool_requested', { tool: toolName, args });
    webRunEvent('tool_requested', { tool: toolName, args: JSON.stringify(args), native: 'true' });
    let permission = toolPermissionDecision(toolName, args);
    const pluginDecision = await pluginPermission({ name: toolName, args, base: permission.action, mode: CONFIG.agentMode });
    if (pluginDecision) permission = { action: pluginDecision, reason: 'решение lifecycle plugin' };
    if (permission.action === 'deny') {
      const result = `Permission denied: ${permission.reason}`;
      console.log(c(`⛔ ${result}`, 'red'));
      auditEvent('native_tool_blocked', { tool: toolName, reason: permission.reason });
      webRunEvent('tool_blocked', { tool: toolName, reason: permission.reason });
      history.push({ role: 'tool', tool_call_id: call.id, name: toolName, content: redactSecrets(String(result || '')) });
      continue;
    }
    if (permission.action === 'ask') {
      previewTool(toolName, args);
      const decision = await askConfirm(toolName, args);
      if (decision === 'no') {
        auditEvent('native_tool_denied', { tool: toolName, args });
        const result = 'Пользователь отклонил выполнение этого инструмента.';
        history.push({ role: 'tool', tool_call_id: call.id, name: toolName, content: result });
        continue;
      }
    }
    TELEMETRY.toolCalls++;
    setRunPhase('tool', toolName);
    const live = LIVE_OUTPUT_TOOLS.has(toolName) && CONFIG.liveToolLogs;
    const spinner = live ? null : new Spinner(telemetryLiveText(), 'dots');
    if (spinner) spinner.start();
    const telemetryTimer = startTelemetryTicker(spinner);
    const t0 = Date.now();
    webRunEvent('tool_started', { tool: toolName, native: 'true' });
    const result = await useTool(toolName, args);
    webRunEvent('tool_output', { tool: toolName, result: String(result || ''), native: 'true' });
    webRunEvent('tool_finished', { tool: toolName, durationMs: Date.now() - t0, result: String(result || '').slice(0, 1000), native: 'true' });
    await pluginHook('afterTool', { name: toolName, args, result });
    TELEMETRY.outputChars += String(result || '').length;
    auditEvent('native_tool_finished', { tool: toolName, durationMs: Date.now() - t0, result: String(result || '').slice(0, 500) });
    stopTelemetryTicker(telemetryTimer);
    if (spinner) spinner.stop();
    console.log(c(`  ⏱ ${Date.now() - t0}ms`, 'gray'));
    formatToolResult(toolName, result, args);
    if ((toolName === 'write_file' || toolName === 'append_file') && args.path) {
      const resolved = resolveWorkspacePath(args.path); if (!resolved.error) writtenFiles.add(resolved.path);
    }
    history.push({ role: 'tool', tool_call_id: call.id, name: toolName, content: result });
  }
}

// ═══════════════════════════════════════════════════════════════════
function isEmptyModelText(text) {
  const value = String(text || '').trim();
  return !value || /^(модель вернула пустой ответ|пустой ответ|empty response|no content)\.?$/i.test(value);
}
function providerErrorSummary(error) {
  const message = redactSecrets(String(error?.message || error || 'неизвестная ошибка')).replace(/\s+/g, ' ').trim();
  if (isRateLimit(message)) return rateLimitReason(message);
  if (/timeout|timed out|таймаут/i.test(message)) return 'таймаут ожидания ответа';
  if (/parse error|JSON/i.test(message)) return 'провайдер вернул некорректный ответ';
  return message.slice(0, 180) || 'неизвестная ошибка провайдера';
}

//  MAIN AGENT LOOP
// ═══════════════════════════════════════════════════════════════════
async function agentLoopUnsafe(userInput) {
  const startTime = Date.now();
  const writtenFiles = new Set();
  agentBusy = true;
  setAgentInputRaw(true);
  abortRequested = false;
  activeProviderAbort = null;
  beginAgentTelemetry(userInput);
  auditEvent('task_started', { inputChars: String(userInput || '').length, model: currentModel });
  await pluginHook('event', { type: 'task.started', provider: currentProvider, model: currentModel, mode: CONFIG.agentMode, inputChars: String(userInput || '').length });

  history.push({ role: 'user', content: userInput });

  let finalAnswer = '';
  let lastRes = null;

  for (let step = 0; step < agentStepLimit(); step++) {
    TELEMETRY.step = step + 1;
    if (abortRequested) { finalAnswer = 'Задача остановлена пользователем.'; setRunPhase('stopped', 'пользователь'); break; }
    if (correctionQueue.length) {
      const correction = correctionQueue.splice(0).join('\n');
      history.push({ role: 'user', content: `Корректировка пользователя во время выполнения:
${correction}` });
      console.log(c('↪ Корректировка добавлена в контекст.', 'yellow'));
    }
    try {
      setRunPhase('model', providerDisplayName());
      const requestMessages = messagesForProvider();
      TELEMETRY.requestChars = requestMessages.reduce((sum, msg) => sum + String(msg.content || '').length, 0);
      TELEMETRY.estimatedInputTokens = estimateTokens(TELEMETRY.requestChars);
      auditEvent('model_request', { step: TELEMETRY.step, model: currentModel, requestChars: TELEMETRY.requestChars, estimatedInputTokens: TELEMETRY.estimatedInputTokens });
      // Поток Zen/OpenRouter сам выводит токены и start/end timing; plugin provider пока non-stream.
      const willStream = CONFIG.streamMode && (currentProvider === 'zen' || currentProvider === 'openrouter');
      const spinner = willStream ? null : new Spinner(telemetryLiveText(), 'dots');
      if (spinner) spinner.start();
      const telemetryTimer = startTelemetryTicker(spinner);
      let res;
      try { res = await callCurrentProvider(); }
      catch (firstError) {
        if (currentProvider === 'zen' && CONFIG.streamMode) res = await callZenWithRetry(messagesForProvider(), currentModel, undefined, false);
        else { stopTelemetryTicker(telemetryTimer); if (spinner) spinner.stop(); throw firstError; }
      }
      recordProviderResult(res);
      auditEvent('model_response', { step: TELEMETRY.step, model: res.model || currentModel, outputChars: String(res.text || '').length, usage: res.usage || {}, toolCalls: Array.isArray(res.toolCalls) ? res.toolCalls.length : 0 });
      stopTelemetryTicker(telemetryTimer);
      if (spinner) spinner.stop();
      lastRes = res;

      let text = res.text || '';

      if (res.thinking && CONFIG.showThinking && CONFIG.verbose) {
        console.log(c('[💭 Провайдер вернул reasoning-канал. Вместо скрытой цепочки показан публичный план и проверяемые действия.]', 'gray'));
      }

      // Native OpenRouter tool_calls имеют приоритет над текстовым fallback-протоколом.
      if (currentProvider !== 'zen' && Array.isArray(res.toolCalls) && res.toolCalls.length) {
        printPublicAssistantNote(text);
        history.push({ role: 'assistant', content: text || '', tool_calls: res.toolCalls });
        await handleNativeToolCalls(res.toolCalls, writtenFiles);
        continue;
      }

      if (correctionQueue.length) continue;

      if (isEmptyModelText(text) || text.length < 8) {
        try {
          history.push({ role: 'user', content: 'Используй доступные инструменты или дай конкретный ответ.' });
          setRunPhase('model', 'повторный запрос');
          const r2 = await callCurrentProvider();
          recordProviderResult(r2);
          if (r2.text && !isEmptyModelText(r2.text) && r2.text.length > 8) text = r2.text;
          if (currentProvider !== 'zen' && r2.toolCalls?.length) {
            history.push({ role: 'assistant', content: r2.text || '', tool_calls: r2.toolCalls });
            await handleNativeToolCalls(r2.toolCalls, writtenFiles);
            continue;
          }
          if (isEmptyModelText(text) && (currentProvider === 'zen' || currentProvider === 'openrouter')) {
            const previousStream = CONFIG.streamMode;
            CONFIG.streamMode = false;
            try {
              const r3 = await callCurrentProvider();
              recordProviderResult(r3);
              if (r3.text && !isEmptyModelText(r3.text)) text = r3.text;
              if (currentProvider !== 'zen' && r3.toolCalls?.length) {
                history.push({ role: 'assistant', content: r3.text || '', tool_calls: r3.toolCalls });
                await handleNativeToolCalls(r3.toolCalls, writtenFiles);
                continue;
              }
            } finally { CONFIG.streamMode = previousStream; }
          }
        } catch {}
      }

      if (CONFIG.autoUseTools && await handleToolCall(text, writtenFiles)) {
        continue;
      }

      finalAnswer = isEmptyModelText(text) ? 'Модель не вернула содержательный ответ после повторных попыток.' : text;
      if (CONFIG.streamMode && res.outputShown) finalAnswer = '';
      history.push({ role: 'assistant', content: text });
      break;
    } catch (err) {
      if (abortRequested) { finalAnswer = 'Задача остановлена пользователем.'; setRunPhase('stopped', 'пользователь'); break; }
      const em = (err && err.message) ? err.message : (String(err) || 'неизвестная ошибка');
      finalAnswer = `Ошибка: ${em}`;
      auditEvent('model_error', { step: TELEMETRY.step, error: em });
      setRunPhase('error', em.slice(0, 80));
      console.log(c('\n❌ ' + finalAnswer, 'red'));
      break;
    }
  }

  // ═════════════════════════════════════════════════════════════════
  //  VERIFY: no stubs / no truncated JS
  // ═════════════════════════════════════════════════════════════════
  if (!finalAnswer.startsWith('Ошибка') && writtenFiles.size) {
    const jsFiles = [...writtenFiles].filter(f => f.endsWith('.js') && fs.existsSync(f));
    if (jsFiles.length) {
      for (let v = 0; v < 3; v++) {
        const errors = [];
        for (const f of jsFiles) {
          try {
            execSync(`"${process.execPath}" --check "${f}"`, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
          } catch (e) {
            const msg = (e.stderr || e.stdout || e.message || '').split('\n').slice(0, 8).join('\n');
            errors.push(`${f}:\n${msg}`);
          }
        }
        if (!errors.length) {
          if (v > 0) console.log(c('\n✅ Синтаксис всех файлов корректен', 'green'));
          break;
        }
        console.log(c(`\n🔍 Ошибки синтаксиса (попытка ${v + 1}/3), исправляю...`, 'yellow'));
        const prevAuto = CONFIG.autoApprove;
        CONFIG.autoApprove = true;
        try {
          const fixMsg = 'Исправь ошибки синтаксиса в следующих файлах, используя edit_file или append_file. Пиши ПОЛНЫЙ рабочий код, без заглушек, TODO и "реализовать позже".\n\n' + errors.join('\n\n');
          history.push({ role: 'user', content: fixMsg });
          const r = await callCurrentProvider();
          if (currentProvider !== 'zen' && r.toolCalls?.length) {
            history.push({ role: 'assistant', content: r.text || '', tool_calls: r.toolCalls });
            await handleNativeToolCalls(r.toolCalls, writtenFiles);
          } else {
            let guard = 0;
            let cur = r.text || '';
            while (cur && guard++ < agentStepLimit()) {
              if (await handleToolCall(cur, writtenFiles)) {
                const nr = await callCurrentProvider();
                if (currentProvider !== 'zen' && nr.toolCalls?.length) {
                  history.push({ role: 'assistant', content: nr.text || '', tool_calls: nr.toolCalls });
                  await handleNativeToolCalls(nr.toolCalls, writtenFiles);
                  break;
                }
                cur = nr.text || '';
              } else break;
            }
          }
        } catch (e) {
          console.log(c('⚠️ Не удалось авто-исправить: ' + (e.message || e), 'red'));
        } finally {
          CONFIG.autoApprove = prevAuto;
        }
      }
    }
  }

  const took = ((Date.now() - startTime) / 1000).toFixed(1);
  if (finalAnswer && !CONFIG.streamMode) {
    console.log();
    formatFinalAnswer(finalAnswer);
  }
  if (lastRes && lastRes.usage) {
    const u = lastRes.usage;
    const tot = u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0));
    if (tot) {
      const bar = miniProgress(tot, 32000, 16);
      console.log(c(`\n${bar} ≈${tot} tok • ${took}s`, 'gray'));
    }
  } else if (finalAnswer) {
    console.log(c(`\n${took}s`, 'gray'));
  }

  if (TELEMETRY.phase !== 'error' && TELEMETRY.phase !== 'stopped') setRunPhase('complete', 'результат готов');
  auditEvent('task_finished', { phase: TELEMETRY.phase, durationMs: TELEMETRY.startedAt ? Date.now() - TELEMETRY.startedAt : 0, steps: TELEMETRY.step, toolCalls: TELEMETRY.toolCalls, usage: TELEMETRY.usage || {} });
  await pluginHook('event', { type: 'task.finished', phase: TELEMETRY.phase, steps: TELEMETRY.step, toolCalls: TELEMETRY.toolCalls });
  drawTelemetryPanel(' Итог выполнения ');
  saveHistory();
  agentBusy = false;
  setRunPhase('user-control', 'ожидание следующей команды');
  console.log(c('▣ Управление снова у вас. Можно дать следующую задачу или корректировку.', 'brightGreen'));
  return finalAnswer;
}

// Public wrapper guarantees that a failed provider/plugin cannot leave the
// process permanently locked in "busy" state or leave a confirmation hanging.
async function agentLoop(userInput) {
  try {
    return await agentLoopUnsafe(userInput);
  } finally {
    if (pendingConfirmation) {
      const pending = pendingConfirmation;
      pendingConfirmation = null;
      try { pending.resolve('no'); } catch {}
    }
    agentBusy = false;
    setAgentInputRaw(false);
    if (ACTIVE_STREAM) finishAiStream('aborted');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  INTERACTIVE MODE
// ═══════════════════════════════════════════════════════════════════
function getHelp() {
  const tw = termWidth();
  const w = Math.min(64, tw - 4);
  const lines = [
    `${c('КОМАНДЫ', 'cyan')}`,
    `  ${c('/help', 'brightCyan')}        — показать справку`,
    `  ${c('/tools', 'brightCyan')}       — полный список MCP-инструментов`,
    `  ${c('/custom-tools', 'brightCyan')} — локальные само-созданные tools`,
    `  ${c('/plugins', 'brightCyan')}     — lifecycle plugins`,
    `  ${c('/subagents', 'brightCyan')}   — встроенные и local subagents`,
    `  ${c('/mode [build|plan|explore]', 'brightCyan')} — режим агента`,
    `  ${c('/long [on|off]', 'brightCyan')} — долгие задачи и команды до 1 часа`,
    `  ${c('/zen [модель]', 'brightCyan')} — режим бесплатных Zen-моделей`,
    `  ${c('/open [модель]', 'brightCyan')} — OpenRouter + native tool calls`,
    `  ${c('/provider [id]', 'brightCyan')} — выбрать встроенный/plugin provider`,
    `  ${c('/key', 'brightCyan')}         — задать OpenRouter key через Android password-dialog`,
    `  ${c('/key status|clear', 'brightCyan')} — проверить / удалить ключ`,
    `  ${c('/hf [set TOKEN|status|clear]', 'brightCyan')} — Hugging Face token и модели`,
    `  ${c('/vision [модель]', 'brightCyan')} — vision-модель для скриншотов`,
    `  ${c('/models [N|id]', 'brightCyan')} — список / выбор модели провайдера (free + платные)`,
    `  ${c('/models all', 'brightCyan')}    — показать модели всех провайдеров`,
    `  ${c('/session', 'brightCyan')}      — список AI-сессий`,
    `  ${c('/session new ИМЯ', 'brightCyan')} — новая / переключение сессии`,
    `  ${c('/session fork ИМЯ', 'brightCyan')} — ветка текущей сессии`,
    `  ${c('/session export [путь]', 'brightCyan')} — экспорт JSON`,
    `  ${c('/session import путь ИМЯ', 'brightCyan')} — импорт JSON`,
    `  ${c('/continue', 'brightCyan')}     — продолжить активную сессию`,
    `  ${c('/correct текст', 'brightCyan')} — корректировка во время работы`,
    `  ${c('/abort', 'brightCyan')}        — остановить работу после текущего шага`,
    `  ${c('/mcp', 'brightCyan')}         — статус MCP и рабочая папка`,
    `  ${c('/status', 'brightCyan')}      — токены, время и текущая фаза`,
    `  ${c('/audit [N]', 'brightCyan')}     — журнал действий текущего проекта`,
    `  ${c('/workspace [путь]', 'brightCyan')} — показать / сменить MCP-папку`,
    `  ${c('/project list', 'brightCyan')}    — список коротких имён проектов`,
    `  ${c('/project add ИМЯ ПУТЬ', 'brightCyan')} — привязать папку проекта`,
    `  ${c('/project use ИМЯ', 'brightCyan')} — переключить активный проект и память`,
    `  ${c('/project memory', 'brightCyan')} — показать память активного проекта`,
    `  ${c('/onnx status', 'brightCyan')}  — статус локальной ONNX-модели и memory`,
    `  ${c('/onnx model ПУТЬ', 'brightCyan')} — подключить .onnx-файл`,
    `  ${c('/onnx memory add ТЕКСТ', 'brightCyan')} — сохранить знание в memory`,
    `  ${c('/net', 'brightCyan')}         — проверить доступ к серверу моделей`,
    `  ${c('/vpn', 'brightCyan')}         — подсказка для системного Android VPN`,
    `  ${c('/proxy [URL|off|test]', 'brightCyan')} — пул прокси, автопереключение и проверка скорости`,
    `  ${c('/proxy add URL | /proxy remove N | /proxy auto on/off', 'brightCyan')} — управление пулом прокси`,
    `  ${c('/git', 'brightCyan')}             — GitHub token, репозиторий, коммиты, сборки и APK`,
    `  ${c('/git key [TOKEN|status|clear]', 'brightCyan')} — безопасно задать или удалить GitHub token`,
    `  ${c('/git repo owner/name', 'brightCyan')} — выбрать репозиторий по умолчанию`,
    `  ${c('/git commits|builds|watch|apk|push', 'brightCyan')} — GitHub операции`,
    `  ${c('/agents', 'brightCyan')}        — список других CLI-агентов (Claude Code, Codex, Aider, OpenCode...)`,
    `  ${c('/install-agent [пакет]', 'brightCyan')} — установить CLI-агента через npm/npx`,
    `  ${c('/tunnel [start|stop|status]', 'brightCyan')} — встроенный туннель для обхода блокировок`,
    `  ${c('/stream', 'brightCyan')}      — переключить стриминг`,
    `  ${c('/logs', 'brightCyan')}        — включить/выключить вывод команд в реальном времени`,
    `  ${c('/animation [on|off]', 'brightCyan')} — ANSI-перерисовка loading bar`,
    `  ${c('/indicator [вид]', 'brightCyan')} — выбор вида индикатора стрелками`,
    `  ${c('/auto [on|off]', 'brightCyan')} — авто-одобрение инструментов`,
    `  ${c('/think', 'brightCyan')}       — показать/скрыть публичный план и наблюдения`,
    `  ${c('/clarify [on|off]', 'brightCyan')} — уточняющие вопросы перед работой`,
    `  ${c('/clear', 'brightCyan')}       — очистить историю`,
    `  ${c('/save', 'brightCyan')}        — сохранить историю`,
    `  ${c('/dash', 'brightCyan')}        — показать/скрыть дашборд`,
    `  ${c('/compact', 'brightCyan')}      — компактный режим`,
    `  ${c('/todo текст [parent N]', 'brightCyan')} — добавить задачу (parent — иерархия)`,
    `  ${c('/todos', 'brightCyan')}        — список задач (дерево со статусами)`,
    `  ${c('/start N', 'brightCyan')}      — отметить задачу «в работе»`,
    `  ${c('/done N', 'brightCyan')}       — отметить задачу выполненной (успех)`,
    `  ${c('/fail N причина', 'brightCyan')} — отметить задачу проваленной`,
    `  ${c('/rm N', 'brightCyan')}         — удалить задачу (и подзадачи)`,
    `  ${c('/clear-todo', 'brightCyan')}   — очистить все задачи`,
    `  ${c('/sub run <агент> <задача>', 'brightCyan')} — запустить субагента`,
    `  ${c('/sub batch <агент>|<задача>;...', 'brightCyan')} — параллельно несколько субагентов`,
    `  ${c('/sub bg <агент> <задача>', 'brightCyan')} — фоновая задача субагента`,
    `  ${c('/sub status [id|all]', 'brightCyan')} — статус фоновых задач`,
    `  ${c('/exit', 'brightCyan')}        — выход`,
    ``,
    `${c('ПРИМЕРЫ', 'cyan')}`,
    `  создай файл test.txt с текстом Привет`,
    `  прочитай package.json`,
    `  выполни ls -la`,
    `  что в текущей папке?`,
  ];
  box(lines, { width: w, title: ' Справка ', style: 'double', color: 'cyan' }).forEach(l => console.log(l));
}

function showTools() {
  const groups = [
    ['Рабочая папка и файлы', ['workspace_info','set_workspace','project_inspect','project_list','project_register','project_use','project_remove','project_memory','onnx_status','onnx_set_model','onnx_memory_list','onnx_memory_add','onnx_memory_search','onnx_run','tree_dir','list_dir','find_files','search_text','file_info','read_file','write_file','edit_file','append_file','delete_file','mkdir','copy_file','move_file','file_backup','file_diff','archive_create','archive_extract']],
    ['Процессы, мониторинг и терминал', ['process_start','process_status','process_logs','process_stop','monitor_start','monitor_list','monitor_logs','monitor_stop','terminal_create','terminal_write','terminal_read','terminal_list','terminal_close','http_request','health_check','websocket_test']],
    ['Код, npm, SQLite и Git', ['npm_install','npm_run','run_tests','run_lint','code_check','dependency_audit','sqlite_info','sqlite_query','sqlite_schema','sqlite_backup','env_list','env_set','env_delete','git_status','git_diff','git_branch','git_log','git_init','git_commit','git_push','github_repo_info','github_read_file','github_list_dir','github_write_file','github_readme','github_commits','github_builds','github_watch_build','github_download_apk']],
    ['Vision и изображения', ['image_info','ocr_image','vision_analyze','vision_ui_audit','vision_compare','pollinations_generate','pollinations_models','read_image']],
    ['Саморасширение', ['custom_tool_list','custom_tool_create','custom_tool_inspect','custom_tool_run','custom_tool_delete']],
    ['Subagents', ['subagent_list','subagent_create','subagent_task','subagent_batch','subagent_background','subagent_status','subagent_delete']],
    ['Lifecycle plugins', ['plugin_list','plugin_create','plugin_inspect','plugin_tool_list','plugin_tool_run','plugin_provider_list','plugin_delete']],
    ['Сеть и Android', ['network_check','web_search','download_file','open_url','clipboard_read','clipboard_write','notify','termux_info']],
    ['Планирование', ['todo_list','todo_add','todo_start','todo_done','todo_fail','todo_remove','execute_command']]
  ];
  const w = Math.min(90, termWidth() - 2);
  const lines = [`${c(`Всего MCP-инструментов: ${Object.keys(MCP_TOOLS).length}`, 'brightCyan')}`, ''];
  for (const [title, names] of groups) {
    lines.push(c(title, 'yellow'));
    for (const name of names) if (MCP_TOOLS[name]) lines.push(`  ${c(name, 'brightCyan')} — ${MCP_TOOLS[name]}`);
    lines.push('');
  }
  box(lines, { width: w, title: ' MCP Tools ', style: 'double', color: 'cyan' }).forEach(line => console.log(line));
}

async function selectModel(rl) {
  const tw = termWidth();
  const w = Math.min(56, tw - 4);
  const lines = ZEN_MODELS.map((m, i) => `  ${c(String(i + 1) + '.', 'yellow')} ${c(m.id, 'brightCyan')} — ${m.name} (${m.ctx})`);
  box(lines, { width: w, title: ' Модели ', style: 'single', color: 'cyan' }).forEach(l => console.log(l));

  const ans = await new Promise(r => rl.question(c('Выбери [1-' + ZEN_MODELS.length + ']: ', 'yellow'), r));
  const n = parseInt(ans.trim(), 10);
  if (n >= 1 && n <= ZEN_MODELS.length) {
    currentModel = ZEN_MODELS[n - 1].id;
    console.log(c('✓ Модель: ' + currentModel, 'green'));
  }
}

// Интерактивный постраничный выбор модели (стрелками), чтобы большие списки
// (free+paid OpenRouter и т.п.) не «дёргались» и не вываливались за экран.
function pickModelInteractive(title, models) {
  const list = models || [];
  if (!canUseArrowMenu() || !list.length) return null;
  const PAGE = 12;
  let page = 0;
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE));
  return new Promise(resolve => {
    const renderPage = () => {
      const start = page * PAGE;
      const slice = list.slice(start, start + PAGE);
      const options = slice.map(m => ({
        label: m.id,
        description: `${m.name || ''} • ${m.ctx || ''}${m.tier === 'paid' ? ' • платно' : ''}${m.reasoning ? ' • reasoning' : ''}`.trim().replace(/\s•\s+$/,''),
        model: m
      }));
      if (page < totalPages - 1) options.push({ label: `▶ Далее (ещё ${list.length - (start + PAGE)})`, page: page + 1 });
      if (page > 0) options.push({ label: '◀ Назад', page: page - 1 });
      openArrowMenu(`${title} — стр. ${page + 1}/${totalPages}`, options, async opt => {
        if (opt.page !== undefined) { page = opt.page; renderPage(); }
        else resolve(opt.model);
      }, () => resolve(null));
    };
    renderPage();
  });
}

async function chooseCurrentProviderModel(spec = '') {
  const raw = String(spec || '').trim();
  const cat = await listModelsForProvider(currentProvider);
  const all = [...cat.free, ...cat.paid];
  const meta = providerMeta(currentProvider) || { name: currentProvider, icon: '🔧' };
  if (!raw) {
    const picked = await pickModelInteractive(`Модели • ${meta.name}`, all);
    if (picked) {
      currentModel = picked.id;
      if (currentProvider === 'openrouter') CONFIG.openRouterModel = currentModel;
      saveHistory(); console.log(c(`✓ ${currentProvider}: ${currentModel}`, 'green'));
      return;
    }
    // Интерактив недоступен (нет TTY) — печатаем списки free/paid.
    printModels(cat, meta.name);
    return;
  }
  const index = parseInt(raw, 10);
  const selected = Number.isInteger(index) && index >= 1 && index <= all.length ? all[index - 1] : all.find(m => m.id === raw) || { id: raw, name: raw };
  currentModel = selected.id;
  if (currentProvider === 'openrouter') CONFIG.openRouterModel = currentModel;
  saveHistory();
  console.log(c(`✓ ${currentProvider}: ${currentModel}`, 'green'));
}

// Неинтерактивный печатный список моделей провайдера (free и paid раздельно).
function printModels(cat, title = '') {
  const lines = [];
  if (cat.free.length) {
    lines.push(c('БЕСПЛАТНЫЕ', 'green'), '');
    cat.free.forEach((m, i) => lines.push(`  ${c(String(i + 1) + '.', 'yellow')} ${c(m.id, 'brightCyan')} — ${m.name || ''} (${m.ctx || ''})${m.reasoning ? ' • reasoning' : ''}`));
  }
  if (cat.paid.length) {
    lines.push('', c('ПЛАТНЫЕ', 'brightMagenta'), '');
    const base = cat.free.length;
    cat.paid.forEach((m, i) => lines.push(`  ${c(String(base + i + 1) + '.', 'yellow')} ${c(m.id, 'brightCyan')} — ${m.name || ''} (${m.ctx || ''})${m.reasoning ? ' • reasoning' : ''}`));
  }
  lines.push('', c('Выбор: /models N  или  /models id_модели', 'gray'));
  box(lines, { width: Math.min(96, termWidth() - 2), title: ` Модели • ${title} `, style: 'single', color: 'cyan' }).forEach(line => console.log(line));
}
function drawSessions() {
  const rows = listSessions();
  const lines = rows.length ? rows.map(item => `${item.active ? c('●', 'green') : c('○', 'gray')} ${c(item.name, 'brightCyan')} — ${item.messages} msg • ${item.provider} • ${item.model}\n    ${c('рабочая папка:', 'gray')} ${c(item.workspace || '—', 'gray')}`) : [c('Сессий нет.', 'gray')];
  lines.push('', c('Каждая сессия помнит свою рабочую папку и историю — /session ИМЯ вернёт вас туда.', 'gray'));
  lines.push(c('Команды: /session new ИМЯ | /session ИМЯ | /session delete ИМЯ', 'gray'));
  box(lines, { width: Math.min(90, termWidth() - 2), title: ' Сессии ', style: 'single', color: 'cyan' }).forEach(line => console.log(line));
}

async function main() {
  loadOpenRouterKey();
  loadGitHubConfig();
  if (CONFIG.activeProject) { const projectStart = useProjectTool({ alias: CONFIG.activeProject }); if (projectStart.error) console.log(c('⚠️ ' + projectStart.error, 'yellow')); }
  loadHistory();
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  readline.emitKeypressEvents(process.stdin, rl);
  process.stdin.on('keypress', handleAgentKeypress);
  if (typeof process.stdin.prependListener === 'function') process.stdin.prependListener('data', handleAgentInputData);
  let inputClosed = false;
  rl.on('close', () => { inputClosed = true; });
  startEmbeddedServer();
  await new Promise(r => setTimeout(r, 300));
  if (process.env.ZEN_SKIP_NETWORK_CHECK !== '1') {
    await checkNetwork();
  }
  await checkMCP();
  printBanner();

  const prompt = () => {
    if (inputClosed || agentBusy || pendingConfirmation || activeArrowMenu) return;
    process.stdout.write(CONFIG.compactMode ? c('▶ ', 'green') : c('\n┌─[zen]─▶ ', 'green'));
  };
  promptRenderer = prompt;
  const finishCommand = () => { if (!agentBusy && !pendingConfirmation && !activeArrowMenu) prompt(); };

  async function handleIdleInput(text) {
    const lower = text.toLowerCase();
    if (looksLikeOpenRouterKey(text)) {
      const result = saveKeyFromCommand(text);
      console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ OpenRouter key сохранён: ${result.masked}. Не отправляю ключ модели.`, 'green'));
      finishCommand(); return;
    }
    if (looksLikeGitHubToken(text)) {
      const result = saveGitHubToken(text);
      console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ GitHub token сохранён: ${result.masked}. Не отправляю его модели.`, 'green'));
      finishCommand(); return;
    }
    if (lower === '/exit' || lower === '/quit' || lower === '/q') {
      saveHistory();
      for (const monitor of PROCESS_MONITORS.values()) clearInterval(monitor.timer);
      subagentJobsCleanup();
      for (const session of TERMINAL_SESSIONS.values()) { try { session.proc.kill('SIGTERM'); } catch {} }
      rl.close();
      if (embeddedServer?.listening) embeddedServer.close(() => process.exit(0));
      else process.exit(0);
      return;
    }
    if (lower === '/help' || lower === '/?') { getHelp(); finishCommand(); return; }
    if (lower === '/tools') { showTools(); finishCommand(); return; }
    if (lower === '/custom-tools' || lower === '/customtools') {
      const custom = customToolListTool();
      const lines = custom.tools.length ? custom.tools.map(tool => `${tool.name} — ${tool.description}`) : [c('Нет custom tools. Агент создаст их при необходимости в .zen-agent/custom-tools.', 'gray')];
      lines.unshift(c('Папка: ' + custom.directory, 'gray'));
      box(lines, { width: Math.min(90, termWidth() - 2), title: ' Custom tools ', style: 'single', color: 'cyan' }).forEach(line => console.log(line));
      finishCommand(); return;
    }
    if (lower === '/mode' || lower.startsWith('/mode ')) {
      const value = lower.replace(/^\/mode\s*/, '').trim();
      if (!value) {
        const options = Object.entries(AGENT_MODES).map(([id, meta]) => ({ label: meta.label, description: meta.description, mode: id }));
        const opened = openArrowMenu('Режим агента', options, async option => {
          const changed = setAgentMode(option.mode);
          console.log(c(`✓ Режим: ${changed.label}`, 'green'));
        });
        if (!opened) console.log(c('Режимы: build, plan, explore. Пример: /mode plan', 'gray'));
      } else if (AGENT_MODES[value]) {
        const changed = setAgentMode(value);
        console.log(c(`✓ Режим: ${changed.label} — ${changed.description}`, 'green'));
      } else console.log(c('Неизвестный режим. Используй build, plan или explore.', 'red'));
      finishCommand(); return;
    }
    if (lower === '/plugins') {
      const plugins = pluginListTool();
      const lines = plugins.plugins.length ? plugins.plugins.map(p => `${p.enabled ? '●' : '○'} ${p.name} — ${p.description}`) : [c('Нет lifecycle plugins.', 'gray')];
      lines.unshift(c('Папка: ' + plugins.directory, 'gray'));
      box(lines, { width: Math.min(90, termWidth() - 2), title: ' Plugins ', style: 'single', color: 'cyan' }).forEach(line => console.log(line));
      finishCommand(); return;
    }
    if (lower === '/sub' || lower.startsWith('/sub ')) {
      const spec = text.replace(/^\/sub\s*/i, '').trim();
      if (!spec) { console.log(c('Используй: /sub run <агент> <задача> | /sub batch <агент>|<задача>;... | /sub bg <агент> <задача> | /sub status [id] | /sub status all', 'gray')); finishCommand(); return; }
      const [cmd, ...rest] = spec.split(/\s+/);
      if (cmd === 'status') {
        const arg = rest[0] || 'all';
        console.log(JSON.stringify(subagentStatusTool({ id: arg }), null, 2));
        finishCommand(); return;
      }
      if (cmd === 'run' || cmd === 'bg') {
        const agentName = rest[0] || 'explore'; const task = rest.slice(1).join(' ');
        if (!task) { console.log(c('Нужна задача: /sub run <агент> <задача>', 'yellow')); finishCommand(); return; }
        if (cmd === 'bg') { const r = subagentBackgroundTool({ agent: agentName, prompt: task }); console.log(r.error ? c('✗ ' + r.error, 'red') : c(`✓ Фоновая задача ${r.id} (${r.status})`, 'green')); }
        else { console.log(c(`▶ Субагент ${agentName}...`, 'cyan')); const r = await subagentTaskTool({ agent: agentName, prompt: task }); console.log(r.error ? c('✗ ' + r.error, 'red') : (c(`✓ [${r.model}]`, 'green') + '\n' + r.output)); }
        finishCommand(); return;
      }
      if (cmd === 'batch') {
        const parts = rest.join(' ').split(';').map(s => s.trim()).filter(Boolean);
        const specs = parts.map(p => { const m = p.match(/^([a-zA-Z0-9_-]+)[|:](.+)$/); return m ? { agent: m[1], prompt: m[2] } : { agent: 'explore', prompt: p }; });
        console.log(c(`▶ Параллельный запуск ${specs.length} субагентов...`, 'cyan'));
        const r = await subagentBatchTool({ agents: specs });
        console.log(`Итог: успешно ${r.succeeded}, провал ${r.failed}`);
        (r.tasks || []).forEach(t => { console.log(t.success ? c(`  ✓ [${t.model}] ${t.agent}: ${(t.output||'').slice(0,120)}`, 'green') : c(`  ✗ ${t.agent || '?'}: ${t.error}`, 'red')); });
        finishCommand(); return;
      }
      console.log(c('Неизвестная команда /sub. Примеры выше.', 'red'));
      finishCommand(); return;
    }
    if (lower === '/subagents') {
      const agents = subagentListTool();
      const lines = [c('Built-in:', 'yellow'), ...Object.entries(agents.builtins).map(([name, value]) => `${name} — ${value.description}`), '', c('Local:', 'yellow'), ...(agents.custom.length ? agents.custom.map(a => `${a.name} — ${a.description}`) : [c('нет', 'gray')])];
      box(lines, { width: Math.min(90, termWidth() - 2), title: ' Subagents ', style: 'single', color: 'cyan' }).forEach(line => console.log(line));
      finishCommand(); return;
    }
    if (lower === '/long' || lower.startsWith('/long ')) {
      const value = lower.replace(/^\/long\s*/, '').trim();
      CONFIG.longTaskMode = value === 'on' || value === '1' || value === 'да' ? true : value === 'off' || value === '0' || value === 'нет' ? false : !CONFIG.longTaskMode;
      saveHistory();
      console.log(c(`Долгие задачи: ${CONFIG.longTaskMode ? 'ВКЛ' : 'ВЫКЛ'} • шагов до ${agentStepLimit()} • команда до ${Math.round((CONFIG.longTaskMode ? CONFIG.longCommandTimeoutMs : 120000) / 60000)} мин`, CONFIG.longTaskMode ? 'green' : 'yellow'));
      finishCommand(); return;
    }
    if (lower === '/models' || lower === '/model' || lower.startsWith('/models ') || lower.startsWith('/model ')) {
      const spec = text.replace(/^\/models?\s*/i, '').trim();
      if (spec === 'all') {
        for (const p of MODEL_PROVIDERS) {
          const cat = await listModelsForProvider(p.id);
          printModels(cat, p.name + ' (' + p.id + ')');
        }
        finishCommand(); return;
      }
      await chooseCurrentProviderModel(spec); finishCommand(); return;
    }
    if (lower === '/key' || lower.startsWith('/key ')) {
      const value = text.replace(/^\/key\s*/i, '').trim();
      if (!value) {
        if (!openSecretKeyInput()) console.log(c('Защищённый Android password-dialog недоступен. Установи Termux:API либо используй /key set ТВОЙ_КЛЮЧ (ключ будет виден в scrollback).', 'yellow'));
      } else if (value.toLowerCase() === 'status') {
        const status = openRouterKeyStatus();
        console.log(c(`OpenRouter key: ${status.configured ? status.masked : 'не задан'} • ${status.source}`, status.configured ? 'green' : 'yellow'));
      } else if (value.toLowerCase() === 'clear' || value.toLowerCase() === 'remove') {
        const cleared = clearOpenRouterKey();
        console.log(c(cleared.environmentStillSet ? 'Локальный ключ удалён, но OPENROUTER_API_KEY всё ещё задан в окружении.' : '✓ Локальный OpenRouter key удалён.', 'yellow'));
      } else {
        const result = saveKeyFromCommand(value);
        console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ OpenRouter key сохранён: ${result.masked}`, 'green'));
      }
      finishCommand(); return;
    }
    if (lower === '/hf' || lower.startsWith('/hf ')) {
      const value = text.replace(/^\/hf\s*/i, '').trim();
      if (!value) {
        const t = huggingFaceToken();
        console.log(c(`Hugging Face token: ${t ? t.slice(0, 4) + '…' + t.slice(-4) : 'не задан'}`, t ? 'green' : 'yellow'));
        console.log(c('Команды: /hf set ТВОЙ_ТОКЕН | /hf status | /hf clear', 'gray'));
      } else if (/^(status|show)$/i.test(value)) {
        const t = huggingFaceToken();
        console.log(c(`Hugging Face token: ${t ? t.slice(0, 4) + '…' + t.slice(-4) : 'не задан'}`, t ? 'green' : 'yellow'));
        console.log(c('Источник: ' + (process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN ? 'окружение' : (require('fs').existsSync(HF_TOKEN_FILE) ? 'локальный файл' : 'нет')), 'gray'));
      } else if (/^(clear|remove|delete)$/i.test(value)) {
        const cleared = clearHfToken();
        console.log(c(cleared.environmentStillSet ? 'Локальный HF token удалён, но токен из окружения всё ещё активен.' : '✓ Локальный Hugging Face token удалён.', 'yellow'));
      } else {
        const result = saveHfToken(value);
        console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ Hugging Face token сохранён: ${result.masked}`, 'green'));
      }
      finishCommand(); return;
    }
    if (lower === '/vision' || lower.startsWith('/vision ')) {
      const model = text.replace(/^\/vision\s*/i, '').trim();
      if (!model) console.log(c(`Vision model: ${CONFIG.visionModel}. Используй: /vision MODEL_ID`, 'brightCyan'));
      else { CONFIG.visionModel = model; saveHistory(); console.log(c('✓ Vision model: ' + CONFIG.visionModel, 'green')); }
      finishCommand(); return;
    }
    if (lower === '/provider' || lower.startsWith('/provider ')) {
      const value = text.replace(/^\/provider\s*/i, '').trim();
      const providers = allProvidersMenu();
      if (!value) {
        const opened = openArrowMenu('Provider', providers.map(p => ({ label: p.icon + ' ' + p.label, description: p.description, provider: p })), async option => {
          currentProvider = option.provider.id;
          saveHistory(); console.log(c(`✓ Provider: ${currentProvider}`, 'green'));
          const ready = providerReady(currentProvider);
          if (!ready.ok) console.log(c(`⚠️ ${ready.reason}`, 'yellow'));
        });
        if (!opened) {
          providers.forEach(p => { const r = providerReady(p.id); console.log(`${r.ok ? c('●', 'green') : c('○', 'red')} ${p.icon} ${c(p.id, 'brightCyan')} — ${p.description}${r.ok ? '' : c('  (' + r.reason + ')', 'yellow')}`); });
          console.log(c('Выбор: /provider id', 'gray'));
        }
      } else {
        const selected = providers.find(p => p.id === value);
        if (!selected) console.log(c('Provider не найден. Используй /provider без аргумента.', 'red'));
        else {
          currentProvider = selected.id; saveHistory(); console.log(c(`✓ Provider: ${currentProvider}`, 'green'));
          const ready = providerReady(currentProvider);
          if (!ready.ok) console.log(c(`⚠️ ${ready.reason}`, 'yellow'));
        }
      }
      finishCommand(); return;
    }
    if (lower === '/open' || lower.startsWith('/open ')) {
      currentProvider = 'openrouter';
      await fetchOpenRouterFreeModels();
      const spec = text.replace(/^\/open\s*/i, '').trim();
      currentModel = spec || CONFIG.openRouterModel || openRouterFreeModels[0]?.id || 'google/gemma-4-31b-it:free';
      CONFIG.openRouterModel = currentModel;
      saveHistory();
      console.log(c(`✓ Режим OpenRouter: ${currentModel}`, 'green'));
      if (!openRouterKey()) console.log(c('⚠️ Сначала добавь ключ: /key', 'yellow'));
      console.log(c('Бесплатные модели: /models', 'gray'));
      finishCommand(); return;
    }
    if (lower === '/zen' || lower.startsWith('/zen ')) {
      currentProvider = 'zen';
      const spec = text.replace(/^\/zen\s*/i, '').trim();
      currentModel = spec || CONFIG.defaultModel;
      saveHistory(); console.log(c(`✓ Режим Zen: ${currentModel}`, 'green')); finishCommand(); return;
    }
    if (lower === '/continue') {
      loadHistory();
      const info = sessionInfoTool();
      console.log(info.error ? c('✗ ' + info.error, 'red') : c(`✓ Продолжена сессия: ${info.name} • ${info.messages} сообщений • ${info.provider}/${info.model}`, 'green'));
      finishCommand(); return;
    }
    if (lower === '/sessions' || lower === '/session') {
      const rows = listSessions();
      const opened = openArrowMenu('AI-сессии', rows.map(item => ({ label: item.name, description: `${item.messages} msg • ${item.provider} • ${item.model}`, session: item })), async option => {
        const changed = switchSession(option.session.name);
        console.log(changed.error ? c('✗ ' + changed.error, 'red') : c(`✓ Сессия: ${changed.name} (${changed.messages} msg)`, 'green'));
      });
      if (!opened) drawSessions();
      finishCommand(); return;
    }
    if (lower.startsWith('/session ')) {
      const parts = text.slice('/session '.length).trim().split(/\s+/); const action = (parts.shift() || '').toLowerCase(); const name = parts.join(' ');
      if (action === 'new' || action === 'switch') {
        const changed = switchSession(name); console.log(changed.error ? c('✗ ' + changed.error, 'red') : c(`✓ Сессия: ${changed.name} (${changed.messages} msg)`, 'green'));
      } else if (action === 'fork') {
        const forked = forkSession(name); console.log(forked.error ? c('✗ ' + forked.error, 'red') : c(`✓ Ветка сессии: ${forked.name} ← ${forked.parent}`, 'green'));
      } else if (action === 'rename') {
        const renamed = renameSession(name); console.log(renamed.error ? c('✗ ' + renamed.error, 'red') : c('✓ Сессия переименована: ' + renamed.name, 'green'));
      } else if (action === 'delete' || action === 'rm') {
        const removed = deleteSession(name); console.log(removed.error ? c('✗ ' + removed.error, 'red') : c('✓ Сессия удалена: ' + removed.name, 'green'));
      } else if (action === 'info') {
        const info = sessionInfoTool(name || activeSession); console.log(info.error ? c('✗ ' + info.error, 'red') : JSON.stringify(info, null, 2));
      } else if (action === 'export') {
        const exported = exportSession(name || undefined); console.log(exported.error ? c('✗ ' + exported.error, 'red') : c('✓ Экспорт: ' + exported.path, 'green'));
      } else if (action === 'import') {
        const importPath = parts.shift(); const importName = parts.join(' ');
        const imported = importSession(importPath, importName); console.log(imported.error ? c('✗ ' + imported.error, 'red') : c(`✓ Импортирована сессия: ${imported.name}`, 'green'));
      } else {
        const changed = switchSession([action, ...parts].join(' ')); console.log(changed.error ? c('✗ ' + changed.error, 'red') : c(`✓ Сессия: ${changed.name} (${changed.messages} msg)`, 'green'));
      }
      finishCommand(); return;
    }
    if (lower === '/audit' || lower.startsWith('/audit ')) {
      const count = parseInt(lower.replace(/^\/audit\s*/, ''), 10) || 30;
      const records = readAudit(count);
      const lines = records.length ? records.map(item => `${item.at} • ${item.event}${item.tool ? ' • ' + item.tool : ''}${item.durationMs !== undefined ? ' • ' + item.durationMs + 'ms' : ''}${item.error ? ' • ' + item.error : ''}`) : [c('Журнал пока пуст.', 'gray')];
      box(lines, { width: Math.min(100, termWidth() - 2), title: ' Audit trail ', style: 'single', color: 'cyan' }).forEach(line => console.log(line));
      finishCommand(); return;
    }
    if (lower === '/mcp' || lower === '/status') {
      await checkMCP();
      console.log(c('MCP: ', 'gray') + (mcpAvailable ? c('● подключён', 'green') : c('○ недоступен', 'gray')));
      console.log(c(`Провайдер: ${currentProvider} • Модель: ${currentModel} • Сессия: ${activeSession}`, 'brightCyan'));
      console.log(c('Рабочая папка MCP: ', 'gray') + c(WORKSPACE_ROOT, 'brightCyan'));
      if (lower === '/status') drawTelemetryPanel(' Текущий runtime ');
      finishCommand(); return;
    }
    if (lower === '/net' || lower === '/network') { await checkNetwork(); finishCommand(); return; }
    if (lower === '/vpn') {
      box([c('VPN включается в Android-приложении.', 'brightCyan'), 'Termux не должен быть в исключениях split tunneling.', 'После подключения: /net'], { width: Math.min(72, termWidth() - 2), title: ' Android VPN ', style: 'single', color: 'cyan' }).forEach(line => console.log(line));
      finishCommand(); return;
    }
    if (lower === '/proxy' || lower.startsWith('/proxy ')) {
      const value = text.replace(/^\/proxy\s*/i, '').trim();
      const parts = value.split(/\s+/).filter(Boolean);
      const action = (parts.shift() || '').toLowerCase();
      if (!value || action === 'status' || action === 'list') {
        const st = proxyStatus();
        const lines = [
          `${c('Активный:', 'gray')} ${st.proxy ? c(st.proxy, 'green') : c('прямое соединение', 'yellow')}`,
          `${c('Автопереключение:', 'gray')} ${st.failover ? c('ВКЛ', 'green') : c('ВЫКЛ', 'yellow')} • порог медленного ответа: ${st.slowMs} мс`,
          ...st.pool.map(item => `${item.active ? c('●', 'green') : c('○', 'gray')} ${item.index}. ${c(item.label, item.active ? 'brightCyan' : 'white')} • попыток ${item.attempts}, ошибок ${item.failures}, медленных ${item.slow}`),
          c('Команды: /proxy add URL | /proxy remove N | /proxy clear | /proxy auto on/off | /proxy slow MS | /proxy test', 'gray')
        ];
        box(lines, { width: Math.min(100, termWidth() - 2), title: ' Пул прокси ', style: 'single', color: 'cyan' }).forEach(line => console.log(line));
        finishCommand(); return;
      }
      if (action === 'add') {
        const changed = addProxy(parts.join(' '));
        console.log(changed.error ? c('✗ ' + changed.error, 'red') : c('✓ ' + changed.message, 'green'));
        finishCommand(); return;
      }
      if (action === 'remove' || action === 'rm' || action === 'delete') {
        const changed = removeProxy(parts.join(' '));
        console.log(changed.error ? c('✗ ' + changed.error, 'red') : c('✓ Прокси удалён из пула', 'green'));
        finishCommand(); return;
      }
      if (action === 'clear') {
        const changed = clearProxyPool(); console.log(changed.error ? c('✗ ' + changed.error, 'red') : c('✓ ' + changed.message, 'green'));
        finishCommand(); return;
      }
      if (action === 'auto') {
        const setting = (parts[0] || '').toLowerCase();
        CONFIG.proxyFailover = setting === 'on' || setting === '1' || setting === 'да' ? true : setting === 'off' || setting === '0' || setting === 'нет' ? false : !CONFIG.proxyFailover;
        saveNetworkConfig(); console.log(c('Автопереключение прокси: ' + (CONFIG.proxyFailover ? 'ВКЛ' : 'ВЫКЛ'), CONFIG.proxyFailover ? 'green' : 'yellow'));
        finishCommand(); return;
      }
      if (action === 'slow') {
        const ms = Number.parseInt(parts[0], 10);
        if (!Number.isInteger(ms) || ms < 1000 || ms > 120000) console.log(c('Порог должен быть от 1000 до 120000 мс.', 'red'));
        else { CONFIG.proxySlowMs = ms; saveNetworkConfig(); console.log(c(`Порог медленного прокси: ${ms} мс`, 'green')); }
        finishCommand(); return;
      }
      if (action === 'test' || action === 'check') {
        const tested = await testProxyPool();
        const lines = tested.rows.map(row => `${row.ok ? c('●', 'green') : c('○', 'red')} ${row.proxy} • ${row.status} • ${row.ms} мс${row.slow ? c(' • медленно', 'yellow') : ''}`);
        if (!lines.length) lines.push(c('Пул пуст: проверяется прямое соединение через /net.', 'gray'));
        box(lines, { width: Math.min(100, termWidth() - 2), title: ' Проверка прокси ', style: 'single', color: tested.success ? 'green' : 'red' }).forEach(line => console.log(line));
        finishCommand(); return;
      }
      const changed = setProxy(value);
      console.log(changed.error ? c('✗ ' + changed.error, 'red') : c('✓ ' + changed.message, 'green'));
      if (!changed.error) await checkNetwork();
      finishCommand(); return;
    }
    if (lower === '/git' || lower.startsWith('/git ')) {
      const value = text.replace(/^\/git\s*/i, '').trim();
      const parts = value.split(/\s+/).filter(Boolean);
      const action = (parts.shift() || '').toLowerCase();
      if (!value || action === 'status') {
        const token = githubTokenStatus();
        console.log(c(`GitHub token: ${token.configured ? token.masked : 'не задан'} • ${token.source}`, token.configured ? 'green' : 'yellow'));
        console.log(c(`Репозиторий по умолчанию: ${CONFIG.githubRepo || 'не выбран'}`, 'gray'));
        console.log(c('Команды: /git key | /git repo owner/name | /git commits [repo] [N] | /git builds [repo] | /git watch repo RUN_ID | /git apk repo [release|RUN_ID] [путь] | /git push [ветка]', 'gray'));
        finishCommand(); return;
      }
      if (action === 'key' || action === 'token') {
        const valuePart = parts.join(' ').trim();
        if (!valuePart) {
          if (!openGitHubSecretInput()) console.log(c('Защищённый диалог недоступен. Используй /git key set ТВОЙ_TOKEN; token будет сохранён локально и замаскирован в логах.', 'yellow'));
        } else if (/^(status|show)$/i.test(valuePart)) {
          const status = githubTokenStatus(); console.log(c(`GitHub token: ${status.configured ? status.masked : 'не задан'} • ${status.source}`, status.configured ? 'green' : 'yellow'));
        } else if (/^(clear|remove|delete)$/i.test(valuePart)) {
          const cleared = clearGitHubToken(); console.log(c(cleared.environmentStillSet ? 'Локальный GitHub token удалён, но token из окружения всё ещё активен.' : '✓ Локальный GitHub token удалён.', 'yellow'));
        } else {
          const saved = saveGitHubToken(valuePart); console.log(saved.error ? c('✗ ' + saved.error, 'red') : c(`✓ GitHub token сохранён: ${saved.masked}`, 'green'));
        }
        finishCommand(); return;
      }
      if (action === 'repo') {
        const repo = parts[0] || '';
        const checked = githubRepoArgs({ repo });
        if (checked.error) console.log(c('✗ ' + checked.error, 'red'));
        else { CONFIG.githubRepo = checked.full; const saved = saveGitHubConfig(); console.log(saved.error ? c('✗ ' + saved.error, 'red') : c('✓ Репозиторий по умолчанию: ' + CONFIG.githubRepo, 'green')); }
        finishCommand(); return;
      }
      if (action === 'commits' || action === 'log') {
        const repo = parts[0] || CONFIG.githubRepo; const limit = parts[1] || '10';
        const result = await githubCommitsTool({ repo, limit });
        if (result.error) console.log(c('✗ ' + result.error, 'red'));
        else (result.commits || []).forEach(item => console.log(`${c(item.shortSha, 'yellow')} ${item.message} ${c('• ' + (item.author || ''), 'gray')}`));
        finishCommand(); return;
      }
      if (action === 'builds' || action === 'runs' || action === 'actions') {
        const result = await githubBuildsTool({ repo: parts[0] || CONFIG.githubRepo, limit: parts[1] || 20 });
        if (result.error) console.log(c('✗ ' + result.error, 'red'));
        else (result.runs || []).forEach(run => console.log(`${run.conclusion === 'success' ? c('●', 'green') : run.conclusion === 'failure' ? c('●', 'red') : c('○', 'yellow')} #${run.id} ${run.name} • ${run.status}${run.conclusion ? ' • ' + run.conclusion : ''} • ${run.branch || ''}`));
        finishCommand(); return;
      }
      if (action === 'watch') {
        const repo = parts.shift() || CONFIG.githubRepo; const runId = parts.shift();
        const result = await githubWatchBuildTool({ repo, run_id: runId, interval_seconds: parts.shift() || 10 });
        console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ Сборка завершена: ${result.run?.conclusion || result.run?.status}`, result.success ? 'green' : 'yellow'));
        finishCommand(); return;
      }
      if (action === 'apk' || action === 'download-apk') {
        const repo = parts.shift() || CONFIG.githubRepo; const source = parts[0] && /^(release|actions)$/i.test(parts[0]) ? parts.shift().toLowerCase() : 'actions';
        const runOrTag = parts.shift(); const output = parts.shift();
        const args = { repo, source, path: output };
        if (source === 'release' && runOrTag && runOrTag !== 'latest') args.tag = runOrTag;
        else if (source === 'actions' && runOrTag && /^\d+$/.test(runOrTag)) args.run_id = runOrTag;
        const result = await githubDownloadApkTool(args);
        console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ APK скачан: ${result.apk || result.path || result.archive}`, 'green'));
        finishCommand(); return;
      }
      if (action === 'push') {
        const decision = await askConfirm('git_push', { cwd: '.', branch: parts[0] || '', remote: parts[1] || 'origin' });
        if (decision === 'no') { console.log(c('Отправка в GitHub отменена.', 'yellow')); finishCommand(); return; }
        const result = await gitPushTool({ cwd: '.', branch: parts[0], remote: parts[1] || 'origin', __cliLive: true });
        console.log(result.error ? c('✗ ' + result.error, 'red') : c('✓ Git push завершён.', 'green'));
        finishCommand(); return;
      }
      console.log(c('Неизвестная GitHub-команда. Используй /git status или /git без аргументов.', 'red'));
      finishCommand(); return;
    }
    if (lower === '/agents' || lower.startsWith('/agents ') || lower.startsWith('/install-agent')) {
      if (lower.startsWith('/install-agent')) {
        const spec = text.replace(/^\/install-agent\s*/i, '').trim() || text.replace(/^\/agents\s+install\s*/i, '').trim();
        if (!spec) { console.log(c('Используй: /install-agent <npm-пакет>  или  /install-agent <имя из /agents>', 'yellow')); finishCommand(); return; }
        const known = HUB_AGENTS.find(a => a.name.toLowerCase() === spec.toLowerCase() || a.pkg === spec || a.npx === spec);
        const pkg = known ? known.pkg : (spec.startsWith('@') || spec.includes('/') || /^[a-z0-9_.-]+$/.test(spec) ? spec : null);
        if (!pkg) { console.log(c('Некорректный npm-пакет: ' + spec, 'red')); finishCommand(); return; }
        console.log(c(`📦 Установка: npm install -g ${pkg}`, 'cyan'));
        const r = await runCommandWithLiveLogs(`npm install -g ${pkg}`, process.cwd(), { timeout: 600000, env: commandEnvironment() });
        if (r.exit === 0) console.log(c(`✓ Установлено: ${pkg}`, 'green'));
        else console.log(c(`✗ Ошибка установки ${pkg} (код ${r.exit}). См. вывод выше.`, 'red'));
        finishCommand(); return;
      }
      // /agents — список других CLI-агентов.
      const sub = text.replace(/^\/agents\s*/i, '').trim().toLowerCase();
      const lines = [];
      HUB_AGENTS.forEach((a, i) => {
        lines.push(`${c(String(i + 1) + '.', 'yellow')} ${c(a.name, 'brightCyan')} — ${a.desc}`);
        lines.push(`    ${c('установка:', 'gray')} ${a.install}`);
        lines.push(`    ${c('npx:', 'gray')} ${c(agentNpxCmd(a), 'gray')}${a.key ? ' • ключ: ' + a.key : ''}`);
      });
      lines.push('', c('Установить: /install-agent <пакет> | /agents run <номер> — запустить через npx', 'gray'));
      box(lines, { width: Math.min(96, termWidth() - 2), title: ' Другие CLI-агенты (npx/npm) ', style: 'single', color: 'magenta' }).forEach(l => console.log(l));
      if (/^run\s+(\d+)$/.test(sub) || /^run\s+\S+$/.test(sub)) {
        const arg = sub.split(/\s+/)[1];
        const agent = HUB_AGENTS[Number(arg) - 1] || HUB_AGENTS.find(a => a.name.toLowerCase() === arg);
        if (agent) {
          console.log(c(`▶ Запуск: ${agentNpxCmd(agent)}`, 'cyan'));
          await runCommandWithLiveLogs(agentNpxCmd(agent), process.cwd(), { timeout: 120000, env: commandEnvironment() });
        } else console.log(c('Агент не найден. Смотри список выше.', 'red'));
      }
      finishCommand(); return;
    }
    if (lower === '/tunnel' || lower.startsWith('/tunnel ')) {
      const value = text.replace(/^\/tunnel\s*/i, '').trim();
      if (value === 'off' || value === 'stop') {
        if (tunnelServer) { try { tunnelServer.close(); } catch {} tunnelServer = null; CONFIG.tunnelEnabled = false; console.log(c('✓ Туннель остановлен', 'green')); } else { console.log(c('Туннель не запущен', 'yellow')); }
        finishCommand(); return;
      }
      if (value === 'status' || !value) {
        const running = tunnelServer && tunnelServer.listening;
        console.log(c('Туннель: ', 'gray') + (running ? c('активен на порту ' + CONFIG.tunnelPort, 'green') : c('не запущен', 'yellow')));
        console.log(c('Используй: /tunnel start | /tunnel stop | /tunnel status', 'gray'));
        finishCommand(); return;
      }
      if (value === 'start' || value === 'on') {
        if (tunnelServer && tunnelServer.listening) { console.log(c('Туннель уже запущен на порту ' + CONFIG.tunnelPort, 'yellow')); finishCommand(); return; }
        CONFIG.tunnelEnabled = true;
        tunnelServer = startTunnel(CONFIG.tunnelPort, '127.0.0.1', () => {
          console.log(c('✓ Туннель запущен: http://127.0.0.1:' + CONFIG.tunnelPort, 'green'));
          console.log(c('Zen API будет проксироваться через туннель при блокировке', 'gray'));
        });
        tunnelServer.on('error', (err) => { console.error(c('✗ Ошибка туннеля: ' + err.message, 'red')); });
        finishCommand(); return;
      }
      console.log(c('Неизвестная команда: /tunnel ' + value, 'red'));
      console.log(c('Используй: /tunnel start | /tunnel stop | /tunnel status', 'gray'));
      finishCommand(); return;
    }
    if (lower === '/workspace' || lower === '/ws' || lower.startsWith('/workspace ') || lower.startsWith('/ws ')) {
      const rawPath = text.replace(/^\/(workspace|ws)\s*/i, '').trim();
      if (!rawPath) console.log(c('Рабочая папка MCP: ', 'gray') + c(WORKSPACE_ROOT, 'brightCyan'));
      else { const changed = setWorkspaceRoot(rawPath); console.log(changed.error ? c('✗ ' + changed.error, 'red') : c('✓ MCP-папка: ' + changed.workspace, 'green')); }
      finishCommand(); return;
    }
    if (lower === '/project' || lower === '/projects' || lower.startsWith('/project ') || lower.startsWith('/projects ')) {
      const value = text.replace(/^\/projects?\s*/i, '').trim();
      const parts = value.split(/\s+/).filter(Boolean); const action = (parts.shift() || 'list').toLowerCase();
      if (action === 'list') {
        const list = projectListTool();
        const lines = list.projects.length ? list.projects.map(item => `${item.active ? c('●', 'green') : c('○', 'gray')} ${c(item.alias, 'brightCyan')} — ${item.path}`) : [c('Нет зарегистрированных проектов. Добавь: /project add ИМЯ ПУТЬ', 'gray')];
        lines.unshift(`${c('Активный:', 'gray')} ${list.active || 'не выбран'}`);
        box(lines, { width: Math.min(100, termWidth() - 2), title: ' Проекты ', style: 'single', color: 'cyan' }).forEach(line => console.log(line));
      } else if (action === 'add' || action === 'register') {
        const alias = parts.shift(); const projectPath = parts.join(' '); const result = registerProjectTool({ alias, path: projectPath });
        console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ Проект '${result.alias}' привязан к ${result.path}`, 'green'));
      } else if (action === 'use' || action === 'open' || action === 'switch') {
        const result = useProjectTool({ alias: parts.shift() });
        console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ Активный проект: ${result.alias} • ${result.workspace}`, 'green'));
      } else if (action === 'remove' || action === 'delete') {
        const result = removeProjectTool({ alias: parts.shift() });
        console.log(result.error ? c('✗ ' + result.error, 'red') : c('✓ Имя проекта удалено, папка не затронута.', 'green'));
      } else if (action === 'memory') {
        const result = projectMemoryTool({ action: 'read' }); console.log(result.error ? c('✗ ' + result.error, 'red') : JSON.stringify(result.memory, null, 2));
      } else console.log(c('Используй: /project list | /project add ИМЯ ПУТЬ | /project use ИМЯ | /project memory', 'yellow'));
      finishCommand(); return;
    }
    if (lower === '/onnx' || lower.startsWith('/onnx ')) {
      const value = text.replace(/^\/onnx\s*/i, '').trim(); const parts = value.split(/\s+/).filter(Boolean); const action = (parts.shift() || 'status').toLowerCase(); let result;
      if (action === 'status') result = await onnxStatusTool();
      else if (action === 'model' || action === 'set') result = await onnxSetModelTool({ path: parts.join(' ') });
      else if (action === 'memory' && (parts[0] || '').toLowerCase() === 'list') result = onnxMemoryListTool();
      else if (action === 'memory' && (parts[0] || '').toLowerCase() === 'search') result = onnxMemorySearchTool({ query: parts.slice(1).join(' ') });
      else if (action === 'memory' && (parts[0] || '').toLowerCase() === 'add') result = onnxMemoryAddTool({ text: parts.slice(1).join(' '), source: 'cli' });
      else result = { error: 'Используй: /onnx status | /onnx model ПУТЬ | /onnx memory list/search/add' };
      console.log(result.error ? c('✗ ' + result.error, 'red') : JSON.stringify(result, null, 2)); finishCommand(); return;
    }
    if (lower === '/logs') { CONFIG.liveToolLogs = !CONFIG.liveToolLogs; console.log(c('Логи команд в реальном времени: ' + (CONFIG.liveToolLogs ? 'ВКЛ' : 'ВЫКЛ'), CONFIG.liveToolLogs ? 'green' : 'yellow')); finishCommand(); return; }
    if (lower === '/animation' || lower.startsWith('/animation ')) {
      const value = lower.replace(/^\/animation\s*/, '').trim();
      CONFIG.animatedIndicator = value === 'on' || value === '1' || value === 'да' ? true : value === 'off' || value === '0' || value === 'нет' ? false : !CONFIG.animatedIndicator;
      saveHistory();
      console.log(c('ANSI-анимация loading bar: ' + (CONFIG.animatedIndicator ? 'ВКЛ' : 'ВЫКЛ'), CONFIG.animatedIndicator ? 'green' : 'yellow'));
      if (CONFIG.animatedIndicator) console.log(c('Если кадры снова склеятся, выполни /animation off.', 'yellow'));
      finishCommand(); return;
    }
    if (lower === '/indicator' || lower.startsWith('/indicator ')) {
      const value = lower.replace(/^\/indicator\s*/, '').trim();
      if (value) {
        const changed = setIndicatorStyle(value);
        console.log(changed.error ? c('✗ ' + changed.error, 'red') : c('✓ Индикатор: ' + changed.label, 'green'));
      } else {
        const options = Object.entries(INDICATOR_THEMES).map(([id, meta]) => ({ label: meta.label, description: id === CONFIG.indicatorStyle ? 'текущий' : id, style: id }));
        const opened = openArrowMenu('Выбор индикатора', options, async option => {
          const changed = setIndicatorStyle(option.style);
          console.log(c('✓ Индикатор: ' + changed.label, 'green'));
        });
        if (!opened) console.log(c('Варианты: ' + Object.keys(INDICATOR_THEMES).join(', ') + '. Пример: /indicator game', 'gray'));
      }
      finishCommand(); return;
    }
    if (lower === '/stream') { CONFIG.streamMode = !CONFIG.streamMode; console.log(c('AI-стриминг: ' + (CONFIG.streamMode ? 'ВКЛ' : 'ВЫКЛ'), CONFIG.streamMode ? 'green' : 'yellow')); finishCommand(); return; }
    if (lower === '/auto' || lower.startsWith('/auto ')) {
      const value = lower.replace(/^\/auto\s*/,'').trim();
      CONFIG.autoApprove = value === 'on' || value === '1' || value === 'да' ? true : value === 'off' || value === '0' || value === 'нет' ? false : !CONFIG.autoApprove;
      saveHistory();
      console.log(c('Авто-одобрение: ' + (CONFIG.autoApprove ? 'ВКЛ' : 'ВЫКЛ'), CONFIG.autoApprove ? 'green' : 'yellow')); finishCommand(); return;
    }
    if (lower === '/think') { CONFIG.showThinking = !CONFIG.showThinking; console.log(c('План и наблюдения: ' + (CONFIG.showThinking ? 'ВКЛ' : 'ВЫКЛ'), CONFIG.showThinking ? 'green' : 'yellow')); finishCommand(); return; }
    if (lower === '/clarify' || lower.startsWith('/clarify ')) {
      const value = lower.replace(/^\/clarify\s*/, '').trim();
      CONFIG.askClarifyingQuestions = value === 'on' || value === '1' || value === 'да' ? true : value === 'off' || value === '0' || value === 'нет' ? false : !CONFIG.askClarifyingQuestions;
      saveHistory();
      console.log(c('Уточняющие вопросы: ' + (CONFIG.askClarifyingQuestions ? 'ВКЛ' : 'ВЫКЛ'), CONFIG.askClarifyingQuestions ? 'green' : 'yellow')); finishCommand(); return;
    }
    if (lower === '/clear') { history = []; saveHistory(); console.log(c('История активной сессии очищена', 'green')); finishCommand(); return; }
    if (lower === '/save') { saveHistory(); console.log(c('Сессия сохранена', 'green')); finishCommand(); return; }
    if (lower === '/dash') { CONFIG.showDashboard = !CONFIG.showDashboard; console.log(c('Дашборд: ' + (CONFIG.showDashboard ? 'ВКЛ' : 'ВЫКЛ'), CONFIG.showDashboard ? 'green' : 'yellow')); finishCommand(); return; }
    if (lower === '/compact') { CONFIG.compactMode = !CONFIG.compactMode; console.log(c('Компактный режим: ' + (CONFIG.compactMode ? 'ВКЛ' : 'ВЫКЛ'), CONFIG.compactMode ? 'green' : 'yellow')); finishCommand(); return; }
    if (lower === '/todo' || lower.startsWith('/todo ')) { const todoText = text.slice(5).trim(); if (todoText) { addTodo(todoText); console.log(c('✓ Добавлено: ' + todoText, 'green')); } drawTodos(); finishCommand(); return; }
    if (lower === '/todos' || lower === '/list') { drawTodos(); finishCommand(); return; }
    if (lower.startsWith('/start ')) { const id = parseInt(lower.slice(6).trim(), 10); console.log(startTodo(id, WORKSPACE_ROOT) ? c('● Задача в работе', 'cyan') : c('✗ Задача не найдена', 'red')); drawTodos(); finishCommand(); return; }
    if (lower.startsWith('/done ')) { const id = parseInt(lower.slice(5).trim(), 10); console.log(doneTodo(id, WORKSPACE_ROOT) ? c('✓ Задача выполнена', 'green') : c('✗ Задача не найдена', 'red')); drawTodos(); finishCommand(); return; }
    if (lower.startsWith('/fail ')) { const rest = lower.slice(5).trim(); const parts = rest.split(/\s+/); const id = parseInt(parts.shift(), 10); const reason = parts.join(' '); console.log(failTodo(id, reason, WORKSPACE_ROOT) ? c('✗ Задача отмечена провалом', 'red') : c('✗ Задача не найдена', 'red')); drawTodos(); finishCommand(); return; }
    if (lower.startsWith('/rm ')) { const id = parseInt(lower.slice(3).trim(), 10); console.log(removeTodo(id, WORKSPACE_ROOT) ? c('✓ Задача удалена', 'green') : c('✗ Задача не найдена', 'red')); drawTodos(); finishCommand(); return; }
    if (lower === '/clear-todo' || lower === '/cleartodo') { clearTodos(WORKSPACE_ROOT); console.log(c('✓ Задачи очищены', 'green')); finishCommand(); return; }
    if (CONFIG.showDashboard) drawDashboard();
    void agentLoop(text).then(() => { if (!CONFIG.compactMode) drawMiniStatus(); }).catch(e => console.log(c('❌ ' + e.message, 'red'))).finally(prompt);
  }

  rl.on('line', line => {
    const rawLine = String(line || '');
    if (/\x1b\x1b|\^\[\^\[/.test(rawLine)) {
      handleAgentKeypress('\x1b', { name: 'escape' });
      handleAgentKeypress('\x1b', { name: 'escape' });
      return;
    }
    const text = rawLine.trim();
    if (pendingConfirmation) {
      if (/^(y|yes|да|1)$/i.test(text)) {
        const pending = pendingConfirmation; pendingConfirmation = null; pending.resolve('yes'); return;
      }
      if (/^(n|no|нет|0)$/i.test(text)) {
        const pending = pendingConfirmation; pendingConfirmation = null; pending.resolve('no'); return;
      }
      // Корректировку можно дать даже пока ожидается опасная операция.
      correctionQueue.push(text.replace(/^\/(correct|fix)\s*/i, '').trim() || text);
      console.log(c('✎ Корректировка сохранена. Для текущего инструмента всё ещё ответь y или n.', 'yellow'));
      return;
    }
    if (!text) { finishCommand(); return; }
    if (agentBusy) {
      // Ключ — управляющая команда, а не корректировка для модели. Никогда не передаём его в history.
      if (/^\/key\s+/i.test(text)) {
        const result = saveKeyFromCommand(text.replace(/^\/key\s*/i, ''));
        console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ OpenRouter key сохранён: ${result.masked}`, 'green'));
        if (result.success) correctionQueue.push('OpenRouter key теперь настроен. При необходимости повтори vision_analyze, не выводи и не записывай ключ.');
        return;
      }
      if (looksLikeOpenRouterKey(text)) {
        const result = saveKeyFromCommand(text);
        console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ OpenRouter key сохранён: ${result.masked}. Не отправляю ключ модели.`, 'green'));
        if (result.success) correctionQueue.push('OpenRouter key теперь настроен. Повтори vision_analyze без вывода ключа.');
        return;
      }
      if (looksLikeGitHubToken(text)) {
        const result = saveGitHubToken(text);
        console.log(result.error ? c('✗ ' + result.error, 'red') : c(`✓ GitHub token сохранён: ${result.masked}.`, 'green'));
        if (result.success) correctionQueue.push('GitHub token теперь настроен. Используй GitHub-инструменты без вывода токена.');
        return;
      }
      if (/^\/(abort|stop)$/i.test(text)) {
        abortRequested = true;
        auditEvent('task_abort_requested', { step: TELEMETRY.step });
        setRunPhase('stopped', 'запрошено пользователем');
        try { activeProviderAbort?.(); } catch {}
        console.log(c('⏹ Остановка запрошена; OpenRouter-запрос будет прерван, текущая локальная команда завершится безопасно.', 'yellow'));
        return;
      }
      const correction = text.replace(/^\/(correct|fix)\s*/i, '').trim() || text;
      correctionQueue.push(correction);
      setRunPhase('correction', 'ожидает следующего шага');
      console.log(c('✎ Корректировка принята и будет применена на следующем шаге.', 'yellow'));
      return;
    }
    void handleIdleInput(text).catch(e => { console.log(c('❌ ' + e.message, 'red')); finishCommand(); });
  });
  prompt();
}
// ═══════════════════════════════════════════════════════════════════
//  CLI ARGS
// ═══════════════════════════════════════════════════════════════════
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--stream') CONFIG.streamMode = true;
  if (args[i] === '--auto-approve') CONFIG.autoApprove = true;
  if (args[i] === '--verbose' || args[i] === '-v') CONFIG.verbose = true;
  if (args[i] === '--model' && args[i + 1]) currentModel = args[++i];
  if (args[i] === '--project' && args[i + 1]) CONFIG.activeProject = args[++i];
  if (args[i] === '--openrouter' || args[i] === '--open') currentProvider = 'openrouter';
  if (args[i] === '--zen') currentProvider = 'zen';
  if (args[i] === '--openrouter-model' && args[i + 1]) { currentProvider = 'openrouter'; currentModel = args[++i]; }
  if (args[i] === '--compact') CONFIG.compactMode = true;
  if (args[i] === '--no-dash') CONFIG.showDashboard = false;
  if (args[i] === '--proxy' && args[i + 1]) {
    const cliProxy = validProxyUrl(args[++i]);
    if (cliProxy) { CONFIG.proxy = cliProxy; CONFIG.proxyPool = [cliProxy]; CONFIG.proxyActiveIndex = 0; }
  }
  if (args[i] === '--no-ipv4') CONFIG.curlIpv4 = false;
}

// Нужен и в одноразовом режиме: node agent-runtime.js "...".
// Flags may precede the prompt; the old implementation mistakenly entered
// interactive mode whenever the first argument started with --.
function cliPromptArgs(argv) {
  const withValue = new Set(['--model', '--openrouter-model', '--proxy', '--project']);
  const flags = new Set(['--stream', '--auto-approve', '--verbose', '-v', '--openrouter', '--open', '--zen', '--compact', '--no-dash', '--no-ipv4', '--interactive']);
  const prompt = [];
  for (let i = 0; i < argv.length; i++) {
    if (withValue.has(argv[i])) { i++; continue; }
    if (flags.has(argv[i])) continue;
    prompt.push(argv[i]);
  }
  return prompt;
}
if (require.main === module) {
  loadOpenRouterKey();
  loadGitHubConfig();
  const promptArgs = cliPromptArgs(args);
  if (!promptArgs.length || args.includes('--interactive')) {
    void main().catch(error => { console.error(c('❌ ' + redactSecrets(String(error?.stack || error)), 'red')); process.exitCode = 1; });
  } else {
    (async () => {
      if (CONFIG.activeProject) { const projectStart = useProjectTool({ alias: CONFIG.activeProject }); if (projectStart.error) console.log(c('⚠️ ' + projectStart.error, 'yellow')); }
      await checkMCP();
      const prompt = promptArgs.join(' ');
      await agentLoop(prompt);
      process.exit(0);
    })().catch(error => { console.error(c('❌ ' + redactSecrets(String(error?.stack || error)), 'red')); process.exitCode = 1; });
  }
}

module.exports = {
  CONFIG,
  MCP_TOOLS,
  ZEN_MODELS,
  handleMCPTool,
  handleToolCall,
  validateToolArguments,
  resolveWorkspacePath,
  workspaceInfo,
  singleSiteHtml,
  startEmbeddedServer,
  agentLoop,
  redactSecrets,
  parseDsmlToolCalls,
  setProxy,
  addProxy,
  removeProxy,
  clearProxyPool,
  proxyStatus,
  testProxyPool,
  rotateProxy,
  checkNetwork,
  callZenDirect,
  stopManagedProcess,
  managedProcessStatus,
  listModelsForProvider,
  providerReady,
  providerMeta,
  allProvidersMenu,
  MODEL_PROVIDERS,
  HUB_AGENTS,
  githubReadFileTool,
  githubListDirTool,
  githubWriteFileTool,
  githubReadmeTool,
  workspaceBoundaryCheck,
  saveHfToken,
  clearHfToken,
  huggingFaceToken,
  HUGGINGFACE_MODELS,
  subagentBatchTool,
  subagentBackgroundTool,
  subagentStatusTool,
  runSubagent,
  addTodo,
  setTodoStatus,
  todosRecursive,
  todoSummary,
  failTodo,
  startTodo
};
