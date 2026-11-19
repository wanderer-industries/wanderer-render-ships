import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

interface Gr2MeshArea {
  faces: number[];
}

interface Gr2Mesh {
  name: string;
  vertex: {
    position: number[];
  };
  indices: Gr2MeshArea[];
}

interface Gr2Json {
  meshes: Gr2Mesh[];
}

export interface EveModelImportOptions {
  typeId: number;
  hullName: string;
  sharedCacheDirectory?: string;
  converterPath?: string;
}

const execFileAsync = promisify(execFile);
const DEFAULT_SHARED_CACHE_DIRECTORY = 'C:\\CCP\\EVE';
const DEFAULT_CONVERTER_PATH = resolve('.cache', 'tools', 'gr2tojson', 'gr2tojson.exe');
const EVE_RESOURCES_BASE_URL = 'https://resources.eveonline.com';
const RESOURCE_DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const MODEL_CACHE_DIRECTORY = resolve('.cache', 'models');
const IMPORT_WORK_DIRECTORY = resolve('.cache', 'eve-import');
const PREFERRED_LOD_LABEL = 'lod 320';
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BINARY_CHUNK_TYPE = 0x004e4942;
const ARRAY_BUFFER_TARGET = 34962;
const ELEMENT_ARRAY_BUFFER_TARGET = 34963;
const FLOAT_COMPONENT_TYPE = 5126;
const UNSIGNED_INT_COMPONENT_TYPE = 5125;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const alignToFourBytes = (length: number): number => (length + 3) & ~3;

const createPaddedBuffer = (buffer: Buffer, fill = 0): Buffer => {
  const padded = Buffer.alloc(alignToFourBytes(buffer.length), fill);
  buffer.copy(padded);
  return padded;
};

const computeNormals = (positions: Float32Array, indices: Uint32Array): Float32Array => {
  const normals = new Float32Array(positions.length);

  for (let index = 0; index < indices.length; index += 3) {
    const first = indices[index];
    const second = indices[index + 1];
    const third = indices[index + 2];
    if (first === undefined || second === undefined || third === undefined) continue;

    const a = first * 3;
    const b = second * 3;
    const c = third * 3;
    const abX = (positions[b] ?? 0) - (positions[a] ?? 0);
    const abY = (positions[b + 1] ?? 0) - (positions[a + 1] ?? 0);
    const abZ = (positions[b + 2] ?? 0) - (positions[a + 2] ?? 0);
    const acX = (positions[c] ?? 0) - (positions[a] ?? 0);
    const acY = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0);
    const acZ = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0);
    const normalX = abY * acZ - abZ * acY;
    const normalY = abZ * acX - abX * acZ;
    const normalZ = abX * acY - abY * acX;

    for (const offset of [a, b, c]) {
      normals[offset] = (normals[offset] ?? 0) + normalX;
      normals[offset + 1] = (normals[offset + 1] ?? 0) + normalY;
      normals[offset + 2] = (normals[offset + 2] ?? 0) + normalZ;
    }
  }

  for (let index = 0; index < normals.length; index += 3) {
    const x = normals[index] ?? 0;
    const y = normals[index + 1] ?? 0;
    const z = normals[index + 2] ?? 0;
    const length = Math.hypot(x, y, z) || 1;
    normals[index] = x / length;
    normals[index + 1] = y / length;
    normals[index + 2] = z / length;
  }

  return normals;
};

const getPositionBounds = (positions: Float32Array): { min: number[]; max: number[] } => {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];

  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] ?? 0;
      min[axis] = Math.min(min[axis] ?? value, value);
      max[axis] = Math.max(max[axis] ?? value, value);
    }
  }

  return { min, max };
};

