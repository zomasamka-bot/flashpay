"use strict";
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const root = path.resolve(__dirname, "..");
const excluded = new Set(["node_modules", ".git", ".next", ".vercel", ".r36-build", "__pycache__"]);
let bytes = 22, files = 0;
function walk(directory, prefix = "") {
  for (const name of fs.readdirSync(directory).sort()) {
    const relative = prefix ? prefix + "/" + name : name;
    if (excluded.has(name) || relative === "vendor/financial-kernel/dist" ||
        name.startsWith(".env") || /\.(tsbuildinfo|log|pyc)$/.test(name)) continue;
    const absolute = path.join(directory, name), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw Error("SOURCE_SYMLINK_NOT_ALLOWED");
    if (stat.isDirectory()) { walk(absolute, relative); continue; }
    if (!stat.isFile()) throw Error("SOURCE_FILE_TYPE_NOT_ALLOWED");
    // Standard ZIP/Deflate, no extra fields or archive comment; include both headers.
    const compressed = zlib.deflateRawSync(fs.readFileSync(absolute), { level: 9 });
    bytes += 30 + 46 + 2 * Buffer.byteLength(relative) + compressed.length;
    files++;
  }
}
walk(root);
console.log(JSON.stringify({ sourceFiles: files, standardZipBytes: bytes, maxBytes: 1000000 }));
if (bytes >= 1000000) throw Error("SOURCE_ZIP_EXCEEDS_1000000_BYTES");
