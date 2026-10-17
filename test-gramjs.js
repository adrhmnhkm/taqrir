
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const MIN_FILE_SIZE = 20 * 1024 * 1024;
const WORKERS = 8;

async function main() {
    const apiId = Number(process.env.TG_API_ID);
    const apiHash = process.env.TG_API_HASH;
    const botToken = process.env.TELEGRAM_TOKEN;

    if (!apiId || !apiHash || !botToken) {
        throw new Error(
            'TG_API_ID, TG_API_HASH, atau TELEGRAM_TOKEN belum tersedia di .env'
        );
    }

    const client = new TelegramClient(
        new StringSession(''),
        apiId,
        apiHash,
        { connectionRetries: 3 }
    );

    await client.start({ botAuthToken: botToken });

    console.log('GramJS aktif. Kirim satu audio baru ke bot.');

    let processing = false;

    client.addEventHandler(async (event) => {
        const message = event.message;

        if (!message?.media || processing) return;

        const size = Number(message.media.document?.size || 0);

        if (size < MIN_FILE_SIZE) return;

        processing = true;

        const outputPath = path.join(
            __dirname,
            `gramjs-test-${message.id}.bin`
        );

        const startedAt = Date.now();
        let lastPercent = -1;
        let lastSpeedTime = startedAt;
        let lastSpeedBytes = 0;

        try {
            console.log('\nFile terdeteksi:', size, 'byte');
            console.log('Workers:', WORKERS);
            console.log('Mulai unduh paralel...\n');

            await client.downloadMedia(message, {
                outputFile: outputPath,
                workers: WORKERS,

                progressCallback: (received, total) => {
                    const bytes = Number(received) || 0;
                    const totalBytes = Number(total) || size;
                    const percent = Math.floor(
                        (bytes / totalBytes) * 100
                    );

                    if (percent !== lastPercent) {
                        const now = Date.now();
                        const elapsed = (now - startedAt) / 1000;
                        const interval = (now - lastSpeedTime) / 1000;

                        let speed = 0;

                        if (interval > 0) {
                            speed = Math.max(
                                0,
                                bytes - lastSpeedBytes
                            ) / interval;
                        }

                        console.log(
                            `Progres: ${percent}% | ` +
                            `${(bytes / 1048576).toFixed(2)} MiB / ` +
                            `${(totalBytes / 1048576).toFixed(2)} MiB | ` +
                            `${(speed / 1048576).toFixed(2)} MiB/s | ` +
                            `${elapsed.toFixed(0)} detik`
                        );

                        lastPercent = percent;
                        lastSpeedTime = now;
                        lastSpeedBytes = bytes;
                    }
                },
            });

            if (!fs.existsSync(outputPath)) {
                throw new Error('File hasil unduhan tidak ditemukan.');
            }

            const stats = fs.statSync(outputPath);

            console.log('\nUnduhan selesai.');
            console.log('Ukuran sumber:', size, 'byte');
            console.log('Ukuran hasil:', stats.size, 'byte');
            console.log(
                'Ukuran cocok:',
                stats.size === size ? 'YA' : 'TIDAK'
            );
            console.log(
                'Durasi:',
                ((Date.now() - startedAt) / 1000).toFixed(1),
                'detik'
            );

            if (stats.size !== size) {
                console.log(
                    'Perhatian: ukuran tidak cocok. Jangan gunakan file ini.'
                );
            }
        } catch (error) {
            console.error('\nUnduhan gagal:', error.message);
        } finally {
            processing = false;
            console.log('\nSkrip tetap menunggu audio berikutnya.');
        }
    }, new NewMessage({ incoming: true }));
}

main().catch((error) => {
    console.error('Tes gagal:', error.message);
    process.exitCode = 1;
});
