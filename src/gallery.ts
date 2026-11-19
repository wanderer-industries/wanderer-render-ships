import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const GALLERY_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Wanderer ship holograms</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #020617; color: #e2e8f0; }
      body { margin: 0; background: radial-gradient(circle at top, #172554 0, #020617 50%); min-height: 100vh; }
      header { position: sticky; top: 0; z-index: 2; padding: 18px 24px; background: rgba(2, 6, 23, .9); border-bottom: 1px solid #1e3a5f; backdrop-filter: blur(12px); }
      h1 { margin: 0 0 12px; font-size: 18px; }
      input { width: min(420px, 90vw); padding: 9px 12px; color: inherit; background: #0f172a; border: 1px solid #334155; }
      #meta { margin-left: 12px; color: #7dd3fc; font-size: 12px; }
      main { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; padding: 24px; }
      article { overflow: hidden; background: rgba(15, 23, 42, .78); border: 1px solid #1e3a5f; }
      article:hover { border-color: #67e8f9; box-shadow: 0 0 24px rgba(34, 211, 238, .18); }
      img { display: block; width: 100%; aspect-ratio: 1; object-fit: contain; background-image: linear-gradient(rgba(56,189,248,.05) 1px, transparent 1px), linear-gradient(90deg,rgba(56,189,248,.05) 1px,transparent 1px); background-size: 16px 16px; }
      div { padding: 9px 10px; }
      strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
      small { color: #64748b; }
    </style>
  </head>
  <body>
    <header><h1>Wanderer ship holograms</h1><input id="search" type="search" placeholder="Search ship or type ID" /><span id="meta"></span></header>
    <main id="ships"></main>
    <script type="module">
      const manifest = await fetch('./manifest.json', { cache: 'no-store' }).then(response => response.json());
      const root = document.querySelector('#ships');
      const search = document.querySelector('#search');
      document.querySelector('#meta').textContent = manifest.totals.generated + ' generated';
      const render = () => {
        const query = search.value.trim().toLowerCase();
        root.replaceChildren(...manifest.ships.filter(ship => !query || ship.name.toLowerCase().includes(query) || String(ship.typeId).includes(query)).map(ship => {
          const article = document.createElement('article');
          const image = document.createElement('img');
          image.loading = 'lazy';
          image.src = ship.files[0];
          image.alt = ship.name;
          const info = document.createElement('div');
          const name = document.createElement('strong');
          name.textContent = ship.name;
          const details = document.createElement('small');
          details.textContent = ship.typeId + (ship.groupName ? ' · ' + ship.groupName : '');
          info.append(name, details);
          article.append(image, info);
          return article;
        }));
      };
      search.addEventListener('input', render);
      render();
    </script>
  </body>
</html>`;

export const writeGallery = async (outputDirectory: string): Promise<void> => {
  await writeFile(join(outputDirectory, 'index.html'), GALLERY_HTML, 'utf8');
};
