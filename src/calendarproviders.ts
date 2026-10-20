/**
 * Google Calendar and Microsoft Outlook, as the live agenda reads them on a
 * computer without Calendar.app: how to sign in to each, and how to read today's
 * events from it, turned into the same facts the Mac's helper writes
 * (`calendar.ts`), so everything after the read is shared.
 *
 * Read-only on both, and only what the agenda shows: calendar names, today's
 * events, and the user's own answer to each. Google is asked for attendees'
 * `self` and `responseStatus` alone, so no colleague's address is ever
 * downloaded; Microsoft reports the user's own response on the event.
 *
 * Everything here takes `fetch` from its caller, so the tests run against
 * recorded answers and no account.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { CalendarProvider } from './types.ts';
import type { RawCalendarEvent } from './calendar.ts';

export type Fetch = typeof fetch;

/** The registered apps. Client IDs are public by design: each sign-in shows them in the address bar. */
export interface OAuthClients {
  google: { id: string; secret: string };
  microsoft: { id: string };
}

/** EKParticipantStatus, which `calendar.ts` reads: declined is the one that matters. */
const STATUS = { pending: 1, accepted: 2, declined: 3, tentative: 4 } as const;

/** EKEventAvailability: busy 0, free 1, tentative 2, unavailable 3. */
const AVAILABILITY = { busy: 0, free: 1, tentative: 2, unavailable: 3 } as const;

/** Where the provider's sign-in comes back to, on the dashboard's own port. */
export const CALLBACK_PATH = '/oauth/callback';

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

/** A sign-in's tokens, as either provider's token endpoint gives them. */
export interface Tokens {
  access: string;
  /** How many seconds `access` works for. */
  expiresIn: number;
  /** Absent when a refresh kept the one there was. */
  refresh: string | null;
  /** Who signed in, from the ID token, on a sign-in rather than a refresh. */
  identity: { subject: string; email: string } | null;
  /** The scopes granted, which may be fewer than asked for. */
  scopes: string[];
}

/** One calendar, as listed. */
export interface ProviderCalendar {
  id: string;
  title: string;
}

/** What a provider is, to the accounts that sign in to it. */
export interface Provider {
  name: CalendarProvider;
  label: string;
  /** The host the redirect goes to: Microsoft registers `localhost`; Google takes either. */
  redirectHost(pageHost: string): string;
  authorizeUrl(params: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint: string | null }): string;
  /** Why the scopes granted aren't enough, or null. */
  missing(scopes: readonly string[]): string | null;
  exchange(fetch: Fetch, clients: OAuthClients, params: { code: string; redirectUri: string; verifier: string }): Promise<Tokens>;
  refresh(fetch: Fetch, clients: OAuthClients, refreshToken: string): Promise<Tokens>;
  /** Ask the provider to forget the sign-in, where it lets an app do that. */
  revoke(fetch: Fetch, refreshToken: string): Promise<void>;
  calendars(fetch: Fetch, token: string): Promise<ProviderCalendar[]>;
  /** Today's events on one calendar, between `start` and `end`. */
  events(fetch: Fetch, token: string, calendarId: string, start: Date, end: Date): Promise<RawCalendarEvent[]>;
}

/* ---------- PKCE ---------- */

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function randomState(): string {
  return base64url(randomBytes(24));
}

/* ---------- shared ---------- */

/**
 * The claims in an ID token. Not verified, and it needn't be: it came straight
 * from the provider's token endpoint over TLS, in answer to our own request,
 * which is the case OpenID Connect allows to skip the signature.
 */
export function idClaims(idToken: unknown): Record<string, unknown> {
  if (typeof idToken !== 'string') return {};
  const payload = idToken.split('.')[1];
  if (!payload) return {};
  try {
    const value: unknown = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

async function tokenRequest(fetch: Fetch, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new OAuthError(text(body.error) ?? `http_${res.status}`, text(body.error_description) ?? `the sign-in service answered ${res.status}`);
  }
  return body;
}

function tokensFrom(body: Record<string, unknown>, identity: (claims: Record<string, unknown>) => Tokens['identity']): Tokens {
  const access = text(body.access_token);
  if (!access) throw new OAuthError('no_token', 'the sign-in service sent no access token');
  return {
    access,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in) || 3600,
    refresh: text(body.refresh_token),
    identity: body.id_token ? identity(idClaims(body.id_token)) : null,
    scopes: (text(body.scope) ?? '').split(/\s+/).filter(Boolean),
  };
}

