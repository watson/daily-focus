/**
 * The tab icons an instance can choose between with `DAILY_FOCUS_ICON`.
 *
 * One design in several colours rather than several designs: a pinned tab shows
 * nothing but its icon, so two instances need to differ at a glance, and still be
 * recognisably the same app. Each is named for its ring, the part that carries at
 * 16 pixels; the dot is picked to stay distinct from it. `blue` is the original.
 */
const FAVICONS = {
  blue: { ring: '#2a78d6', dot: '#eb6834' },
  green: { ring: '#1baf7a', dot: '#4a3aa7' },
  purple: { ring: '#7a4fd6', dot: '#eda100' },
  red: { ring: '#d63a3a', dot: '#2a78d6' },
  teal: { ring: '#0b8ea8', dot: '#e87ba4' },
  amber: { ring: '#e09a00', dot: '#4a3aa7' },
} as const;

export type FaviconName = keyof typeof FAVICONS;

export const FAVICON_NAMES = Object.keys(FAVICONS) as FaviconName[];

export function faviconSvg(name: FaviconName): string {
  const { ring, dot } = FAVICONS[name];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<circle cx="50" cy="50" r="38" fill="none" stroke="${ring}" stroke-width="10"/>` +
    `<circle cx="50" cy="50" r="10" fill="${dot}"/>` +
    `</svg>`
  );
}
