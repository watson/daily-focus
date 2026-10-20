/**
 * Calendar accounts the live agenda reads on a computer without Calendar.app:
 * Google and Microsoft, signed in to from the page.
 *
 * Signing in starts only from a click, and goes through the provider's own page
 * in the browser on this computer: `begin` hands the page the provider's address
 * to go to, the provider sends the browser back to `/oauth/callback` on the
 * dashboard's own port, and that page posts what it was given to `finish`, which
 * trades it for tokens (OAuth with PKCE, as a desktop app does it, with no
 * secret worth the name).
 *
 * What it keeps, in `calendar-accounts.json`: who each account is, and its
 * refresh token sealed by the operating system (`calendarvault.ts`). What it
 * reads is held in memory only, never written down, and never handed to the
 * agent, the assistant or setup's sessions: the privacy policy promises that,
 * and Google's terms for calendar data ask it.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { CalendarListing } from './questions.ts';
import { CalendarHelperError, type CalendarFacts, type RawCalendarEvent } from './calendar.ts';
import {
  adminConsentUrl,
  CALLBACK_PATH,
  OAuthError,
  pkce,
  PROVIDERS,
  randomState,
  type Fetch,
  type OAuthClients,
  type Provider,
} from './calendarproviders.ts';
import { systemVault, type Vault } from './calendarvault.ts';
import { writeJsonAtomic } from './fs.ts';
import { hostnameOf } from './guard.ts';
import type { CalendarAccountsState, CalendarAccountView, CalendarProvider } from './types.ts';

/** How long a sign-in may take in the browser before its start no longer counts. */
const PENDING_MS = 15 * 60_000;

/** Errors that mean the sign-in itself is gone: only connecting again brings it back. */
const SIGNED_OUT = new Set(['invalid_grant', 'interaction_required', 'consent_required', 'unauthorized_client', 'invalid_client']);

interface StoredAccount {
  id: string;
  provider: CalendarProvider;
  email: string;
  connectedAt: string;
  /** The refresh token, as the vault sealed it. */
  token: string;
}

interface Pending {
  provider: CalendarProvider;
  verifier: string;
  redirectUri: string;
  returnTo: string;
  loginHint: string | null;
  expires: number;
}

/** One account's read, kept to stand in when its next one fails. */
interface AccountRead {
  calendars: CalendarFacts['calendars'];
  events: RawCalendarEvent[];
}

/** What the page's callback posts: the provider's answer, as it came back in the address. */
export interface CallbackAnswer {
  state: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}

/** How a sign-in ended, for the callback page to show before it goes back to where it started. */
export interface FinishResult {
  returnTo: string;
  /** The address connected, when it worked. */
  connected?: string;
  error?: string;
  /** For a work account its organisation must approve first: the page an IT admin approves it on. */
  adminUrl?: string;
}

export interface CalendarAccountsDeps {
  fetch?: Fetch;
  /** The vault, or why there is none, asked afresh until there is one. */
  vault?: () => Vault | { unavailable: string };
  platform?: NodeJS.Platform;
  now?: () => Date;
}

/** Whether `hostname` is this computer, which a provider can send the browser back to. */
export function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/** Where to send the browser afterwards: a path on this dashboard, never another site. */
function safeReturn(returnTo: unknown): string {
  return typeof returnTo === 'string' && /^\/(?![/\\])/.test(returnTo) ? returnTo : '/';
}

/** Today in the dashboard's zone, midnight to midnight. */
export function dayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

export class CalendarAccounts {
  readonly #file: string;
  readonly #clients: OAuthClients;
  readonly #onChange: () => void;
  readonly #fetch: Fetch;
  readonly #vaultFor: () => Vault | { unavailable: string };
  readonly #platform: NodeJS.Platform;
  readonly #now: () => Date;

  #accounts: StoredAccount[] = [];
  #vault: Vault | null = null;
  readonly #pending = new Map<string, Pending>();
  readonly #access = new Map<string, { token: string; expiresAt: number }>();
  readonly #refreshing = new Map<string, Promise<string>>();
  readonly #lastGood = new Map<string, AccountRead>();
  readonly #problems = new Map<string, string>();
  /** Writes of the file, one after another, each with the accounts as they are by then. */
  #writes: Promise<void> = Promise.resolve();

  /**
   * `onChange` says only that the page should show something new: a sign-in
   * finished, an account gone, a read that found one needing connecting again.
   * Reading again after a connect is the caller's.
   */
  constructor(file: string, store: string, clients: OAuthClients, onChange: () => void, deps: CalendarAccountsDeps = {}) {
    this.#file = file;
    this.#clients = clients;
    this.#onChange = onChange;
    this.#fetch = deps.fetch ?? fetch;
    this.#platform = deps.platform ?? process.platform;
    this.#vaultFor = deps.vault ?? (() => systemVault(store, this.#platform));
    this.#now = deps.now ?? (() => new Date());
  }

