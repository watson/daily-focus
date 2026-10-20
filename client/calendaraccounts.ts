/**
 * The calendar accounts the live agenda reads off a Mac, on the setup screen's
 * calendar card and under Calendar in Settings: who is connected, and a way to
 * connect Google or Microsoft, to connect one again, or to disconnect it.
 *
 * Connecting goes through the provider's own page in this browser tab and comes
 * back here (`src/calendaraccounts.ts`). Before it does, the panel says what
 * Daily Focus will read and what it will never do with it, and goes on only when
 * the user says to: Google asks for that, right before its consent page, and it
 * is what anyone would want to know at that moment anyway.
 */

import { h, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import type { CalendarAccountsState, CalendarProvider } from '../src/types.ts';
import { el } from './el.ts';
import type { Handlers } from './types.ts';

const NAME: Record<CalendarProvider, string> = { google: 'Google Calendar', microsoft: 'Outlook' };

const MAKER: Record<CalendarProvider, string> = { google: 'Google', microsoft: 'Microsoft' };

const DETAIL: Record<CalendarProvider, string> = {
  google: 'A Google account, personal or work',
  microsoft: 'Outlook.com, or Microsoft 365 at work or school',
};

const PRIVACY_URL = 'https://dailyfocus.dev/privacy/#calendars';

/** A sign-in the user has asked for and not yet confirmed: which provider, and the account it renews. */
interface Asking {
  provider: CalendarProvider;
  reconnect: string | null;
}

export function calendarAccountsView(
  accounts: CalendarAccountsState | undefined,
  handlers: Handlers,
  opts: { returnTo: string; disconnect: boolean },
): JSX.Element | null {
  if (!accounts?.offered) return null;
  return h(Panel, { accounts, handlers, ...opts });
}

function Panel({
  accounts,
  handlers,
  returnTo,
  disconnect,
}: {
  accounts: CalendarAccountsState;
  handlers: Handlers;
  returnTo: string;
  disconnect: boolean;
}): JSX.Element {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (want: Asking) => {
    setBusy(true);
    setError(null);
    try {
      // Leaves the page for the provider's; it comes back to `returnTo`.
      await handlers.connectCalendar(want.provider, returnTo, want.reconnect);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (accounts.unavailable) {
    return el('div', { class: 'calendar-accounts' }, el('p', { class: 'field__note' }, accounts.unavailable));
  }
  if (accounts.providers.length === 0) {
    return el(
      'div',
      { class: 'calendar-accounts' },
      el('p', { class: 'field__note' }, 'This copy of Daily Focus can’t connect a calendar account. The agenda uses the events in the morning brief.'),
    );
  }

  return el(
    'div',
    { class: 'calendar-accounts' },
    accounts.accounts.length
      ? el(
          'ul',
          { class: 'calendar-accounts__list' },
          accounts.accounts.map((account) =>
            el(
              'li',
              { key: account.id, class: 'calendar-accounts__account' },
              el(
                'p',
                null,
                el('strong', { class: 'service-account__name' }, account.email),
                el('span', { class: 'calendar-accounts__provider' }, ` · ${NAME[account.provider]}`),
              ),
              account.problem ? el('p', { class: 'connect__error', role: 'alert' }, account.problem) : null,
              el(
                'p',
                { class: 'connect__actions' },
                account.problem && accounts.providers.includes(account.provider)
                  ? el(
                      'button',
                      { type: 'button', class: 'button', disabled: busy, onClick: () => setAsking({ provider: account.provider, reconnect: account.id }) },
                      'Reconnect',
                    )
                  : null,
                disconnect
                  ? el(
                      'button',
                      { type: 'button', class: 'button', disabled: busy, onClick: () => handlers.disconnectCalendar(account.id) },
                      'Disconnect',
                    )
                  : null,
              ),
            ),
          ),
        )
      : el('p', { class: 'field__note' }, 'Connect the account your calendar is on, and the agenda stays live through the day: a meeting moved or declined shows at once.'),
    asking
      ? el(
          'div',
          { class: 'calendar-accounts__ask', role: 'group', 'aria-label': `Connect ${NAME[asking.provider]}` },
          el(
            'p',
            null,
            `Daily Focus will ask ${MAKER[asking.provider]} to let it read the names of your calendars and today’s events, and nothing else. ` +
              'It uses them only for the agenda here. They stay on this computer, and never go to Claude Code, Codex or any other AI.',
          ),
          asking.provider === 'microsoft'
            ? el('p', { class: 'connect__note' }, 'A work or school account may need your IT admin to approve Daily Focus first.')
            : null,
          el('p', { class: 'connect__note' }, el('a', { href: PRIVACY_URL, target: '_blank', rel: 'noopener' }, 'How Daily Focus handles your calendar')),
          el(
            'p',
            { class: 'connect__actions' },
            el(
              'button',
              { type: 'button', class: 'button button--primary', disabled: busy, onClick: () => void go(asking) },
              busy ? `Opening ${MAKER[asking.provider]}…` : `Continue to ${MAKER[asking.provider]}`,
            ),
            el('button', { type: 'button', class: 'button', disabled: busy, onClick: () => setAsking(null) }, 'Cancel'),
          ),
        )
      : el(
          'div',
          { class: 'calendar-accounts__connect' },
          accounts.providers.map((provider) =>
            el(
              'button',
              { type: 'button', class: 'button', key: provider, title: DETAIL[provider], onClick: () => setAsking({ provider, reconnect: null }) },
              accounts.accounts.some((account) => account.provider === provider) ? `Connect another ${NAME[provider]} account` : `Connect ${NAME[provider]}`,
            ),
          ),
        ),
    error ? el('p', { class: 'connect__error', role: 'alert' }, error) : null,
  );
}