/** A GET to a calendar API with the account's token, as JSON. */
async function getJson(fetch: Fetch, url: string, token: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = (body.error ?? {}) as Record<string, unknown>;
    const message = text(error.message) ?? text(body.error_description) ?? `the calendar answered ${res.status}`;
    // A token refused here is one to get again, as a failed refresh is.
    throw new OAuthError(res.status === 401 ? 'unauthorized' : `http_${res.status}`, message);
  }
  return body;
}

/** `YYYY-MM-DD` as local midnight, with no offset, which `calendar.ts` reads as the dashboard's day. */
function localMidnight(date: string): string {
  return `${date}T00:00:00`;
}

/* ---------- Google ---------- */

const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';

/** Only what the agenda shows: attendees narrowed to the user's own answer, so no one else's address comes down. */
const GOOGLE_EVENT_FIELDS =
  'items(id,iCalUID,summary,status,start,end,transparency,hangoutLink,attendees(self,responseStatus),conferenceData/entryPoints(entryPointType,uri)),nextPageToken';

export const google: Provider = {
  name: 'google',
  label: 'Google',
  redirectHost: (pageHost) => (pageHost === 'localhost' ? 'localhost' : '127.0.0.1'),
  authorizeUrl({ clientId, redirectUri, state, challenge, loginHint }) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: ['openid', 'email', ...GOOGLE_CALENDAR_SCOPES].join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // A refresh token every time, a reconnect included, which Google otherwise gives only on first consent.
      access_type: 'offline',
      prompt: 'consent',
      ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();
    return url.toString();
  },
  missing(scopes) {
    return GOOGLE_CALENDAR_SCOPES.every((scope) => scopes.includes(scope))
      ? null
      : 'Google didn’t grant both calendar permissions. Connect again and leave both ticked: one lists your calendars, the other reads their events.';
  },
  async exchange(fetch, clients, { code, redirectUri, verifier }) {
    const body = await tokenRequest(fetch, 'https://oauth2.googleapis.com/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clients.google.id,
      code_verifier: verifier,
      ...(clients.google.secret ? { client_secret: clients.google.secret } : {}),
    });
    return tokensFrom(body, googleIdentity);
  },
  async refresh(fetch, clients, refreshToken) {
    const body = await tokenRequest(fetch, 'https://oauth2.googleapis.com/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clients.google.id,
      ...(clients.google.secret ? { client_secret: clients.google.secret } : {}),
    });
    return tokensFrom(body, googleIdentity);
  },
  async revoke(fetch, refreshToken) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  },
  async calendars(fetch, token) {
    const found: ProviderCalendar[] = [];
    let page: string | null = null;
    do {
      const url = new URL(`${GOOGLE_API}/users/me/calendarList`);
      url.search = new URLSearchParams({
        maxResults: '250',
        fields: 'items(id,summary,summaryOverride),nextPageToken',
        ...(page ? { pageToken: page } : {}),
      }).toString();
      const body = await getJson(fetch, url.toString(), token);
      for (const raw of Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : []) {
        const id = text(raw.id);
        // The name the user gave it in Google Calendar, where they renamed one shared with them.
        const title = text(raw.summaryOverride) ?? text(raw.summary);
        if (id && title) found.push({ id, title });
      }
      page = text(body.nextPageToken);
    } while (page);
    return found;
  },
  async events(fetch, token, calendarId, start, end) {
    const found: RawCalendarEvent[] = [];
    let page: string | null = null;
    do {
      const url = new URL(`${GOOGLE_API}/calendars/${encodeURIComponent(calendarId)}/events`);
      url.search = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        fields: GOOGLE_EVENT_FIELDS,
        ...(page ? { pageToken: page } : {}),
      }).toString();
      const body = await getJson(fetch, url.toString(), token);
      for (const raw of Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : []) {
        const event = googleEvent(raw);
        if (event) found.push(event);
      }
      page = text(body.nextPageToken);
    } while (page);
    return found;
  },
};

function googleIdentity(claims: Record<string, unknown>): Tokens['identity'] {
  const subject = text(claims.sub);
  const email = text(claims.email);
  return subject && email ? { subject, email } : null;
}