  /** Read the accounts file, forgiving what doesn't parse: an account that can't be read is one to connect again. */
  async load(): Promise<void> {
    if (!this.offered) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.#file, 'utf8'));
    } catch {
      return;
    }
    const list = Array.isArray((raw as { accounts?: unknown } | null)?.accounts) ? ((raw as { accounts: unknown[] }).accounts) : [];
    this.#accounts = list.flatMap((entry) => {
      const account = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
      const { id, provider, email, connectedAt, token } = account;
      return typeof id === 'string' && (provider === 'google' || provider === 'microsoft') && typeof email === 'string' && typeof token === 'string'
        ? [{ id, provider, email, connectedAt: typeof connectedAt === 'string' ? connectedAt : '', token }]
        : [];
    });
  }

  /** Off a Mac, where Calendar.app is read instead. */
  get offered(): boolean {
    return this.#platform !== 'darwin';
  }

  get count(): number {
    return this.#accounts.length;
  }

  /** The providers this copy has an app registered with. */
  #providers(): CalendarProvider[] {
    return (['google', 'microsoft'] as const).filter((name) => this.#clients[name].id !== '');
  }

  /** The vault, found once there is one; until then, why there isn't. */
  #findVault(): Vault | { unavailable: string } {
    if (this.#vault) return this.#vault;
    const found = this.#vaultFor();
    if (!('unavailable' in found)) this.#vault = found;
    return found;
  }

  view(): CalendarAccountsState {
    if (!this.offered) return { offered: false, providers: [], unavailable: null, accounts: [] };
    const vault = this.#findVault();
    return {
      offered: true,
      providers: this.#providers(),
      unavailable: 'unavailable' in vault ? vault.unavailable : null,
      accounts: this.#accounts.map((account): CalendarAccountView => ({
        id: account.id,
        provider: account.provider,
        email: account.email,
        problem: this.#problems.get(account.id) ?? null,
      })),
    };
  }

  /**
   * Start a sign-in: where to send the browser. Only from this computer, since
   * the provider sends it back to this computer's own address. `reconnect`
   * names the account to sign in as again, which the provider's page offers first.
   */
  begin(name: CalendarProvider, host: string, returnTo: unknown, reconnect: string | null = null): string {
    if (!this.offered) throw new Error('on a Mac, the agenda reads Calendar.app instead');
    const provider = PROVIDERS[name];
    if (!this.#providers().includes(name)) throw new Error(`this copy of Daily Focus can’t sign in to ${provider.label}`);
    const vault = this.#findVault();
    if ('unavailable' in vault) throw new Error(vault.unavailable);
    const hostname = hostnameOf(host);
    if (hostname === null || !isLoopback(hostname)) {
      throw new Error(
        `${provider.label} sends you back to the computer Daily Focus runs on, so connect from a browser there, at http://localhost:${portOf(host) ?? 4321}`,
      );
    }
    const now = this.#now().getTime();
    for (const [state, pending] of this.#pending) if (pending.expires < now) this.#pending.delete(state);

    const port = portOf(host);
    const redirectUri = `http://${provider.redirectHost(hostname)}${port ? `:${port}` : ''}${CALLBACK_PATH}`;
    const { verifier, challenge } = pkce();
    const state = randomState();
    const loginHint = reconnect ? (this.#accounts.find((account) => account.id === reconnect)?.email ?? null) : null;
    this.#pending.set(state, { provider: name, verifier, redirectUri, returnTo: safeReturn(returnTo), loginHint, expires: now + PENDING_MS });
    return provider.authorizeUrl({ clientId: this.#clients[name].id, redirectUri, state, challenge, loginHint });
  }

  /**
   * Finish a sign-in with what the provider sent back. Each start is good for
   * one finish: a second, or one nobody started here, is refused, which is what
   * keeps a page elsewhere from finishing a sign-in into this dashboard.
   */
  async finish(answer: CallbackAnswer): Promise<FinishResult> {
    const pending = this.#pending.get(answer.state);
    this.#pending.delete(answer.state);
    if (!pending || pending.expires < this.#now().getTime()) {
      return { returnTo: '/', error: 'This sign-in has expired, or was finished already. Start it again from Daily Focus.' };
    }
    const provider = PROVIDERS[pending.provider];
    const { returnTo } = pending;

    if (answer.error) return { returnTo, ...refusedBy(provider, answer, this.#clients) };
    if (!answer.code) return { returnTo, error: `${provider.label} sent no answer to sign in with. Try connecting again.` };

    const vault = this.#findVault();
    if ('unavailable' in vault) return { returnTo, error: vault.unavailable };

    let tokens;
    try {
      tokens = await provider.exchange(this.#fetch, this.#clients, { code: answer.code, redirectUri: pending.redirectUri, verifier: pending.verifier });
    } catch (err) {
      return { returnTo, error: `${provider.label} wouldn’t complete the sign-in: ${(err as Error).message}` };
    }
    const missing = provider.missing(tokens.scopes);
    if (missing) {
      if (tokens.refresh) await provider.revoke(this.#fetch, tokens.refresh).catch(() => {});
      return { returnTo, error: missing };
    }
    if (!tokens.refresh || !tokens.identity) {
      return { returnTo, error: `${provider.label} didn’t say who signed in, or gave no lasting sign-in. Try connecting again.` };
    }

    const id = `${provider.name}:${tokens.identity.subject}`;
    let sealed: string;
    try {
      sealed = await vault.seal(id, tokens.refresh);
    } catch (err) {
      return { returnTo, error: `The sign-in worked, but couldn’t be kept safely: ${(err as Error).message}` };
    }
    const account: StoredAccount = { id, provider: provider.name, email: tokens.identity.email, connectedAt: this.#now().toISOString(), token: sealed };
    this.#accounts = [...this.#accounts.filter((each) => each.id !== id), account];
    this.#access.set(id, { token: tokens.access, expiresAt: this.#now().getTime() + tokens.expiresIn * 1000 });
    this.#problems.delete(id);
    this.#lastGood.delete(id);
    await this.#save();
    this.#onChange();
    return { returnTo, connected: account.email };
  }

  /**
   * Forget an account: its token from the vault, and everything read from it.
   * Google is asked to revoke the sign-in too; Microsoft offers apps no way to.
   */
  async disconnect(id: string): Promise<void> {
    const account = this.#accounts.find((each) => each.id === id);
    if (!account) return;
    const vault = this.#findVault();
    if (!('unavailable' in vault)) {
      const token = await vault.open(id, account.token).catch(() => null);
      if (token) await PROVIDERS[account.provider].revoke(this.#fetch, token).catch(() => {});
      await vault.forget(id, account.token).catch(() => {});
    }
    this.#accounts = this.#accounts.filter((each) => each.id !== id);
    this.#access.delete(id);
    this.#lastGood.delete(id);
    this.#problems.delete(id);
    await this.#save();
    this.#onChange();
  }

  /** Why no read can happen now, or null. */
  get ready(): string | null {
    if (!this.offered) return 'on a Mac, the agenda reads Calendar.app instead';
    if (this.#accounts.length === 0) return 'No Google or Microsoft calendar is connected. Connect one under Calendar on the settings page.';
    return null;
  }

  /** Every connected account's calendars, for setup and the settings page to tick. */
  async listCalendars(): Promise<CalendarListing[]> {
    const listed = await Promise.all(
      this.#accounts.map(async (account) => {
        const provider = PROVIDERS[account.provider];
        const calendars = await this.#withToken(account, (token) => provider.calendars(this.#fetch, token)).catch((err: unknown) => {
          throw new Error(this.#describe(account, err));
        });
        return calendars.map((calendar) => ({ title: calendar.title, source: account.email, eventsToday: 0 }));
      }),
    );
    return listed.flat();
  }

  /**
   * Today's events on the calendars named, from every account. An account that
   * fails stands in with its last good read and says why; only when none has
   * anything to show does the read fail as a whole.
   */
  async read(names: readonly string[]): Promise<CalendarFacts> {
    const wanted = new Set(names.map((name) => name.trim().toLowerCase()));
    const { start, end } = dayBounds(this.#now());
    const problems: string[] = [];
    const reads = await Promise.all(
      this.#accounts.map(async (account): Promise<AccountRead | null> => {
        const provider = PROVIDERS[account.provider];
        try {
          const calendars = await this.#withToken(account, (token) => provider.calendars(this.#fetch, token));
          const chosen = calendars.filter((calendar) => wanted.has(calendar.title.toLowerCase()));
          const events = await Promise.all(
            chosen.map(async (calendar) =>
              (await this.#withToken(account, (token) => provider.events(this.#fetch, token, calendar.id, start, end))).map((event) => ({
                ...event,
                externalId: opaque(event.externalId),
                calendarId: `${account.id}/${calendar.id}`,
              })),
            ),
          );
          const read: AccountRead = {
            calendars: calendars.map((calendar) => ({ id: `${account.id}/${calendar.id}`, title: calendar.title, source: account.email })),
            events: events.flat(),
          };
          this.#lastGood.set(account.id, read);
          if (this.#problems.delete(account.id)) this.#onChange();
          return read;
        } catch (err) {
          problems.push(this.#describe(account, err));
          return this.#lastGood.get(account.id) ?? null;
        }
      }),
    );
    const found = reads.filter((read): read is AccountRead => read !== null);
    if (found.length === 0 && problems.length > 0) throw new CalendarHelperError(problems.join(' '));
    return {
      generatedAt: this.#now().toISOString(),
      calendars: found.flatMap((read) => read.calendars),
      events: found.flatMap((read) => read.events),
      selfKnown: true,
      ...(problems.length ? { problems } : {}),
    };
  }

  /** A read failure said for the page, kept against the account when it means signing in again. */
  #describe(account: StoredAccount, err: unknown): string {
    const label = `${PROVIDERS[account.provider].label} (${account.email})`;
    if (err instanceof OAuthError && SIGNED_OUT.has(err.code)) {
      const message = `${label} needs connecting again: choose Reconnect under Calendar on the settings page.`;
      if (this.#problems.get(account.id) !== message) {
        this.#problems.set(account.id, message);
        this.#onChange();
      }
      return message;
    }
    return `Couldn’t read ${label}: ${(err as Error).message}.`;
  }

  /** Call the API with a fresh enough token, and once more with a new one if it was refused anyway. */
  async #withToken<T>(account: StoredAccount, call: (token: string) => Promise<T>): Promise<T> {
    try {
      return await call(await this.#token(account));
    } catch (err) {
      if (!(err instanceof OAuthError) || err.code !== 'unauthorized') throw err;
      this.#access.delete(account.id);
      return call(await this.#token(account));
    }
  }

  /**
   * An access token for the account: the one held, until a minute before it
   * runs out, then a new one from the refresh token. One refresh at a time per
   * account: Microsoft hands out a new refresh token with each, and two at once
   * would race to keep theirs.
   */
  #token(account: StoredAccount): Promise<string> {
    const held = this.#access.get(account.id);
    if (held && held.expiresAt - 60_000 > this.#now().getTime()) return Promise.resolve(held.token);
    const under = this.#refreshing.get(account.id);
    if (under) return under;
    const refresh = (async () => {
      const vault = this.#findVault();
      if ('unavailable' in vault) throw new Error(vault.unavailable);
      // A token the vault can't give back is a sign-in gone, as one the provider refuses is.
      const refreshToken = await vault.open(account.id, account.token).catch((err: unknown) => {
        throw new OAuthError('invalid_grant', (err as Error).message);
      });
      const tokens = await PROVIDERS[account.provider].refresh(this.#fetch, this.#clients, refreshToken);
      if (tokens.refresh && tokens.refresh !== refreshToken) {
        const sealed = await vault.seal(account.id, tokens.refresh);
        this.#accounts = this.#accounts.map((each) => (each.id === account.id ? { ...each, token: sealed } : each));
        await this.#save();
      }
      this.#access.set(account.id, { token: tokens.access, expiresAt: this.#now().getTime() + tokens.expiresIn * 1000 });
      return tokens.access;
    })().finally(() => this.#refreshing.delete(account.id));
    this.#refreshing.set(account.id, refresh);
    return refresh;
  }

  #save(): Promise<void> {
    const write = this.#writes.then(() => writeJsonAtomic(this.#file, { accounts: this.#accounts }));
    this.#writes = write.catch(() => {});
    return write;
  }
}

/**
 * An event's ID as the dashboard keeps it: hashed. Dismissing an agenda event
 * writes its ID to the action log, which the morning agent reads, so the ID
 * carries nothing from the calendar. The same invitation seen through two
 * accounts still hashes alike, which is how it is shown once.
 */
function opaque(id: unknown): string | undefined {
  return typeof id === 'string' && id !== '' ? createHash('sha256').update(id).digest('base64url').slice(0, 22) : undefined;
}

function portOf(host: string): string | null {
  return /:(\d{1,5})$/.exec(host)?.[1] ?? null;
}

/** What the provider's refusal means for the user, and for a work account their organisation must approve, where to send their IT admin. */
function refusedBy(provider: Provider, answer: CallbackAnswer, clients: OAuthClients): Omit<FinishResult, 'returnTo'> {
  const description = answer.errorDescription ?? '';
  // Microsoft's word for "an administrator has to approve this first".
  if (provider.name === 'microsoft' && /AADSTS(90094|90095|65001)|admin/i.test(description)) {
    return {
      error:
        'Your organisation needs an IT admin to approve Daily Focus before this account can connect. ' +
        'Send them the link below. Once they have approved it, connect again.',
      adminUrl: adminConsentUrl(clients.microsoft.id),
    };
  }
  if (answer.error === 'access_denied') return { error: 'You didn’t allow access, so nothing was connected.' };
  return { error: `${provider.label} stopped the sign-in: ${description || answer.error}` };
}
