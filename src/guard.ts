/**
 * Which requests the server answers at all.
 *
 * The dashboard has no login. Listening on loopback keeps the network out, but
 * not the browser: any page open in it can send requests here, and two kinds
 * would get through.
 *
 *  - A form on another site can POST without asking first, as long as the body
 *    is form-encoded or `text/plain`, and a `text/plain` body can be shaped into
 *    valid JSON. So every POST must say `application/json`, which a page can only
 *    send across origins after a preflight this server never answers. GET and
 *    HEAD stay free of side effects, which is what makes this enough.
 *  - A page can point its own hostname at 127.0.0.1 once it has loaded, and then
 *    read and write here as if it were the dashboard. The browser still sends
 *    that hostname as `Host`, and the page cannot change it, so only names a
 *    stranger can't point here are answered: localhost, IP addresses,
 *    Tailscale's `ts.net` names, and the host the server was told to listen on.
 */

import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

export interface Refusal {
  status: number;
  error: string;
}

/** A `Host` header: a bracketed IPv6 address or a plain name, and an optional port. Nothing else. */
const HOST_HEADER = /^(?:\[([0-9a-f:.]+)\]|([^\s:@/[\]]+))(?::\d{1,5})?$/i;

/** The name in a `Host` header, lowercased, without its port, brackets or trailing dot. Null when it isn't one. */
export function hostnameOf(header: string): string | null {
  const match = HOST_HEADER.exec(header);
  if (!match) return null;
  return (match[1] ?? match[2]!).toLowerCase().replace(/\.$/, '');
}

/** Whether `hostname` is a name no other site can make resolve to this server. */
export function isTrustedHostname(hostname: string, listenHost: string): boolean {
  // A page can only be served from an IP address by whoever holds that address.
  if (isIP(hostname) !== 0) return true;
  // Browsers resolve these to loopback themselves, without asking DNS.
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  // Tailscale assigns every name under ts.net, which is how a second device
  // reaches the dashboard through Tailscale Serve.
  if (hostname.endsWith('.ts.net')) return true;
  return hostname === listenHost.toLowerCase().replace(/\.$/, '');
}

/** Why the server won't answer `req`, or null when it will. */
export function refusal(req: IncomingMessage, listenHost: string): Refusal | null {
  const hostname = hostnameOf(req.headers.host ?? '');
  if (hostname === null || !isTrustedHostname(hostname, listenHost)) {
    return {
      status: 403,
      error:
        `this dashboard answers only to localhost, IP addresses, Tailscale names and DAILY_FOCUS_HOST, ` +
        `and was reached as ${JSON.stringify(req.headers.host ?? '')}`,
    };
  }
  if (req.method === 'POST') {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') return { status: 415, error: 'send this as application/json' };
  }
  return null;
}
