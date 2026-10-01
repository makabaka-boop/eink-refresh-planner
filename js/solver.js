/*
 * 求解器核心：电子纸整段帧序列的最小费用合法刷新规划。
 *
 * 画面为 n x n 像素（默认 48x48），黑白二值，
 * 固定分成 tiles x tiles 个瓦片（默认 3x3，每块 16x16）。
 *
 * 每帧二选一：
 *   - 全屏刷新 (F)：费用 FULL_COST(600)，全部瓦片残影计数清零；
 *   - 局部刷新 (P)：对本帧相对上一帧“显示内容发生变化”的瓦片分别局刷，
 *       每块费用 30 + 该瓦片中改变的像素数，
 *       被刷瓦片残影计数 +1，其余瓦片计数不变。
 * 任何瓦片计数不得超过 2。初始画面全白（0），所有计数为 0。
 *
 * 状态 = 每个瓦片“距上次全刷以来连续局刷的次数”，每位 2 bit（0..2），
 * 编码为一个整数。帧 t 是否可行、费用多少只取决于状态与该帧的变化清单，
 * 因此在整段帧序列上做动态规划，而不是逐帧贪心。
 *
 * 同一 (帧, 状态) 去重时比较 (总费用, 全刷累计次数, 动作序列字典序)：
 * 动作序列以每帧字符 'F'/'P' 比较，'F' < 'P'，
 * 即“费用相同先取全刷次数较少者；再取全刷更早出现（全刷先于局刷）者”。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Epaper = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const GRID_N = 48;
  const TILES = 3;
  const TILE_N = GRID_N / TILES; // 16
  const MAX_FRAMES = 20;
  const FULL_COST = 600;
  const PARTIAL_BASE = 30;
  const GHOST_LIMIT = 2;

  const TILE_COUNT = TILES * TILES;
  const STATE_COUNT = (GHOST_LIMIT + 1) ** TILE_COUNT; // 3^9 = 19683
  const INITIAL_STATE = 0; // 全 0：所有瓦片残影计数为 0

  /** 规整配置：生产默认 48x48 / 3x3；测试可用更小瓦片数。 */
  function makeConfig(n, tiles) {
    n = n || GRID_N;
    tiles = tiles || TILES;
    if (n % tiles !== 0) throw new Error('画面边长必须能被瓦片数整除');
    return { n, tiles, tileN: n / tiles, tileCount: tiles * tiles };
  }

  /** 解码状态：返回长度 tileCount 的数组，元素为各瓦片残影计数。 */
  function decodeState(state, tileCount) {
    const m = tileCount || TILE_COUNT;
    const counters = new Array(m);
    for (let i = 0; i < m; i++) {
      counters[i] = state % 3;
      state = Math.floor(state / 3);
    }
    return counters;
  }

  /** 由计数数组编码状态；counters 中 undefined 视为 0。 */
  function encodeState(counters) {
    let state = 0;
    for (let i = counters.length - 1; i >= 0; i--) {
      state = state * 3 + (counters[i] | 0);
    }
    return state;
  }

  /**
   * 计算相邻两帧之间每个瓦片的改变像素数。
   * prev 缺省表示初始全白画面。
   * 返回长度 tileCount 的数组：未变化为 0，否则为 XOR 后该瓦片内的黑点数。
   */
  function tileDiffs(prev, curr, options) {
    const cfg = options instanceof Object ? options : makeConfig();
    const { n, tiles, tileN, tileCount } = cfg;
    const diffs = new Array(tileCount).fill(0);
    for (let ty = 0; ty < tiles; ty++) {
      for (let tx = 0; tx < tiles; tx++) {
        const k = ty * tiles + tx;
        let count = 0;
        const y0 = ty * tileN;
        const x0 = tx * tileN;
        for (let y = y0; y < y0 + tileN; y++) {
          const row = y * n;
          for (let x = x0; x < x0 + tileN; x++) {
            const idx = row + x;
            if ((curr[idx] | 0) !== ((prev ? prev[idx] : 0) | 0)) count++;
          }
        }
        diffs[k] = count;
      }
    }
    return diffs;
  }

  function better(a, b) {
    if (a.cost !== b.cost) return a.cost < b.cost;
    if (a.fulls !== b.fulls) return a.fulls < b.fulls;
    return a.actions < b.actions; // 'F' < 'P'：全刷先于局刷
  }

  /**
   * 在整段帧序列上做动态规划。
   * @param {number[][]} frames 长度 1..MAX_FRAMES，每帧长度 n*n 的 0/1 数组
   * @param {{n?:number, tiles?:number}} [options] 默认 48 / 3x3
   */
  function solve(frames, options) {
    const cfg = makeConfig(options && options.n, options && options.tiles);
    const { n, tiles, tileCount } = cfg;
    const stateCount = (GHOST_LIMIT + 1) ** tileCount;

    const empty = {
      feasible: true,
      frames: 0,
      totalCost: 0,
      fullRefreshCount: 0,
      actions: '',
      steps: []
    };
    if (!frames || frames.length === 0) return empty;
    if (frames.length > MAX_FRAMES) {
      throw new Error('帧数不能超过 ' + MAX_FRAMES);
    }
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i] || frames[i].length !== n * n) {
        throw new Error('第 ' + (i + 1) + ' 帧尺寸必须为 ' + n + 'x' + n);
      }
    }

    // 预计算每帧相对上一帧（第 0 帧相对初始全白）的瓦片变化。
    const diffsByFrame = frames.map((f, t) => tileDiffs(t === 0 ? null : frames[t - 1], f, cfg));
    const pow3 = [];
    for (let k = 0; k < tileCount; k++) pow3[k] = 3 ** k;

    // dp[state] = 到达该状态的最优（去重键）候选；prev 为回溯表，按帧分层。
    let dp = new Map();
    dp.set(INITIAL_STATE, { cost: 0, fulls: 0, actions: '' });
    const backtrack = [null]; // backtrack[t] 给出“第 t 帧动作后”各状态的来源

    for (let t = 0; t < frames.length; t++) {
      const diffs = diffsByFrame[t];
      const changed = [];
      let partialCost = 0;
      for (let k = 0; k < tileCount; k++) {
        if (diffs[k] > 0) {
          changed.push(k);
          partialCost += PARTIAL_BASE + diffs[k];
        }
      }

      const next = new Map();
      const prevLayer = new Map();

      for (const [state, cand] of dp) {
        // —— 动作 F：全屏刷新，费用 600，计数全部清零 ——
        {
          const nc = { cost: cand.cost + FULL_COST, fulls: cand.fulls + 1, actions: cand.actions + 'F' };
          const ex = next.get(INITIAL_STATE);
          if (!ex || better(nc, ex)) {
            next.set(INITIAL_STATE, nc);
            prevLayer.set(INITIAL_STATE, { from: state, kind: 'F' });
          }
        }

        // —— 动作 P：只刷变化瓦片；任一变化瓦片计数已达 2 则不合法 ——
        let legal = true;
        for (let i = 0; i < changed.length; i++) {
          const digit = Math.floor(state / pow3[changed[i]]) % 3;
          if (digit >= GHOST_LIMIT) { legal = false; break; }
        }
        if (legal) {
          let ns = state;
          for (let i = 0; i < changed.length; i++) ns += pow3[changed[i]]; // 合法时该位 0/1
          const nc = { cost: cand.cost + partialCost, fulls: cand.fulls, actions: cand.actions + 'P' };
          const ex = next.get(ns);
          if (!ex || better(nc, ex)) {
            next.set(ns, nc);
            prevLayer.set(ns, { from: state, kind: 'P' });
          }
        }
      }

      dp = next;
      backtrack.push(prevLayer);
    }

    if (dp.size === 0) {
      return {
        feasible: false,
        frames: frames.length,
        totalCost: null,
        fullRefreshCount: null,
        actions: null,
        steps: null
      };
    }

    // 在全部终止状态中取最优。
    let bestState = null;
    let best = null;
    for (const [state, cand] of dp) {
      if (!best || better(cand, best)) {
        best = cand;
        bestState = state;
      }
    }

    // 回溯，重建每帧动作、费用与计数变化。
    const actionChars = new Array(frames.length);
    let state = bestState;
    for (let t = frames.length; t >= 1; t--) {
      const link = backtrack[t].get(state);
      actionChars[t - 1] = link.kind;
      state = link.from;
    }

    const steps = [];
    let counters = new Array(tileCount).fill(0);
    let total = 0;
    for (let t = 0; t < frames.length; t++) {
      const diffs = diffsByFrame[t];
      const changedTiles = [];
      const costs = [];
      let cost = 0;
      for (let k = 0; k < tileCount; k++) {
        if (diffs[k] > 0) {
          changedTiles.push(k);
          const c = PARTIAL_BASE + diffs[k];
          costs.push(c);
          cost += c;
        }
      }
      const before = counters.slice();
      const kind = actionChars[t];
      if (kind === 'F') {
        counters = new Array(tileCount).fill(0);
        cost = FULL_COST;
      } else {
        for (let i = 0; i < changedTiles.length; i++) counters[changedTiles[i]]++;
      }
      total += cost;
      steps.push({
        frame: t,
        kind,
        cost,
        changedTiles,
        changedPixels: diffs.slice(),
        costs,
        countersBefore: before,
        countersAfter: counters.slice()
      });
    }

    return {
      feasible: true,
      frames: frames.length,
      totalCost: total,
      fullRefreshCount: best.fulls,
      actions: best.actions,
      steps,
      config: { n, tiles, tileCount, stateCount }
    };
  }

  /** 枚举全部 2^frames 个动作序列的朴素参考实现，仅用于小规模对拍。 */
  function solveBruteForce(frames, options) {
    const cfg = makeConfig(options && options.n, options && options.tiles);
    const { tiles, tileCount } = cfg;
    const diffsByFrame = frames.map((f, t) => tileDiffs(t === 0 ? null : frames[t - 1], f, cfg));
    let best = null;

    function visit(t, counters, cost, fulls, actions) {
      if (t === frames.length) {
        if (!best || cost < best.cost ||
            (cost === best.cost && fulls < best.fulls) ||
            (cost === best.cost && fulls === best.fulls && actions < best.actions)) {
          best = { cost, fulls, actions };
        }
        return;
      }
      const diffs = diffsByFrame[t];

      // F：全刷恒合法，计数清零
      visit(t + 1, new Array(tileCount).fill(0), cost + FULL_COST, fulls + 1, actions + 'F');

      // P：对所有变化瓦片局刷；有变化瓦片计数已达 2 则该序列非法
      const changed = [];
      let pcost = 0;
      let legal = true;
      for (let k = 0; k < tileCount; k++) {
        if (diffs[k] > 0) {
          if (counters[k] >= GHOST_LIMIT) { legal = false; break; }
          changed.push(k);
          pcost += PARTIAL_BASE + diffs[k];
        }
      }
      if (legal) {
        const nc2 = counters.slice();
        for (let i = 0; i < changed.length; i++) nc2[changed[i]]++;
        visit(t + 1, nc2, cost + pcost, fulls, actions + 'P');
      }
    }

    visit(0, new Array(tileCount).fill(0), 0, 0, '', []);
    return best;
  }

  return {
    GRID_N, TILES, TILE_N, TILE_COUNT, MAX_FRAMES,
    FULL_COST, PARTIAL_BASE, GHOST_LIMIT,
    STATE_COUNT,
    makeConfig, decodeState, encodeState, tileDiffs, solve, solveBruteForce
  };
});
