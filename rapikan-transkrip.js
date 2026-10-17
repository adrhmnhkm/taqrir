
const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];

if (!inputPath || !fs.existsSync(inputPath)) {
    console.error('File tidak ditemukan. Masukkan path file transkrip.');
    process.exit(1);
}

const raw = fs.readFileSync(inputPath, 'utf8');

// Rapikan spasi dan baris kosong berlebihan tanpa mengubah kata.
const cleaned = raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const outputPath = path.join(
    path.dirname(inputPath),
    `${path.parse(inputPath).name}-rapi.txt`
);

fs.writeFileSync(outputPath, cleaned, 'utf8');

console.log('Selesai merapikan format dasar.');
console.log('File hasil:', outputPath);
