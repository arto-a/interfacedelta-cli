import { request as httpsRequest, type RequestOptions } from 'node:https';
import type {
  LookupAddress,
  LookupAllOptions,
  LookupOneOptions,
} from 'node:dns';
import type {
  DiscoveryErrorCode,
  RedirectObservation,
} from '@interfacedelta/contracts';
import {
  parsePublicHttpsOrigin,
  systemResolver,
  TargetPolicyError,
  validateAndResolve,
  type ResolvedAddress,
  type Resolver,
} from './target-policy';

export const OUTBOUND_LIMITS = {
  timeoutMs: 5_000,
  maxRedirects: 3,
  maxBodyBytes: 256 * 1024,
  /**
   * How much of an oversized non-2xx body is kept. The status is the
   * observation; the body is context, and nothing parses a truncated one.
   */
  maxErrorBodyPrefixBytes: 64 * 1024,
} as const;

export interface RetrievedDocument {
  readonly ok: true;
  readonly body: Buffer;
  readonly httpStatus: number;
  readonly contentType?: string;
  readonly finalUrl: string;
  readonly durationMs: number;
  readonly redirects: readonly RedirectObservation[];
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Set when a non-2xx body exceeded the byte limit and only its first bytes were kept. */
  readonly truncated?: true;
}
export interface RetrievalFailure {
  readonly ok: false;
  readonly code: DiscoveryErrorCode;
  readonly message: string;
  readonly httpStatus?: number;
  readonly finalUrl?: string;
  readonly contentType?: string;
  readonly durationMs: number;
  readonly redirects: readonly RedirectObservation[];
}
export type RetrievalResult = RetrievedDocument | RetrievalFailure;
export interface OutboundPostOptions {
  readonly redirect?: 'reject';
  /** Delivery acceptance only; inspection failures retain their canonical evidence shape. */
  readonly retainOversizedResponseStatus?: boolean;
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Sent on the first request only and dropped on every redirect, so a
   * credential never follows a Location header. Hosted inspection never sets it.
   */
  readonly credentialHeaders?: Readonly<Record<string, string>>;
  readonly maxBodyBytes: number;
  readonly stopAfterBody?: (body: Buffer, contentType?: string) => boolean;
}
export interface OutboundGetOptions {
  readonly maxBodyBytes?: number;
  readonly accept?: string;
  readonly initialRequestKind?: 'robots' | 'protocol';
}
export interface SafeOutboundClient {
  get(url: URL, options?: OutboundGetOptions): Promise<RetrievalResult>;
  post(url: URL, options: OutboundPostOptions): Promise<RetrievalResult>;
}

export type OutboundRequestKind = 'robots' | 'protocol' | 'redirect';
export type OutboundRequestAuthorization = { readonly requestId: string };
export interface OutboundRequestBoundary {
  beforeRequest(input: {
    readonly url: URL;
    readonly method: 'GET' | 'POST';
    readonly kind: OutboundRequestKind;
  }): Promise<OutboundRequestAuthorization>;
  afterRequest(input: {
    readonly authorization: OutboundRequestAuthorization;
    readonly url: URL;
    readonly result:
      | {
          readonly outcome: 'response';
          readonly status: number;
          readonly bytes: number;
        }
      | { readonly outcome: 'error'; readonly errorCode: string };
  }): Promise<void>;
}
export class OutboundPolicyError extends Error {
  constructor(
    readonly reasonCode: string,
    message = 'Discovery outbound policy refused the request.',
  ) {
    super(message);
    this.name = 'OutboundPolicyError';
  }
}
export interface ConstrainedHttpsClientOptions {
  readonly userAgent?: string;
  readonly boundary?: OutboundRequestBoundary;
}

export type Transport = (
  url: URL,
  options: RequestOptions,
  maxBytes: number,
  timeoutMs: number,
  body?: Buffer,
  stopAfterBody?: (body: Buffer, contentType?: string) => boolean,
) => Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated?: boolean;
}>;

const nodeTransport: Transport = (
  url,
  options,
  maxBytes,
  timeoutMs,
  body,
  stopAfterBody,
) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const request = httpsRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        const status = response.statusCode ?? 0;
        if (bytes > maxBytes && status >= 200 && status < 300) {
          request.destroy(
            Object.assign(new Error('Response exceeds the byte limit.'), {
              code: 'RESPONSE_TOO_LARGE',
              httpStatus: status,
            }),
          );
        } else if (bytes > maxBytes) {
          // A non-2xx status is the observation; its body (often a large HTML
          // error page) is context only, so keep a short prefix and stop.
          chunks.push(chunk);
          settled = true;
          clearTimeout(deadline);
          resolve({
            status,
            headers: response.headers,
            // concat with a total length copies only the prefix, so the
            // buffered remainder can be released.
            body: Buffer.concat(
              chunks,
              Math.min(maxBytes, OUTBOUND_LIMITS.maxErrorBodyPrefixBytes),
            ),
            truncated: true,
          });
          response.destroy();
          request.destroy();
        } else {
          chunks.push(chunk);
          const buffered = Buffer.concat(chunks);
          const contentType = Array.isArray(response.headers['content-type'])
            ? response.headers['content-type'][0]
            : response.headers['content-type'];
          if (stopAfterBody?.(buffered, contentType)) {
            settled = true;
            clearTimeout(deadline);
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: buffered,
            });
            response.destroy();
            request.destroy();
          }
        }
      });
      response.on('end', () => {
        settled = true;
        clearTimeout(deadline);
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    const deadline = setTimeout(
      () =>
        request.destroy(
          Object.assign(new Error('Request timed out.'), { code: 'TIMEOUT' }),
        ),
      timeoutMs,
    );
    request.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        reject(error);
      }
    });
    request.end(body);
  });

