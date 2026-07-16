import { describe, expect, it } from "vitest";
import { Output } from "ai";
import { toJSONSchema } from "zod";

import { reportSchema } from "../agent/research-types";

describe("AI SDK structured output transport", () => {
  it("describes Output.object as JSON with the exact report schema", async () => {
    const output = Output.object({ schema: reportSchema });

    await expect(output.responseFormat).resolves.toEqual({
      type: "json",
      schema: toJSONSchema(reportSchema, { target: "draft-7" }),
    });
  });
});
