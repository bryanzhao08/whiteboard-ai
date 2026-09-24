const encoder = new TextEncoder();

function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let position = 0;
  for (const part of parts) { output.set(part, position); position += part.length; }
  return output;
}

export function createPdfFromJpeg(dataUrl, imageWidth, imageHeight) {
  if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Expected a JPEG data URL');
  const binary = atob(dataUrl.slice('data:image/jpeg;base64,'.length));
  const jpeg = Uint8Array.from(binary, character => character.charCodeAt(0));
  const landscape = imageWidth >= imageHeight;
  const pageWidth = landscape ? 842 : 595;
  const pageHeight = landscape ? 595 : 842;
  const margin = 30;
  const scale = Math.min((pageWidth - margin * 2) / imageWidth, (pageHeight - margin * 2) / imageHeight);
  const drawnWidth = imageWidth * scale;
  const drawnHeight = imageHeight * scale;
  const x = (pageWidth - drawnWidth) / 2;
  const y = (pageHeight - drawnHeight) / 2;
  const content = encoder.encode(`q\n${drawnWidth.toFixed(3)} 0 0 ${drawnHeight.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm\n/Im0 Do\nQ\n`);
  const chunks = [];
  const offsets = [0];
  let length = 0;
  const append = value => { const bytes = typeof value === 'string' ? encoder.encode(value) : value; chunks.push(bytes); length += bytes.length; };
  const object = (number, value) => { offsets[number] = length; append(`${number} 0 obj\n`); append(value); append('\nendobj\n'); };

  append('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
  object(4, concatBytes([encoder.encode(`<< /Length ${content.length} >>\nstream\n`), content, encoder.encode('endstream')]));
  object(5, concatBytes([encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, encoder.encode('\nendstream')]));
  const xref = length;
  append('xref\n0 6\n0000000000 65535 f \n');
  for (let number = 1; number <= 5; number++) append(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
