/* 经典 Worker：整段帧序列在后台求解，避免编辑时阻塞页面。 */
'use strict';

importScripts('solver.js');

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type !== 'solve') return;
  let result;
  try {
    result = Epaper.solve(msg.frames, msg.options);
  } catch (err) {
    self.postMessage({
      type: 'result',
      reqId: msg.reqId,
      token: msg.token,
      error: String(err && err.message ? err.message : err)
    });
    return;
  }
  self.postMessage({ type: 'result', reqId: msg.reqId, token: msg.token, result: result });
};
