/*
 * Worker 客户端 + 代际守卫。
 *
 * 编辑帧序列时可能连续发起多次求解；较旧（token 更小）的 Worker 结果
 * 若“迟到”，绝不能覆盖较新编辑对应的结果——run() 只提交最近一次请求。
 *
 * transport 可注入，便于在 Node 测试中模拟“旧结果晚于新结果到达”。
 * Worker 不可用（如 file:// 受限）时自动退化为同步求解，页面仍可离线使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./solver.js'));
  } else {
    root.EpaperClient = factory(root.Epaper);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (Epaper) {
  'use strict';

  /** 代际守卫：只提交最近一次 run 的完成（resolve/reject）。 */
  class LatestRun {
    constructor() {
      this.token = 0;
      this.current = null; // 最新一代的 slot
    }

    /** 发起新一代请求，返回该代的 { token, promise, resolve, reject }。 */
    begin() {
      const token = ++this.token;
      const slot = { token, settled: false, resolve: null, reject: null };
      this.current = slot;
      const promise = new Promise((resolve, reject) => {
        slot.resolve = resolve;
        slot.reject = reject;
      });
      const gen = {
        token,
        promise,
        /** 只有最新一代允许落地；迟到的旧结果被静默丢弃，返回是否被接受。 */
        resolve: (value) => commit(slot, 'resolve', value),
        reject: (err) => commit(slot, 'reject', err)
      };
      const self = this;
      function commit(s, kind, value) {
        if (self.current !== s || s.settled) return false;
        s.settled = true;
        s[kind](value);
        return true;
      }
      return gen;
    }

    /** 代次是否仍为最新（迟到回调可自查）。 */
    isCurrent(token) {
      return this.current !== null && this.current.token === token;
    }
  }

  /** 可注入传输层的调度器：transport.send(payload, reply)，reply 可能乱序到达。 */
  function createScheduler(transport) {
    const latest = new LatestRun();
    let seq = 0;

    function run(frames, options) {
      const gen = latest.begin();
      const reqId = ++seq;
      transport.send({ type: 'solve', reqId, token: gen.token, frames, options }, function (reply) {
        if (!reply || reply.reqId !== reqId) return;
        if (reply.error) {
          gen.reject(new Error(reply.error));
        } else {
          gen.resolve(reply.result);
        }
      });
      return gen.promise;
    }

    return { run, latest };
  }

  /** 浏览器用 Worker 传输；构造失败/运行报错时抛出，由调用方决定退化。 */
  function workerTransport(url) {
    const worker = new Worker(url);
    const pending = new Map();
    worker.onmessage = function (e) {
      const msg = e.data;
      if (!msg || msg.type !== 'result') return;
      const cb = pending.get(msg.reqId);
      if (cb) {
        pending.delete(msg.reqId);
        cb(msg);
      }
    };
    worker.onerror = function (e) {
      // Worker 整体崩溃：让所有在途请求带着各自 reqId 失败（可被代际守卫丢弃）。
      const err = String((e && e.message) || 'worker error');
      for (const [reqId, cb] of pending) cb({ type: 'result', reqId, error: err });
      pending.clear();
    };
    return {
      worker,
      send: function (payload, reply) {
        pending.set(payload.reqId, reply);
        worker.postMessage(payload);
      }
    };
  }

  /** 同步求解传输（Worker 不可用时的离线退化路径）。 */
  function syncTransport() {
    return {
      send: function (payload, reply) {
        // 推迟到微任务，与 Worker 的异步语义保持一致。
        Promise.resolve().then(() => {
          try {
            reply({ type: 'result', reqId: payload.reqId, token: payload.token,
                    result: Epaper.solve(payload.frames, payload.options) });
          } catch (err) {
            reply({ type: 'result', reqId: payload.reqId, token: payload.token,
                    error: String(err.message || err) });
          }
        });
      }
    };
  }

  /**
   * 页面使用的客户端：优先 Worker，构造失败则退化同步求解。
   * 所有调用共用同一个 LatestRun，迟到的旧 Worker 结果永不覆盖新结果。
   */
  class SolverClient {
    constructor(workerUrl) {
      let transport = null;
      if (typeof Worker !== 'undefined' && workerUrl) {
        try {
          transport = workerTransport(workerUrl);
        } catch (err) {
          transport = null;
        }
      }
      if (!transport) transport = syncTransport();
      this._scheduler = createScheduler(transport);
    }

    solve(frames, options) {
      return this._scheduler.run(frames, options);
    }

    get token() {
      return this._scheduler.latest.token;
    }
  }

  return { LatestRun, createScheduler, workerTransport, syncTransport, SolverClient };
});
