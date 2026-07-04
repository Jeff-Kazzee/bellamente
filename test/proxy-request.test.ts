import { expect, test } from "bun:test";
import { hasToolResults, promptText, requestSummary } from "../src/proxy-request";

test("proxy request helpers summarize Chat Completions bodies and flatten text content", () => {
  const body = {
    model: "gpt-test",
    stream: true,
    tools: [{ type: "function", function: { name: "searchMemory" } }],
    messages: [
      { role: "system", content: "System rules" },
      {
        role: "user",
        content: [
          "First part",
          { type: "text", text: "second part" },
          { type: "image_url", image_url: { url: "data:" } },
          { type: "text", text: null },
        ],
      },
      { role: "tool", content: [{ type: "text", text: "tool output" }] },
      { role: "assistant", content: null },
    ],
  };

  expect(promptText(body)).toBe("system: System rules\nuser: First part\nsecond part\ntool: tool output");
  expect(hasToolResults(body)).toBe(true);
  expect(requestSummary(body)).toEqual({
    model: "gpt-test",
    messageCount: 4,
    toolCount: 1,
    hasSystem: true,
    stream: true,
  });
});

test("proxy request helpers handle missing or non-string request fields", () => {
  expect(promptText({ messages: [{ role: "user", content: 42 }] })).toBeUndefined();
  expect(hasToolResults({ messages: [{ role: "user", content: "hello" }] })).toBe(false);
  expect(requestSummary({ model: 42, messages: "not-array", tools: "not-array" })).toEqual({
    model: null,
    messageCount: 0,
    toolCount: 0,
    hasSystem: false,
    stream: false,
  });
});
