import { resolve } from 'node:path';
import { DEFAULT_HOLOGRAM_COLOR, VALID_IMAGE_SIZES } from './constants.js';
import type { GeneratorOptions, OutputFormat, RgbColor } from './types.js';

const DEFAULT_OPTIONS: GeneratorOptions = {
  outputDirectory: resolve('dist'),
  cacheDirectory: resolve('.cache', 'renders'),
  size: 256,
  format: 'webp',
  quality: 88,
  concurrency: 6,
  force: false,
  dryRun: false,
  limit: null,
  typeIds: [],
  color: { ...DEFAULT_HOLOGRAM_COLOR },
};

const HELP_TEXT = `
wanderer-render-ships

Usage:
  npm run generate -- [options]

Options:
  --output <directory>      Output directory (default: dist)
  --cache <directory>       Original render cache (default: .cache/renders)
  --size <number>           32, 64, 128, 256, 512 or 1024 (default: 256)
  --format <format>         webp, png or both (default: webp)
  --quality <number>        WebP quality from 1 to 100 (default: 88)
  --concurrency <number>    Concurrent downloads/renders (default: 6)
  --color <hex>             Hologram color (default: #d8f3ff)
  --ids <id,id,...>         Generate only the specified EVE type IDs
  --limit <number>          Generate only the first N discovered ships
  --force                   Regenerate existing output files
  --dry-run                 Discover ships without downloading images
  --help                    Show this help
`;

const readValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
};

const parseInteger = (value: string, flag: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} must be an integer.`);
  }
  return parsed;
};

const parseFormat = (value: string): OutputFormat => {
  if (value === 'webp' || value === 'png' || value === 'both') {
    return value;
  }
  throw new Error('--format must be webp, png or both.');
};

const parseColor = (value: string): RgbColor => {
  const normalized = value.replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    throw new Error('--color must be a six-digit hex color, for example #d8f3ff.');
  }
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  };
};

export const getHelpText = (): string => HELP_TEXT.trim();

export const parseArgs = (args: string[]): GeneratorOptions => {
  const options: GeneratorOptions = { ...DEFAULT_OPTIONS, color: { ...DEFAULT_OPTIONS.color }, typeIds: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === '--help') {
      process.stdout.write(`${getHelpText()}\n`);
      process.exit(0);
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--ids') {
      const idValues: string[] = [];
      while (args[index + 1] && !args[index + 1]?.startsWith('--')) {
        index += 1;
        idValues.push(...(args[index]?.split(',') ?? []));
      }
      if (idValues.length === 0) throw new Error('--ids requires at least one type ID.');
      options.typeIds = idValues.map((id) => parseInteger(id.trim(), arg));
      continue;
    }

    const value = readValue(args, index, arg);
    index += 1;

    if (arg === '--output') options.outputDirectory = resolve(value);
    else if (arg === '--cache') options.cacheDirectory = resolve(value);
    else if (arg === '--format') options.format = parseFormat(value);
    else if (arg === '--color') options.color = parseColor(value);
    else if (arg === '--size') options.size = parseInteger(value, arg);
    else if (arg === '--quality') options.quality = parseInteger(value, arg);
    else if (arg === '--concurrency') options.concurrency = parseInteger(value, arg);
    else if (arg === '--limit') options.limit = parseInteger(value, arg);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!VALID_IMAGE_SIZES.has(options.size)) throw new Error('--size must be a power of two from 32 through 1024.');
  if (options.quality < 1 || options.quality > 100) throw new Error('--quality must be between 1 and 100.');
  if (options.concurrency < 1 || options.concurrency > 32) throw new Error('--concurrency must be between 1 and 32.');
  if (options.limit !== null && options.limit < 1) throw new Error('--limit must be greater than zero.');

  return options;
};
