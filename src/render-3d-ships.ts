import { access, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { SHIP_CATEGORY_ID } from './constants.js';
import { discoverShipTypes, resolveShipTypeIds } from './esi.js';
import { getCachedModelPath, importEveModel } from './eve-model-import.js';
import { buildModelIndexes, loadSdeTypes, resolveModelTypeId, type SdeTypeInfo } from './sde.js';
import type { ShipType } from './types.js';

interface RenderOptions {
  outputDirectory: string;
  width: number;
  height: number;
  force: boolean;
  dryRun: boolean;
  limit: number | null;
  typeIds: number[];
  familyTypeIds: number[];
}

interface RenderedShip {
  typeId: number;
  name: string;
  file: string;
  modelTypeId: number;
  variationParentTypeId: number | null;
  graphicId: number | null;
  hullName: string | null;
  iconFolder: string | null;
  sdePublished: boolean | null;
}

interface FailedRender {
  typeId: number;
  name: string;
  error: string;
}

interface RenderShip extends ShipType {
  modelTypeId: number;
  variationParentTypeId: number | null;
  graphicId: number | null;
  hullName: string | null;
  iconFolder: string | null;
  sdePublished: boolean | null;
}

const DEFAULT_OUTPUT_DIRECTORY = resolve('dist', 'ships-3d', 'phantom-gray');
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 512;
const DISCOVERY_CONCURRENCY = 8;
const LOAD_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const CAPTURE_DELAY_MS = 250;
const BROWSER_CHANNELS = ['chrome', 'msedge'] as const;
const DATA_URL_PREFIX = 'data:image/png;base64,';
const HELP_TEXT = `
Render EVE ship types as transparent Phantom gray PNG files.

Usage:
  npm run ships:render -- [options]

Options:
  --output <directory>   Output directory (default: dist/ships-3d/phantom-gray)
  --width <pixels>       PNG width (default: 1024)
  --height <pixels>      PNG height (default: 512)
  --ids <id,id,...>      Render only selected EVE type IDs
  --families <id,...>    Render every variant related to selected type IDs
  --limit <number>       Render only the first N discovered ships
  --force                Replace existing PNG files
  --dry-run              Discover IDs and write catalog.json without rendering
  --help                 Show this help
`;

const parsePositiveInteger = (value: string, flag: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
};

const readOptionValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
};

const parseOptions = (args: string[]): RenderOptions => {
  const options: RenderOptions = {
    outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    force: false,
    dryRun: false,
    limit: null,
    typeIds: [],
    familyTypeIds: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag) continue;

    if (flag === '--help') {
      process.stdout.write(HELP_TEXT.trimStart());
      process.exit(0);
    }
    if (flag === '--force') {
      options.force = true;
      continue;
    }
    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    const value = readOptionValue(args, index, flag);
    index += 1;
    if (flag === '--output') options.outputDirectory = resolve(value);
    else if (flag === '--width') options.width = parsePositiveInteger(value, flag);
    else if (flag === '--height') options.height = parsePositiveInteger(value, flag);
    else if (flag === '--limit') options.limit = parsePositiveInteger(value, flag);
    else if (flag === '--ids') {
      options.typeIds = value.split(',').map((id) => parsePositiveInteger(id.trim(), flag));
    } else if (flag === '--families') {
      options.familyTypeIds = value.split(',').map((id) => parsePositiveInteger(id.trim(), flag));
    } else throw new Error(`Unknown option: ${flag}`);
  }

  if (options.typeIds.length > 0 && options.familyTypeIds.length > 0) {
    throw new Error('--ids and --families cannot be used together.');
  }

  return options;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const writeAtomically = async (path: string, contents: Buffer | string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, path);
};

const copyAtomically = async (sourcePath: string, targetPath: string): Promise<void> => {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await copyFile(sourcePath, temporaryPath);
  await rename(temporaryPath, targetPath);
};

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

const waitForModel = async (page: Page): Promise<void> => {
  const statusLocator = page.locator('#status');
  const deadline = Date.now() + LOAD_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const status = (await statusLocator.textContent()) ?? '';
    const failed = await statusLocator.evaluate((element) => element.classList.contains('error'));
    if (failed) throw new Error(status || 'Viewer reported an unknown load failure.');
    if (status.endsWith(' loaded')) return;
    await page.waitForTimeout(100);
  }

  throw new Error(`Model loading timed out after ${LOAD_TIMEOUT_MS}ms.`);
};

