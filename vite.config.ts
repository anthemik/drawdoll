import { defineConfig, Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dev-only: POST a PNG to /__shot?name=x and it is written to $DRAWDOLL_SHOTS/x.png.
 * Lets tooling inspect full-resolution renders. Inactive unless the env var is set.
 */
function shots(): Plugin {
  return {
    name: 'drawdoll-shots',
    apply: 'serve',
    configureServer(server) {
      const dir = process.env.DRAWDOLL_SHOTS;
      if (!dir) return;
      server.middlewares.use('/__shot', (req, res) => {
        const name = (new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? 'shot').replace(/[^\w-]/g, '');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${name}.png`), Buffer.concat(chunks));
            res.end('ok');
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  server: { port: 5173 },
  // three.js alone is ~550 kB; one bundle is fine for an app that loads once.
  build: { chunkSizeWarningLimit: 800 },
  plugins: [shots()],
});
