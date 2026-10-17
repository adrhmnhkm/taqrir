
require('dotenv').config();

const fs = require('fs');
const path = require('path');

async function main() {
    const filePath = process.argv[2];

    if (!filePath) {
        throw new Error(
            'Cara pakai: node test-whisper.js "path\\audio.mp3"'
        );
    }

    if (!fs.existsSync(filePath)) {
        throw new Error(`File tidak ditemukan: ${filePath}`);
    }

    if (!process.env.KENARI_API_KEY) {
        throw new Error('KENARI_API_KEY belum tersedia di .env');
    }

    const form = new FormData();

    form.append('model', 'whisper-large-v3-turbo');

    // Biarkan kosong agar bahasa terdeteksi otomatis.
    // Ini penting untuk pengujian audio Arab-Indonesia.
    form.append('response_format', 'verbose_json');

    form.append(
        'file',
        new Blob([fs.readFileSync(filePath)], {
            type: 'audio/mpeg',
        }),
        path.basename(filePath)
    );

    console.log('Mengirim audio ke Whisper...');
    console.log('Ukuran file:', fs.statSync(filePath).size, 'byte');

    const start = Date.now();

    const response = await fetch(
        'https://kenari.id/v1/audio/transcriptions',
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.KENARI_API_KEY}`,
            },
            body: form,
        }
    );

    const body = await response.text();

    if (!response.ok) {
        throw new Error(
            `Kenari HTTP ${response.status}: ${body.slice(0, 1500)}`
        );
    }

    const result = JSON.parse(body);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const outputPath = path.join(
        path.dirname(filePath),
        `${path.parse(filePath).name}-whisper.txt`
    );

    fs.writeFileSync(
        outputPath,
        result.text || '',
        'utf8'
    );

    console.log('\nTranskripsi selesai!');
    console.log('Waktu proses:', elapsed, 'detik');
    console.log('Durasi audio:', result.duration ?? 'tidak dilaporkan', 'detik');
    console.log('Bahasa terdeteksi:', result.language ?? 'tidak dilaporkan');
    console.log('Panjang transkrip:', (result.text || '').length, 'karakter');
    console.log('File hasil:', outputPath);
}

main().catch(error => {
    console.error('\nTes Whisper gagal:', error.message);
    process.exitCode = 1;
});
