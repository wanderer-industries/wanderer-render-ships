import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/args.js';

test('parseArgs returns safe defaults', () => {
  const options = parseArgs([]);
  assert.equal(options.size, 256);
  assert.equal(options.format, 'webp');
  assert.equal(options.concurrency, 6);
  assert.deepEqual(options.color, { red: 216, green: 243, blue: 255 });
});

test('parseArgs accepts a targeted render configuration', () => {
  const options = parseArgs([
    '--ids',
    '587',
    '11192',
    '--size',
    '512',
    '--format',
    'both',
    '--quality',
    '91',
    '--color',
    '#ffffff',
  ]);
  assert.deepEqual(options.typeIds, [587, 11192]);
  assert.equal(options.size, 512);
  assert.equal(options.format, 'both');
  assert.equal(options.quality, 91);
  assert.deepEqual(options.color, { red: 255, green: 255, blue: 255 });
});

test('parseArgs rejects unsupported image sizes', () => {
  assert.throws(() => parseArgs(['--size', '300']), /power of two/);
});
