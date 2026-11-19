import sharp from 'sharp';
import type { OutputFormat, RgbColor } from './types.js';

type SharpInstance = ReturnType<typeof sharp>;

export interface HologramOptions {
  size: number;
  format: OutputFormat;
  quality: number;
  color: RgbColor;
}

const CHANNEL_COUNT = 4;
const OPAQUE_EDGE_FLOOR = 20;
const OPAQUE_EDGE_SCALE = 0.9;
const EDGE_SUPPORT_RADIUS = 2;
const MIN_EDGE_NEIGHBORS = 4;
const MIN_EDGE_COMPONENT_SIZE = 18;
const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1] as const;
const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1] as const;

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

const getPixelOffset = (x: number, y: number, width: number): number => (y * width + x) * CHANNEL_COUNT;

const getSample = (values: Float32Array, x: number, y: number, width: number, height: number): number => {
  const boundedX = Math.max(0, Math.min(width - 1, x));
  const boundedY = Math.max(0, Math.min(height - 1, y));
  return values[boundedY * width + boundedX] ?? 0;
};

const calculateGradient = (values: Float32Array, x: number, y: number, width: number, height: number): number => {
  let gradientX = 0;
  let gradientY = 0;
  let kernelIndex = 0;

  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const sample = getSample(values, x + offsetX, y + offsetY, width, height);
      gradientX += sample * (SOBEL_X[kernelIndex] ?? 0);
      gradientY += sample * (SOBEL_Y[kernelIndex] ?? 0);
      kernelIndex += 1;
    }
  }

  return Math.min(255, Math.hypot(gradientX, gradientY) * 0.32);
};

const countEdgeNeighbors = (values: Float32Array, x: number, y: number, width: number, height: number): number => {
  let neighbors = 0;

  for (let offsetY = -EDGE_SUPPORT_RADIUS; offsetY <= EDGE_SUPPORT_RADIUS; offsetY += 1) {
    for (let offsetX = -EDGE_SUPPORT_RADIUS; offsetX <= EDGE_SUPPORT_RADIUS; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue;
      if (getSample(values, x + offsetX, y + offsetY, width, height) > OPAQUE_EDGE_FLOOR) neighbors += 1;
    }
  }

  return neighbors;
};

const findSupportedEdges = (values: Float32Array, width: number, height: number): Uint8Array => {
  const candidates = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const edge = values[index] ?? 0;
      const neighbors = countEdgeNeighbors(values, x, y, width, height);
      if (edge > OPAQUE_EDGE_FLOOR && neighbors >= MIN_EDGE_NEIGHBORS) candidates[index] = 1;
    }
  }

  const retained = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);

  for (let start = 0; start < candidates.length; start += 1) {
    if (!candidates[start] || visited[start]) continue;

    const component: number[] = [];
    const queue = [start];
    visited[start] = 1;

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const index = queue[queueIndex];
      if (index === undefined) continue;
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const neighborX = x + offsetX;
          const neighborY = y + offsetY;
          if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
          const neighborIndex = neighborY * width + neighborX;
          if (!candidates[neighborIndex] || visited[neighborIndex]) continue;
          visited[neighborIndex] = 1;
          queue.push(neighborIndex);
        }
      }
    }

    if (component.length < MIN_EDGE_COMPONENT_SIZE) continue;
    for (const index of component) retained[index] = 1;
  }

  return retained;
};

const encodeOutput = async (
  image: SharpInstance,
  format: Exclude<OutputFormat, 'both'>,
  quality: number,
): Promise<Buffer> => {
  if (format === 'png') return image.png({ compressionLevel: 9, palette: false }).toBuffer();
  return image.webp({ quality, alphaQuality: 100, effort: 5 }).toBuffer();
};

