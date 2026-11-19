# Wanderer Render Ships

Generates transparent, CDN-ready hologram images for every published ship type in EVE Online.

The generator discovers ship type IDs from ESI category `6` (`Ship`), downloads official type renders from the EVE Image Server and applies a local hologram pipeline:

- luminous hull detail extracted from the source render;
- Sobel edges from the hull silhouette and surface lighting;
- cyan/white emissive color;
- subtle scanlines and deterministic flicker;
- transparent background and bloom;
- optimized WebP and/or PNG output.

It does not redistribute or emulate the EVE client renderer. Generated images are derivatives of the official static type renders.

The EVE Image Server returns a ship render as an opaque JPEG with a baked-in space background. The generator therefore detects hull edges, rejects small disconnected background highlights, and builds a new transparent hologram layer. It is an approximation of the in-client hologram, not the original 3D model or CCP shader.

## Requirements

- Node.js 20 or newer;
- internet access to `esi.evetech.net` and `images.evetech.net`.

## Install

```bash
npm install
```

## Generate

Test three ships first:

```bash
npm run generate:sample
npm run serve
```

Open <http://localhost:4173> to inspect the generated gallery.

## 3D model viewer

The project also includes a separate WebGL laboratory for finding a repeatable ship pose before the hologram shader is added:

```bash
npm run viewer
```

Open <http://127.0.0.1:4174/?typeId=587>. The viewer provides:

- GLB loading by EVE type ID;
- loading an arbitrary GLB/GLTF URL or local file;
- Draco-compressed geometry support;
- pitch, yaw and roll controls;
- a `Nose right` preset (`-10° / 90° / 0°`);
- orthographic camera and automatic framing;
- selectable `Phantom gray`, `Bright wireframe` and original-material modes;
- mouse orbit/zoom and PNG export.