async function beforeDeadline<T>(
  operation: Promise<T>,
  remainingMs: number,
): Promise<T> {
  if (remainingMs <= 0)
    throw Object.assign(new Error('Request timed out.'), { code: 'TIMEOUT' });
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('Request timed out.'), {
                code: 'TIMEOUT',
              }),
            ),
          remainingMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function pinnedLookup(
  addresses: readonly ResolvedAddress[],
): NonNullable<RequestOptions['lookup']> {
  return ((
    _: string,
    options: LookupOneOptions | LookupAllOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    if ('all' in options && options.all)
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family })),
      );
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  }) as NonNullable<RequestOptions['lookup']>;
}

export class ConstrainedHttpsClient implements SafeOutboundClient {
  constructor(
    private readonly resolver: Resolver = systemResolver,
    private readonly transport: Transport = nodeTransport,
    private readonly options: ConstrainedHttpsClientOptions = {},
  ) {}

  async get(
    initialUrl: URL,
    options: OutboundGetOptions = {},
  ): Promise<RetrievalResult> {
    return this.perform(
      initialUrl,
      'GET',
      undefined,
      options.accept ? { accept: options.accept } : {},
      options.maxBodyBytes ?? OUTBOUND_LIMITS.maxBodyBytes,
      undefined,
      options.initialRequestKind ?? 'protocol',
    );
  }

  async post(
    initialUrl: URL,
    options: OutboundPostOptions,
  ): Promise<RetrievalResult> {
    return this.perform(
      initialUrl,
      'POST',
      options.body,
      options.headers,
      options.maxBodyBytes,
      options.stopAfterBody,
      'protocol',
      options.credentialHeaders,
      options.redirect,
      options.retainOversizedResponseStatus,
    );
  }

