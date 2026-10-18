/**
 * Connecting GitHub or Jira, as the setup screen, the boards and Settings show
 * it: a button, then what is happening (the CLI being fetched, the code to enter
 * on GitHub, the browser to finish in), until it is connected. The server does
 * the work (`src/connect.ts`); every tab sees the same connection, so one started
 * in another tab shows its progress here.
 */

import type { JSX } from 'preact';

import type { ConnectionState, Service } from '../src/types.ts';
import { el } from './el.ts';
import type { Handlers } from './types.ts';

export const SERVICE_NAME: Record<Service, string> = { github: 'GitHub', jira: 'Jira' };

const CLI_NAME: Record<Service, string> = { github: 'the GitHub CLI', jira: 'the Atlassian CLI' };

const MAKER: Record<Service, string> = { github: 'GitHub', jira: 'Atlassian' };

export function connectionView(
  service: Service,
  connection: ConnectionState,
  handlers: Handlers,
  { label = `Connect ${SERVICE_NAME[service]}`, again = false }: { label?: string; again?: boolean } = {},
): JSX.Element {
  const cancel = el('button', { type: 'button', class: 'button', onClick: () => handlers.cancelConnect(service) }, 'Cancel');

  if (connection.status === 'fetching' || connection.status === 'starting') {
    return el(
      'div',
      { class: 'connect', role: 'status' },
      el(
        'p',
        { class: 'connect__lead connect__busy' },
        connection.status === 'fetching' ? `Getting ${CLI_NAME[service]} from ${MAKER[service]}…` : `Connecting ${SERVICE_NAME[service]}…`,
      ),
      el('p', { class: 'connect__actions' }, cancel),
    );
  }

  if (connection.status === 'waiting' && service === 'github' && connection.code && connection.url) {
    const { code, url } = connection;
    return el(
      'div',
      { class: 'connect', role: 'status' },
      el('p', { class: 'connect__lead' }, 'Enter this code on GitHub, then come back here:'),
      el('p', { class: 'connect__code' }, el('code', null, code)),
      el(
        'p',
        { class: 'connect__actions' },
        el(
          'button',
          {
            type: 'button',
            class: 'button button--primary',
            // Opened by the click itself, which a browser lets through.
            onClick: () => {
              handlers.copy(code);
              window.open(url, '_blank', 'noopener');
            },
          },
          'Copy the code and open GitHub',
        ),
        cancel,
      ),
    );
  }

  if (connection.status === 'waiting') {
    return el(
      'div',
      { class: 'connect', role: 'status' },
      el('p', { class: 'connect__lead connect__busy' }, `Finish in the ${MAKER[service]} page that opened in your browser, then come back here.`),
      el('p', { class: 'connect__note' }, 'It has to be the browser on this computer.'),
      el('p', { class: 'connect__actions' }, cancel),
    );
  }

  return el(
    'div',
    { class: 'connect' },
    connection.status === 'failed' && connection.error
      ? el('p', { class: 'connect__error', role: 'alert' }, `That didn’t work: ${connection.error}`)
      : null,
    connection.status === 'failed' && connection.command
      ? el(
          'div',
          { class: 'connect__command' },
          el('p', { class: 'connect__note' }, 'You can finish in a terminal instead:'),
          el('pre', null, el('code', null, connection.command)),
        )
      : null,
    el(
      'p',
      { class: 'connect__actions' },
      el(
        'button',
        { type: 'button', class: 'button', onClick: () => handlers.connect(service, again) },
        connection.status === 'failed' ? 'Try again' : label,
      ),
    ),
  );
}

/** Whether a connection is at work, which shows it even where its button wouldn't be. */
export function connecting(connection: ConnectionState | undefined): boolean {
  return connection !== undefined && ['fetching', 'starting', 'waiting'].includes(connection.status);
}
