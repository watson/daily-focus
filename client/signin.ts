/**
 * Signing in to GitHub through gh, as the setup screen, the pull request board
 * and Settings show it: a button, then the code to enter on GitHub's device
 * page, until gh says it is done. The server runs gh (`src/ghsignin.ts`); every
 * tab sees the same sign-in, so one started in another tab shows its code here.
 */

import type { JSX } from 'preact';

import type { GitHubSignInState } from '../src/types.ts';
import { el } from './el.ts';
import type { Handlers } from './types.ts';

export function gitHubSignIn(signIn: GitHubSignInState, handlers: Handlers, label = 'Sign in to GitHub'): JSX.Element {
  if (signIn.status === 'waiting' && signIn.code && signIn.url) {
    const { code, url } = signIn;
    return el(
      'div',
      { class: 'signin', role: 'status' },
      el('p', { class: 'signin__lead' }, 'Enter this code on GitHub, then come back here:'),
      el('p', { class: 'signin__code' }, el('code', null, code)),
      el(
        'p',
        { class: 'signin__actions' },
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
        el('button', { type: 'button', class: 'button', onClick: () => handlers.cancelGitHubSignIn() }, 'Cancel'),
      ),
      el('p', { class: 'signin__note' }, 'Waiting for GitHub…'),
    );
  }
  return el(
    'div',
    { class: 'signin' },
    signIn.status === 'failed' && signIn.error
      ? el('p', { class: 'signin__error', role: 'alert' }, `Signing in didn't work: ${signIn.error}`)
      : null,
    el(
      'p',
      { class: 'signin__actions' },
      el(
        'button',
        {
          type: 'button',
          class: 'button',
          disabled: signIn.status === 'starting',
          'aria-busy': String(signIn.status === 'starting'),
          onClick: () => handlers.signInToGitHub(),
        },
        signIn.status === 'starting' ? 'Starting…' : signIn.status === 'failed' ? 'Try again' : label,
      ),
    ),
  );
}
