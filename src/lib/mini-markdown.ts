// A deliberately tiny markdown subset for assistant answers: paragraphs, bullet/numbered lists, **bold**, `code`
// and links. It returns a tree that React renders as elements (never HTML strings), so model output can't inject markup.
// Only in-app links (starting with a single "/") become links; anything else stays plain text.

export type Inline = { t: "text"; v: string } | { t: "b"; c: Inline[] } | { t: "code"; v: string } | { t: "link"; href: string; c: Inline[] };
export type Block = { t: "p"; c: Inline[] } | { t: "ul"; items: Inline[][] } | { t: "ol"; items: Inline[][] } | { t: "h"; c: Inline[] };

export const isSafeHref = (href: string) => /^\/(?!\/)[A-Za-z0-9\-._~/?#[\]@!$&'()*+,;=%:]*$/.test(href) && !/^\/\\/.test(href);

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("**", i)) {
      const end = s.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "b", c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (s[i] === "[") {
      const close = s.indexOf("](", i + 1);
      const end = close > 0 ? s.indexOf(")", close + 2) : -1;
      if (close > i && end > close) {
        const label = s.slice(i + 1, close);
        const href = s.slice(close + 2, end).trim();
        if (!label.includes("[") && !/\s/.test(href)) {
          flush();
          const kids = parseInline(label);
          out.push(isSafeHref(href) ? { t: "link", href, c: kids } : { t: "text", v: label });
          i = end + 1;
          continue;
        }
      }
    }
    buf += s[i];
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: "ul" | "ol"; items: string[] } | null = null;
  const endPara = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join(" ")) });
    para = [];
  };
  const endList = () => {
    if (list) blocks.push({ t: list.t, items: list.items.map(parseInline) } as Block);
    list = null;
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const num = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/);
    const head = line.match(/^#{1,4}\s+(.*)$/);
    if (!line.trim()) {
      endPara();
      endList();
    } else if (head) {
      endPara();
      endList();
      blocks.push({ t: "h", c: parseInline(head[1]) });
    } else if (bullet || num) {
      endPara();
      const kind = bullet ? "ul" : "ol";
      if (list && list.t !== kind) endList();
      if (!list) list = { t: kind, items: [] };
      list.items.push((bullet ?? num)![1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      endList();
      para.push(line.trim());
    }
  }
  endPara();
  endList();
  return blocks;
}