export const createHologram = async (input: Buffer, options: HologramOptions): Promise<Map<string, Buffer>> => {
  const sourceMetadata = await sharp(input).metadata();
  const sourceHasAlpha = sourceMetadata.hasAlpha;
  const { data, info } = await sharp(input)
    .resize(options.size, options.size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      withoutEnlargement: false,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const luminance = new Float32Array(info.width * info.height);
  const alphaValues = new Float32Array(info.width * info.height);

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const pixelOffset = getPixelOffset(x, y, info.width);
      const red = data[pixelOffset] ?? 0;
      const green = data[pixelOffset + 1] ?? 0;
      const blue = data[pixelOffset + 2] ?? 0;
      const alpha = data[pixelOffset + 3] ?? 0;
      const index = y * info.width + x;
      alphaValues[index] = alpha;
      luminance[index] = (red * 0.2126 + green * 0.7152 + blue * 0.0722) * (alpha / 255);
    }
  }

  const core = Buffer.alloc(info.width * info.height * CHANNEL_COUNT);
  const glow = Buffer.alloc(info.width * info.height * CHANNEL_COUNT);
  const surfaceEdges = new Float32Array(info.width * info.height);

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      surfaceEdges[y * info.width + x] = calculateGradient(luminance, x, y, info.width, info.height);
    }
  }
  const supportedEdges = findSupportedEdges(surfaceEdges, info.width, info.height);

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const pixelOffset = getPixelOffset(x, y, info.width);
      const alpha = data[pixelOffset + 3] ?? 0;
      const light = luminance[y * info.width + x] ?? 0;
      const surfaceEdge = surfaceEdges[y * info.width + x] ?? 0;
      const silhouetteEdge = calculateGradient(alphaValues, x, y, info.width, info.height);
      const rawEdge = sourceHasAlpha ? surfaceEdge * 1.25 + silhouetteEdge * 1.45 : surfaceEdge;
      const edgeFloor = sourceHasAlpha ? 0 : OPAQUE_EDGE_FLOOR;
      const edgeMultiplier = sourceHasAlpha ? 1 : OPAQUE_EDGE_SCALE;
      const hasEdgeSupport = sourceHasAlpha || supportedEdges[y * info.width + x] === 1;
      const normalizedX = Math.abs((x - info.width / 2) / (info.width / 2));
      const normalizedY = Math.abs((y - info.height / 2) / (info.height / 2));
      const borderFade = Math.min(1, Math.max(0.15, (1.06 - Math.max(normalizedX, normalizedY)) / 0.18));
      let edge = 0;
      if (hasEdgeSupport) {
        edge = Math.min(190, Math.max(0, rawEdge - edgeFloor) * edgeMultiplier * borderFade);
      }
      const alphaRatio = alpha / 255;
      const body = sourceHasAlpha ? alphaRatio * (22 + light * 0.2) : 0;
      const scanline = y % 4 === 0 ? 0.74 : 1;
      const flicker = 0.94 + (((x * 17 + y * 31) % 13) / 13) * 0.06;
      const outputAlpha = clampByte(Math.max(body, edge * 0.78) * scanline * flicker);
      const edgeRatio = edge / 190;

      core[pixelOffset] = clampByte(options.color.red + (255 - options.color.red) * edgeRatio * 0.35);
      core[pixelOffset + 1] = clampByte(options.color.green + (255 - options.color.green) * edgeRatio * 0.35);
      core[pixelOffset + 2] = clampByte(options.color.blue + (255 - options.color.blue) * edgeRatio * 0.35);
      core[pixelOffset + 3] = outputAlpha;

      glow[pixelOffset] = options.color.red;
      glow[pixelOffset + 1] = options.color.green;
      glow[pixelOffset + 2] = options.color.blue;
      glow[pixelOffset + 3] = clampByte(edge * 0.22);
    }
  }

  const rawDescriptor = { raw: { width: info.width, height: info.height, channels: CHANNEL_COUNT as 4 } };
  const glowLayer = await sharp(glow, rawDescriptor)
    .blur(Math.max(0.8, options.size / 180))
    .png()
    .toBuffer();
  const coreLayer = await sharp(core, rawDescriptor).png().toBuffer();
  const composed = sharp({
    create: { width: info.width, height: info.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([
    { input: glowLayer, blend: 'screen' },
    { input: coreLayer, blend: 'screen' },
  ]);

  const outputs = new Map<string, Buffer>();
  if (options.format === 'webp' || options.format === 'both') {
    outputs.set('webp', await encodeOutput(composed.clone(), 'webp', options.quality));
  }
  if (options.format === 'png' || options.format === 'both') {
    outputs.set('png', await encodeOutput(composed.clone(), 'png', options.quality));
  }
  return outputs;
};
