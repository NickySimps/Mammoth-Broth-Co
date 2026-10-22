import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const fire = readFileSync(new URL('../fire.css', import.meta.url), 'utf8');

test('navigation offsets do not force smooth document scrolling', () => {
  assert.doesNotMatch(css, /scroll-behavior:\s*smooth/);
  assert.match(css, /scroll-margin-top:\s*calc\(var\(--sticky-nav-height,\s*80px\)\s*\+\s*16px\)/);
});

test('sticky navigation contains its margins so measured anchor offsets include the whole bar', () => {
  assert.match(css, /\.sticky-nav-container\s*\{[^}]*display:\s*flow-root/s);
});

test('shared control contract covers primary, secondary and icon controls', () => {
  for (const selector of ['.btn-primitive', '.provider-button', '.button-link', '.btn-cart-quantity-change', '.close-button']) {
    assert.ok(css.includes(selector), selector);
  }
  assert.match(css, /--control-size:\s*44px/);
  assert.match(css, /:disabled[\s\S]*?cursor:\s*not-allowed/);
  assert.match(css, /:focus-visible[\s\S]*?outline:\s*3px solid/);
});

test('mobile document and dialogs have natural bounded scrolling', () => {
  assert.match(css, /background-attachment:\s*scroll/);
  assert.match(css, /max-height:\s*calc\(100dvh\s*-\s*32px\)/);
  assert.match(css, /overscroll-behavior:\s*contain/);
  assert.match(css, /nav\.active\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(fire, /min-height:\s*var\(--control-size,\s*44px\)/);
  assert.doesNotMatch(fire, /width:\s*30vw/);
});

test('brand background and reduced-motion support stay intact', () => {
  assert.ok(css.includes('Tiling\\ Background.webp'));
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('shared foreground tokens contrast against their intended surfaces', () => {
  const token = name => {
    const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
    assert.ok(value, `Missing token ${name}`);
    return value[1];
  };
  const luminance = hex => hex.slice(1).match(/../g).map(part => {
    const channel = parseInt(part, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  for (const [foreground, background] of [
    [token('cream'), token('button-primary')],
    [token('cream'), token('button-primary-hover')],
    [token('ink'), '#ffffff'],
    [token('ink-muted'), token('cream')],
    [token('link'), token('cream')],
    ['#38251c', '#f0b05e'],
  ]) {
    const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    const ratio = (levels[0] + .05) / (levels[1] + .05);
    assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
  }
});
