// Run in a separate process: unhandled runtime rejections must not be swallowed by the runner.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { APIUserAbortError, noul, TypeSafeClient } from "../../src/index.ts";

const abort = process.argv[2] === "abort";
const status = Number(process.argv[3] ?? 200);
const controller = new AbortController();
const data = {
  model: "fixture",
  answers: { ok: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 1, output_tokens: 1 },
};
const server = createServer((_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  if (abort) res.flushHeaders();
  else res.end(JSON.stringify(data));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const client = new TypeSafeClient({
    apiKey: "synthetic",
    baseURL: `http://127.0.0.1:${server.address().port}`,
    retry: { maxRetries: 0 },
    fetch: async (url, init) => {
      assert.equal(new URL(url).hostname, "127.0.0.1");
      const response = await fetch(url, init);
      // Event-loop barrier, not a timing-based sleep. SDK sees headers first.
      if (abort) setImmediate(() => controller.abort());
      return response;
    },
  });
  const pending = client.systemOne(
    { state: "synthetic", questions: { ok: noul("?") } },
    { signal: controller.signal },
  );
  if (abort) {
    await assert.rejects(pending, APIUserAbortError);
    console.log("PASS caught APIUserAbortError");
  } else {
    assert.deepEqual(await pending, data);
    console.log("PASS healthy response");
  }
  await new Promise((resolve) => setImmediate(resolve));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
console.log("PASS normal process exit");
