// One-off: extract text from the PRD PDF (page-marked) using pdfjs-dist v3.
const fs = require('fs');
const path = require('path');
const pdfjs = require(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));

(async () => {
  const pdfPath = process.argv[2];
  const outPath = process.argv[3];
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // Rebuild lines: pdfjs items carry positions; group by rounded y, then sort by x.
    const lines = new Map();
    for (const item of tc.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x, str: item.str, eol: item.hasEOL });
    }
    const sorted = [...lines.entries()].sort((a, b) => b[0] - a[0]);
    let pageText = '';
    for (const [, segs] of sorted) {
      segs.sort((a, b) => a.x - b.x);
      pageText += segs.map(s => s.str).join('') + '\n';
    }
    out += `\n===== PAGE ${i} =====\n` + pageText;
  }
  fs.writeFileSync(outPath, out, 'utf8');
  console.log(`pages=${doc.numPages} chars=${out.length} -> ${outPath}`);
})().catch(e => { console.error(e); process.exit(1); });
