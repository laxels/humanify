import { visitAllIdentifiers } from "./visit-all-identifiers.js";
import { showProgress } from "../progress.js";
import { verbose } from "../verbose.js";
import { anthropicToolUse } from "./anthropic-tool-use.js";

export function anthropicRename({
  model,
  contextWindowSize,
}: {
  model?: string;
  contextWindowSize: number;
}) {
  return async (code: string): Promise<string> => {
    return await visitAllIdentifiers(
      code,
      async (name, surroundingCode) => {
        verbose.log(`Renaming ${name}`);
        verbose.log("Context: ", surroundingCode);

        const result = await anthropicToolUse<{ newName: string }>({
          model,
          system: `Rename Javascript variables/function \`${name}\` to have descriptive name based on their usage in the code."`,
          content: surroundingCode,
          tool: {
            name: "rename",
            description: "Provide the new name for the identifier",
            input_schema: {
              type: "object" as const,
              properties: {
                newName: {
                  type: "string",
                  description: `The new name for the variable/function called \`${name}\``,
                },
              },
              required: ["newName"],
            },
          },
        });

        verbose.log(`Renamed to ${result.newName}`);

        return result.newName;
      },
      contextWindowSize,
      showProgress,
    );
  };
}