const GOOGLE_RESPONSE: Record<string, number> = {
  needsAction: STATUS.pending,
  accepted: STATUS.accepted,
  declined: STATUS.declined,
  tentative: STATUS.tentative,
};

/** One Google event as the helper would have written it; null for a cancelled one. */
export function googleEvent(raw: Record<string, unknown>): RawCalendarEvent | null {
  if (raw.status === 'cancelled') return null;
  const start = (raw.start ?? {}) as Record<string, unknown>;
  const end = (raw.end ?? {}) as Record<string, unknown>;
  const allDay = text(start.date) !== null;
  const event: RawCalendarEvent = {
    // The invitation's own UID: the same event seen through two accounts is one.
    externalId: text(raw.iCalUID) ?? text(raw.id),
    title: text(raw.summary) ?? '',
    start: allDay ? localMidnight(text(start.date)!) : text(start.dateTime),
    end: allDay ? (text(end.date) ? localMidnight(text(end.date)!) : null) : text(end.dateTime),
    allDay,
    availability: raw.transparency === 'transparent' ? AVAILABILITY.free : AVAILABILITY.busy,
  };
  const self = Array.isArray(raw.attendees)
    ? (raw.attendees as Record<string, unknown>[]).find((attendee) => attendee.self === true)
    : undefined;
  const response = self ? GOOGLE_RESPONSE[String(self.responseStatus)] : undefined;
  if (response !== undefined) event.selfStatus = response;
  const video = Array.isArray((raw.conferenceData as Record<string, unknown> | undefined)?.entryPoints)
    ? ((raw.conferenceData as Record<string, unknown>).entryPoints as Record<string, unknown>[]).find((entry) => entry.entryPointType === 'video')
    : undefined;
  const url = text(raw.hangoutLink) ?? text(video?.uri);
  if (url) event.url = url;
  return event;
}

/* ---------- Microsoft ---------- */

const MICROSOFT_LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';

const MICROSOFT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Calendars.ReadBasic',
];

const GRAPH = 'https://graph.microsoft.com/v1.0';

const MICROSOFT_EVENT_FIELDS = 'id,iCalUId,subject,start,end,isAllDay,showAs,isCancelled,responseStatus,onlineMeeting';

/**
 * Where an IT admin approves Daily Focus for their whole organisation: what a
 * work account's user needs when their organisation lets no one approve apps
 * for themselves, which is Microsoft's default for calendar access.
 */
export function adminConsentUrl(clientId: string): string {
  const url = new URL('https://login.microsoftonline.com/organizations/v2.0/adminconsent');
  url.search = new URLSearchParams({
    client_id: clientId,
    scope: 'https://graph.microsoft.com/Calendars.ReadBasic https://graph.microsoft.com/User.Read',
    redirect_uri: `http://localhost${CALLBACK_PATH}`,
  }).toString();
  return url.toString();
}

