/**
 * dev.ts — one command for working on the page: the bundle in watch mode plus a static
 * server for `public/`, so `bun run dev` and then opening the printed URL is the whole setup.
 *
 * A watch build alone leaves you staring at an empty address bar, and `bun run serve` alone
 * serves a bundle you forgot to rebuild. This does both and says which port it took.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "./serve";

const root = resolve(import.meta.dir, "..");
const port = Number(process.env.PORT ?? 8080);
const bundle = resolve(root, "public/skisphere.js");

const watcher = spawn(
  "bun",
  ["build", "src/main.ts", "--outfile", "public/skisphere.js", "--target", "browser", "--watch"],
  { cwd: root, stdio: "inherit" },
);

const server = startServer(port);

console.log(`\n  Skisphere → http://127.0.0.1:${server.port}/`);
console.log(`  serving ${resolve(root, "public")}`);
if (!existsSync(bundle)) console.log("  first build is still running — reload once it prints the bundle size");
console.log("  watching src/ · ctrl-C stops the watcher and the server\n");

const stop = () => {
  watcher.kill("SIGTERM");
  server.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);