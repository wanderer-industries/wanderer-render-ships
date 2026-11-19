import { importEveModel } from './eve-model-import.js';

const readValue = (args: string[], flag: string): string => {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const typeIdValue = args.includes('--type-id') ? readValue(args, '--type-id') : args[0];
  const typeId = Number.parseInt(typeIdValue ?? '', 10);
  if (!Number.isInteger(typeId) || typeId < 1) throw new Error('--type-id must be a positive integer.');
  const hullName = args.includes('--hull') ? readValue(args, '--hull') : args[1];
  if (!hullName) throw new Error('--hull requires a value.');
  const sharedCacheDirectory = args.includes('--shared-cache') ? readValue(args, '--shared-cache') : undefined;
  const converterPath = args.includes('--converter') ? readValue(args, '--converter') : undefined;
  const outputPath = await importEveModel({ typeId, hullName, sharedCacheDirectory, converterPath });
  process.stdout.write(`Imported ${hullName} as ${outputPath}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
