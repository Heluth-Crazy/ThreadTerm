#!/usr/bin/env node
/**
 * Generate Windows ICO file from PNG images
 */

const fs = require('fs');
const path = require('path');

// ICO file format constants
const ICONDIR_SIZE = 6;  // 3 uint16_t: reserved, type, count
const ICONDIRENTRY_SIZE = 16;  // icon directory entry size

function createICO(outputPath, images) {
  const count = images.length;
  const header = Buffer.alloc(ICONDIR_SIZE);

  // ICO header
  header.writeUInt16LE(0, 0);  // Reserved
  header.writeUInt16LE(1, 2);  // Type: 1 = icon
  header.writeUInt16LE(count, 4);  // Count

  const entries = [];
  const imageData = [];
  let offset = ICONDIR_SIZE + (count * ICONDIRENTRY_SIZE);

  for (const img of images) {
    const data = fs.readFileSync(img.path);
    const size = data.length;

    const entry = Buffer.alloc(ICONDIRENTRY_SIZE);
    entry.writeUInt8(img.width > 255 ? 0 : img.width, 0);  // Width
    entry.writeUInt8(img.height > 255 ? 0 : img.height, 1);  // Height
    entry.writeUInt8(0, 2);  // Color palette
    entry.writeUInt8(0, 3);  // Reserved
    entry.writeUInt16LE(1, 4);  // Color planes
    entry.writeUInt16LE(32, 6);  // Bits per pixel
    entry.writeUInt32LE(size, 8);  // Image size
    entry.writeUInt32LE(offset, 12);  // Image offset

    entries.push(entry);
    imageData.push(data);
    offset += size;
  }

  // Combine all parts
  const parts = [header, ...entries, ...imageData];
  const ico = Buffer.concat(parts);

  fs.writeFileSync(outputPath, ico);
  console.log(`Created: ${outputPath} (${count} images)`);
}

// Main
const winIconDir = path.join(__dirname, '..', 'resources', 'winicon');
const outputPath = path.join(__dirname, '..', 'resources', 'icon.ico');

const images = [
  { path: path.join(winIconDir, '16.png'), width: 16, height: 16 },
  { path: path.join(winIconDir, '32.png'), width: 32, height: 32 },
  { path: path.join(winIconDir, '48.png'), width: 48, height: 48 },
  { path: path.join(winIconDir, '64.png'), width: 64, height: 64 },
  { path: path.join(winIconDir, '128.png'), width: 128, height: 128 },
  { path: path.join(winIconDir, '256.png'), width: 256, height: 256 },
];

// Verify all images exist
for (const img of images) {
  if (!fs.existsSync(img.path)) {
    console.error(`Missing: ${img.path}`);
    process.exit(1);
  }
}

createICO(outputPath, images);
console.log('Windows icon generation complete!');
