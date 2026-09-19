import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/**
 * Serves the immutable reference tree for read-only browser inspection.
 * It intentionally implements neither writes nor directory listings.
 */
export async function startReadonlyReferenceServer(referenceRoot) {
  const root = resolve(referenceRoot);
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const target = resolve(root, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
      if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("out of scope");
      const body = await readFile(target);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": mime[extname(target).toLowerCase()] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else response.end(body);
    } catch {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end("Not found");
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}
