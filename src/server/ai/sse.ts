// minimal Server-Sent Events reader for streamed provider responses (fetch body → events)

export type SseEvent = { event: string | null; data: string };

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  const flush = (): SseEvent | null => {
    if (!data.length && event === null) return null;
    const out = { event, data: data.join("\n") };
    event = null;
    data = [];
    return out;
  };
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r\n|\n|\r/)) >= 0) {
        // a trailing "\r" may be the first half of "\r\n" split across chunks: wait for the next chunk
        if (buffer[nl] === "\r" && nl === buffer.length - 1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          const ev = flush();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keep-alive
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split(/\r\n|\n|\r/)) {
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (line.startsWith("event:")) event = line.slice(6).trimStart();
      }
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
