const AdmZip = require('adm-zip');

function docx(text = '每日读一页书，记录一项观察，整理桌面。') {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p></w:body></w:document>`));
  return zip.toBuffer();
}

// A genuine one-page PDF with a ToUnicode map, so Chinese text extraction is
// exercised without depending on fonts, Office, Python, or a PDF generator.
function pdf(text = 'Observe the light. Read one page. 整理桌面。') {
  const chars = [...new Set(Array.from(text))];
  const map = new Map(chars.map((char, index) => [char, (index + 1).toString(16).padStart(4, '0')]));
  const utf16 = value => Buffer.from(value, 'utf16le').swap16().toString('hex');
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /FixtureUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${chars.map(char => `<${map.get(char)}> <${utf16(char)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const stream = `BT /F1 12 Tf 40 700 Td <${Array.from(text).map(char => map.get(char)).join('')}> Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /FixtureFont /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FixtureFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>',
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`
  ];
  let body = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

module.exports = { docx, pdf };
