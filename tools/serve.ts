/**
 * serve.ts — a two-minute static server for `public/`, so the page can be opened over http
 * (geolocation and the clipboard need a secure context; localhost counts as one).
 */
import { join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "public");
const port = Number(process.env.PORT ?? 8080);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

export function startServer(port = Number(process.env.PORT ?? 8080)) {
  return Bun.serve({
    port,
    async fetch(request) {
      let rel: string;
      try {
        rel = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, "") || "index.html");
      } catch {
        return new Response("bad request", { status: 400 });
      }
      const path = normalize(join(root, rel));
      if (!path.startsWith(root)) return new Response("forbidden", { status: 403 });
      const file = Bun.file(path);
      if (!(await file.exists())) return new Response(`not found: /${rel}`, { status: 404 });
      const type = TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream";
      return new Response(file, { headers: { "content-type": type, "cache-control": "no-store" } });
    },
  });
}

if (import.meta.main) {
  const server = startServer();
  console.log(`Skisphere on http://localhost:${server.port}/  (root ${root})`);
}