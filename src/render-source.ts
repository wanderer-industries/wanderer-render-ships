import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_BASE_URL } from './constants.js';
import { fetchWithRetry } from './http.js';

export const getRenderUrl = (typeId: number, size: number): string => {
  return `${IMAGE_BASE_URL}/types/${typeId}/render?size=${size}`;
};

export const getOriginalRender = async (
  typeId: number,
  size: number,
  cacheDirectory: string,
  force: boolean,
): Promise<{ buffer: Buffer; sourceUrl: string }> => {
  const cachePath = join(cacheDirectory, `${typeId}-${size}.img`);
  const sourceUrl = getRenderUrl(typeId, size);

  if (!force) {
    try {
      return { buffer: await readFile(cachePath), sourceUrl };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }

  const response = await fetchWithRetry(sourceUrl);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Unexpected content type for type ${typeId}: ${contentType || 'missing'}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(cachePath, buffer);
  return { buffer, sourceUrl };
};
