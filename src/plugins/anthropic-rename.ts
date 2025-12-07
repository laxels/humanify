import Anthropic from "@anthropic-ai/sdk";
import { visitAllIdentifiers } from "./local-llm-rename/visit-all-identifiers.js";
import { showPercentage } from "../progress.js";
import { verbose } from "../verbose.js";

export function anthropicRename({
  apiKey,
  model,
  contextWindowSize
}: {
  apiKey: string;
  model: string;
  contextWindowSize: number;
}) {
  const client = new Anthropic({ apiKey });

  return async (code: string): Promise<string> => {
    return await visitAllIdentifiers(
      code,
      async (name, surroundingCode) => {
        verbose.log(`Renaming ${name}`);
        verbose.log("Context: ", surroundingCode);

        const response = await client.messages.create({
          model,
          max_tokens: 100,
          system: `Rename Javascript variables/function \`${name}\` to have descriptive name based on their usage in the code."`,
          messages: [{ role: "user", content: surroundingCode }],
          tools: [
            {
              name: "rename",
              description: "Provide the new name for the identifier",
              input_schema: {
                type: "object" as const,
                properties: {
                  newName: {
                    type: "string",
                    description: `The new name for the variable/function called \`${name}\``
                  }
                },
                required: ["newName"]
              }
            }
          ],
          tool_choice: { type: "tool", name: "rename" }
        });

        const toolUse = response.content.find(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
        );
        if (!toolUse) {
          throw new Error("Failed to rename: no tool use in response", {
            cause: response
          });
        }

        const renamed = (toolUse.input as { newName: string }).newName;

        verbose.log(`Renamed to ${renamed}`);

        return renamed;
      },
      contextWindowSize,
      showPercentage
    );
  };
}
