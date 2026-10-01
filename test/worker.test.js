'use strict';

/*
 * 经典 Worker 入口（js/solver-worker.js）的消息往返测试。
 * Node 中没有真实 Worker/importScripts，这里模拟其全局对象加载脚本，
 * 验证：solve 消息 -> 结果（带 reqId/token 原样回传）；异常输入 -> error 消息；
 * 非 solve 消息被忽略。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Epaper = require('../js/solver.js');

function loadWorkerContext() {
  const posted = [];
  const sandbox = {
    Epaper, // importScripts('solver.js') 在真实 Worker 中产生的全局
    console,
    postMessage: (m) => posted.push(m),
    importScripts: (file) => {
      // 真实 Worker 中 solver.js 通过 UMD 挂到 self.Epaper；这里模拟该结果。
      assert.equal(file, 'solver.js');
      sandbox.Epaper = Epaper;
    }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const workerSrc = fs.readFileSync(path.resolve(__dirname, '../js/solver-worker.js'), 'utf8');
  vm.runInContext(workerSrc, sandbox);
  return { sandbox, posted };
}

function framesBlink() {
  const dot = new Array(48 * 48).fill(0);
  dot[2 * 48 + 2] = 1;
  const blank = new Array(48 * 48).fill(0);
  return [dot, blank, dot.slice(), blank];
}

test('Worker：solve 消息返回带 reqId/token 的正确结果', () => {
  const { sandbox, posted } = loadWorkerContext();
  sandbox.onmessage({ data: { type: 'solve', reqId: 7, token: 3, frames: framesBlink() } });
  assert.equal(posted.length, 1);
  const m = posted[0];
  assert.equal(m.type, 'result');
  assert.equal(m.reqId, 7);
  assert.equal(m.token, 3);
  assert.equal(m.result.actions, 'PFPP');
  assert.equal(m.result.totalCost, 693);
  assert.equal(m.result.fullRefreshCount, 1);
  assert.equal(m.result.steps.length, 4);
});

test('Worker：非法输入回 error 消息（不抛出 Worker）', () => {
  const { sandbox, posted } = loadWorkerContext();
  sandbox.onmessage({ data: { type: 'solve', reqId: 8, token: 4, frames: [[]] } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].reqId, 8);
  assert.equal(typeof posted[0].error, 'string');
  assert.match(posted[0].error, /48/);
});

test('Worker：非 solve 消息忽略', () => {
  const { sandbox, posted } = loadWorkerContext();
  sandbox.onmessage({ data: { type: 'ping' } });
  assert.equal(posted.length, 0);
});

test('Worker：多次请求各自回传 reqId（与客户端的代际守卫配合）', () => {
  const { sandbox, posted } = loadWorkerContext();
  sandbox.onmessage({ data: { type: 'solve', reqId: 1, token: 1, frames: [new Array(48 * 48).fill(0)] } });
  sandbox.onmessage({ data: { type: 'solve', reqId: 2, token: 2, frames: framesBlink() } });
  assert.deepEqual(posted.map((m) => m.reqId), [1, 2]);
  assert.equal(posted[0].result.frames, 1);
  assert.equal(posted[1].result.frames, 4);
  // 客户端按 reqId 路由、按 token 丢弃旧代；Worker 端如实透传两个字段。
  assert.equal(posted[0].token, 1);
  assert.equal(posted[1].token, 2);
});
