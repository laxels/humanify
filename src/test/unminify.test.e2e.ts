import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import assert from "node:assert";
import { humanify } from "../test-utils.js";
import { anthropicToolUse } from "../plugins/anthropic-tool-use.js";

const TEST_OUTPUT_DIR = "test-output";

test.afterEach(async () => {
  await rm(TEST_OUTPUT_DIR, { recursive: true, force: true });
});

test("Unminifies an example file successfully", async () => {
  const fileIsMinified = async (filename: string) => {
    const code = await readFile(filename, "utf-8");
    const result = await anthropicToolUse<{ rating: string }>({
      model: "claude-opus-4-5",
      system: `Your job is to read code and rate its readability and variable names. Answer "EXCELLENT", "GOOD" or "UNREADABLE".`,
      content: code,
      tool: {
        name: "rate_code",
        description: "Rate the readability of the code",
        input_schema: {
          type: "object" as const,
          properties: {
            rating: {
              type: "string",
              enum: ["EXCELLENT", "GOOD", "UNREADABLE"],
              description: "The readability rating of the code",
            },
          },
          required: ["rating"],
        },
      },
    });
    return result.rating;
  };

  const expectStartsWith = (expected: string[], actual: string) => {
    assert(
      expected.some((e) => actual.startsWith(e)),
      `Expected "${expected}" but got ${actual}`,
    );
  };

  await expectStartsWith(
    ["UNREADABLE"],
    await fileIsMinified(`fixtures/example.min.js`),
  );

  await humanify(
    "fixtures/example.min.js",
    "--verbose",
    "--outputDir",
    TEST_OUTPUT_DIR,
  );

  await expectStartsWith(
    ["EXCELLENT", "GOOD"],
    await fileIsMinified(`${TEST_OUTPUT_DIR}/deobfuscated.js`),
  );
});