export const microsoft: Provider = {
  name: 'microsoft',
  label: 'Microsoft',
  // The one registered for every port: Microsoft ignores the port of a localhost redirect.
  redirectHost: () => 'localhost',
  authorizeUrl({ clientId, redirectUri, state, challenge, loginHint }) {
    const url = new URL(`${MICROSOFT_LOGIN}/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: MICROSOFT_SCOPES.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
      ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();
    return url.toString();
  },
  missing(scopes) {
    return scopes.some((scope) => /(^|\/)Calendars\.Read(Basic)?$/i.test(scope))
      ? null
      : 'Microsoft didn’t grant calendar access. Connect again and accept it.';
  },
  async exchange(fetch, clients, { code, redirectUri, verifier }) {
    const body = await tokenRequest(fetch, `${MICROSOFT_LOGIN}/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clients.microsoft.id,
      code_verifier: verifier,
      scope: MICROSOFT_SCOPES.join(' '),
    });
    return tokensFrom(body, microsoftIdentity);
  },
  async refresh(fetch, clients, refreshToken) {
    const body = await tokenRequest(fetch, `${MICROSOFT_LOGIN}/token`, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clients.microsoft.id,
      scope: MICROSOFT_SCOPES.join(' '),
    });
    return tokensFrom(body, microsoftIdentity);
  },
  // Microsoft has no way for an app to revoke its own sign-in: forgetting the token is all there is.
  async revoke() {},
  async calendars(fetch, token) {
    const found: ProviderCalendar[] = [];
    let next: string | null = `${GRAPH}/me/calendars?$select=id,name&$top=100`;
    while (next) {
      const body = await getJson(fetch, next, token);
      for (const raw of Array.isArray(body.value) ? (body.value as Record<string, unknown>[]) : []) {
        const id = text(raw.id);
        const title = text(raw.name);
        if (id && title) found.push({ id, title });
      }
      next = text(body['@odata.nextLink']);
    }
    return found;
  },
  async events(fetch, token, calendarId, start, end) {
    const found: RawCalendarEvent[] = [];
    const first = new URL(`${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/calendarView`);
    first.search = new URLSearchParams({
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      $select: MICROSOFT_EVENT_FIELDS,
      $top: '100',
    }).toString();
    let next: string | null = first.toString();
    while (next) {
      // Times in UTC, so they read the same whichever zone the mailbox is set to.
      const body = await getJson(fetch, next, token, { prefer: 'outlook.timezone="UTC"' });
      for (const raw of Array.isArray(body.value) ? (body.value as Record<string, unknown>[]) : []) {
        const event = microsoftEvent(raw);
        if (event) found.push(event);
      }
      next = text(body['@odata.nextLink']);
    }
    return found;
  },
};

function microsoftIdentity(claims: Record<string, unknown>): Tokens['identity'] {
  const subject = text(claims.oid) ?? text(claims.sub);
  const email = text(claims.email) ?? text(claims.preferred_username);
  return subject && email ? { subject, email } : null;
}

const MICROSOFT_SHOW_AS: Record<string, number> = {
  free: AVAILABILITY.free,
  // A day marked as working from somewhere else is the user's to fill, as a free one is.
  workingElsewhere: AVAILABILITY.free,
  tentative: AVAILABILITY.tentative,
  busy: AVAILABILITY.busy,
  oof: AVAILABILITY.unavailable,
};

const MICROSOFT_RESPONSE: Record<string, number> = {
  notResponded: STATUS.pending,
  accepted: STATUS.accepted,
  organizer: STATUS.accepted,
  tentativelyAccepted: STATUS.tentative,
  declined: STATUS.declined,
};

/** A Graph time in UTC, as `Date` reads it: Graph gives seven decimals and no zone. */
function graphUtc(value: unknown): Date | null {
  const raw = text((value as Record<string, unknown> | undefined)?.dateTime);
  if (!raw) return null;
  const date = new Date(`${raw.replace(/(\.\d{3})\d+/, '$1').replace(/Z$/, '')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The date an all-day event is on. Graph stores it as midnight in the zone it
 * was made in and hands it back in UTC, so it is the nearest UTC midnight: right
 * for every zone within twelve hours of UTC.
 */
function allDayDate(when: Date): string {
  const nearest = new Date(Math.round(when.getTime() / 86_400_000) * 86_400_000);
  return nearest.toISOString().slice(0, 10);
}

/** One Outlook event as the helper would have written it; null for a cancelled one. */
export function microsoftEvent(raw: Record<string, unknown>): RawCalendarEvent | null {
  if (raw.isCancelled === true) return null;
  const start = graphUtc(raw.start);
  const end = graphUtc(raw.end);
  if (!start) return null;
  const allDay = raw.isAllDay === true;
  const event: RawCalendarEvent = {
    externalId: text(raw.iCalUId) ?? text(raw.id),
    title: text(raw.subject) ?? '',
    start: allDay ? localMidnight(allDayDate(start)) : start.toISOString(),
    end: end ? (allDay ? localMidnight(allDayDate(end)) : end.toISOString()) : null,
    allDay,
    availability: MICROSOFT_SHOW_AS[String(raw.showAs)] ?? -1,
  };
  const response = MICROSOFT_RESPONSE[String((raw.responseStatus as Record<string, unknown> | undefined)?.response)];
  if (response !== undefined) event.selfStatus = response;
  const url = text((raw.onlineMeeting as Record<string, unknown> | undefined)?.joinUrl);
  if (url) event.url = url;
  return event;
}

export const PROVIDERS: Record<CalendarProvider, Provider> = { google, microsoft };
