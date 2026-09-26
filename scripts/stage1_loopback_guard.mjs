// Preloaded with NODE_OPTIONS only by disposable Stage 1 integration child
// processes. Record targets without URLs, headers or payloads; block anything
// outside loopback before the runtime can open a connection.
import fs from 'node:fs';
import net from 'node:net';

const logPath = process.env.STAGE1_OUTBOUND_TARGET_LOG;
function record(disposition, host, port) {
  if (!logPath) throw new Error('Stage 1 outbound target log is required');
  fs.appendFileSync(logPath, `${disposition}\t${String(host || 'localhost').replace(/[\r\n\t]/g, '')}\t${String(port || '')}\n`, { mode: 0o600 });
}
function isLoopback(host) {
  const normalized = String(host || 'localhost').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = args[0];
  let options;
  if (first && typeof first === 'object') options = first;
  else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    options = { port: Number(first), host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  } else options = { path: first };
  const host = options.host || options.hostname || 'localhost';
  const port = options.port || '';
  if (options.path || !isLoopback(host)) {
    record('DENIED', options.path ? 'unix-socket' : host, port);
    throw new Error('Stage 1 integration egress is restricted to loopback and disposable PostgreSQL');
  }
  record('ALLOWED', host, port);
  return originalConnect.apply(this, args);
};

if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input.url); }
    catch { record('DENIED', 'invalid-url', ''); return Promise.reject(new Error('Stage 1 integration egress rejected an invalid URL')); }
    const host = url.hostname;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (!['http:', 'https:'].includes(url.protocol) || !isLoopback(host)) {
      record('DENIED', host, port);
      return Promise.reject(new Error('Stage 1 integration egress is restricted to loopback and disposable PostgreSQL'));
    }
    record('ALLOWED', host, port);
    return originalFetch(input, init);
  };
}
