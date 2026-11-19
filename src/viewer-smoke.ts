import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import sharp from 'sharp';
import { createServer } from 'vite';

interface ShipSample {
  typeId: number;
  name: string;
  slug: string;
}

interface ContactOverlay {
  input: Buffer;
  left: number;
  top: number;
}

type CaptureMode = 'phantom-gray' | 'wireframe';

const SMOKE_SHIPS: ReadonlyArray<ShipSample> = [{ typeId: 587, name: 'Rifter', slug: 'rifter' }];
const SAMPLE_SHIPS: ReadonlyArray<ShipSample> = [
  { typeId: 641, name: 'Megathron', slug: 'megathron' },
  { typeId: 17740, name: 'Vindicator', slug: 'vindicator' },
  { typeId: 28665, name: 'Vargur', slug: 'vargur' },
  { typeId: 605, name: 'Heron', slug: 'heron' },
  { typeId: 587, name: 'Rifter', slug: 'rifter' },
  { typeId: 24698, name: 'Drake', slug: 'drake' },
  { typeId: 638, name: 'Raven', slug: 'raven' },
  { typeId: 642, name: 'Apocalypse', slug: 'apocalypse' },
  { typeId: 645, name: 'Dominix', slug: 'dominix' },
  { typeId: 17738, name: 'Machariel', slug: 'machariel' },
];
const LOAD_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const BROWSER_CHANNELS = ['chrome', 'msedge'] as const;
const CAPTURE_VIEWPORT = { width: 768, height: 480 } as const;
const CONTACT_COLUMNS = 5;
const CONTACT_TILE_WIDTH = 384;
const CONTACT_TILE_HEIGHT = 240;
const CONTACT_LABEL_HEIGHT = 34;
const CONTACT_BACKGROUND = { r: 5, g: 10, b: 14, alpha: 1 } as const;

const closeWithTimeout = async (label: string, close: () => Promise<void>): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolveTimeout) => {
    timeout = setTimeout(() => {
      process.stderr.write(`${label} cleanup exceeded ${CLEANUP_TIMEOUT_MS}ms; continuing.\n`);
      resolveTimeout();
    }, CLEANUP_TIMEOUT_MS);
  });

  await Promise.race([close(), timeoutPromise]);
  if (timeout) clearTimeout(timeout);
};

const launchBrowser = async (): Promise<Browser> => {
  let lastError: unknown;

  for (const channel of BROWSER_CHANNELS) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

const waitForModelStatus = async (page: Page): Promise<string> => {
  const statusLocator = page.locator('#status');
  const deadline = Date.now() + LOAD_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const status = (await statusLocator.textContent()) ?? '';
    const failed = await statusLocator.evaluate((element) => element.classList.contains('error'));
    if (failed) throw new Error(status || 'Viewer reported an unknown load failure.');
    if (status.endsWith(' loaded')) return status;
    await page.waitForTimeout(100);
  }

  throw new Error(`Model loading timed out after ${LOAD_TIMEOUT_MS}ms.`);
};

const getOutputDirectory = (isBatch: boolean): string => {
  if (isBatch) return resolve('dist', 'ships-3d', 'samples');
  return resolve('test-output');
};

const captureShip = async (
  page: Page,
  serverUrl: string,
  outputDirectory: string,
  ship: ShipSample,
  captureOnly: boolean,
  captureMode: CaptureMode,
): Promise<string> => {
  const captureQuery = captureOnly ? `&capture=1&mode=${captureMode}` : `&mode=${captureMode}`;
  await page.goto(`${serverUrl}?typeId=${ship.typeId}${captureQuery}`, { waitUntil: 'domcontentloaded' });
  const status = await waitForModelStatus(page);
  await page.waitForTimeout(250);

  const outputPath = resolve(outputDirectory, `${ship.typeId}-${ship.slug}-${captureMode}.png`);
  if (captureOnly) await page.locator('#viewport').screenshot({ path: outputPath });
  else await page.screenshot({ path: outputPath });
  process.stdout.write(`${status}: ${outputPath}\n`);
  return outputPath;
};

const createContactSheet = async (
  ships: ReadonlyArray<ShipSample>,
  imagePaths: string[],
  outputPath: string,
): Promise<void> => {
  const rows = Math.ceil(ships.length / CONTACT_COLUMNS);
  const composites: ContactOverlay[] = [];

  for (let index = 0; index < ships.length; index += 1) {
    const ship = ships[index];
    const imagePath = imagePaths[index];
    if (!ship || !imagePath) continue;

    const column = index % CONTACT_COLUMNS;
    const row = Math.floor(index / CONTACT_COLUMNS);
    const left = column * CONTACT_TILE_WIDTH;
    const top = row * CONTACT_TILE_HEIGHT;
    const imageHeight = CONTACT_TILE_HEIGHT - CONTACT_LABEL_HEIGHT;
    const image = await sharp(imagePath).resize(CONTACT_TILE_WIDTH, imageHeight, { fit: 'cover' }).png().toBuffer();
    const label = Buffer.from(
      `<svg width="${CONTACT_TILE_WIDTH}" height="${CONTACT_LABEL_HEIGHT}"><rect width="100%" height="100%" fill="#091218"/><text x="14" y="22" fill="#dbe8ef" font-family="Arial, sans-serif" font-size="15">${ship.name} · ${ship.typeId}</text></svg>`,
    );

    composites.push({ input: image, left, top });
    composites.push({ input: label, left, top: top + imageHeight });
  }

  await sharp({
    create: {
      width: CONTACT_COLUMNS * CONTACT_TILE_WIDTH,
      height: rows * CONTACT_TILE_HEIGHT,
      channels: 4,
      background: CONTACT_BACKGROUND,
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);
};

const main = async (): Promise<void> => {
  const isBatch = process.argv.includes('--samples');
  const captureMode: CaptureMode = process.argv.includes('--wireframe') ? 'wireframe' : 'phantom-gray';
  const ships = isBatch ? SAMPLE_SHIPS : SMOKE_SHIPS;
  const outputDirectory = getOutputDirectory(isBatch);
  const server = await createServer({ configFile: resolve('vite.config.ts') });
  await server.listen();
  const browser = await launchBrowser();

  try {
    const serverUrl = server.resolvedUrls?.local[0];
    if (!serverUrl) throw new Error('Vite did not expose a local URL.');

    await mkdir(outputDirectory, { recursive: true });
    const page = await browser.newPage({ viewport: CAPTURE_VIEWPORT });
    const imagePaths: string[] = [];
    for (const ship of ships) {
      imagePaths.push(await captureShip(page, serverUrl, outputDirectory, ship, isBatch, captureMode));
    }

    if (isBatch) {
      const contactSheetPath = resolve(outputDirectory, `contact-sheet-${captureMode}.png`);
      await createContactSheet(ships, imagePaths, contactSheetPath);
      process.stdout.write(`Contact sheet: ${contactSheetPath}\n`);
    }
  } finally {
    await closeWithTimeout('Browser', () => browser.close());
    await closeWithTimeout('Vite server', () => server.close());
  }
};

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
