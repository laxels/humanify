import assert from "node:assert";
import test from "node:test";
import { humanify } from "./test-utils.js";

test("anthropic throws error on missing file", async () => {
  await assert.rejects(humanify("anthropic", "nonexistent-file.js"));
});
