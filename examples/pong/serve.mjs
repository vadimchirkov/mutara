// Zero-dependency static server for the Pong viewer.
// Serves examples/pong/ so view.html can poll progress.json (file://
// blocks fetch). Run: node examples/pong/serve.mjs [port].
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, extname, normalize } from "node:path";

const root = new URL("./", import.meta.url).pathname;
const port = Number(process.argv[2] ?? 8901);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };

createServer(async (req, res) => {
  try {
    const path = normalize(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "view.html"));
    if (!path.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => console.log(`pong viewer: http://localhost:${port}/view.html`));
