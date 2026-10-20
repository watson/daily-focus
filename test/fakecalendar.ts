/**
 * Google and Microsoft for tests: their token endpoints, calendars and events,
 * as far as Daily Focus uses them, and a vault that seals by reversing. No
 * account, no network, no keyring.
 */

import { createHash } from 'node:crypto';

import type { OAuthClients } from '../src/calendarproviders.ts';
import type { Vault } from '../src/calendarvault.ts';

export const CLIENTS: OAuthClients = { google: { id: 'google-client', secret: 'google-secret' }, microsoft: { id: 'microsoft-client' } };

/** A vault that seals by reversing, so a test can see the file holds no token as it is. */
export function fakeVault(): Vault & { forgotten: string[] } {
  const forgotten: string[] = [];
  return {
    forgotten,
    seal: async (_account, secret) => `sealed:${[...secret].reverse().join('')}`,
    open: async (_account, sealed) => [...sealed.slice('sealed:'.length)].reverse().join(''),
    forget: async (account) => {
      forgotten.push(account);
    },
  };
}

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Recorded {
  url: URL;
  form: URLSearchParams | null;
  auth: string | null;
}

/**
 * Google and Microsoft as far as these tests need them: token endpoints that
 * check the PKCE verifier against the challenge the sign-in sent, calendars,
 * and today's events.
 */
export function fakeProviders(opts: { googleScopes?: string; rotate?: boolean; day?: string } = {}) {
  const day = opts.day ?? '2026-10-20';
  const calls: Recorded[] = [];
  let refreshFails = false;
  const challenges = new Map<string, string>();
  let issued = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const form = typeof init?.body === 'string' && init.body.includes('=') ? new URLSearchParams(init.body) : null;
    const headers = new Headers(init?.headers);
    calls.push({ url, form, auth: headers.get('authorization') });
    const token = (provider: string) => {
      // As Google does, even for a desktop app using PKCE.
      if (provider === 'google' && form?.get('client_secret') !== 'google-secret') {
        return json({ error: 'invalid_request', error_description: 'client_secret is missing.' }, 400);
      }
      if (form?.get('grant_type') === 'authorization_code') {
        const expected = challenges.get(form.get('code') ?? '');
        const got = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (got !== expected) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
        return json({
          access_token: `${provider}-access-${++issued}`,
          expires_in: 3600,
          refresh_token: `${provider}-refresh-1`,
          scope:
            provider === 'google'
              ? (opts.googleScopes ??
                'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly')
              : 'https://graph.microsoft.com/Calendars.ReadBasic https://graph.microsoft.com/User.Read openid profile email',
          id_token:
            provider === 'google'
              ? jwt({ sub: 'g-123', email: 'robin@personal.example' })
              : jwt({ oid: 'm-456', preferred_username: 'robin@northwind.example' }),
        });
      }
      if (refreshFails) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
      return json({
        access_token: `${provider}-access-${++issued}`,
        expires_in: 3600,
        ...(opts.rotate ? { refresh_token: `${provider}-refresh-${issued}` } : {}),
      });
    };
    if (url.href === 'https://oauth2.googleapis.com/token') return token('google');
    if (url.href === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') return token('microsoft');
    if (url.href === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
    if (url.pathname === '/calendar/v3/users/me/calendarList') {
      return json({ items: [{ id: 'primary@personal.example', summary: 'robin@personal.example', summaryOverride: 'Family' }, { id: 'noisy', summary: 'Noisy' }] });
    }
    if (url.pathname.startsWith('/calendar/v3/calendars/')) {
      return json({
        items: [
          { id: 'e1', iCalUID: 'uid-1@google.com', summary: 'Swimming', start: { dateTime: `${day}T16:00:00` }, end: { dateTime: `${day}T17:00:00` } },
        ],
      });
    }
    if (url.href.startsWith('https://graph.microsoft.com/v1.0/me/calendars?')) return json({ value: [{ id: 'AAMk', name: 'Calendar' }] });
    if (url.pathname.endsWith('/calendarView')) {
      return json({
        value: [
          {
            id: 'x',
            iCalUId: 'uid-2',
            subject: 'Design review',
            start: { dateTime: `${day}T09:00:00.0000000`, timeZone: 'UTC' },
            end: { dateTime: `${day}T10:00:00.0000000`, timeZone: 'UTC' },
            showAs: 'busy',
            responseStatus: { response: 'accepted' },
          },
        ],
      });
    }
    return json({ error: { message: `unexpected ${url.href}` } }, 404);
  }) as typeof globalThis.fetch;
  /** The provider's page, as far as a test needs it: approve, and remember the challenge for the code it hands back. */
  const approve = (authorizeUrl: string, code: string) => {
    const url = new URL(authorizeUrl);
    challenges.set(code, url.searchParams.get('code_challenge') ?? '');
    return { state: url.searchParams.get('state') ?? '', code };
  };
  /** The user revokes the sign-in at the provider: every refresh fails from now on. */
  const revoke = () => {
    refreshFails = true;
  };
  return { fetch, calls, approve, revoke };
}
