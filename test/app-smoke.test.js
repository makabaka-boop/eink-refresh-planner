'use strict';

/*
 * 页面冒烟测试：无浏览器/jsdom 环境下，用最小 DOM + Canvas 桩，
 * 在独立 VM 上下文里真实加载 solver / client / app，
 * 验证 编辑 -> Worker(同步退化)求解 -> 渲染 -> 播放 -> 导出 整条页面链路，
 * 以及“连续编辑时迟到的旧结果不落地”。每个测试使用全新上下文，互不污染。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');

function makeClassList() {
  const set = new Set();
  return {
    add: (...xs) => xs.forEach((x) => set.add(x)),
    remove: (...xs) => xs.forEach((x) => set.delete(x)),
    toggle: (x, force) => {
      const on = force === undefined ? !set.has(x) : !!force;
      on ? set.add(x) : set.delete(x);
      return on;
    },
    contains: (x) => set.has(x)
  };
}

function pseudoNode(html) {
  return {
    tagName: '#text',
    children: [],
    classList: makeClassList(),
    get outerHTML() { return html; },
    get textContent() { return html.replace(/<[^>]*>/g, ''); },
    appendChild() {}
  };
}

function makeElement(tag, id) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: id || '',
    children: [],
    style: {},
    dataset: {},
    width: 48, height: 48,
    className: '',
    _text: '',
    _inner: null,
    title: '',
    href: '',
    download: '',
    disabled: false,
    _listeners: {},
    set innerHTML(v) {
      this._inner = String(v);
      this._text = '';
      this.children = [];
    },
    get innerHTML() {
      return this._inner !== null
        ? this._inner
        : this.children.map((c) => (c.outerHTML || '')).join('') + this._text;
    },
    set textContent(v) {
      this._text = String(v);
      this._inner = null;
      this.children = [];
    },
    get textContent() {
      return this._text + this.children.map((c) => c.textContent || '').join('');
    },
    get outerHTML() {
      const cls = this.className ? ' class="' + this.className + '"' : '';
      return '<' + this.tagName.toLowerCase() + cls + '>' + this.innerHTML +
             '</' + this.tagName.toLowerCase() + '>';
    },
    appendChild(c) {
      if (this._inner !== null && this._inner !== '') {
        this.children.push(pseudoNode(this._inner));
      }
      this._inner = null;
      this.children.push(c);
      c.parentNode = this;
      return c;
    },
    insertBefore(c) {
      if (this._inner !== null && this._inner !== '') {
        this.children.push(pseudoNode(this._inner));
      }
      this._inner = null;
      this.children.unshift(c);
      c.parentNode = this;
      return c;
    },
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    addEventListener(ev, fn) {
      (this._listeners[ev] = this._listeners[ev] || []).push(fn);
    },
    click() { (this._listeners.click || []).forEach((fn) => fn({})); },
    dispatch(ev, arg) {
      (this._listeners[ev] || []).forEach((fn) => fn(arg || { target: this }));
    },
    querySelectorAll() { return []; },
    querySelector() { return makeElement('span'); },
    remove() {},
    getContext() {
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {}
      };
    },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 432, height: 432 })
  };
  el.classList = makeClassList();
  return el;
}

/** 构造一个安装好页面运行环境的独立 VM 上下文，并返回桩对象集合。 */
function createPage() {
  const ids = [
    'solveStatus', 'editor', 'tileOverlay', 'frameStrip', 'frameCountNum',
    'addFrameBtn', 'addBlankBtn', 'dupFrameBtn', 'delFrameBtn',
    'demoBtn', 'resetBtn', 'invertBtn', 'clearFrameBtn',
    'toolBlack', 'toolWhite', 'frameEditHint',
    'solutionBody', 'stepsBody', 'player', 'pvFrame', 'pvTotal',
    'pvAction', 'pvCounters', 'pvStale', 'pvCost', 'pvFulls',
    'exportBtn', 'pvFirst', 'pvPrev', 'pvPlay', 'pvNext'
  ];
  const byId = new Map();
  ids.forEach((id) => {
    const e = makeElement('div', id);
    if (id === 'solveStatus') {
      const txt = makeElement('span');
      e.appendChild(txt);
      e.querySelector = (sel) => (sel === '.txt' ? txt : makeElement('span'));
    }
    byId.set(id, e);
  });

  const timers = [];
  const documentStub = {
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => {
      const e = makeElement(tag);
      if (tag === 'canvas') { e.width = 48; e.height = 48; }
      return e;
    },
    body: makeElement('body'),
    querySelectorAll: () => []
  };

  // app 使用外部注入的 Epaper / EpaperClient（与页面 <script> 顺序一致）。
  const Epaper = require('../js/solver.js');
  const EpaperClient = require('../js/solver-client.js');

  const sandbox = {
    Epaper,
    EpaperClient,
    document: documentStub,
    console,
    Promise,
    Uint8Array,
    Uint8ClampedArray,
    Date,
    Math,
    Error,
    Object,
    Array,
    Map,
    setInterval: () => 1,
    clearInterval: () => {},
    Worker: undefined, // 强制同步退化传输
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL() {} },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } },
    setTimeout: (fn) => {
      const id = timers.length + 1;
      timers.push({ fn, id, cancelled: false, ran: false });
      return id;
    },
    clearTimeout: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cancelled = true;
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const appSrc = require('node:fs').readFileSync(
    path.resolve(__dirname, '../js/app.js'), 'utf8');
  vm.runInContext(appSrc, sandbox);

  const flushTimers = async () => {
    for (const t of timers) {
      if (!t.cancelled && !t.ran) { t.ran = true; t.fn(); }
    }
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };

  return { byId, document: documentStub, flushTimers };
}

