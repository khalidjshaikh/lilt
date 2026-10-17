#!/usr/bin/env node
/*
 * A tiny static server for local development.
 *
 * It listens on both loopback families:
 *   127.0.0.1  (IPv4)
 *   ::1        (IPv6)
 *
 * Loopback addresses are secure contexts, so the microphone API still works at
 * either http://127.0.0.1:8787 or http://[::1]:8787.
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT || 8787);
const hosts = ["127.0.0.1", "::1"];

const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
]);

function send(response, status, message, type = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  response.end(message);
}

async function handle(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    send(response, 405, "Method not allowed\n");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    send(response, 400, "Bad request\n");
    return;
  }

  if (pathname.endsWith("/")) pathname += "index.html";
  const file = resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    send(response, 403, "Forbidden\n");
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const type = MIME.get(extname(file).toLowerCase()) || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Length": info.size,
      "Cache-Control": "no-store",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => {
      if (!response.headersSent) send(response, 500, "Read error\n");
      else response.destroy();
    });
    stream.pipe(response);
  } catch {
    send(response, 404, "Not found\n");
  }
}

function listen(host) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((request, response) => {
      handle(request, response).catch(() => {
        if (!response.headersSent) send(response, 500, "Server error\n");
        else response.destroy();
      });
    });
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      server.on("error", (error) => {
        console.error(`[${host}] ${error.message}`);
      });
      resolvePromise(server);
    });
  });
}

const outcomes = await Promise.allSettled(hosts.map((host) => listen(host)));
const active = [];
for (let index = 0; index < outcomes.length; index += 1) {
  const outcome = outcomes[index];
  if (outcome.status === "fulfilled") {
    active.push({ host: hosts[index], server: outcome.value });
  } else {
    console.warn(`Could not listen on ${hosts[index]}: ${outcome.reason.message}`);
  }
}

if (active.length === 0) {
  console.error(`No listener could start on port ${port}.`);
  process.exit(1);
}

console.log(`\nLilt is listening on port ${port}:\n`);
console.log(`  http://localhost:${port}`);
for (const { host } of active) {
  console.log(host.includes(":") ? `  http://[${host}]:${port}` : `  http://${host}:${port}`);
}
console.log("\nMicrophone access works on any loopback address above.");
console.log("Press Ctrl+C to stop.\n");

function shutdown() {
  for (const { server } of active) server.close();
  setTimeout(() => process.exit(0), 100).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
