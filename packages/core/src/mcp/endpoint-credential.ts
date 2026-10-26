import type {
  OutboundGetOptions,
  OutboundPostOptions,
  RetrievalResult,
  SafeOutboundClient,
} from '../scanner/outbound-boundary';

/** RFC 6750 b64token: what a bearer credential may contain on the wire. */
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
export const BEARER_TOKEN_MAX_LENGTH = 4096;

export const isBearerToken = (value: string) =>
  value.length <= BEARER_TOKEN_MAX_LENGTH && BEARER_TOKEN.test(value);

/**
 * Adds one bearer credential to POSTs whose URL is exactly `endpoint`.
 * Every other request, and every redirect hop, goes without it. Used only by
 * the CLI for an endpoint and token its user named; hosted inspection never
 * holds a credential.
 */
export class EndpointCredentialClient implements SafeOutboundClient {
  /** True once the credential was attached to at least one request. */
  sent = false;
  /** Set when a credentialed request was redirected; the next hop had no token. */
  redirectedTo?: string;
  readonly endpointHref: string;
  constructor(
    private readonly inner: SafeOutboundClient,
    endpoint: URL,
    private readonly token: string,
  ) {
    if (!isBearerToken(token))
      throw new Error('The credential is not a valid bearer token.');
    this.endpointHref = endpoint.href;
  }

  get(url: URL, options?: OutboundGetOptions): Promise<RetrievalResult> {
    return this.inner.get(url, options);
  }

  async post(url: URL, options: OutboundPostOptions): Promise<RetrievalResult> {
    if (url.href !== this.endpointHref) return this.inner.post(url, options);
    this.sent = true;
    const result = await this.inner.post(url, {
      ...options,
      credentialHeaders: { authorization: `Bearer ${this.token}` },
    });
    if (result.redirects.length) this.redirectedTo ??= result.redirects[0]!.to;
    return result;
  }
}
