/** Formatting helpers shared by the renderers. No DOM state, no fetching. */

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const shortDayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const shortDayYearFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

export function parseDate(value) {
  if (typeof value !== 'string' || value === '') return null;
  // A bare date is local midnight, matching the server's parsing.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatTime(value) {
  const d = parseDate(value);
  return d ? timeFmt.format(d) : '';
}

export function formatDay(value) {
  const d = parseDate(value);
  return d ? dayFmt.format(d) : '';
}

export function formatShortDay(value) {
  const d = parseDate(value);
  return d ? shortDayFmt.format(d) : '';
}

/** "Friday". */
export function formatWeekday(value) {
  const d = parseDate(value);
  return d ? weekdayFmt.format(d) : '';
}

export function localDateKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Whole calendar days from today to `value`. Negative means the past. */
export function daysFromToday(value, now = new Date()) {
  const target = parseDate(value);
  if (!target) return null;
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** "Today" / "Tomorrow" / "3 days ago" / a short date. */
export function relativeDay(value, now = new Date()) {
  const diff = daysFromToday(value, now);
  if (diff === null) return '';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff <= 7) return `in ${diff} days`;
  if (diff < -1 && diff >= -7) return `${Math.abs(diff)} days ago`;
  return formatShortDay(value);
}

export function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

const MARKDOWN =
  /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\bhttps?:\/\/[^\s<]+)/g;

/**
 * Render the small slice of Markdown an agent actually reaches for: links, inline
 * code, bold, and bare URLs.
 *
 * This builds text nodes and elements rather than assigning innerHTML, so agent
 * output can never inject markup — the detail field is untrusted by construction.
 */
export function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  let last = 0;

  for (const match of String(text).matchAll(MARKDOWN)) {
    const index = match.index ?? 0;
    if (index > last) fragment.append(document.createTextNode(text.slice(last, index)));

    if (match[1]) {
      fragment.append(anchor(match[3], match[2]));
    } else if (match[4]) {
      const code = document.createElement('code');
      code.textContent = match[5];
      fragment.append(code);
    } else if (match[6]) {
      const strong = document.createElement('strong');
      strong.textContent = match[7];
      fragment.append(strong);
    } else if (match[8]) {
      fragment.append(anchor(match[8], match[8]));
    }

    last = index + match[0].length;
  }

  if (last < text.length) fragment.append(document.createTextNode(text.slice(last)));
  return fragment;
}

function anchor(href, label) {
  const a = document.createElement('a');
  // Belt and braces: the regex only matches http(s), and this re-checks after parsing.
  a.href = /^https?:\/\//i.test(href) ? href : '#';
  a.textContent = label;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/**
 * "just now" / "12 min ago" / "5 h ago" / "3 days ago" / a short date.
 *
 * Hour granularity under two days, because on the pull request board the
 * difference between a review that landed an hour ago and one from this morning
 * is the difference between "they're on it" and "ask".
 */
export function relativeTime(value, now = new Date()) {
  const d = parseDate(value);
  if (!d) return '';
  const seconds = Math.round((now.getTime() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days} days ago`;
  // Past a month the date itself reads better than "247 days ago", and once it's
  // in another year the year has to be on it: "Jan 14" is ambiguous on a PR that
  // has been open since the one before last.
  return d.getFullYear() === now.getFullYear() ? formatShortDay(value) : shortDayYearFmt.format(d);
}
