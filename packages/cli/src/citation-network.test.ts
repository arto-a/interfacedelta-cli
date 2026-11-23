import './test-network-block.cjs';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { pinnedCitationRequest } from './citation-network';

afterEach(() => vi.restoreAllMocks());

it('connects only to the checked address without pooling and keeps the TLS/Host hostname', async () => {
  const request = Object.assign(new EventEmitter(), { end: vi.fn() });
  const response = Object.assign(Readable.from([Buffer.from('source bytes')]), {
    statusCode: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
  const mocked = vi
    .spyOn(https, 'request')
    .mockReturnValue(request as unknown as ReturnType<typeof https.request>);
  const url = new URL('https://source.example:8443/paper?version=2');
  const address = { address: '93.184.216.34', family: 4 };
  const controller = new AbortController();
  const pending = pinnedCitationRequest(url, address, {
    headers: { 'Accept-Encoding': 'identity' },
    signal: controller.signal,
  });
  const [target, options, onResponse] = mocked.mock.calls[0] as unknown as [
    URL,
    https.RequestOptions,
    (response: unknown) => void,
  ];
  expect(target).toBe(url);
  expect(options).toMatchObject({
    method: 'GET',
    agent: false,
    family: address.family,
    signal: controller.signal,
  });
  // A rebinding resolver is never consulted: the connector gets only the checked IP.
  const callback = vi.fn();
  (options.lookup as LookupFunction)('source.example', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, address.address, address.family);
  expect(request.end).toHaveBeenCalledTimes(1);
  onResponse(response);
  expect(await (await pending).text()).toBe('source bytes');
});

it('closes responses that cannot have a body instead of draining unbounded bytes', async () => {
  const request = Object.assign(new EventEmitter(), { end: vi.fn() });
  const response = Object.assign(new Readable({ read() {} }), {
    statusCode: 205,
    headers: {},
  });
  const destroy = vi.spyOn(response, 'destroy');
  const mocked = vi
    .spyOn(https, 'request')
    .mockReturnValue(request as unknown as ReturnType<typeof https.request>);
  const pending = pinnedCitationRequest(
    new URL('https://source.example/empty'),
    { address: '93.184.216.34', family: 4 },
    { headers: {}, signal: new AbortController().signal },
  );
  const onResponse = mocked.mock.calls[0]![2] as (response: unknown) => void;
  onResponse(response);
  expect(await (await pending).text()).toBe('');
  expect(destroy).toHaveBeenCalledTimes(1);
});
