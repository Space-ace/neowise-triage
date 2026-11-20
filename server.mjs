import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";
import { pathToFileURL } from "node:url";

const html = await readFile(new URL("./index.html", import.meta.url));
const client = await readFile(new URL("./client.mjs", import.meta.url));
const manualReview = { status: "manual_review", topic: null, draft: null };

export async function triage(text, model = classify, timeoutMs = 300) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Model timeout"));
        controller.abort();
      }, timeoutMs);
    });
    const raw = await Promise.race([
      Promise.resolve().then(() => model(text, { signal: controller.signal })),
      timeout,
    ]);
    const value = JSON.parse(raw);
    if (!value || !["delivery", "pricing", "other"].includes(value.topic)
        || typeof value.draft !== "string" || !value.draft.trim()) {
      return manualReview;
    }
    return { status: "ready", topic: value.topic, draft: value.draft.trim() };
  } catch {
    return manualReview;
  } finally {
    clearTimeout(timer);
  }
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleTriage(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }
  return json(response, 200, await triage(body.text.trim()));
}

export function createApp() {
return createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method === "GET" && request.url === "/client.mjs") {
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    response.end(client);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
