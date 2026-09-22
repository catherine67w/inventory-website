// Converts one HEIC to JPEG, then exits.
//
// Exiting is the point. The decoder is libheif compiled to WebAssembly, and a
// WASM heap is never handed back to the operating system — one photo parks
// around 330 MB for the life of the process. Doing this inside the web server
// leaves it permanently near the memory limit of a small instance, where the
// next upload tips it over and the host restarts it mid-save.
//
// Run as: node scripts/heic-worker.js <input> <output> <maxBytes>

const fs = require('fs');
const heicConvert = require('heic-convert');

async function main() {
  const [input, output, maxBytesText] = process.argv.slice(2);
  if (!input || !output) {
    process.stderr.write('usage: heic-worker.js <input> <output> [maxBytes]\n');
    process.exit(2);
  }
  const maxBytes = Number(maxBytesText) || 3_500_000;

  const buffer = await fs.promises.readFile(input);
  let jpeg = Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: 0.85 }));

  // Too large for the API once base64-encoded. Quality is the only lever here:
  // this decoder cannot resize.
  if (jpeg.length > maxBytes) {
    jpeg = Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: 0.55 }));
  }

  await fs.promises.writeFile(output, jpeg);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(String((err && err.message) || err) + '\n');
    process.exit(1);
  },
);