test('页面冒烟：载入演示后自动求解、逐帧播放费用累计、导出按钮可用', async () => {
  const page = createPage();
  await page.flushTimers(); // 初始空白帧求解

  page.byId.get('demoBtn').click();
  await page.flushTimers();

  const solutionHtml = page.byId.get('solutionBody').innerHTML;
  assert.match(solutionHtml, /693/, '总费用 693 出现在方案区');
  assert.match(solutionHtml.replace(/<[^>]*>/g, ''), /PFPP/,
    '动作序列 PFPP（费用相同取全刷更早者）');
  assert.equal(page.byId.get('exportBtn').disabled, false);

  // 帧条 4 个缩略图；逐帧列表 4 行。
  assert.equal(page.byId.get('frameStrip').children.length, 4);
  const steps = page.byId.get('stepsBody').children[0];
  assert.ok(steps);
  assert.equal(steps.children.length, 4);

  // PFPP：第1帧 P(31) -> 第2帧 F(600) 累计631 -> 第3帧 P(31) 662 -> 末帧 693。
  assert.equal(page.byId.get('pvFrame').textContent, '初始');
  assert.equal(page.byId.get('pvCost').textContent, '0');

  page.byId.get('pvNext').click();
  assert.equal(page.byId.get('pvFrame').textContent, '1');
  assert.equal(page.byId.get('pvCost').textContent, '31');
  assert.match(page.byId.get('pvAction').innerHTML, /局部刷新（P）/);

  page.byId.get('pvNext').click();
  assert.equal(page.byId.get('pvFrame').textContent, '2');
  assert.equal(page.byId.get('pvCost').textContent, '631');
  assert.equal(page.byId.get('pvFulls').textContent, '1');
  assert.match(page.byId.get('pvAction').innerHTML, /全屏刷新（F）/);

  page.byId.get('pvNext').click();
  assert.equal(page.byId.get('pvFrame').textContent, '3');
  assert.equal(page.byId.get('pvCost').textContent, '662');

  page.byId.get('pvNext').click();
  assert.equal(page.byId.get('pvFrame').textContent, '4');
  assert.equal(page.byId.get('pvCost').textContent, '693');
  assert.equal(page.byId.get('pvFulls').textContent, '1');

  page.byId.get('pvFirst').click();
  assert.equal(page.byId.get('pvFrame').textContent, '初始');
  assert.equal(page.byId.get('pvCost').textContent, '0');

  // 导出：点击触发下载，文件名含总费用。
  let downloaded = null;
  const origCreate = page.document.createElement;
  page.document.createElement = function (tag) {
    const e = origCreate(tag);
    if (tag === 'a') e.click = function () { downloaded = { href: e.href, name: e.download }; };
    return e;
  };
  page.byId.get('exportBtn').click();
  assert.ok(downloaded, '触发了导出下载');
  assert.match(downloaded.name, /cost693/);
});

test('页面冒烟：连续编辑后只有最新一次求解结果落地', async () => {
  const page = createPage();
  await page.flushTimers();

  page.byId.get('demoBtn').click();
  await page.flushTimers();
  assert.match(page.byId.get('solutionBody').innerHTML, /693/);

  page.byId.get('resetBtn').click();
  page.byId.get('demoBtn').click(); // 立即再编辑，使上一代作废
  await page.flushTimers();
  assert.match(page.byId.get('solutionBody').innerHTML, /693/);
  assert.equal(page.byId.get('frameStrip').children.length, 4);
});

test('页面冒烟：初始单空白帧方案为全 P、费用 0', async () => {
  const page = createPage();
  await page.flushTimers();
  const html = page.byId.get('solutionBody').innerHTML;
  assert.match(html, />0</, '总费用 0');
  assert.match(html.replace(/<[^>]*>/g, ''), /^(?=[\s\S]*\bP\b)[\s\S]*$/, '动作含 P');
  assert.equal(page.byId.get('frameStrip').children.length, 1);
  assert.equal(page.byId.get('exportBtn').disabled, false);
});
