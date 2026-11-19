import { createReadStream, createWriteStream } from 'node:fs';
import { access, appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import unzipper from 'unzipper';
import { USER_AGENT } from './constants.js';
import { fetchJson } from './http.js';

export interface SdeTypeInfo {
  typeId: number;
  graphicId: number | null;
  hullName: string | null;
  iconFolder: string | null;
  published: boolean;
  variationParentTypeId: number | null;
}

export interface SdeModelIndexes {
  hullNames: ReadonlyMap<string, number>;
  iconFolders: ReadonlyMap<string, number>;
}

interface LatestSdeRecord {
  _key: string;
  buildNumber: number;
  releaseDate: string;
}

interface SdeTypeRecord {
  _key: number;
  graphicID?: number;
  published: boolean;
  variationParentTypeID?: number;
}

interface SdeGraphicRecord {
  _key: number;
  iconFolder?: string;
  sofHullName?: string;
}

interface SdeGraphicInfo {
  hullName: string | null;
  iconFolder: string | null;
}

const LATEST_SDE_URL = 'https://developers.eveonline.com/static-data/tranquility/latest.jsonl';
const SDE_ARCHIVE_BASE_URL = 'https://developers.eveonline.com/static-data/tranquility';
const SDE_REQUEST_TIMEOUT_MS = 2 * 60_000;
const SDE_DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const SDE_DOWNLOAD_ATTEMPTS = 4;
const DEFAULT_SDE_CACHE_DIRECTORY = resolve('.cache', 'sde');
const TYPES_ENTRY_PATTERN = /(^|\/)types\.jsonl$/;
const GRAPHICS_ENTRY_PATTERN = /(^|\/)graphics\.jsonl$/;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const getArchiveSize = async (url: string): Promise<number> => {
  const response = await fetch(url, {
    method: 'HEAD',
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(SDE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Unable to inspect SDE: HTTP ${response.status}.`);
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    throw new Error('The official SDE response did not include a valid content length.');
  }
  return contentLength;
};

const downloadChunk = async (url: string, start: number, end: number): Promise<Buffer> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= SDE_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(SDE_REQUEST_TIMEOUT_MS),
      });
      if (response.status !== 206) throw new Error(`SDE range request returned HTTP ${response.status}.`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const expectedLength = end - start + 1;
      if (buffer.length !== expectedLength) {
        throw new Error(`SDE range ${start}-${end} returned ${buffer.length} of ${expectedLength} bytes.`);
      }
      return buffer;
    } catch (error) {
      lastError = error;
      if (attempt < SDE_DOWNLOAD_ATTEMPTS) await delay(attempt * 1_000);
    }
  }

  throw lastError;
};

const downloadArchive = async (url: string, archivePath: string): Promise<void> => {
  const archiveSize = await getArchiveSize(url);

  const temporaryPath = `${archivePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, Buffer.alloc(0));
  for (let start = 0; start < archiveSize; start += SDE_DOWNLOAD_CHUNK_SIZE) {
    const end = Math.min(start + SDE_DOWNLOAD_CHUNK_SIZE - 1, archiveSize - 1);
    await appendFile(temporaryPath, await downloadChunk(url, start, end));
    const percent = Math.round(((end + 1) / archiveSize) * 100);
    process.stdout.write(`SDE download: ${percent}%\n`);
  }
  await rename(temporaryPath, archivePath);
};

const extractEntry = async (archivePath: string, outputPath: string, entryPattern: RegExp): Promise<void> => {
  const archive = await unzipper.Open.file(archivePath);
  const entry = archive.files.find((file) => entryPattern.test(file.path));
  if (!entry) throw new Error(`The official SDE archive does not contain ${entryPattern.source}.`);

  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await pipeline(entry.stream(), createWriteStream(temporaryPath));
  await rename(temporaryPath, outputPath);
};

const parseGraphics = async (graphicsPath: string): Promise<Map<number, SdeGraphicInfo>> => {
  const graphics = new Map<number, SdeGraphicInfo>();
  const lines = createInterface({ input: createReadStream(graphicsPath), crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as SdeGraphicRecord;
    graphics.set(record._key, {
      hullName: record.sofHullName ?? null,
      iconFolder: record.iconFolder ?? null,
    });
  }

  return graphics;
};

const parseTypes = async (
  typesPath: string,
  graphics: ReadonlyMap<number, SdeGraphicInfo>,
): Promise<Map<number, SdeTypeInfo>> => {
  const types = new Map<number, SdeTypeInfo>();
  const lines = createInterface({ input: createReadStream(typesPath), crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as SdeTypeRecord;
    const graphic = record.graphicID ? graphics.get(record.graphicID) : undefined;
    types.set(record._key, {
      typeId: record._key,
      graphicId: record.graphicID ?? null,
      hullName: graphic?.hullName ?? null,
      iconFolder: graphic?.iconFolder ?? null,
      published: record.published,
      variationParentTypeId: record.variationParentTypeID ?? null,
    });
  }

  return types;
};

export const loadSdeTypes = async (
  cacheDirectory = DEFAULT_SDE_CACHE_DIRECTORY,
): Promise<{ buildNumber: number; types: Map<number, SdeTypeInfo> }> => {
  const latest = await fetchJson<LatestSdeRecord>(LATEST_SDE_URL);
  const archiveName = `eve-online-static-data-${latest.buildNumber}-jsonl.zip`;
  const archivePath = join(cacheDirectory, archiveName);
  const typesPath = join(cacheDirectory, `${latest.buildNumber}-types.jsonl`);
  const graphicsPath = join(cacheDirectory, `${latest.buildNumber}-graphics.jsonl`);
  await mkdir(cacheDirectory, { recursive: true });

  if (!(await pathExists(typesPath))) {
    if (!(await pathExists(archivePath))) {
      process.stdout.write(`Downloading official CCP SDE build ${latest.buildNumber}...\n`);
      await downloadArchive(`${SDE_ARCHIVE_BASE_URL}/${archiveName}`, archivePath);
    }
    process.stdout.write('Extracting types.jsonl from SDE...\n');
    await extractEntry(archivePath, typesPath, TYPES_ENTRY_PATTERN);
  }
  if (!(await pathExists(graphicsPath))) {
    process.stdout.write('Extracting graphics.jsonl from SDE...\n');
    await extractEntry(archivePath, graphicsPath, GRAPHICS_ENTRY_PATTERN);
  }

  const graphics = await parseGraphics(graphicsPath);
  return { buildNumber: latest.buildNumber, types: await parseTypes(typesPath, graphics) };
};

export const resolveVariationParent = (typeId: number, types: ReadonlyMap<number, SdeTypeInfo>): number => {
  const visited = new Set<number>();
  let currentTypeId = typeId;

  while (!visited.has(currentTypeId)) {
    visited.add(currentTypeId);
    const parentTypeId = types.get(currentTypeId)?.variationParentTypeId;
    if (!parentTypeId || parentTypeId === currentTypeId) return currentTypeId;
    currentTypeId = parentTypeId;
  }

  return typeId;
};

const getCanonicalScore = (type: SdeTypeInfo): number => {
  let score = 0;
  if (type.published) score += 4;
  if (!type.variationParentTypeId) score += 2;
  return score;
};

const buildModelIndex = (
  types: ReadonlyMap<number, SdeTypeInfo>,
  getKey: (type: SdeTypeInfo) => string | null,
): ReadonlyMap<string, number> => {
  const index = new Map<string, number>();

  for (const type of types.values()) {
    const key = getKey(type);
    if (!key) continue;
    const candidateTypeId = resolveVariationParent(type.typeId, types);
    const candidate = types.get(candidateTypeId) ?? type;
    const existingTypeId = index.get(key);
    const existing = existingTypeId ? types.get(existingTypeId) : undefined;
    const candidateScore = getCanonicalScore(candidate);
    const existingScore = existing ? getCanonicalScore(existing) : -1;
    const winsTie =
      existingTypeId !== undefined && candidateScore === existingScore && candidateTypeId < existingTypeId;
    if (!existing || candidateScore > existingScore || winsTie) {
      index.set(key, candidateTypeId);
    }
  }

  return index;
};

export const buildModelIndexes = (types: ReadonlyMap<number, SdeTypeInfo>): SdeModelIndexes => ({
  hullNames: buildModelIndex(types, (type) => type.hullName),
  iconFolders: buildModelIndex(types, (type) => type.iconFolder),
});

export const resolveModelTypeId = (
  typeId: number,
  types: ReadonlyMap<number, SdeTypeInfo>,
  indexes: SdeModelIndexes,
): number => {
  const variationParent = resolveVariationParent(typeId, types);
  if (variationParent !== typeId) return variationParent;
  const type = types.get(typeId);
  if (!type) return typeId;
  let hullModelTypeId: number | undefined;
  if (type.hullName) {
    hullModelTypeId = indexes.hullNames.get(type.hullName);
    if (hullModelTypeId && hullModelTypeId !== typeId) return hullModelTypeId;
  }
  if (type.iconFolder) return indexes.iconFolders.get(type.iconFolder) ?? typeId;
  return hullModelTypeId ?? typeId;
};
