/**
 * The apps Daily Focus signs in to Google and Microsoft as, for the live agenda
 * off a Mac (`calendaraccounts.ts`). Registered under support@dailyfocus.dev;
 * the privacy policy and terms they point to are on dailyfocus.dev.
 *
 * A client ID is public by design: every sign-in shows it in the address bar.
 * Google also insists on its client secret, though it calls an installed app's
 * secret no secret at all, and both sign-ins use PKCE. Its policy still says
 * never to commit one, so the package build writes it in from
 * `GOOGLE_CLIENT_SECRET` (`scripts/package.ts`), which the Release workflow
 * has. Run from a checkout, there is none, and Google isn't offered.
 */

import type { OAuthClients } from './calendarproviders.ts';

/** Replaced with the secret by the package build; undeclared when run from source. */
declare const __GOOGLE_CLIENT_SECRET__: string | undefined;

export const OAUTH_CLIENTS: OAuthClients = {
  google: {
    id: '764541614043-975bpndfu2pg23eql5rehlsq4vk5l3c8.apps.googleusercontent.com',
    secret: typeof __GOOGLE_CLIENT_SECRET__ === 'string' ? __GOOGLE_CLIENT_SECRET__ : '',
  },
  microsoft: { id: '0ee3236b-66aa-47cb-8ec6-cffc8504c175' },
};