  private async perform(
    initialUrl: URL,
    method: 'GET' | 'POST',
    body: Buffer | undefined,
    additionalHeaders: Readonly<Record<string, string>>,
    maxBodyBytes: number,
    stopAfterBody?: (body: Buffer, contentType?: string) => boolean,
    initialRequestKind: 'robots' | 'protocol' = 'protocol',
    credentialHeaders: Readonly<Record<string, string>> = {},
    redirect?: 'reject',
    retainOversizedResponseStatus = false,
  ): Promise<RetrievalResult> {
    const started = performance.now();
    const redirects: RedirectObservation[] = [];
    let current = initialUrl;
    const requestHeaders = { ...additionalHeaders };
    for (let count = 0; count <= OUTBOUND_LIMITS.maxRedirects; count += 1) {
      let authorization: OutboundRequestAuthorization | undefined;
      try {
        authorization = await this.options.boundary?.beforeRequest({
          url: current,
          method,
          kind: count === 0 ? initialRequestKind : 'redirect',
        });
      } catch (error) {
        const limited = error instanceof OutboundPolicyError;
        return {
          ok: false,
          code: limited ? 'DISCOVERY_POLICY_LIMITED' : 'CONNECTION_ERROR',
          message:
            error instanceof Error
              ? error.message
              : 'Outbound request refused.',
          finalUrl: current.href,
          durationMs: Math.round(performance.now() - started),
          redirects,
        };
      }
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await beforeDeadline(
          validateAndResolve(current, this.resolver),
          OUTBOUND_LIMITS.timeoutMs - (performance.now() - started),
        );
      } catch (error) {
        if (authorization)
          await this.options.boundary!.afterRequest({
            authorization,
            url: current,
            result: {
              outcome: 'error',
              errorCode: (error as NodeJS.ErrnoException).code ?? 'DNS_ERROR',
            },
          });
        if ((error as NodeJS.ErrnoException).code === 'TIMEOUT')
          return {
            ok: false,
            code: 'TIMEOUT',
            message: 'Request timed out.',
            finalUrl: current.href,
            durationMs: Math.round(performance.now() - started),
            redirects,
          };
        const blocked = error instanceof TargetPolicyError;
        return {
          ok: false,
          code: blocked ? 'TARGET_BLOCKED' : 'DNS_ERROR',
          message:
            error instanceof Error ? error.message : 'DNS resolution failed.',
          finalUrl: current.href,
          durationMs: Math.round(performance.now() - started),
          redirects,
        };
      }
      try {
        const response = await this.transport(
          current,
          {
            method,
            lookup: pinnedLookup(addresses),
            servername: current.hostname,
            headers: {
              accept: 'application/json',
              'accept-encoding': 'identity',
              'user-agent': this.options.userAgent ?? 'InterfaceDelta/0.1',
              ...requestHeaders,
              ...(count === 0 ? credentialHeaders : {}),
            },
          },
          maxBodyBytes,
          Math.max(
            1,
            OUTBOUND_LIMITS.timeoutMs - (performance.now() - started),
          ),
          body,
          stopAfterBody,
        );
        // robots.txt decides crawl permission, so it stays fail-closed: an
        // oversized robots response is RESPONSE_TOO_LARGE whatever its status.
        if (response.truncated && initialRequestKind === 'robots')
          throw Object.assign(new Error('Response exceeds the byte limit.'), {
            code: 'RESPONSE_TOO_LARGE',
          });
        if (authorization)
          await this.options.boundary!.afterRequest({
            authorization,
            url: current,
            result: {
              outcome: 'response',
              status: response.status,
              bytes: response.body.length,
            },
          });
        const location = Array.isArray(response.headers.location)
          ? response.headers.location[0]
          : response.headers.location;
        if (
          redirect === 'reject' &&
          response.status >= 300 &&
          response.status < 400
        )
          return {
            ok: true,
            body: response.body,
            httpStatus: response.status,
            headers: {},
            finalUrl: current.href,
            durationMs: Math.round(performance.now() - started),
            redirects,
          };
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          if (count === OUTBOUND_LIMITS.maxRedirects)
            return {
              ok: false,
              code: 'REDIRECT_LIMIT',
              message: 'Redirect limit exceeded.',
              httpStatus: response.status,
              finalUrl: current.href,
              durationMs: Math.round(performance.now() - started),
              redirects,
            };
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return {
              ok: false,
              code: 'REDIRECT_LOCATION_INVALID',
              message: 'Redirect Location is invalid.',
              httpStatus: response.status,
              finalUrl: current.href,
              durationMs: Math.round(performance.now() - started),
              redirects,
            };
          }
          redirects.push({
            from: current.href,
            to: next.href,
            httpStatus: response.status,
          });
          if (next.origin !== current.origin)
            delete requestHeaders['mcp-session-id'];
          current = next;
          continue;
        }
        const encoding = Array.isArray(response.headers['content-encoding'])
          ? response.headers['content-encoding'][0]
          : response.headers['content-encoding'];
        if (encoding && encoding !== 'identity')
          return {
            ok: false,
            code: 'UNSUPPORTED_CONTENT_ENCODING',
            message: 'Compressed responses are not accepted.',
            httpStatus: response.status,
            finalUrl: current.href,
            durationMs: Math.round(performance.now() - started),
            redirects,
          };
        const headers = Object.fromEntries(
          Object.entries(response.headers).map(([name, value]) => [
            name.toLowerCase(),
            Array.isArray(value) ? value.join(', ') : value,
          ]),
        );
        return {
          ok: true,
          body: response.body,
          httpStatus: response.status,
          contentType: headers['content-type'],
          headers,
          finalUrl: current.href,
          durationMs: Math.round(performance.now() - started),
          redirects,
          ...(response.truncated ? { truncated: true as const } : {}),
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (authorization)
          await this.options.boundary!.afterRequest({
            authorization,
            url: current,
            result: {
              outcome: 'error',
              errorCode: code ?? 'CONNECTION_ERROR',
            },
          });
        return {
          ok: false,
          ...(retainOversizedResponseStatus &&
          code === 'RESPONSE_TOO_LARGE' &&
          typeof (error as { httpStatus?: number }).httpStatus === 'number'
            ? { httpStatus: (error as { httpStatus: number }).httpStatus }
            : {}),
          code:
            code === 'TIMEOUT'
              ? 'TIMEOUT'
              : code === 'RESPONSE_TOO_LARGE'
                ? 'RESPONSE_TOO_LARGE'
                : 'CONNECTION_ERROR',
          message:
            code === 'TIMEOUT'
              ? 'Request timed out.'
              : code === 'RESPONSE_TOO_LARGE'
                ? 'Response exceeds the byte limit.'
                : 'HTTPS request failed.',
          finalUrl: current.href,
          durationMs: Math.round(performance.now() - started),
          redirects,
        };
      }
    }
    throw new Error('Unreachable redirect state');
  }
}

export function discoveryUrl(origin: URL, path: string): URL {
  return new URL(path, parsePublicHttpsOrigin(origin.href));
}
