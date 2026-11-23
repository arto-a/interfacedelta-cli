/* eslint-disable @typescript-eslint/no-require-imports -- Node preloads this CommonJS file before test collection. */
/* global require, URL, Request */
// Loaded before test collection. Tests may use in-process loopback HTTP only.
const { syncBuiltinESMExports } = require('node:module');
const https = require('node:https');
const tls = require('node:tls');
const http = require('node:http');
const dns = require('node:dns');
const dnsPromises = require('node:dns/promises');
const blocked = () => {
  throw new Error('Real network/HTTPS is blocked in CLI tests');
};
https.request = blocked;
https.get = blocked;
tls.connect = blocked;
const local = (hostname) =>
  ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
for (const resolver of [dns, dnsPromises]) {
  const original = resolver.lookup;
  resolver.lookup = function (hostname, ...args) {
    if (!local(hostname)) return blocked();
    return original.call(this, hostname, ...args);
  };
}
for (const name of ['request', 'get']) {
  const original = http[name];
  http[name] = function (input, ...args) {
    const hostname =
      typeof input === 'string' || input instanceof URL
        ? new URL(input).hostname
        : (input.hostname ?? input.host ?? 'localhost');
    if (!local(hostname)) return blocked();
    return original.call(this, input, ...args);
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'http:' || !local(url.hostname))
    return Promise.reject(
      new Error('Real network/HTTPS is blocked in CLI tests'),
    );
  return originalFetch(input, init);
};
syncBuiltinESMExports();
