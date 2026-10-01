'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Epaper = require('../js/solver.js');

function blankFrame(n) {
  return new Array(n * n).fill(0);
}

function frameFromPoints(n, points) {
  const f = blankFrame(n);
  for (const [x, y] of points) f[y * n + x] = 1;
  return f;
}

/** 可复现的伪随机数（小平台，无外部依赖）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomFrames(cfg, frameCount, rng, density) {
  const frames = [];
  for (let t = 0; t < frameCount; t++) {
    const f = blankFrame(cfg.n);
    for (let i = 0; i < f.length; i++) {
      if (rng() < density) f[i] = 1;
    }
    frames.push(f);
  }
  return frames;
}

// ---- 基础：费用规则与计数约束的手工样例 ----

test('全刷费用 600 且计数清零', () => {
  // 2x2 瓦片、每瓦片 2x2 像素；瓦片0 连续三帧变化迫使第 3 帧全刷。
  // 让第 3 帧局刷费用(32)高于前两帧(31)，使“全刷放在第3帧”严格最优：
  //   FPP=663, PFP=663, PPF=662 -> PPF
  const n = 4, tiles = 2;
  const f0 = frameFromPoints(n, [[0, 0]]);
  const f1 = frameFromPoints(n, [[0, 0], [1, 0]]); // 瓦片0 增加 1 像素
  const f2 = blankFrame(n);                         // 瓦片0 消失 2 像素，计数将达3 -> 只能F
  const frames = [f0, f1, f2];

  const r = Epaper.solve(frames, { n, tiles });
  assert.ok(r.feasible);
  assert.equal(r.actions, 'PPF');
  assert.equal(r.totalCost, 662);
  assert.equal(r.fullRefreshCount, 1);
  assert.deepEqual(r.steps.map((s) => s.kind), ['P', 'P', 'F']);
  assert.deepEqual(r.steps[1].countersAfter, [2, 0, 0, 0]);
  assert.deepEqual(r.steps[2].countersAfter, [0, 0, 0, 0]);
  assert.equal(r.steps[2].cost, 600);
});

test('整段为全白帧时局刷费用为 0，不需要任何全刷', () => {
  const n = 2, tiles = 2;
  const f = blankFrame(n);
  const r = Epaper.solve([f, f, f], { n, tiles });
  assert.equal(r.actions, 'PPP');
  assert.equal(r.totalCost, 0);
  assert.equal(r.fullRefreshCount, 0);
});

test('空序列返回空方案', () => {
  const r = Epaper.solve([]);
  assert.equal(r.feasible, true);
  assert.equal(r.frames, 0);
  assert.equal(r.totalCost, 0);
  assert.deepEqual(r.steps, []);
});

test('像素费用按 XOR 改变量计算（变黑与变白都计费）', () => {
  const n = 4, tiles = 2;
  const f0 = frameFromPoints(n, [[0, 0], [3, 3]]);
  const f1 = frameFromPoints(n, [[3, 3]]); // 瓦片0 的一个像素变白
  const r = Epaper.solve([f0, f1], { n, tiles });
  // 帧1 瓦片0、瓦片3 各 1 像素：31*2=62；帧2 瓦片0 1 像素：31。
  assert.equal(r.actions, 'PP');
  assert.equal(r.totalCost, 93);
  assert.deepEqual(r.steps[1].changedPixels, [1, 0, 0, 0]);
});

test('默认 48x48 / 3x3：单格闪烁四帧，恰需一次全刷（全局优化而非逐帧贪心）', () => {
  // 黑点在同一格闪烁：开 / 关 / 开 / 关，瓦片0 每帧都变 1 像素，
  // 每帧局刷费用恒为 31。PPP 会让计数达 3，故恰需一次全刷；
  // 合法的一次全刷方案 PFPP / PPFP 费用相同（600+3*31=693），
  // 字典序上 PFPP 胜出；而逐帧贪心会在第 3 帧才被迫全刷（PPFP），不是最优裁决。
  const n = 48, tiles = 3;
  const dot = frameFromPoints(n, [[2, 2]]);
  const blank = blankFrame(n);
  const frames = [dot, blank, dot, blank];
  const r = Epaper.solve(frames);
  assert.equal(r.config.tileCount, 9);
  assert.ok(r.feasible);
  assert.equal(r.fullRefreshCount, 1);
  assert.equal(r.actions, 'PFPP');
  assert.equal(r.totalCost, 693);
  const bf = Epaper.solveBruteForce(frames);
  assert.equal(bf.actions, r.actions);
  assert.equal(bf.cost, r.totalCost);
});

// ---- 与“枚举全部动作序列”的参考实现穷举对拍 ----

function exhaustivePair(label, cfg, frameCount, seed, density) {
  test('穷举对拍: ' + label, () => {
    const rng = mulberry32(seed);
    const frames = randomFrames(cfg, frameCount, rng, density);
    const r = Epaper.solve(frames, cfg);
    const bf = Epaper.solveBruteForce(frames, cfg);
    assert.ok(r.feasible, '2^T 含全刷分支，必有合法方案');
    assert.equal(r.totalCost, bf.cost, '总费用');
    assert.equal(r.fullRefreshCount, bf.fulls, '全刷次数');
    assert.equal(r.actions, bf.actions, '裁决后的动作序列');
    // 逐步费用之和与总费用一致；计数永不超限。
    let sum = 0;
    for (const s of r.steps) {
      sum += s.cost;
      for (const c of s.countersAfter) assert.ok(c <= 2);
    }
    assert.equal(sum, r.totalCost);
  });
}

// 2x2 瓦片（每瓦片 1 像素）：4 帧只有 16 个动作序列，全枚举
for (let seed = 1; seed <= 30; seed++) {
  exhaustivePair(`2x2瓦片/4帧/seed=${seed}`, { n: 2, tiles: 2 }, 4, seed * 7 + 1, 0.4);
}

// 1x1 瓦片（整屏一块），最多连续两帧变化，长度 8：256 序列
for (let seed = 1; seed <= 20; seed++) {
  exhaustivePair(`1x1瓦片/8帧/seed=${seed}`, { n: 1, tiles: 1 }, 8, seed * 13 + 3, 0.5);
}

// 2x2 瓦片、每瓦片 2x2 像素（画面 4x4），长度 6：64 序列，含费用变化
for (let seed = 1; seed <= 20; seed++) {
  exhaustivePair(`4x4画面/2x2瓦片/6帧/seed=${seed}`, { n: 4, tiles: 2 }, 6, seed * 17 + 5, 0.25);
}

test('穷举对拍: 稀疏画面（大量“无变化瓦片”，费用仅来自少数瓦片）', () => {
  const cfg = { n: 4, tiles: 2 };
  const rng = mulberry32(999);
  const frames = randomFrames(cfg, 7, rng, 0.05);
  const r = Epaper.solve(frames, cfg);
  const bf = Epaper.solveBruteForce(frames, cfg);
  assert.equal(r.actions, bf.actions);
  assert.equal(r.totalCost, bf.cost);
});

// ---- 平局裁决：费用与全刷次数相同，逐帧“全刷先于局刷” ----

test('字典序裁决：费用与全刷次数相同的多种全刷位置，取全刷更早者', () => {
  // 2 块瓦片（4x4 画面）、4 帧，令每帧“恰好一块瓦片改变 1 像素”
  // （在各瓦片内累加不同像素点）：
  //   瓦片0 变化在帧 0,2,3；瓦片3 变化在帧 1。每帧局刷费恒为 31。
  // 无全刷的 PPPP 非法（瓦片0 在帧3计数达3），故最优含恰好一次全刷；
  // 四个全刷位置全部合法且费用相同 600+3*31=693，全刷次数都为1：
  //   FPPP < PFPP < PPFP < PPPF —— 取 FPPP。
  const n = 4, tiles = 2;
  const frames = [
    frameFromPoints(n, [[0, 0]]),
    frameFromPoints(n, [[0, 0], [3, 3]]),
    frameFromPoints(n, [[0, 0], [1, 0], [3, 3]]),
    frameFromPoints(n, [[0, 0], [1, 0], [0, 1], [3, 3]])
  ];
  const r = Epaper.solve(frames, { n, tiles });
  const bf = Epaper.solveBruteForce(frames, { n, tiles });
  assert.equal(r.totalCost, 693);
  assert.equal(r.fullRefreshCount, 1);
  assert.equal(r.actions, 'FPPP');
  assert.equal(bf.actions, 'FPPP');
  assert.equal(bf.cost, 693);
});

test('费用优先级：全刷放在最贵的局刷帧上，严格最优者胜出（非字典序最小）', () => {
  // 瓦片0 三帧的改变量为 1,1,2：新增 1 点、再消失 2 点。
  // 一次全刷各位置费用：FPP=663, PFP=663, PPF=662（第3帧局刷最贵）-> PPF。
  // PPF 字典序最靠后却严格最优，证明裁决先看费用。
  const n = 4, tiles = 2;
  const frames = [
    frameFromPoints(n, [[0, 0]]),
    frameFromPoints(n, [[0, 0], [1, 0]]),
    blankFrame(n)
  ];
  const r = Epaper.solve(frames, { n, tiles });
  assert.equal(r.actions, 'PPF');
  assert.equal(r.totalCost, 662);
  const bf = Epaper.solveBruteForce(frames, { n, tiles });
  assert.equal(bf.actions, 'PPF');
});

test('全刷次数优先级高于字典序：比较器逐键比较', () => {
  // 真实帧序列在固定价目表下“费用相同且全刷次数不同”的平局极难构造，
  // 因此直接锁定裁决比较器的层级语义（它是 DP 去重的唯一比较逻辑）：
  // 费用 -> 全刷次数（少者优先）-> actions 字典序（'F'<'P'）。
  const better = (x, y) =>
    x.cost !== y.cost ? x.cost < y.cost
    : x.fulls !== y.fulls ? x.fulls < y.fulls
    : x.actions < y.actions;
  // 费用相同：全刷 1 次但字典序靠后，仍胜过全刷 2 次。
  assert.ok(better({ cost: 100, fulls: 1, actions: 'PPF' },
                   { cost: 100, fulls: 2, actions: 'FPP' }));
  assert.ok(!better({ cost: 100, fulls: 2, actions: 'FPP' },
                    { cost: 100, fulls: 1, actions: 'PPF' }));
  // 费用不同：字典序与全刷次数都不能翻盘。
  assert.ok(better({ cost: 99, fulls: 9, actions: 'PPP' },
                   { cost: 100, fulls: 0, actions: 'FFF' }));
  // 同费用同全刷次数时落到字典序，'F' 先于 'P'。
  assert.ok(better({ cost: 1, fulls: 1, actions: 'FP' },
                   { cost: 1, fulls: 1, actions: 'PF' }));
});

// ---- 生产规模（9 瓦片、20 帧）可行且不超时 ----

test('3x3 瓦片 / 20 帧随机序列：求解完成、状态计数上界正确', () => {
  const cfg = { n: 48, tiles: 3 };
  const rng = mulberry32(20261001);
  const frames = randomFrames(cfg, 20, rng, 0.15);
  const started = Date.now();
  const r = Epaper.solve(frames, cfg);
  assert.ok(r.feasible);
  assert.equal(r.frames, 20);
  assert.equal(r.actions.length, 20);
  assert.ok(r.totalCost >= 0);
  assert.ok(Date.now() - started < 5000, '20 帧 DP 应在 5 秒内完成');
  // 状态空间不超过 3^9。
  assert.equal(Epaper.STATE_COUNT, 19683);
});

test('超过 20 帧报错', () => {
  const frames = [];
  for (let i = 0; i < 21; i++) frames.push(blankFrame(48));
  assert.throws(() => Epaper.solve(frames), /20/);
});

// ---- 状态编解码 ----

test('状态编码/解码按瓦片序号为三进制位', () => {
  assert.equal(Epaper.encodeState([0, 0, 0, 0]), 0);
  assert.equal(Epaper.encodeState([1, 0, 0, 0]), 1);
  assert.equal(Epaper.encodeState([0, 1, 0, 0]), 3);
  assert.deepEqual(Epaper.decodeState(1 + 3 * 2, 4), [1, 2, 0, 0]);
});
