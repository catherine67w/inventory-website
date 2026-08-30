// iPhones photograph in HEIC by default, and nothing downstream can read it —
// not Claude, not Chrome, not most backup viewers. Rather than accept the file
// and fail later, an uploaded HEIC is converted to JPEG the moment it lands and
// the JPEG is what gets kept. The original is still on the phone.
//
// macOS ships `sips`, so this needs no dependency on the machine the app runs
// on. On anything else it says so plainly instead of failing obscurely.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HEIC_TYPES = ['.heic', '.heif'];

// Long edge cap. Claude scales images down internally anyway, and an
// unconstrained 48-megapixel photo only costs upload time and API limits.
// 3000px keeps small print on an invoice legible with room to spare.
const MAX_EDGE = 3000;

// The API rejects images past about 5 MB once base64-encoded, so stay well under.
const MAX_BYTES = 3_500_000;

const isHeic = (name) => HEIC_TYPES.includes(path.extname(name || '').toLowerCase());

function sipsAvailable() {
  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// macOS route: fast, no dependency, and it resizes in the same pass.
function convertWithSips(filePath, jpegPath) {
  execFileSync('sips', [
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', 'high',
    '-Z', String(MAX_EDGE),
    filePath, '--out', jpegPath,
  ], { stdio: 'ignore', timeout: 60_000 });
}

// Everywhere else: a pure-JavaScript decoder, so a Linux server needs nothing
// installed. It cannot resize, so quality is the lever for keeping the file
// under the API's per-image limit — dropping it only on the photos that need it
// rather than softening every one.
async function convertWithLibrary(filePath, jpegPath) {
  const heicConvert = require('heic-convert');
  const input = await fs.promises.readFile(filePath);

  let output = Buffer.from(await heicConvert({ buffer: input, format: 'JPEG', quality: 0.85 }));
  if (output.length > MAX_BYTES) {
    output = Buffer.from(await heicConvert({ buffer: input, format: 'JPEG', quality: 0.55 }));
  }
  await fs.promises.writeFile(jpegPath, output);
}

// Converts in place: writes a .jpg beside the original, removes the original,
// and returns the new path. Throws with a readable message on failure.
async function heicToJpeg(filePath) {
  const jpegPath = filePath.replace(/\.[^.]+$/, '') + '.jpg';

  try {
    if (sipsAvailable()) convertWithSips(filePath, jpegPath);
    else await convertWithLibrary(filePath, jpegPath);
  } catch (err) {
    throw new Error('This HEIC photo could not be converted. Send it to yourself as a ' +
      'JPEG, or take the photo again with Most Compatible turned on. ' +
      `(${err.message})`);
  }

  if (!fs.existsSync(jpegPath) || fs.statSync(jpegPath).size === 0) {
    throw new Error('This HEIC photo converted to an empty file. Try photographing it again.');
  }

  // Only the JPEG is kept: two copies of one invoice photo is just clutter, and
  // the HEIC is the copy nothing else can open.
  fs.promises.unlink(filePath).catch(() => {});
  return jpegPath;
}

// Rewrites a multer file in place so everything after this point sees a JPEG.
async function normalizeUpload(file) {
  if (!isHeic(file.originalname) && !isHeic(file.path)) return file;

  const jpegPath = await heicToJpeg(file.path);
  file.path = jpegPath;
  file.filename = path.basename(jpegPath);
  // The display name keeps its own extension swapped too, so the invoice does
  // not claim to have come from a .HEIC that no longer exists.
  file.originalname = String(file.originalname || '').replace(/\.[^.]+$/, '') + '.jpg';
  return file;
}

module.exports = { isHeic, heicToJpeg, normalizeUpload, HEIC_TYPES };
