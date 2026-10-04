// builds a small, valid single-page PDF with plain text (demo documents only)
export function makePdf(title: string, lines: string[]): Uint8Array {
  const esc = (t: string) => t.replace(/[^\x20-\x7e]/g, "-").replace(/([\\()])/g, "\\$1");
  const wrap = (t: string, n = 88) => {
    const out: string[] = [];
    let cur = "";
    for (const w of t.split(" ")) {
      if ((cur + " " + w).trim().length > n) { out.push(cur.trim()); cur = w; } else cur += " " + w;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.length ? out : [""];
  };
  const body = lines.flatMap((l) => wrap(l));
  const ops = [`BT /F1 16 Tf 56 780 Td (${esc(title)}) Tj ET`, ...body.slice(0, 48).map((l, i) => `BT /F1 10 Tf 56 ${750 - i * 14} Td (${esc(l)}) Tj ET`)].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(ops, "latin1")} >>\nstream\n${ops}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
