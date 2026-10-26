import { EventEmitter } from 'node:events';

/**
 * Test-only stand-in for node:https `request()`. It replays one scripted
 * response per URL in fixed-size chunks and stops as soon as the caller
 * destroys the request or response, so tests can see how many bytes the real
 * transport read. Tests install it with `vi.mock('node:https', ...)`.
 */
export type ScriptedReply = {
  status: number;
  headers?: Record<string, string>;
  body: Buffer;
  chunkBytes?: number;
};
export type ScriptedRequest = {
  url: string;
  deliveredBytes: number;
  responseDestroyed: boolean;
};

export function scriptedHttpsRequest(reply: (url: URL) => ScriptedReply) {
  const requests: ScriptedRequest[] = [];
  const implementation = (
    url: URL,
    _options: unknown,
    onResponse: (response: EventEmitter) => void,
  ) => {
    const scripted = reply(url);
    const entry = {
      url: url.href,
      deliveredBytes: 0,
      responseDestroyed: false,
    };
    requests.push(entry);
    let destroyed = false;
    const response = Object.assign(new EventEmitter(), {
      statusCode: scripted.status,
      headers: scripted.headers ?? {},
      destroy() {
        destroyed = true;
        entry.responseDestroyed = true;
      },
    });
    const request = Object.assign(new EventEmitter(), {
      destroy(error?: Error) {
        destroyed = true;
        if (error) setImmediate(() => request.emit('error', error));
      },
      end() {
        setImmediate(() => {
          onResponse(response);
          const size = scripted.chunkBytes ?? 64 * 1024;
          for (let offset = 0; offset < scripted.body.length; offset += size) {
            if (destroyed) return;
            const chunk = scripted.body.subarray(offset, offset + size);
            entry.deliveredBytes += chunk.length;
            response.emit('data', chunk);
          }
          if (!destroyed) response.emit('end');
        });
      },
    });
    return request;
  };
  return { implementation, requests };
}
