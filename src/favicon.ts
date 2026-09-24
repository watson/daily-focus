import type { Profile } from './config.ts';

/**
 * The tab icon for each profile: a blue briefcase for work, a green house for
 * personal.
 *
 * A pinned tab shows nothing but its icon, so the two instances differ in shape as
 * well as colour; colour alone was too subtle at a glance. Both are solid
 * silhouettes, with the latch and the door cut out rather than drawn in white, so
 * they hold up at 16 pixels on a light or dark tab bar.
 */
const FAVICONS: Record<Profile, string> = {
  work:
    `<path d="M34 30V20a8 8 0 0 1 8-8h16a8 8 0 0 1 8 8v10" fill="none" stroke="#2a78d6" stroke-width="9"/>` +
    `<path fill="#2a78d6" fill-rule="evenodd" d="M16 30h68a10 10 0 0 1 10 10v38a10 10 0 0 1-10 10H16A10 10 0 0 1 6 78V40a10 10 0 0 1 10-10ZM40 46v14h20V46Z"/>`,
  personal: `<path fill="#1baf7a" fill-rule="evenodd" d="M50 8 96 48H84v44H16V48H4ZM41 92V66h18v26Z"/>`,
};

export function faviconSvg(profile: Profile): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${FAVICONS[profile]}</svg>`;
}
