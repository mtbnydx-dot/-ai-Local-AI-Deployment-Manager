// 07 §6.6 SSE frame splitter for streamed completions: split frames,
// [DONE], comments, CRLF, multi-line data; plus the route header.

import assert from "node:assert/strict";
import test from "node:test";

import { describeRoute } from "../../console/lib/route-header.js";
import { parseSseChunk } from "../../console/lib/sse-parse.js";

const delta = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;

test("complete frames are parsed and the incomplete tail is kept", () => {
  const first = parseSseChunk(`${delta("Hel")}\n\n${delta("lo")}\n\ndata: {"choi`);
  assert.deepEqual(first.events.map((event) => event.data.choices[0].delta.content), ["Hel", "lo"]);
  assert.equal(first.rest, 'data: {"choi');
  const second = parseSseChunk(`${first.rest}ces":[{"delta":{"content":"!"}}]}\n\n`);
  assert.deepEqual(second.events.map((event) => event.data.choices[0].delta.content), ["!"]);
  assert.equal(second.rest, "");
});

test("a frame split anywhere, even inside the blank line, parses once complete", () => {
  const stream = `${delta("a")}\n\n${delta("b")}\n\ndata: [DONE]\n\n`;
  for (let cut = 0; cut <= stream.length; cut += 1) {
    const one = parseSseChunk(stream.slice(0, cut));
    const two = parseSseChunk(one.rest + stream.slice(cut));
    const all = [...one.events, ...two.events];
    assert.deepEqual(all.map((event) => (event.done ? "DONE" : event.data.choices[0].delta.content)), ["a", "b", "DONE"], `cut at ${cut}`);
    assert.equal(two.rest, "");
  }
});

test("[DONE] ends the stream, comments are skipped, CRLF and CR line ends work", () => {
  const { events, rest } = parseSseChunk(`: keep-alive\r\n\r\n${delta("x")}\r\n\r\ndata: [DONE]\r\n\r\n`);
  assert.equal(rest, "");
  assert.equal(events.length, 2);
  assert.equal(events[0].data.choices[0].delta.content, "x");
  assert.deepEqual({ done: events[1].done, data: events[1].data }, { done: true, data: null });
  const cr = parseSseChunk(`${delta("y")}\r\r`);
  assert.equal(cr.events[0].data.choices[0].delta.content, "y");
});

test("event, id and multi-line data fields; non-JSON payloads keep their raw text", () => {
  const { events } = parseSseChunk("event: message\nid: 7\ndata: {\"a\":\ndata: 1}\n\ndata:no-space\n\nevent: ping\n\n");
  assert.equal(events.length, 2, "a frame without data is dropped");
  assert.deepEqual(events[0], { event: "message", id: "7", done: false, data: { a: 1 }, raw: "{\"a\":\n1}" });
  assert.deepEqual(events[1], { event: null, id: null, done: false, data: null, raw: "no-space" });
});

test("empty and odd input is harmless", () => {
  assert.deepEqual(parseSseChunk(""), { events: [], rest: "" });
  assert.deepEqual(parseSseChunk(undefined), { events: [], rest: "" });
  assert.deepEqual(parseSseChunk("\n\n\n\n"), { events: [], rest: "" });
});

test("describeRoute summarises x-local-ai-route like the classic Playground", () => {
  const sep = ` ${String.fromCharCode(0xb7)} `;
  assert.deepEqual(describeRoute("vllm primary qwen3.8 capability:chat"), {
    manager: "vllm", instance: "primary", model: "qwen3.8", reason: "capability:chat", text: ["vllm", "primary", "qwen3.8", "capability:chat"].join(sep),
  });
  assert.equal(describeRoute("llama llama gemma default").text, ["llama", "gemma", "default"].join(sep), "an instance named like its manager is left out");
  assert.equal(describeRoute(new Headers({ "x-local-ai-route": "vllm a m r" })).model, "m");
  assert.equal(describeRoute({ headers: new Headers({ "x-local-ai-route": "vllm a m r" }) }).instance, "a");
  assert.equal(describeRoute(new Headers()), null);
  assert.equal(describeRoute(""), null);
});
