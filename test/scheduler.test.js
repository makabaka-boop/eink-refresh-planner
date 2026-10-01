'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LatestRun, createScheduler, syncTransport } = require('../js/solver-client.js');
const Epaper = require('../js/solver.js');

function frame(ones, n) {
  n = n || 1;
  const f = new Array(n * n).fill(0);
  for (const i of ones) f[i] = 1;
  return f;
}

test('LatestRun：只有最新一代能提交，迟到的旧结果被丢弃', async () => {
  const latest = new LatestRun();

  const first = latest.begin();
  const second = latest.begin(); // 用户再次编辑，新一代开始
  assert.equal(second.token, 2);
  assert.equal(latest.isCurrent(first.token), false);
  assert.equal(latest.isCurrent(second.token), true);

  // 旧 Worker 的结果“迟到”：不得兑现第一代的承诺。
  let oldSettled = false;
  first.promise.then(
    () => { oldSettled = true; },
    () => { oldSettled = true; }
  );
  assert.equal(first.resolve('late-result'), false);
  await Promise.resolve();
  assert.equal(oldSettled, false);

  // 新一代结果正常落地。
  let value = null;
  second.promise.then((v) => { value = v; });
  assert.equal(second.resolve('new-result'), true);
  await Promise.resolve();
  assert.equal(value, 'new-result');

  // 新一代落地后，迟到的重复回调也被拒绝。
  assert.equal(second.resolve('again'), false);
  assert.equal(second.reject(new Error('again')), false);
});

test('LatestRun：旧一代的 reject 迟到也不得影响页面', async () => {
  const latest = new LatestRun();
  const first = latest.begin();
  const second = latest.begin();

  let outcome = 'pending';
  first.promise.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });

  // 旧 Worker 以错误结束（例如求解异常），但它已经过期。
  assert.equal(first.reject(new Error('late worker failure')), false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(outcome, 'pending');

  // 新一代仍可正常兑现。
  let v = null;
  second.promise.then((x) => { v = x; });
  second.resolve('ok');
  await Promise.resolve();
  assert.equal(v, 'ok');
});

test('调度器：旧请求晚于新请求到达时，页面只拿到新结果', async () => {
  // 手动传输层：缓存两个回调，让旧请求的结果更晚到达（模拟 Worker 乱序）。
  const replies = [];
  const transport = {
    send(payload, reply) { replies.push({ payload, reply }); }
  };
  const scheduler = createScheduler(transport);

  const p1 = scheduler.run([frame([0])], { n: 1, tiles: 1 });
  const p2 = scheduler.run([frame([]), frame([0])], { n: 1, tiles: 1 });

  // 新请求先返回。
  const r2 = Epaper.solve([frame([]), frame([0])], { n: 1, tiles: 1 });
  replies[1].reply({ type: 'result', reqId: replies[1].payload.reqId, result: r2 });
  const got2 = await p2;
  assert.equal(got2.frames, 2);
  assert.equal(got2.actions, r2.actions);

  // 旧请求迟到：它的承诺不应在之后被错误兑现。
  let oldOutcome = 'pending';
  p1.then(() => { oldOutcome = 'resolved'; }, () => { oldOutcome = 'rejected'; });
  const r1 = Epaper.solve([frame([0])], { n: 1, tiles: 1 });
  replies[0].reply({ type: 'result', reqId: replies[0].payload.reqId, result: r1 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(oldOutcome, 'pending', '旧一代承诺保持悬空，迟到结果不落地');
});

test('调度器：连续三次编辑，只有最后一次的结果能落地', async () => {
  const queued = [];
  const transport = { send: (p, cb) => queued.push([p, cb]) };
  const scheduler = createScheduler(transport);

  const pA = scheduler.run([frame([0])], { n: 1, tiles: 1 });
  const pB = scheduler.run([frame([0]), frame([0])], { n: 1, tiles: 1 });
  const pC = scheduler.run([frame([0]), frame([]), frame([0])], { n: 1, tiles: 1 });

  // 防止未处理拒绝噪音；A/B 永不会落地。
  pA.catch(() => {});
  pB.catch(() => {});

  // A、B 迟到（先失败后成功）都无效。
  queued[0][1]({ type: 'result', reqId: queued[0][0].reqId, error: 'late failure A' });
  queued[1][1]({ type: 'result', reqId: queued[1][0].reqId,
                 result: Epaper.solve([frame([0]), frame([0])], { n: 1, tiles: 1 }) });

  let outcome = 'pending';
  let val = null;
  pC.then((v) => { outcome = 'resolved'; val = v; },
          () => { outcome = 'rejected'; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(outcome, 'pending', '旧结果不能提前兑现 C');

  // C 正常返回。
  queued[2][1]({ type: 'result', reqId: queued[2][0].reqId,
                 result: Epaper.solve([frame([0]), frame([]), frame([0])], { n: 1, tiles: 1 }) });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(outcome, 'resolved');
  assert.equal(val.frames, 3);
});

test('同步退化传输：Worker 不可用时结果一致', async () => {
  const scheduler = createScheduler(syncTransport());
  const frames = [frame([0]), frame([]), frame([0]), frame([])];
  const r = await scheduler.run(frames, { n: 1, tiles: 1 });
  const ref = Epaper.solve(frames, { n: 1, tiles: 1 });
  assert.equal(r.actions, ref.actions);
  assert.equal(r.totalCost, ref.totalCost);
});

test('调度器：错误结果会拒绝当前承诺', async () => {
  const queued = [];
  const transport = { send: (p, cb) => queued.push([p, cb]) };
  const scheduler = createScheduler(transport);
  const p = scheduler.run([frame([0])], { n: 1, tiles: 1 });
  queued[0][1]({ type: 'result', reqId: queued[0][0].reqId, error: 'boom' });
  await assert.rejects(p, /boom/);
});
