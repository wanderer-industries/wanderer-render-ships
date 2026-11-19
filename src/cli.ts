import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from './args.js';
import { ESI_BASE_URL, GENERATOR_VERSION, IMAGE_BASE_URL, SHIP_CATEGORY_ID } from './constants.js';
import { mapWithConcurrency } from './concurrency.js';
import { discoverShipTypes, resolveShipTypeIds } from './esi.js';
import { writeGallery } from './gallery.js';
import { createHologram } from './hologram.js';
import { getOriginalRender, getRenderUrl } from './render-source.js';
import type { FailedShip, GeneratedShip, GeneratorOptions, ShipManifest, ShipType } from './types.js';

type GenerationResult = { ok: true; ship: GeneratedShip } | { ok: false; ship: FailedShip };

const getExtensions = (format: GeneratorOptions['format']): string[] => {
  if (format === 'both') return ['webp', 'png'];
  return [format];
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const writeAtomically = async (path: string, buffer: Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, buffer);
  await rename(temporaryPath, path);
};

const getDigest = (buffers: Buffer[]): string => {
  const hash = createHash('sha256');
  for (const buffer of buffers) hash.update(buffer);
  return hash.digest('hex');
};

const getRelativeUrl = (outputDirectory: string, path: string): string => {
  return `./${relative(outputDirectory, path).replaceAll('\\', '/')}`;
};

const generateShip = async (ship: ShipType, options: GeneratorOptions): Promise<GenerationResult> => {
  const extensions = getExtensions(options.format);
  const outputPaths = extensions.map((extension) =>
    join(options.outputDirectory, 'ships', String(options.size), `${ship.typeId}.${extension}`),
  );

  try {
    const allOutputsExist = !options.force && (await Promise.all(outputPaths.map(pathExists))).every(Boolean);
    let outputBuffers: Buffer[];

    if (allOutputsExist) {
      outputBuffers = await Promise.all(outputPaths.map((path) => readFile(path)));
    } else {
      const original = await getOriginalRender(ship.typeId, options.size, options.cacheDirectory, options.force);
      const generated = await createHologram(original.buffer, options);
      outputBuffers = [];

      for (let index = 0; index < extensions.length; index += 1) {
        const extension = extensions[index];
        const outputPath = outputPaths[index];
        if (!extension || !outputPath) continue;
        const buffer = generated.get(extension);
        if (!buffer) throw new Error(`Hologram processor did not produce ${extension} output.`);
        await writeAtomically(outputPath, buffer);
        outputBuffers.push(buffer);
      }
    }

    return {
      ok: true,
      ship: {
        ...ship,
        files: outputPaths.map((path) => getRelativeUrl(options.outputDirectory, path)),
        sourceUrl: getRenderUrl(ship.typeId, options.size),
        sha256: getDigest(outputBuffers),
      },
    };
  } catch (error) {
    return {
      ok: false,
      ship: { ...ship, error: error instanceof Error ? error.message : String(error) },
    };
  }
};

const buildManifest = (
  options: GeneratorOptions,
  discoveredCount: number,
  results: GenerationResult[],
): ShipManifest => {
  const ships = results.filter((result) => result.ok).map((result) => result.ship);
  const failures = results.filter((result) => !result.ok).map((result) => result.ship);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generatorVersion: GENERATOR_VERSION,
    source: { esi: ESI_BASE_URL, images: IMAGE_BASE_URL, categoryId: SHIP_CATEGORY_ID },
    settings: {
      size: options.size,
      format: options.format,
      quality: options.quality,
      color: options.color,
    },
    totals: { discovered: discoveredCount, generated: ships.length, failed: failures.length },
    ships,
    failures,
  };
};

const selectShips = async (options: GeneratorOptions): Promise<ShipType[]> => {
  let ships: ShipType[];
  if (options.typeIds.length > 0) ships = await resolveShipTypeIds(options.typeIds);
  else ships = await discoverShipTypes(options.concurrency);
  if (options.limit !== null) ships = ships.slice(0, options.limit);
  return ships;
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write('Discovering EVE ship types...\n');
  const ships = await selectShips(options);
  process.stdout.write(`Discovered ${ships.length} ships.\n`);

  if (options.dryRun) {
    for (const ship of ships) process.stdout.write(`${ship.typeId}\t${ship.name}\n`);
    return;
  }

  await mkdir(options.outputDirectory, { recursive: true });
  let completed = 0;
  const results = await mapWithConcurrency(ships, options.concurrency, async (ship) => {
    const result = await generateShip(ship, options);
    completed += 1;
    const status = result.ok ? 'ok' : 'failed';
    process.stdout.write(`[${completed}/${ships.length}] ${status} ${ship.typeId} ${ship.name}\n`);
    return result;
  });

  const manifest = buildManifest(options, ships.length, results);
  await writeAtomically(
    join(options.outputDirectory, 'manifest.json'),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  await writeGallery(options.outputDirectory);

  process.stdout.write(
    `Finished: ${manifest.totals.generated} generated, ${manifest.totals.failed} failed. Output: ${options.outputDirectory}\n`,
  );
  if (manifest.totals.failed > 0) process.exitCode = 2;
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