const enrichShips = (ships: ShipType[], sdeTypes: ReadonlyMap<number, SdeTypeInfo>): RenderShip[] => {
  const modelIndexes = buildModelIndexes(sdeTypes);
  return ships.map((ship) => {
    const sdeType = sdeTypes.get(ship.typeId);
    return {
      ...ship,
      modelTypeId: resolveModelTypeId(ship.typeId, sdeTypes, modelIndexes),
      variationParentTypeId: sdeType?.variationParentTypeId ?? null,
      graphicId: sdeType?.graphicId ?? null,
      hullName: sdeType?.hullName ?? null,
      iconFolder: sdeType?.iconFolder ?? null,
      sdePublished: sdeType?.published ?? null,
    };
  });
};

const getShips = async (options: RenderOptions, sdeTypes: ReadonlyMap<number, SdeTypeInfo>): Promise<RenderShip[]> => {
  let ships: ShipType[];
  if (options.typeIds.length > 0) ships = await resolveShipTypeIds(options.typeIds);
  else ships = await discoverShipTypes(DISCOVERY_CONCURRENCY);
  let enrichedShips = enrichShips(ships, sdeTypes);

  if (options.familyTypeIds.length > 0) {
    const modelIndexes = buildModelIndexes(sdeTypes);
    const familyIds = new Set(
      options.familyTypeIds.map((typeId) => resolveModelTypeId(typeId, sdeTypes, modelIndexes)),
    );
    enrichedShips = enrichedShips.filter((ship) => familyIds.has(ship.modelTypeId));
  }
  if (options.limit !== null) enrichedShips = enrichedShips.slice(0, options.limit);
  return enrichedShips;
};

const getCanvasPng = async (page: Page): Promise<Buffer> => {
  const dataUrl = await page.locator('#viewport').evaluate((element) => {
    if (element.tagName !== 'CANVAS') throw new Error('#viewport is not a canvas.');
    const canvas = element as unknown as { toDataURL: (type: string) => string };
    return canvas.toDataURL('image/png');
  });
  if (!dataUrl.startsWith(DATA_URL_PREFIX)) throw new Error('Viewer returned an invalid PNG data URL.');
  return Buffer.from(dataUrl.slice(DATA_URL_PREFIX.length), 'base64');
};

const getLocalModelUrl = (modelPath: string): string => `/@fs/${modelPath.replaceAll('\\', '/')}`;

const renderShip = async (
  page: Page,
  serverUrl: string,
  modelTypeId: number,
  outputPath: string,
  modelUrl?: string,
): Promise<void> => {
  const query = new URLSearchParams({
    typeId: String(modelTypeId),
    capture: '1',
    mode: 'phantom-gray',
    transparent: '1',
  });
  if (modelUrl) query.set('modelUrl', modelUrl);
  await page.goto(`${serverUrl}?${query}`, { waitUntil: 'domcontentloaded' });
  await waitForModel(page);
  await page.waitForTimeout(CAPTURE_DELAY_MS);
  await writeAtomically(outputPath, await getCanvasPng(page));
};

