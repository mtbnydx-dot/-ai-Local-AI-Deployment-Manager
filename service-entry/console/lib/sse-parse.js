// Server-sent event frame splitter for streamed chat completions (07 §6.6),
// ported from the classic console's Playground loop (index.html).
//
// Feed it the accumulated text; it returns the complete frames and the
// incomplete tail to keep for the next chunk. Frames end at a blank line
// (LF, CRLF or CR line ends). Comment lines (": …") are skipped, several
// `data:` lines join with "\n", and `data: [DONE]` becomes { done: true }.

const FRAME_END = /\r\n\r\n|\n\n|\r\r/;

function parseFrame(frame) {
  const data = [];
  let event = null;
  let id = null;
  let seen = false;
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      data.push(value);
      seen = true;
    } else if (field === "event") {
      event = value;
      seen = true;
    } else if (field === "id") {
      id = value;
      seen = true;
    }
  }
  if (!seen || !data.length) return null;
  const text = data.join("\n");
  if (text.trim() === "[DONE]") return { event, id, done: true, data: null, raw: text };
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { event, id, done: false, data: json, raw: text };
}

/**
 * @param buffer text received so far (the previous `rest` plus the new chunk)
 * @returns {{ events: Array<{ event, id, done, data, raw }>, rest: string }}
 *   `data` is the parsed JSON, or null when the payload is not JSON.
 */
export function parseSseChunk(buffer) {
  const events = [];
  let rest = String(buffer ?? "");
  for (;;) {
    const match = FRAME_END.exec(rest);
    if (!match) break;
    const frame = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    const parsed = parseFrame(frame);
    if (parsed) events.push(parsed);
  }
  return { events, rest };
}
