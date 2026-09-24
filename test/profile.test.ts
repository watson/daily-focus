import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { FAVICON_NAMES, faviconSvg } from '../src/favicon.ts';

test('the work profile is the default, and keeps every integration on', () => {
  const config = loadConfig({});
  assert.equal(config.profile, 'work');
  assert.equal(basename(config.promptSource), 'morning-brief-work.md');
  assert.equal(config.favicon, 'blue');
  assert.equal(config.github.enabled, true);
  assert.equal(config.jira.enabled, true);
  assert.equal(config.calendar.enabled, true);
  assert.equal(config.awayAfterMinutes, 10);
});

test('the personal profile switches off the Jira board and away detection', () => {
  const config = loadConfig({ DAILY_FOCUS_PROFILE: 'personal' });
  assert.equal(basename(config.promptSource), 'morning-brief-personal.md');
  assert.equal(config.favicon, 'green');
  assert.equal(config.github.enabled, true);
  assert.equal(config.jira.enabled, false);
  assert.equal(config.calendar.enabled, true);
  assert.equal(config.awayAfterMinutes, 0);
});

test('an explicit setting beats the profile default', () => {
  const config = loadConfig({
    DAILY_FOCUS_PROFILE: 'Personal',
    DAILY_FOCUS_JIRA: 'on',
    DAILY_FOCUS_AWAY_AFTER: '5',
    DAILY_FOCUS_ICON: 'amber',
  });
  assert.equal(config.profile, 'personal');
  assert.equal(config.jira.enabled, true);
  assert.equal(config.awayAfterMinutes, 5);
  assert.equal(config.favicon, 'amber');
});

test('an unknown profile or icon fails at startup rather than falling back', () => {
  assert.throws(() => loadConfig({ DAILY_FOCUS_PROFILE: 'home' }), /DAILY_FOCUS_PROFILE/);
  assert.throws(() => loadConfig({ DAILY_FOCUS_ICON: 'pink' }), /DAILY_FOCUS_ICON/);
});

test('every favicon is a distinct SVG', () => {
  const svgs = FAVICON_NAMES.map(faviconSvg);
  assert.equal(new Set(svgs).size, svgs.length);
  for (const svg of svgs) assert.match(svg, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});
