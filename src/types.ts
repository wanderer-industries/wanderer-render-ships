export type OutputFormat = 'webp' | 'png' | 'both';

export interface GeneratorOptions {
  outputDirectory: string;
  cacheDirectory: string;
  size: number;
  format: OutputFormat;
  quality: number;
  concurrency: number;
  force: boolean;
  dryRun: boolean;
  limit: number | null;
  typeIds: number[];
  color: RgbColor;
}

export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

export interface ShipType {
  typeId: number;
  name: string;
  groupId: number | null;
  groupName: string | null;
}

export interface GeneratedShip extends ShipType {
  files: string[];
  sourceUrl: string;
  sha256: string;
}

export interface FailedShip extends ShipType {
  error: string;
}

export interface ShipManifest {
  schemaVersion: 1;
  generatedAt: string;
  generatorVersion: string;
  source: {
    esi: string;
    images: string;
    categoryId: number;
  };
  settings: {
    size: number;
    format: OutputFormat;
    quality: number;
    color: RgbColor;
  };
  totals: {
    discovered: number;
    generated: number;
    failed: number;
  };
  ships: GeneratedShip[];
  failures: FailedShip[];
}
