import { anthropicToolUse } from "../anthropic/tool-use";
import { showProgress } from "../progress";
import { verbose } from "../verbose";
import { visitAllIdentifiers } from "./visit-all-identifiers";

export async function renameIdentifiers(
  code: string,
  {
    model,
    contextWindowSize,
  }: {
    model?: string;
    contextWindowSize: number;
  },
): Promise<string> {
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
}