The default prototype provider is the community [EVE Model Gallery](https://github.com/EstamelGG/EVE_Model_Gallery), where models follow the `{typeID}_lite.glb` convention. Override it without changing code:

```bash
$env:VITE_MODEL_BASE_URL = "https://cdn.example.com/eve-models"
npm run viewer
```

This provider is deliberately isolated from the renderer. A later CCPWGL or locally extracted EVE-client resource provider can replace it while preserving camera, orientation and capture behavior. Review CCP's content license and the selected model provider's provenance before republishing models or derived renders.

Run the real-browser WebGL smoke test using an installed Chrome or Edge:

```bash
npm run viewer:smoke
```

It loads type `587`, waits for decoded geometry and writes a screenshot under `test-output/`.

Generate the curated ten-ship comparison set with the default gray phantom preset:

```bash
npm run viewer:batch
```

Generate the brighter wireframe variant separately:

```bash
npm run viewer:batch:wireframe
```

These commands write mode-suffixed model PNGs and contact sheets under `dist/ships-3d/samples/`, so the two looks do not overwrite each other. The current set contains Megathron, Vindicator, Vargur, Heron, Rifter, Drake, Raven, Apocalypse, Dominix and Machariel.

## Transparent 3D ship catalog

`Phantom gray` is the default CDN preset. Discover every ship type exposed by ESI category `6` without rendering:

```bash
npm run ships:list
```

This writes `dist/ships-3d/phantom-gray/catalog.json` with every discovered type ID and ship name.

The generator joins that list with the official CCP SDE. It first follows `variationParentTypeID`, then uses the graphics `sofHullName` to catch cosmetic/event editions that have no variation parent. Finally it groups records by `iconFolder` to recognize reskins whose SOF hull suffix differs, such as Python (`conb1_xx`) and Marshal (`conb1_t1`). A hull is rendered once and copied to every related `{typeId}.png`; differing `graphicID` values only represent materials that the texture-free phantom does not need.

If the community GLB gallery does not contain a new standalone hull, the renderer checks `.cache/models/{typeId}.glb`. When the EVE client cache index exists at `C:\\CCP\\EVE` and the Cyno Exporter `gr2tojson` files are installed under `.cache/tools/gr2tojson`, it automatically imports the official GR2 geometry and retries the render. A resource missing from the local `ResFiles` cache is downloaded from the official EVE resources CDN. The imported GLB contains one medium-detail LOD and no textures, which is sufficient for the phantom shader.

Install the external converter by copying `gr2tojson.exe` and `granny2.dll` from [Cyno Exporter](https://github.com/palmbeachcat/cyno-exporter) into `.cache/tools/gr2tojson`. A hull can also be imported explicitly:

```powershell
npm run models:import:eve -- 85086 deabc1_t1
```

Render the full catalog as individual transparent PNG files:

```bash
npm run ships:render
```

Outputs use the stable type-ID convention `dist/ships-3d/phantom-gray/{typeId}.png`; no contact sheet is created. Existing files are skipped, so an interrupted run can be resumed with the same command. Pass `--force` to replace them. A final `manifest.json` contains successful files and model-provider failures.

Useful targeted runs:

```bash
npx tsx src/render-3d-ships.ts --ids 587,605,641 --force
npx tsx src/render-3d-ships.ts --limit 25
npx tsx src/render-3d-ships.ts --width 1024 --height 512
npm run ships:render:megathron-family
```

Generate all published ship types:

```bash
npm run generate -- -- --size 512 --format webp
```

Generate selected ships:

```bash
npm run generate -- -- --ids "587,11192" --size 512 --format both --force
```

The extra `--` keeps recent npm versions on Windows from consuming generator flags. You can also bypass npm argument forwarding with `npx tsx src/cli.ts --ids 587 11192`.

Useful options:

```text
--output <directory>     Output directory, default dist
--cache <directory>      Original render cache, default .cache/renders
--size <number>          32, 64, 128, 256, 512 or 1024
--format <format>        webp, png or both
--quality <number>       WebP quality from 1 through 100
--concurrency <number>   Concurrent downloads and conversions
--color <hex>            Hologram color, default #d8f3ff
--ids <id,id,...>        Render only specific type IDs
--limit <number>         Render only the first N discovered ships
--force                  Refresh source cache and generated images
--dry-run                Print discovered ships without downloading renders
```

## Output

```text
dist/
  index.html
  manifest.json
  ships/
    512/
      587.webp
      11192.webp
```

Stable CDN URL convention:

```text
https://ships.example.com/ships/512/{type_id}.webp
```

The manifest contains ship names, group metadata, source URLs, generated paths, SHA-256 checksums and failures. A failed image does not stop the rest of the batch.

## Hosting

The contents of `dist/` are static and can be uploaded directly to S3, Cloudflare R2, nginx, GitHub Pages or another CDN origin.

For a small nginx container:

```bash
docker build -t wanderer-render-ships .
docker run --rm -p 8080:80 wanderer-render-ships
```

The included nginx configuration enables CORS and immutable one-year caching for versioned image paths. Do not overwrite an existing path if you need immediate cache invalidation; publish a new size/style path or add a version segment.

## Use in Wanderer

```ts
export const getShipHologramUrl = (typeId: number): string => {
  return `https://ships.example.com/ships/512/${typeId}.webp`;
};
```

Keep the official EVE Image Server as a fallback while the generated catalog is being rolled out.

## Updating

Run the full command after EVE releases that add or change hulls. Source renders are cached in `.cache/renders`; pass `--force` when CCP updates existing renders.

## Validation

```bash
npm run typecheck
npm test
npm run format:check
```

## EVE assets and attribution

EVE Online and the EVE logo are the registered trademarks of CCP hf. This project is not affiliated with CCP hf. Review the current EVE Online Developer License Agreement and CCP content usage requirements before publishing generated assets. The code and generated image rights are not interchangeable: generated ship imagery remains subject to CCP's terms.
