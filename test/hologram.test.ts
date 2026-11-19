import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { createHologram } from '../src/hologram.js';

const TEST_SHIP_SVG = Buffer.from(`
  <svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 32 L25 18 L54 25 L60 32 L54 39 L25 46 Z" fill="#8796a5" />
    <path d="M18 31 H51" stroke="#f8fafc" stroke-width="3" />
  </svg>
`);

test('createHologram produces a transparent CDN-ready WebP', async () => {
  const input = await sharp(TEST_SHIP_SVG).png().toBuffer();
  const outputs = await createHologram(input, {
    size: 128,
    format: 'webp',
    quality: 88,
    color: { red: 216, green: 243, blue: 255 },
  });
  const output = outputs.get('webp');
  assert.ok(output);

  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 128);
  assert.equal(metadata.hasAlpha, true);

  const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparentPixels = 0;
  let visiblePixels = 0;
  for (let index = 3; index < data.length; index += info.channels) {
    const alpha = data[index] ?? 0;
    if (alpha === 0) transparentPixels += 1;
    if (alpha > 20) visiblePixels += 1;
  }
  assert.ok(transparentPixels > 0);
  assert.ok(visiblePixels > 0);
});