const createGlb = (mesh: Gr2Mesh): Buffer => {
  const positions = Float32Array.from(mesh.vertex.position);
  const indices = Uint32Array.from(mesh.indices.flatMap((area) => area.faces));
  const normals = computeNormals(positions, indices);
  const positionBuffer = Buffer.from(positions.buffer);
  const normalBuffer = Buffer.from(normals.buffer);
  const indexBuffer = Buffer.from(indices.buffer);
  const positionOffset = 0;
  const normalOffset = alignToFourBytes(positionBuffer.length);
  const indexOffset = alignToFourBytes(normalOffset + normalBuffer.length);
  const binaryLength = alignToFourBytes(indexOffset + indexBuffer.length);
  const binary = Buffer.alloc(binaryLength);
  positionBuffer.copy(binary, positionOffset);
  normalBuffer.copy(binary, normalOffset);
  indexBuffer.copy(binary, indexOffset);
  const bounds = getPositionBounds(positions);

  const gltf = {
    asset: { version: '2.0', generator: 'wanderer-render-ships' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: mesh.name }],
    meshes: [{ name: mesh.name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: binaryLength }],
    bufferViews: [
      { buffer: 0, byteOffset: positionOffset, byteLength: positionBuffer.length, target: ARRAY_BUFFER_TARGET },
      { buffer: 0, byteOffset: normalOffset, byteLength: normalBuffer.length, target: ARRAY_BUFFER_TARGET },
      { buffer: 0, byteOffset: indexOffset, byteLength: indexBuffer.length, target: ELEMENT_ARRAY_BUFFER_TARGET },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: FLOAT_COMPONENT_TYPE,
        count: positions.length / 3,
        type: 'VEC3',
        min: bounds.min,
        max: bounds.max,
      },
      { bufferView: 1, componentType: FLOAT_COMPONENT_TYPE, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: UNSIGNED_INT_COMPONENT_TYPE, count: indices.length, type: 'SCALAR' },
    ],
  };
  const json = createPaddedBuffer(Buffer.from(JSON.stringify(gltf)), 0x20);
  const totalLength = 12 + 8 + json.length + 8 + binary.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(GLB_VERSION, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK_TYPE, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(BINARY_CHUNK_TYPE, 4);
  return Buffer.concat([header, jsonHeader, json, binaryHeader, binary]);
};

const selectRenderMesh = (meshes: Gr2Mesh[]): Gr2Mesh => {
  const preferred = meshes.find((mesh) => mesh.name.toLowerCase().includes(PREFERRED_LOD_LABEL));
  if (preferred) return preferred;
  const sorted = [...meshes].sort((left, right) => left.vertex.position.length - right.vertex.position.length);
  const fallback = sorted[0];
  if (!fallback) throw new Error('The GR2 model does not contain any meshes.');
  return fallback;
};

const findResourceHash = async (indexPath: string, hullName: string): Promise<string | null> => {
  const suffix = `/${hullName.toLowerCase()}.gr2`;
  const lines = createInterface({ input: createReadStream(indexPath), crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of lines) {
    const [resourcePath, resourceHash] = line.split(',');
    if (resourcePath?.toLowerCase().endsWith(suffix)) return resourceHash ?? null;
  }

  return null;
};

const writeAtomically = async (path: string, contents: Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, path);
};

const stageResource = async (resourcePath: string, resourceHash: string, targetPath: string): Promise<void> => {
  if (await pathExists(resourcePath)) {
    await copyFile(resourcePath, targetPath);
    return;
  }

  const response = await fetch(`${EVE_RESOURCES_BASE_URL}/${resourceHash}`, {
    signal: AbortSignal.timeout(RESOURCE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`EVE resource download returned HTTP ${response.status}.`);
  await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
};

export const getCachedModelPath = (typeId: number): string => join(MODEL_CACHE_DIRECTORY, `${typeId}.glb`);

export const importEveModel = async (options: EveModelImportOptions): Promise<string> => {
  const outputPath = getCachedModelPath(options.typeId);
  if (await pathExists(outputPath)) return outputPath;

  const sharedCacheDirectory = resolve(options.sharedCacheDirectory ?? DEFAULT_SHARED_CACHE_DIRECTORY);
  const converterPath = resolve(options.converterPath ?? DEFAULT_CONVERTER_PATH);
  const indexPath = join(sharedCacheDirectory, 'tq', 'resfileindex.txt');
  if (!(await pathExists(indexPath))) throw new Error(`EVE resource index was not found at ${indexPath}.`);
  if (!(await pathExists(converterPath))) throw new Error(`GR2 converter was not found at ${converterPath}.`);

  const resourceHash = await findResourceHash(indexPath, options.hullName);
  if (!resourceHash) throw new Error(`Hull ${options.hullName}.gr2 was not found in the EVE resource index.`);
  const resourcePath = join(sharedCacheDirectory, 'ResFiles', ...resourceHash.split('/'));

  const workDirectory = join(IMPORT_WORK_DIRECTORY, String(options.typeId));
  const gr2Path = join(workDirectory, `${options.hullName}.gr2`);
  const jsonPath = `${gr2Path}.gr2_json`;
  await mkdir(workDirectory, { recursive: true });
  await stageResource(resourcePath, resourceHash, gr2Path);

  try {
    await execFileAsync(converterPath, [gr2Path], { cwd: dirname(converterPath), windowsHide: true });
    const source = (await readFile(jsonPath, 'utf8')).replace(/-nan\(ind\)|-inf|inf/g, '0');
    const model = JSON.parse(source) as Gr2Json;
    const renderMesh = selectRenderMesh(model.meshes);
    await writeAtomically(outputPath, createGlb(renderMesh));
    return outputPath;
  } finally {
    await unlink(gr2Path).catch(() => undefined);
    await unlink(jsonPath).catch(() => undefined);
  }
};
