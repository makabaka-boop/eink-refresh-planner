/* 页面应用：编辑帧序列 -> Worker 全局求解 -> 逐帧展示 / 播放 / 导出共用同一份结果。 */
(function () {
  'use strict';

  const E = window.Epaper;
  const N = E.GRID_N;              // 48
  const T = E.TILES;               // 3
  const TN = E.TILE_N;             // 16
  const TILE_COUNT = E.TILE_COUNT; // 9
  const PIXELS = N * N;

  // ---------------- 状态 ----------------
  const state = {
    frames: [new Uint8Array(PIXELS)], // 至少保留一帧
    selected: 0,
    tool: 'black',
    editTag: 0,          // 每次编辑自增；只有匹配该标记的 Worker 结果才允许落地
    result: null,        // 最近一次“与当前编辑一致”的求解结果
    resultTag: -1,
    pvStep: -1,          // 播放位置：-1 = 初始全白；否则为已执行到的帧下标
    playing: false,
    playTimer: null,
    solveTimer: null,
    solving: false
  };

  const client = new window.EpaperClient.SolverClient('js/solver-worker.js');

  // ---------------- DOM ----------------
  const $ = (id) => document.getElementById(id);
  const editorCanvas = $('editor');
  const ectx = editorCanvas.getContext('2d');
  const playerCanvas = $('player');
  const pctx = playerCanvas.getContext('2d');
  const tileOverlay = $('tileOverlay');
  const stripEl = $('frameStrip');

  // 瓦片覆盖层 9 格
  const overlayCells = [];
  for (let k = 0; k < TILE_COUNT; k++) {
    const d = document.createElement('div');
    d.className = 'cell';
    tileOverlay.appendChild(d);
    overlayCells.push(d);
  }

  // ---------------- 基础工具 ----------------
  function blankFrame() { return new Uint8Array(PIXELS); }

  function drawFrameTo(ctx, frame) {
    const img = ctx.createImageData(N, N);
    for (let i = 0; i < PIXELS; i++) {
      const v = frame && frame[i] ? 0 : 255;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function makeThumb(frame) {
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    drawFrameTo(c.getContext('2d'), frame);
    return c;
  }

  function tileOfCell(x, y) {
    return Math.floor(y / TN) * T + Math.floor(x / TN);
  }

  // ---------------- 求解调度（旧 Worker 结果迟到即丢弃） ----------------
  function scheduleSolve() {
    const tag = ++state.editTag;
    setStatus('working', '求解中…');
    clearTimeout(state.solveTimer);
    state.solving = true;
    state.solveTimer = setTimeout(() => {
      // 复制快照交给 Worker；返回时必须仍与当前编辑一致才采用。
      const snapshot = state.frames.map((f) => f.slice());
      client.solve(snapshot).then((result) => {
        if (tag !== state.editTag) return; // 迟到的旧结果：丢弃
        state.result = result;
        state.resultTag = tag;
        state.solving = false;
        // 播放位置若越界（帧被删短）则收回
        if (state.pvStep > result.frames - 1) state.pvStep = result.frames - 1;
        setStatus('ready', '方案就绪 · ' + result.actions.length + ' 帧已全局优化');
        renderAll();
      }).catch((err) => {
        if (tag !== state.editTag) return;
        state.solving = false;
        setStatus('error', '求解失败：' + err.message);
      });
    }, 120);
  }

  function resultFresh() {
    return state.result && state.resultTag === state.editTag &&
           state.result.frames === state.frames.length;
  }

  function setStatus(kind, text) {
    const el = $('solveStatus');
    el.className = 'status ' + kind;
    el.querySelector('.txt').textContent = text;
  }

  // ---------------- 编辑器绘制 ----------------
  function paintAt(clientX, clientY) {
    const f = state.frames[state.selected];
    if (!f) return;
    const rect = editorCanvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) / rect.width * N);
    const y = Math.floor((clientY - rect.top) / rect.height * N);
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const v = state.tool === 'black' ? 1 : 0;
    if (f[y * N + x] !== v) {
      f[y * N + x] = v;
      drawFrameTo(ectx, f);
      scheduleSolve();
    }
  }

  let drawing = false;
  editorCanvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    editorCanvas.setPointerCapture(e.pointerId);
    paintAt(e.clientX, e.clientY);
  });
  editorCanvas.addEventListener('pointermove', (e) => {
    if (drawing) paintAt(e.clientX, e.clientY);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    editorCanvas.addEventListener(ev, () => { drawing = false; }));

  function setTool(tool) {
    state.tool = tool;
    $('toolBlack').classList.toggle('active', tool === 'black');
    $('toolWhite').classList.toggle('active', tool === 'white');
  }
  $('toolBlack').addEventListener('click', () => setTool('black'));
  $('toolWhite').addEventListener('click', () => setTool('white'));

  $('invertBtn').addEventListener('click', () => {
    const f = state.frames[state.selected];
    if (!f) return;
    for (let i = 0; i < PIXELS; i++) f[i] = f[i] ? 0 : 1;
    drawFrameTo(ectx, f);
    scheduleSolve();
  });

  $('clearFrameBtn').addEventListener('click', () => {
    const f = state.frames[state.selected];
    if (!f) return;
    f.fill(0);
    drawFrameTo(ectx, f);
    scheduleSolve();
  });

  // ---------------- 帧管理 ----------------
  function selectFrame(i) {
    state.selected = Math.max(0, Math.min(i, state.frames.length - 1));
    state.pvStep = state.selected;
    stopPlay();
    renderAll();
  }

  function addFrame(copyCurrent) {
    if (state.frames.length >= E.MAX_FRAMES) return;
    const f = copyCurrent && state.frames[state.selected]
      ? state.frames[state.selected].slice() : blankFrame();
    state.frames.splice(state.selected + 1, 0, f);
    state.selected++;
    state.pvStep = state.selected;
    scheduleSolve();
    renderAll();
  }

  function duplicateFrame() {
    if (state.frames.length >= E.MAX_FRAMES) return;
    const f = state.frames[state.selected].slice();
    state.frames.splice(state.selected + 1, 0, f);
    state.selected++;
    scheduleSolve();
    renderAll();
  }

  function deleteFrame() {
    if (state.frames.length <= 1) {
      // 只保留一帧时，“删除”等价清空
      state.frames[0] = blankFrame();
      state.selected = 0;
    } else {
      state.frames.splice(state.selected, 1);
      state.selected = Math.min(state.selected, state.frames.length - 1);
    }
    state.pvStep = state.selected;
    scheduleSolve();
    renderAll();
  }

  $('addFrameBtn').addEventListener('click', () => addFrame(true));
  $('addBlankBtn').addEventListener('click', () => addFrame(false));
  $('dupFrameBtn').addEventListener('click', duplicateFrame);
  $('delFrameBtn').addEventListener('click', deleteFrame);

  $('resetBtn').addEventListener('click', () => {
    state.frames = [blankFrame()];
    state.selected = 0;
    state.pvStep = -1;
    stopPlay();
    scheduleSolve();
    renderAll();
  });

  // 演示：左上瓦片同一格黑点 开/关/开/关。
  // 连续三局刷会把瓦片计数推到 3，整段最优须在全序列中安排一次全刷：
  // PFPP 与 PPFP 费用相同(600+3*31=693)，逐帧裁决取“全刷更早”的 PFPP。
  $('demoBtn').addEventListener('click', () => {
    const dot = blankFrame();
    dot[2 * N + 2] = 1;
    const white = blankFrame();
    state.frames = [dot.slice(), white.slice(), dot.slice(), white.slice()];
    state.selected = 0;
    state.pvStep = -1;
    stopPlay();
    scheduleSolve();
    renderAll();
  });

  // ---------------- 渲染：编辑器与瓦片高亮 ----------------
  function renderEditor() {
    const f = state.frames[state.selected];
    drawFrameTo(ectx, f);

    const fresh = resultFresh();
    const step = fresh ? state.result.steps[state.selected] : null;
    const diffs = fresh ? step.changedPixels : new Array(TILE_COUNT).fill(0);

    for (let k = 0; k < TILE_COUNT; k++) {
      const cell = overlayCells[k];
      cell.className = 'cell';
      if (!step) continue;
      if (step.kind === 'F') {
        cell.classList.add('changed-full');
      } else if (diffs[k] > 0) {
        cell.classList.add('changed-partial');
        cell.dataset.label = '30+' + diffs[k];
      } else {
        delete cell.dataset.label;
      }
    }

    const partialCount = step && step.kind === 'P' ? step.changedTiles.length : 0;
    $('frameEditHint').textContent = step
      ? '第 ' + (state.selected + 1) + ' 帧动作：' +
        (step.kind === 'F'
          ? '全屏刷新 600（9 块瓦片计数清零）'
          : partialCount === 0
            ? '画面无变化，局刷费用 0（无瓦片被刷）'
            : '局刷 ' + partialCount + ' 块瓦片，费用 ' + step.cost)
      : '编辑后将自动重新求解…';
  }

  // ---------------- 渲染：帧条 ----------------
  function renderStrip() {
    stripEl.innerHTML = '';
    $('frameCountNum').textContent = state.frames.length;
    state.frames.forEach((f, i) => {
      const div = document.createElement('div');
      div.className = 'frame-thumb' + (i === state.selected ? ' selected' : '');
      div.appendChild(makeThumb(f));

      const meta = document.createElement('div');
      meta.className = 'meta';
      const num = document.createElement('span');
      num.textContent = '#' + (i + 1);
      meta.appendChild(num);
      div.appendChild(meta);

      if (resultFresh()) {
        const s = state.result.steps[i];
        const b = document.createElement('span');
        b.className = 'badge ' + (s.kind === 'F' ? 'F' : (s.cost > 0 ? 'P' : 'P0'));
        b.textContent = s.kind;
        b.title = (s.kind === 'F' ? '全屏刷新' : '局刷') + ' · 费用 ' + s.cost;
        div.insertBefore(b, div.firstChild);
        num.textContent = '#' + (i + 1) + ' · ' + s.cost;
      }

      div.addEventListener('click', () => selectFrame(i));
      stripEl.appendChild(div);
    });

    const maxed = state.frames.length >= E.MAX_FRAMES;
    $('addFrameBtn').disabled = maxed;
    $('addBlankBtn').disabled = maxed;
    $('dupFrameBtn').disabled = maxed;
  }

  // ---------------- 渲染：方案总览 + 逐帧列表 ----------------
  function counterGrid(counters, clsPrefix) {
    const g = document.createElement('div');
    g.className = 'counter-grid';
    for (let k = 0; k < TILE_COUNT; k++) {
      const c = document.createElement('div');
      c.className = 'ct lv' + counters[k];
      c.textContent = counters[k];
      c.title = '瓦片 ' + tileName(k) + ' 残影计数 ' + counters[k];
      g.appendChild(c);
    }
    return g;
  }

  function tileName(k) {
    return '(' + (Math.floor(k / T) + 1) + ',' + (k % T + 1) + ')';
  }

  function renderSolution() {
    const body = $('solutionBody');
    const stepsBody = $('stepsBody');
    body.innerHTML = '';
    stepsBody.innerHTML = '';

    if (!resultFresh()) {
      body.innerHTML = '<p class="muted">求解中…（连续编辑时仅采用最新一次 Worker 的结果）</p>';
      stepsBody.innerHTML = '<p class="muted">尚无可用方案。</p>';
      $('exportBtn').disabled = true;
      return;
    }
    const r = state.result;
    $('exportBtn').disabled = false;

    const sum = document.createElement('div');
    sum.className = 'summary';
    sum.innerHTML =
      '<div class="stat"><div class="big">' + r.totalCost +
        '</div><div class="unit">总费用</div></div>' +
      '<div class="stat"><div class="big">' + r.fullRefreshCount +
        '</div><div class="unit">全屏刷新次数</div></div>' +
      '<div class="stat"><div class="big">' +
        r.actions.split('').filter((a) => a === 'P').length +
        '</div><div class="unit">局部刷新帧</div></div>' +
      '<div class="stat"><div class="actions-word">' +
        r.actions.split('').map((a, i) =>
          '<span class="a-' + a + '" title="第' + (i + 1) + '帧 ' +
          (a === 'F' ? '全屏刷新' : '局部刷新') + '">' + a + '</span>').join('') +
        '</div><div class="unit">动作序列（F 全刷 / P 局刷）</div></div>';
    body.appendChild(sum);

    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML =
      '<span><span class="sw" style="background:var(--accent)"></span>全刷 600，计数清零</span>' +
      '<span><span class="sw" style="background:var(--partial)"></span>局刷每块 30＋改变像素</span>' +
      '<span><span class="sw" style="background:#dce6d6"></span>计数1 ' +
      '<span class="sw" style="background:#f2d9d6"></span>计数2（再变必须全刷）</span>';
    body.appendChild(legend);

    // 逐帧列表
    const list = document.createElement('div');
    list.className = 'steps';
    r.steps.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'step-row' + (i === state.pvStep ? ' current' : '');

      const idx = document.createElement('div');
      idx.className = 'idx';
      idx.textContent = i + 1;
      row.appendChild(idx);

      row.appendChild(makeThumb(state.frames[i]));

      const kind = document.createElement('div');
      kind.className = 'kind ' + s.kind;
      kind.textContent = s.kind === 'F' ? '全刷' : '局刷';
      row.appendChild(kind);

      const detail = document.createElement('div');
      detail.className = 'step-detail';
      if (s.kind === 'F') {
        const resetChips = [];
        s.countersBefore.forEach((c, k) => {
          if (c > 0) {
            resetChips.push('<span class="chip full">瓦片' + tileName(k) + '：' + c + '→0</span>');
          }
        });
        detail.innerHTML = '全屏刷新，费用 600，9 块瓦片计数全部清零' +
          (resetChips.length
            ? '：<div class="chips">' + resetChips.join('') + '</div>'
            : '（此前所有计数本就为 0）');
      } else if (s.changedTiles.length === 0) {
        detail.innerHTML = '与上一帧完全相同，无瓦片需要刷新，费用 0';
      } else {
        const chips = s.changedTiles.map((k, j) =>
          '<span class="chip">瓦片' + tileName(k) + ' · 30+' +
          s.changedPixels[k] + '=' + s.costs[j] + '</span>').join('');
        detail.innerHTML = '变化瓦片 ' + s.changedTiles.length + ' 块：<div class="chips">' +
          chips + '</div>';
      }
      row.appendChild(detail);

      const right = document.createElement('div');
      right.className = 'step-cost';
      right.innerHTML = '<div class="c">' + s.cost + '</div>';
      right.appendChild(counterGrid(s.countersAfter));
      row.appendChild(right);

      row.addEventListener('click', () => {
        state.selected = i;
        state.pvStep = i;
        stopPlay();
        renderAll();
      });
      list.appendChild(row);
    });
    stepsBody.appendChild(list);
  }

  // ---------------- 播放 ----------------
  function renderPlayer() {
    const fresh = resultFresh();
    const staleBox = $('pvStale');
    staleBox.innerHTML = '';

    if (!fresh) {
      drawFrameTo(pctx, blankFrame());
      $('pvFrame').textContent = '–';
      $('pvTotal').textContent = '';
      $('pvAction').innerHTML = '<p class="muted">方案与当前编辑不一致，等待最新求解结果…</p>';
      $('pvCounters').innerHTML = '';
      $('pvCost').textContent = '0';
      $('pvFulls').textContent = '0';
      $('exportBtn').disabled = true;
      ['pvFirst', 'pvPrev', 'pvPlay', 'pvNext'].forEach((id) => $(id).disabled = true);
      return;
    }
    ['pvFirst', 'pvPrev', 'pvPlay', 'pvNext'].forEach((id) => $(id).disabled = false);

    const r = state.result;
    if (state.pvStep < 0) state.pvStep = -1;
    if (state.pvStep > r.frames - 1) state.pvStep = r.frames - 1;
    const i = state.pvStep;

    drawFrameTo(pctx, i >= 0 ? state.frames[i] : blankFrame());
    $('pvFrame').textContent = i < 0 ? '初始' : String(i + 1);
    $('pvTotal').textContent = '/ ' + r.frames;

    let cumCost = 0, cumFulls = 0;
    for (let t = 0; t <= i; t++) {
      cumCost += r.steps[t].cost;
      if (r.steps[t].kind === 'F') cumFulls++;
    }
    $('pvCost').textContent = cumCost;
    $('pvFulls').textContent = cumFulls;

    if (i < 0) {
      $('pvAction').innerHTML =
        '<p class="muted">初始状态：全白画面，9 块瓦片残影计数均为 0。点击 ▶ 逐帧执行刷新动作。</p>';
      $('pvCounters').innerHTML = '';
    } else {
      const s = r.steps[i];
      const prev = i === 0 ? null : r.steps[i - 1];
      const before = s.countersBefore;
      const after = s.countersAfter;
      let detail;
      if (s.kind === 'F') {
        detail = '动作：<b style="color:var(--accent)">全屏刷新（F）</b>，费用 600；全部瓦片计数 0→0（清零）。';
      } else if (s.changedTiles.length === 0) {
        detail = '动作：<b style="color:var(--partial)">局部刷新（P）</b>，画面无变化，费用 0，计数不变。';
      } else {
        const chips = s.changedTiles.map((k, j) =>
          '<span class="chip">瓦片' + tileName(k) + '：' + before[k] + '→' + after[k] +
          '（30+' + s.changedPixels[k] + '=' + s.costs[j] + '）</span>').join('');
        detail = '动作：<b style="color:var(--partial)">局部刷新（P）</b> ' +
          s.changedTiles.length + ' 块，费用 ' + s.cost +
          '；被刷瓦片计数加一：<div class="chips" style="margin-top:4px">' + chips + '</div>';
      }
      $('pvAction').innerHTML = '<p style="font-size:12px;margin:6px 0">' + detail + '</p>';
      const wrap = document.createElement('div');
      wrap.innerHTML =
        '<div style="font-size:11px;color:var(--ink-faint);margin-bottom:2px">本帧动作后各瓦片计数</div>';
      wrap.appendChild(counterGrid(after));
      $('pvCounters').innerHTML = '';
      $('pvCounters').appendChild(wrap);
    }

    // 高亮逐帧列表与帧条
    document.querySelectorAll('.step-row').forEach((el, idx) =>
      el.classList.toggle('current', idx === i));
    document.querySelectorAll('.frame-thumb').forEach((el, idx) =>
      el.classList.toggle('selected', idx === state.selected));

    $('pvPlay').textContent = state.playing ? '⏸ 暂停' : '▶ 播放';
  }

  function gotoStep(i) {
    state.pvStep = i;
    if (i >= 0) state.selected = i;
    renderAll();
  }

  $('pvFirst').addEventListener('click', () => { stopPlay(); gotoStep(-1); });
  $('pvPrev').addEventListener('click', () => {
    stopPlay();
    gotoStep(Math.max(-1, state.pvStep - 1));
  });
  $('pvNext').addEventListener('click', () => {
    stopPlay();
    if (resultFresh()) gotoStep(Math.min(state.result.frames - 1, state.pvStep + 1));
  });

  function stopPlay() {
    state.playing = false;
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
    const btn = $('pvPlay');
    if (btn) btn.textContent = '▶ 播放';
  }

  $('pvPlay').addEventListener('click', () => {
    if (!resultFresh()) return;
    if (state.playing) { stopPlay(); renderPlayer(); return; }
    if (state.pvStep >= state.result.frames - 1) state.pvStep = -1;
    state.playing = true;
    renderPlayer();
    state.playTimer = setInterval(() => {
      if (!resultFresh()) { stopPlay(); renderPlayer(); return; }
      if (state.pvStep >= state.result.frames - 1) {
        stopPlay();
        renderAll();
        return;
      }
      state.pvStep++;
      state.selected = state.pvStep;
      renderAll();
    }, 1000);
  });

  // ---------------- 导出（与播放共用同一份求解结果） ----------------
  $('exportBtn').addEventListener('click', () => {
    if (!resultFresh()) return;
    const r = state.result;
    const payload = {
      app: 'epaper-refresh-planner',
      exportedAt: new Date().toISOString(),
      config: {
        gridN: N, tiles: T, tileN: TN, maxFrames: E.MAX_FRAMES,
        fullCost: E.FULL_COST, partialBase: E.PARTIAL_BASE, ghostLimit: E.GHOST_LIMIT
      },
      frameCount: state.frames.length,
      frames: state.frames.map((f) => Array.from(f)),
      solution: {
        feasible: r.feasible,
        totalCost: r.totalCost,
        fullRefreshCount: r.fullRefreshCount,
        actions: r.actions,
        steps: r.steps.map((s) => ({
          frame: s.frame,
          kind: s.kind,
          cost: s.cost,
          changedTiles: s.changedTiles,
          changedPixels: Array.from(s.changedPixels),
          costs: s.costs,
          countersBefore: Array.from(s.countersBefore),
          countersAfter: Array.from(s.countersAfter)
        }))
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'epaper-plan-' + r.frames + 'frames-cost' + r.totalCost + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------------- 汇总渲染 ----------------
  function renderAll() {
    renderEditor();
    renderStrip();
    renderSolution();
    renderPlayer();
  }

  // 初始：触发一次求解（空白帧 -> 费用 0 的全 P 方案）
  scheduleSolve();
  renderAll();
})();
