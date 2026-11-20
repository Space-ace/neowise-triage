import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp, triage } from "./server.mjs";
import { mount } from "./client.mjs";

const manual = { status: "manual_review", topic: null, draft: null };

test("HTTP contract with the unchanged model simulator", async (t) => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function post(body) {
    const response = await fetch(url + "/api/triage", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    return [response.status, await response.json()];
  }
  for (const body of ["{", "null", "[]", "{}", '{"text":null}', '{"text":42}', '{"text":false}', '{"text":{}}', '{"text":[]}', '{"text":""}', '{"text":" \\n "}']) {
    assert.deepEqual(await post(body), [400, { status: "invalid_input" }], body);
  }
  for (const [text, topic] of [["Доставка", "delivery"], ["Стоимость", "pricing"], ["Привет", "other"]]) {
    const [status, data] = await post(JSON.stringify({ text }));
    assert.equal(status, 200);
    assert.equal(data.status, "ready");
    assert.equal(data.topic, topic);
    assert.ok(data.draft.trim());
  }
  for (const text of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    assert.deepEqual(await post(JSON.stringify({ text })), [200, manual], text);
  }
  assert.equal((await fetch(url + "/")).status, 200);
  assert.match(await (await fetch(url + "/client.mjs")).text(), /export function mount/);
});

test("deadline works even if provider ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const pending = triage("hello", (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  await Promise.resolve();
  t.mock.timers.tick(300);
  assert.deepEqual(await pending, manual);
  assert.equal(signal.aborted, true);
});

test("model schema is validated and extra fields cannot override status", async () => {
  for (const value of [null, [], {}, { topic: "delivery", draft: 5 }, { topic: "refund", draft: "hello" }]) {
    assert.deepEqual(await triage("hello", async () => JSON.stringify(value)), manual);
  }
  assert.deepEqual(await triage("hello", async () => JSON.stringify({ topic: "other", draft: " OK ", status: "bad" })),
    { status: "ready", topic: "other", draft: "OK" });
});

function ui(fetchImpl) {
  let submit;
  const message = { value: "Заявка" };
  const result = { textContent: "" };
  mount({ form: { addEventListener: (_, handler) => { submit = handler; } }, message, result, fetchImpl });
  return { message, result, submit: () => submit({ preventDefault() {} }) };
}
const ready = draft => ({ ok: true, status: 200, json: async () => ({ status: "ready", topic: "other", draft }) });

test("UI clears previous draft on every failure and keeps original input", async () => {
  for (const failure of [
    async () => ({ ok: true, json: async () => manual }),
    async () => { throw new Error("Network down"); },
    async () => ({ ok: true, json: async () => { throw new Error("Bad JSON"); } }),
    async () => ({ ok: false, status: 502, json: async () => ({}) }),
  ]) {
    let count = 0;
    const app = ui(() => ++count === 1 ? Promise.resolve(ready("OLD DRAFT")) : failure());
    await app.submit();
    assert.match(app.result.textContent, /OLD DRAFT/);
    await app.submit();
    assert.match(app.result.textContent, /ручной разбор/);
    assert.doesNotMatch(app.result.textContent, /OLD DRAFT/);
    assert.equal(app.message.value, "Заявка");
  }
});

test("UI ignores stale successes and errors, including after empty input", async () => {
  for (const rejectOld of [false, true]) {
    const pending = [];
    const app = ui(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    const a = app.submit();
    const b = app.submit();
    pending[1].resolve(ready("NEW"));
    await b;
    if (rejectOld) pending[0].reject(new Error("old error"));
    else pending[0].resolve(ready("OLD"));
    await a;
    assert.match(app.result.textContent, /NEW/);
    assert.doesNotMatch(app.result.textContent, /OLD|ручной/);
    const c = app.submit();
    app.message.value = "   ";
    await app.submit();
    pending[2].resolve(ready("STALE"));
    await c;
    assert.equal(app.result.textContent, "Введите текст заявки.");
    assert.equal(pending.length, 3);
  }
});