const runRenderer = async (
  options: RenderOptions,
  ships: RenderShip[],
  server: ViteDevServer,
  browser: Browser,
): Promise<{ rendered: RenderedShip[]; failures: FailedRender[] }> => {
  const serverUrl = server.resolvedUrls?.local[0];
  if (!serverUrl) throw new Error('Vite did not expose a local URL.');

  const page = await browser.newPage({ viewport: { width: options.width, height: options.height } });
  const rendered: RenderedShip[] = [];
  const failures: FailedRender[] = [];
  const renderedModels = new Map<number, string>();

  for (let index = 0; index < ships.length; index += 1) {
    const ship = ships[index];
    if (!ship) continue;
    const outputPath = join(options.outputDirectory, `${ship.typeId}.png`);
    const progress = `[${index + 1}/${ships.length}]`;

    try {
      if (!options.force && (await pathExists(outputPath))) {
        if (!renderedModels.has(ship.modelTypeId)) renderedModels.set(ship.modelTypeId, outputPath);
        process.stdout.write(`${progress} skipped ${ship.typeId} ${ship.name}\n`);
      } else {
        const reusablePath = renderedModels.get(ship.modelTypeId);
        if (reusablePath) {
          await copyAtomically(reusablePath, outputPath);
          process.stdout.write(`${progress} reused ${ship.modelTypeId} for ${ship.typeId} ${ship.name}\n`);
        } else {
          const cachedModelPath = getCachedModelPath(ship.modelTypeId);
          let localModelPath = (await pathExists(cachedModelPath)) ? cachedModelPath : null;
          try {
            await renderShip(
              page,
              serverUrl,
              ship.modelTypeId,
              outputPath,
              localModelPath ? getLocalModelUrl(localModelPath) : undefined,
            );
          } catch (remoteError) {
            if (localModelPath || !ship.hullName) throw remoteError;
            try {
              localModelPath = await importEveModel({ typeId: ship.modelTypeId, hullName: ship.hullName });
            } catch (importError) {
              const remoteMessage = remoteError instanceof Error ? remoteError.message : String(remoteError);
              const importMessage = importError instanceof Error ? importError.message : String(importError);
              throw new Error(`${remoteMessage} Local EVE import also failed: ${importMessage}`);
            }
            await renderShip(page, serverUrl, ship.modelTypeId, outputPath, getLocalModelUrl(localModelPath));
            process.stdout.write(`${progress} imported local EVE hull ${ship.hullName}\n`);
          }
          renderedModels.set(ship.modelTypeId, outputPath);
          process.stdout.write(`${progress} rendered ${ship.modelTypeId} for ${ship.typeId} ${ship.name}\n`);
        }
      }
      rendered.push({
        typeId: ship.typeId,
        name: ship.name,
        file: `${ship.typeId}.png`,
        modelTypeId: ship.modelTypeId,
        variationParentTypeId: ship.variationParentTypeId,
        graphicId: ship.graphicId,
        hullName: ship.hullName,
        iconFolder: ship.iconFolder,
        sdePublished: ship.sdePublished,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ typeId: ship.typeId, name: ship.name, error: message });
      process.stderr.write(`${progress} failed ${ship.typeId} ${ship.name}: ${message}\n`);
    }
  }

  return { rendered, failures };
};

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const sde = await loadSdeTypes();
  process.stdout.write('Discovering EVE ship type IDs from category 6...\n');
  const ships = await getShips(options, sde.types);
  process.stdout.write(`Discovered ${ships.length} ships.\n`);
  await mkdir(options.outputDirectory, { recursive: true });
  const catalog = {
    generatedAt: new Date().toISOString(),
    categoryId: SHIP_CATEGORY_ID,
    sdeBuildNumber: sde.buildNumber,
    count: ships.length,
    ships: ships.map((ship) => ({
      typeId: ship.typeId,
      name: ship.name,
      modelTypeId: ship.modelTypeId,
      variationParentTypeId: ship.variationParentTypeId,
      graphicId: ship.graphicId,
      hullName: ship.hullName,
      iconFolder: ship.iconFolder,
      sdePublished: ship.sdePublished,
    })),
  };
  await writeAtomically(join(options.outputDirectory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  if (options.dryRun) {
    process.stdout.write(`Catalog: ${join(options.outputDirectory, 'catalog.json')}\n`);
    return;
  }

  const server = await createServer({ configFile: resolve('vite.config.ts') });
  await server.listen();
  const browser = await launchBrowser();

  try {
    const result = await runRenderer(options, ships, server, browser);
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      preset: 'phantom-gray',
      sdeBuildNumber: sde.buildNumber,
      transparent: true,
      width: options.width,
      height: options.height,
      discovered: ships.length,
      generated: result.rendered.length,
      failed: result.failures.length,
      ships: result.rendered,
      failures: result.failures,
    };
    await writeAtomically(join(options.outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`Finished: ${result.rendered.length} available, ${result.failures.length} failed.\n`);
    if (result.failures.length > 0) process.exitCode = 2;
  } finally {
    await closeWithTimeout('Browser', () => browser.close());
    await closeWithTimeout('Vite server', () => server.close());
  }
};

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
