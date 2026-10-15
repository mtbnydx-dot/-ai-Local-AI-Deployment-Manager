// A Server-Sent Events reader for fetch() streams (05 §12.6). The playground
// cannot use EventSource (it sends no Authorization header and no POST body),
// so the response body is decoded and split into events here. The parser
// follows the WHATWG rules that matter for OpenAI- and Anthropic-style
// streams: LF, CRLF and CR line ends, multi-line data, comment lines, an
// optional leading BOM, and an event without a trailing blank line at the end
// of the stream (dispatched, because a proxy may cut the last newline).

/**
 * createSseParser(onEvent) -> { push(text), end() }
 *   onEvent({ event, data, id }) -- `event` defaults to "message", `data` joins
 *   the data lines with "\n". An event with no data line is not dispatched.
 */
export function createSseParser(onEvent) {
  let buffer = "";
  let started = false;
  let event = "";
  let id = "";
  let data = [];
  let hasData = false;

  function dispatch() {
    if (hasData) onEvent({ event: event || "message", data: data.join("\n"), id });
    event = "";
    data = [];
    hasData = false;
  }

  function line(text) {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      data.push(value);
      hasData = true;
    } else if (field === "event") {
      event = value;
    } else if (field === "id" && !value.includes("\0")) {
      id = value;
    }
    // "retry" and unknown fields are ignored.
  }

  function drain(final) {
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const char = buffer[index];
      if (char !== "\n" && char !== "\r") continue;
      // A CR at the very end may be the first half of a CRLF; wait for the next chunk.
      if (char === "\r" && index === buffer.length - 1 && !final) break;
      line(buffer.slice(start, index));
      if (char === "\r" && buffer[index + 1] === "\n") index += 1;
      start = index + 1;
    }
    buffer = buffer.slice(start);
  }

  return {
    push(text) {
      let chunk = String(text ?? "");
      if (!started && chunk) {
        started = true;
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      }
      buffer += chunk;
      drain(false);
    },
    end() {
      drain(true);
      if (buffer) {
        line(buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error("Aborted"), { name: "AbortError" });
}

/**
 * Reads a fetch() response body to its end, calling onEvent for every SSE
 * event. An abort rejects with the AbortError the fetch signal carries; the
 * events already delivered stay delivered.
 */
export async function readSseStream(body, onEvent, { signal } = {}) {
  if (!body || typeof body.getReader !== "function") throw new TypeError("The response has no readable body");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = createSseParser(onEvent);
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    if (signal?.aborted) throw abortError(signal);
    parser.push(decoder.decode());
    parser.end();
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A pending read keeps the lock; the stream is finished with anyway.
    }
  }
}
