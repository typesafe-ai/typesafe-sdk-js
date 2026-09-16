import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
  { mode: "healthy", status: 200 },
  { mode: "abort", status: 200 },
  { mode: "abort", status: 503 },
])("exits cleanly after a handled $mode response ($status)", ({ mode, status }) => {
  const child = spawnSync(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/native-cancellation.mjs", import.meta.url)),
      mode,
      String(status),
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.stdout + child.stderr).toContain(
    mode === "abort" ? "PASS caught APIUserAbortError" : "PASS healthy response",
  );
  expect(child.status, child.stdout + child.stderr).toBe(0);
  expect(child.stdout).toContain("PASS normal process exit");
});
