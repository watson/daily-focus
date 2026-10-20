/**
 * The apps Daily Focus signs in to Google and Microsoft as, for the live agenda
 * off a Mac (`calendaraccounts.ts`). Registered under support@dailyfocus.dev;
 * the privacy policy and terms they point to are on dailyfocus.dev.
 *
 * A client ID is public by design: every sign-in shows it in the address bar.
 * A desktop app has no secret worth the name either, and both sign-ins use PKCE
 * in its place. A provider without an ID here isn't offered.
 */

import type { OAuthClients } from './calendarproviders.ts';

export const OAUTH_CLIENTS: OAuthClients = {
  google: { id: '764541614043-975bpndfu2pg23eql5rehlsq4vk5l3c8.apps.googleusercontent.com', secret: '' },
  microsoft: { id: '0ee3236b-66aa-47cb-8ec6-cffc8504c175' },
};
