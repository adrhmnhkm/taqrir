
require('dotenv').config();

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { parseFile } = require('music-metadata');
const { performance } = require('node:perf_hooks');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// =====================================================
// KONFIGURASI
// =====================================================

const requiredEnv = [
    'TELEGRAM_TOKEN',
    'KENARI_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'MINI_APP_URL',
    'ADMIN_TELEGRAM_ID',
];

for (const key of requiredEnv) {
    if (!process.env[key]) {
        throw new Error(`Variabel ${key} belum diisi di .env`);
    }
}

const bot = new Telegraf(process.env.TELEGRAM_TOKEN, {
    handlerTimeout: 900000,
});

const MINI_APP_URL = process.env.MINI_APP_URL;
const UPLOAD_PORT = Number(process.env.UPLOAD_PORT || 3000);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// === MONITORING TOKEN ===


const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID);

async function logTokenUsage({
    telegramId,
    jobId,
    stage,
    segmentNumber = null,
    model = 'gemini-3-8-flash',
    usage = {},
    durationSeconds = 0,
    status = 'success',
    errorMessage = null,
}) {
    const promptTokens = Number(usage.prompt_tokens) || 0;
    const completionTokens = Number(usage.completion_tokens) || 0;

    const totalTokens =
        Number(usage.total_tokens) ||
        promptTokens + completionTokens;

    try {
        const { error } = await supabase
            .from('usage_logs')
            .insert({
                telegram_id: telegramId,
                job_id: jobId,
                stage,
                segment_number: segmentNumber,
                model,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: totalTokens,
                duration_seconds: Math.max(
                    0,
                    Math.floor(Number(durationSeconds) || 0)
                ),
                status,
                error_message: errorMessage
                    ? String(errorMessage).slice(0, 1000)
                    : null,
            });

        if (error) {
            console.error(
                '[Usage Monitor] Gagal menyimpan log:',
                error.message
            );
        }
    } catch (error) {
        console.error(
            '[Usage Monitor] Kesalahan pencatatan:',
            error.message
        );
    }
}

function isAdmin(ctx) {
    return Number(ctx.from?.id) === ADMIN_ID;
}

function formatNumber(value) {
    return (Number(value) || 0).toLocaleString('id-ID');
}
 // akhir kode monitoring

 // monitoring bottleneck

 
async function logJobStage({
    telegramId,
    jobId,
    source,
    stage,
    durationMs,
    status = 'success',
    fileSizeBytes = null,
    audioDurationSeconds = null,
    errorMessage = null,
}) {
    try {
        const { error } = await supabase
            .from('job_stage_logs')
            .insert({
                telegram_id: telegramId,
                job_id: jobId,
                source,
                stage,
                duration_ms: Math.max(
                    0,
                    Math.round(Number(durationMs) || 0)
                ),
                status,
                file_size_bytes: fileSizeBytes,
                audio_duration_seconds: audioDurationSeconds,
                error_message: errorMessage
                    ? String(errorMessage).slice(0, 1000)
                    : null,
            });

        if (error) {
            console.error(
                '[Job Monitor] Gagal menyimpan:',
                error.message
            );
        }
    } catch (error) {
        console.error(
            '[Job Monitor] Kesalahan pencatatan:',
            error.message
        );
    }
}

// Measure Stage Function
async function measureStage(meta, stage, task, extra = {}) {
    const startedAt = performance.now();

    try {
        const result = await task();
        const durationMs = Math.round(performance.now() - startedAt);

        await logJobStage({
            ...meta,
            ...extra,
            stage,
            durationMs,
            status: 'success',
        });

        console.log(
            `[TIMER][${meta.source}][${stage}] ` +
            `${(durationMs / 1000).toFixed(2)} detik`
        );

        return result;
    } catch (error) {
        const durationMs = Math.round(performance.now() - startedAt);

        await logJobStage({
            ...meta,
            ...extra,
            stage,
            durationMs,
            status: 'failed',
            errorMessage: error.message,
        });

        console.error(
            `[TIMER][${meta.source}][${stage}] GAGAL setelah ` +
            `${(durationMs / 1000).toFixed(2)} detik`
        );

        throw error;
    }
}

// akhir kode
const INITIAL_QUOTA = 1800;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const CHUNK_SECONDS = 360;
const OVERLAP_SECONDS = 2;
const TELEGRAM_TEXT_LIMIT = 3500;

const uploadDir = path.join(
    os.tmpdir(),
    'kajian-miniapp-uploads'
);

fs.mkdirSync(uploadDir, { recursive: true });

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';

// Tidak membatasi durasi video secara langsung.
// Batas ukuran unduhan tetap diperlukan untuk melindungi disk.
const MAX_YOUTUBE_AUDIO_BYTES = 1024 * 1024 * 1024; // 1 GiB

const YOUTUBE_REQUEST_TTL_MS = 15 * 60 * 1000;
const pendingYoutubeRequests = new Map();

const app = express();
app.use((req, res, next) => {
    const startedAt = Date.now();
    req.monitorStartedAt = performance.now();
    console.log(`[HTTP] ${req.method} ${req.url} mulai`);

    req.on('aborted', () => {
        console.error(
            `[HTTP] Request dibatalkan: ${req.method} ${req.url}`
        );
    });

    res.on('finish', () => {
        console.log(
            `[HTTP] ${req.method} ${req.url} selesai`,
            {
                status: res.statusCode,
                durationMs: Date.now() - startedAt,
            }
        );
    });

    res.on('close', () => {
        if (!res.writableFinished) {
            console.error(
                `[HTTP] Koneksi respons terputus: ${req.method} ${req.url}`
            );
        }
    });

    next();
});
const upload = multer({
    dest: uploadDir,
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
    },
});

app.use(express.static(path.join(__dirname, 'miniapp')));

// =====================================================
// WEBHOOK TELEGRAM (didaftarkan sebelum app.listen)
// =====================================================

if (process.env.WEBHOOK_DOMAIN) {
    app.post('/bot-webhook', express.json({ strict: false }), async (req, res) => {
        console.log('[Webhook] Update masuk:', JSON.stringify(req.body)?.slice(0, 100));
        res.sendStatus(200);
        try {
            await bot.handleUpdate(req.body);
        } catch (err) {
            console.error('[Webhook] handleUpdate error:', err.message);
        }
    });
    console.log('[Webhook] Route /bot-webhook terdaftar.');
}

// =====================================================
// ANTREAN
// =====================================================

let queue = Promise.resolve();

function enqueue(task) {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
}

function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));

    return `${Math.floor(seconds / 60)} menit ${seconds % 60} detik`;
}


function runYtDlp(args, captureStdout = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(YTDLP_PATH, args, {
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            if (captureStdout) {
                stdout += chunk.toString();

                // Metadata JSON tidak seharusnya berukuran besar.
                if (stdout.length > 5 * 1024 * 1024) {
                    child.kill();
                }
            }
        });

        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk.toString()).slice(-6000);
        });

        child.on('error', (error) => {
            if (error.code === 'ENOENT') {
                reject(new Error(
                    'yt-dlp tidak ditemukan. Periksa YTDLP_PATH di .env.'
                ));
                return;
            }

            reject(error);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }

            reject(new Error(
                `yt-dlp gagal (exit ${code}): ${stderr || 'Tidak ada detail error.'}`
            ));
        });
    });
}

function validateYoutubeUrl(rawUrl) {
    let url;

    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('Format URL tidak valid.');
    }

    const allowedHosts = new Set([
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtu.be',
        'www.youtube-nocookie.com',
        'youtube-nocookie.com',
    ]);

    if (
        url.protocol !== 'https:' ||
        !allowedHosts.has(url.hostname.toLowerCase()) ||
        url.username ||
        url.password ||
        url.port
    ) {
        throw new Error('URL harus berasal dari YouTube.');
    }

    // Hapus parameter playlist agar yang diproses hanya satu video.
    url.searchParams.delete('list');
    url.searchParams.delete('index');

    return url.toString();
}

function extractYoutubeUrl(text) {
    const matches = text.match(/https?:\/\/[^\s<>]+/gi) || [];

    for (const candidate of matches) {
        const cleaned = candidate.replace(/[),.!?]+$/, '');

        try {
            return validateYoutubeUrl(cleaned);
        } catch {
            // Abaikan URL lain yang bukan YouTube.
        }
    }

    return null;
}

async function getYoutubeInfo(url) {
    const output = await runYtDlp([
        '--ignore-config',
        '--no-warnings',
        '--no-playlist',
        '--skip-download',
        '--dump-single-json',
        url,
    ], true);

    let info;

    try {
        info = JSON.parse(output);
    } catch {
        throw new Error('Metadata video YouTube tidak dapat dibaca.');
    }

    if (
        !Number.isSafeInteger(Number(info.duration)) ||
        Number(info.duration) <= 0 ||
        !info.title
    ) {
        throw new Error(
            'Judul atau durasi video tidak tersedia. Video mungkin dibatasi atau tidak dapat diakses.'
        );
    }

    return {
        title: String(info.title).slice(0, 250),
        duration: Math.ceil(Number(info.duration)),
        url,
    };
}


async function downloadYoutubeAudio(url, workDir) {
    const outputTemplate = path.join(workDir, 'audio.%(ext)s');

    await runYtDlp([
        '--ignore-config',
        '--no-warnings',
        '--no-playlist',
        '--no-progress',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '5',
        '--max-filesize', '1G',
        '--ffmpeg-location', ffmpegPath,
        '--output', outputTemplate,
        url,
    ]);

    const audioPath = path.join(workDir, 'audio.mp3');
    const stat = await fs.promises.stat(audioPath);

    if (!stat.isFile() || stat.size === 0) {
        throw new Error('Audio hasil unduhan kosong atau tidak ditemukan.');
    }

    if (stat.size > MAX_YOUTUBE_AUDIO_BYTES) {
        throw new Error('Ukuran audio melebihi batas unduhan 1 GiB.');
    }

    return audioPath;
}

// =====================================================
// VERIFIKASI TELEGRAM MINI APP
// =====================================================

function verifyTelegramInitData(initData) {
    if (!initData) return null;

    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');

    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
        return null;
    }

    params.delete('hash');

    const authDate = Number(params.get('auth_date'));
    const now = Math.floor(Date.now() / 1000);

    if (
        !Number.isSafeInteger(authDate) ||
        authDate > now + 60 ||
        now - authDate > 3600
    ) {
        return null;
    }

    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(process.env.TELEGRAM_TOKEN)
        .digest();

    const calculatedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    const expected = Buffer.from(calculatedHash, 'hex');
    const received = Buffer.from(receivedHash, 'hex');

    if (
        expected.length !== received.length ||
        !crypto.timingSafeEqual(expected, received)
    ) {
        return null;
    }

    try {
        const user = JSON.parse(params.get('user') || 'null');

        if (!user || !Number.isSafeInteger(user.id)) {
            return null;
        }

        return user;
    } catch {
        return null;
    }
}

// =====================================================
// SUPABASE DAN KUOTA
// =====================================================

async function ensureUser(ctx) {
    const telegramId = ctx.from.id;
    const username =
        ctx.from.username ||
        ctx.from.first_name ||
        'Hamba Allah';

    const { data: existing, error: findError } = await supabase
        .from('users')
        .select('id, sisa_kuota')
        .eq('telegram_id', telegramId)
        .maybeSingle();

    if (findError) throw findError;

    if (existing) {
        const { error } = await supabase
            .from('users')
            .update({ username })
            .eq('telegram_id', telegramId);

        if (error) throw error;

        return existing;
    }

    const { data: created, error: insertError } = await supabase
        .from('users')
        .insert({
            telegram_id: telegramId,
            username,
            sisa_kuota: INITIAL_QUOTA,
        })
        .select('id, sisa_kuota')
        .single();

    if (!insertError) return created;

    if (insertError.code === '23505') {
        const { data, error } = await supabase
            .from('users')
            .select('id, sisa_kuota')
            .eq('telegram_id', telegramId)
            .single();

        if (error) throw error;
        return data;
    }

    throw insertError;
}

async function getBalance(telegramId) {
    const { data, error } = await supabase
        .from('users')
        .select('sisa_kuota')
        .eq('telegram_id', telegramId)
        .single();

    if (error) throw error;

    return data.sisa_kuota;
}

async function reserveQuota(telegramId, seconds) {
    const { data: user, error: readError } = await supabase
        .from('users')
        .select('sisa_kuota')
        .eq('telegram_id', telegramId)
        .single();

    if (readError) throw readError;

    const currentQuota = Number(user.sisa_kuota);

    if (!Number.isFinite(currentQuota) || currentQuota < seconds) {
        return false;
    }

    const { data, error } = await supabase
        .from('users')
        .update({ sisa_kuota: currentQuota - seconds })
        .eq('telegram_id', telegramId)
        .eq('sisa_kuota', currentQuota)
        .select('sisa_kuota');

    if (error) throw error;

    return Array.isArray(data) && data.length > 0;
}

async function refundQuota(telegramId, seconds) {
    const { data: user, error: readError } = await supabase
        .from('users')
        .select('sisa_kuota')
        .eq('telegram_id', telegramId)
        .single();

    if (readError) throw readError;

    const currentQuota = Number(user.sisa_kuota);

    if (!Number.isFinite(currentQuota)) {
        throw new Error('Saldo kuota tidak valid.');
    }

    const { data, error } = await supabase
        .from('users')
        .update({ sisa_kuota: currentQuota + seconds })
        .eq('telegram_id', telegramId)
        .eq('sisa_kuota', currentQuota)
        .select('sisa_kuota');

    if (error) throw error;

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(
            'Pengembalian kuota gagal: saldo berubah saat proses berlangsung.'
        );
    }
}

// =====================================================
// FFMPEG
// =====================================================

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
        });

        let errorLog = '';

        child.stderr.on('data', (data) => {
            errorLog = (
                errorLog + data.toString()
            ).slice(-4000);
        });

        child.on('error', reject);

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(
                    new Error(`FFmpeg gagal (${code}): ${errorLog}`)
                );
            }
        });
    });
}

async function normalizeAudio(inputPath, outputPath) {
    await runFfmpeg([
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-y',
        '-i', inputPath,
        '-vn',
        '-ac', '1',
        '-ar', '24000',
        '-b:a', '64k',
        '-f', 'mp3',
        outputPath,
    ]);
}

async function downloadTelegramFile(ctx, fileId, outputPath) {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);

    if (!response.ok || !response.body) {
        throw new Error(
            `Unduhan Telegram gagal: HTTP ${response.status}`
        );
    }

    const declaredSize = Number(
        response.headers.get('content-length') || 0
    );

    if (declaredSize > MAX_DOWNLOAD_BYTES) {
        throw new Error('Ukuran audio melampaui batas bot.');
    }

    const { Readable, Transform } = require('stream');
    const { pipeline } = require('stream/promises');

    let received = 0;

    const limiter = new Transform({
        transform(chunk, encoding, callback) {
            received += chunk.length;

            if (received > MAX_DOWNLOAD_BYTES) {
                callback(new Error('Ukuran audio melebihi 20 MiB.'));
                return;
            }

            callback(null, chunk);
        },
    });

    await pipeline(
        Readable.fromWeb(response.body),
        limiter,
        fs.createWriteStream(outputPath)
    );
}

// =====================================================
// TRANSKRIPSI KENARI
// =====================================================

const TRANSCRIPTION_PROMPT = `
Transcribe the entire audio verbatim, from beginning to end.
Do not summarize, paraphrase, omit, or invent speech.
Preserve each spoken language and its original script, including Arabic script for Arabic speech.
Retain repetitions, incomplete sentences, and meaningful filler words.
Use appropriate punctuation (commas, periods) to make the text natural and readable.
Mark genuinely unclear speech as [tidak jelas].

CRITICAL FORMATTING INSTRUCTIONS:
1. Output ONLY the raw transcript divided into logical, readable paragraphs separated by a blank line (two newlines).
2. Absolutely DO NOT include timestamps, timecodes (e.g., 00:00), speaker labels, or line-by-line subtitle breaks.
3. Absolutely DO NOT include introductory notes, internal reasoning, thoughts, or verification notes.
`;

function normalizeToken(token) {
    return token
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

function mergeSegments(previous, next) {
    if (!previous) return next;
    if (!next) return previous;

    const oldWords = previous.trim().split(/\s+/);
    const newWords = next.trim().split(/\s+/);

    const maxOverlap = Math.min(
        25,
        oldWords.length,
        newWords.length
    );

    let overlap = 0;

    for (let count = maxOverlap; count >= 2; count--) {
        const left = oldWords
            .slice(-count)
            .map(normalizeToken);

        const right = newWords
            .slice(0, count)
            .map(normalizeToken);

        if (
            left.every(
                (word, index) =>
                    word !== '' && word === right[index]
            )
        ) {
            overlap = count;
            break;
        }
    }

    const remainder = newWords.slice(overlap).join(' ');

    return [previous.trim(), remainder]
        .filter(Boolean)
        .join('\n\n');
}

async function generateContentWithRetry(filePath, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const audioBase64 = await fs.promises.readFile(filePath, {
                encoding: 'base64',
            });

            const response = await fetch(
                'https://kenari.id/v1/chat/completions',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${process.env.KENARI_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: 'gemini-3-8-flash',
                        messages: [
                            {
                                role: 'user',
                                content: [
                                    {
                                        type: 'text',
                                        text: TRANSCRIPTION_PROMPT,
                                    },
                                    {
                                        type: 'input_audio',
                                        input_audio: {
                                            data: audioBase64,
                                            format: 'mp3',
                                        },
                                    },
                                ],
                            },
                        ],
                        temperature: 0,
                        max_tokens: 8192,
                    }),
                }
            );

            const rawBody = await response.text();

            let data;
            try {
                data = JSON.parse(rawBody);
            } catch {
                throw new Error(
                    `Respons Kenari bukan JSON. HTTP ${response.status}: ` +
                    rawBody.slice(0, 500)
                );
            }

            if (!response.ok) {
                const error = new Error(
                    `Kenari HTTP ${response.status}: ${JSON.stringify(data)}`
                );

                error.status = response.status;
                throw error;
            }
            // Log diagnostik tanpa mencetak isi audio atau API key.
const choice = data.choices?.[0];
const content = choice?.message?.content;

console.log('[Kenari] Diagnostik respons:', {
    httpStatus: response.status,
    responseId: data.id,
    model: data.model,
    hasChoices: Array.isArray(data.choices),
    choicesLength: data.choices?.length,
    finishReason: choice?.finish_reason,
    contentType: typeof content,
    contentIsArray: Array.isArray(content),
    contentLength:
        typeof content === 'string'
            ? content.length
            : Array.isArray(content)
                ? content.length
                : null,
    responseError: data.error
        ? JSON.stringify(data.error).slice(0, 500)
        : null,
});
            return data;
        } catch (error) {
            const status = Number(error.status);
            const message = String(error.message || '');

            const retryable =
                [429, 500, 502, 503, 504].includes(status) ||
                /ECONNRESET|terminated|fetch failed|timed out/i.test(message);

            if (!retryable || attempt === maxAttempts) {
                throw error;
            }

            const delay = 2000 * Math.pow(2, attempt - 1);

            console.log(
                `Kenari gagal sementara. Percobaan ${attempt}/${maxAttempts}. ` +
                `Mencoba lagi dalam ${delay / 1000} detik.`
            );

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Tambahkan fungsi ini di atas transcribeSegment:
// Tambahkan fungsi ini di atas transcribeSegment:

// === 1. Tambahkan dua blok ini SEBELUM formatTranscriptText ===
// Penanda catatan meta yang biasanya ditambahkan model di akhir transkrip.
const META_MARKERS = [
    // Inggris
    'checking transcript',
    'everything aligns',
    'let me verify',
    'i will verify',
    'transcript verified',
    'note to the reader',

    // Indonesia
    'transkrip sudah sesuai',
    'saya sudah memeriksa',
    'catatan verifikasi',

    // Arab
    'المطابقة تامة',
    'تم التحقق من',
    'ملاحظة للمحقق',
];

function stripMetaNotes(text) {
    const lines = text.split('\n');
    const total = lines.length;
    const charTotal = text.length || 1;

    let pos = 0;
    const positions = lines.map((line) => {
        const at = pos;
        pos += line.length + 1;
        return at;
    });

    for (let i = 0; i < total; i++) {
        const lower = lines[i].trim().toLowerCase();

        // Arab: teks Arab sering tak punya batas spasi → pakai includes.
        const hit = META_MARKERS.find((marker) =>
            /[\u0600-\u06FF]/.test(marker)
                ? lines[i].includes(marker)
                : lower.startsWith(marker)
        );

        if (!hit) continue;

        const appearsLate =
            i >= total * 0.7 ||
            positions[i] >= charTotal * 0.7;

        const contentBefore = lines.slice(0, i).join('\n').trim();

        // Penanda di akhir → aman potong ke akhir. Penanda di tengah → buang barisnya saja.
        if (contentBefore.length < 100) return '';

        if (appearsLate) {
            return lines.slice(0, i).join('\n').replace(/\s+$/, '');
        }

        lines[i] = '';
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// === 2. formatTranscriptText versi aman ===
function formatTranscriptText(rawText) {
    if (!rawText) return '';

    let text = rawText;

    // 1. Buang CoT / penalaran internal jika muncul
    text = text.replace(/<thought>[\s\S]*?<\/thought>/gi, '');

    // 1a. Buang pembuka gaya "The user wants..." — HANYA bila benar-benar di awal teks.
    text = text.replace(
        /^(?:the user wants\b|i need to\b|let'?s listen\b)[^\n]*\n?/i,
        ''
    );

    // 1b. Buang catatan meta (VERSI AMAN — ganti regex ekor lama).
    text = stripMetaNotes(text);

    // 2. Buang timestamp — hanya pola jam yang utuh (00:00–23:59).
    text = text.replace(
        /(^|[\s(\[])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s*-\s*(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?(?=[\s)\]:]|$)/gm,
        '$1'
    );

    // 3. Rapikan baris
    text = text.replace(/\r\n/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');

    // 4. Bersihkan spasi ganda di dalam baris
    text = text.replace(/[ \t]{2,}/g, ' ').trim();

    return text;
}


 // ---- fungsi transkrip ----


async function transcribeSegment(
    filePath,
    segmentNumber,
    usageContext
) {
    try {
        console.log(
            `[Segmen ${segmentNumber}] Mengirim audio ke Kenari...`
        );

        const result = await generateContentWithRetry(filePath);

        console.log(
            `[Segmen ${segmentNumber}] Penggunaan token:`,
            {
                prompt_tokens: result.usage?.prompt_tokens,
                completion_tokens: result.usage?.completion_tokens,
                total_tokens: result.usage?.total_tokens,
                request_id: result.id,
            }
        );

        let text = result.choices?.[0]?.message?.content?.trim();

        if (!text || typeof text !== 'string') {
            throw new Error(
                `Transkrip segmen ${segmentNumber} kosong atau format respons tidak dikenal.`
            );
        }

        text = formatTranscriptText(text);

        await logTokenUsage({
            ...usageContext,
            stage: 'transcription',
            segmentNumber,
            model: result.model || 'gemini-3-8-flash',
            usage: result.usage || {},
            status: 'success',
        });

        console.log(
            `[Segmen ${segmentNumber}] Transkripsi berhasil.`
        );

        return text;
    } catch (error) {
        console.error(
            `[Segmen ${segmentNumber}] Proses gagal:`,
            error.message
        );

        await logTokenUsage({
            ...usageContext,
            stage: 'transcription',
            segmentNumber,
            status: 'failed',
            errorMessage: error.message,
        });

        throw error;
    }
}


function toTelegramHtml(text) {
    return text
        // 1. Amankan karakter dasar HTML
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // 2. Ubah **teks** atau *teks* menjadi cetak tebal <b>teks</b>
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

function splitTelegramText(text, limit = TELEGRAM_TEXT_LIMIT) {
    const chunks = [];
    let remaining = text.trim();

    while (remaining.length > limit) {
        let cut = remaining.lastIndexOf('\n', limit);

        if (cut < limit * 0.5) {
            cut = remaining.lastIndexOf(' ', limit);
        }

        if (cut < 1) cut = limit;

        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }

    if (remaining) chunks.push(remaining);

    return chunks;
}

const SUMMARY_PROMPT = `
You are an expert Islamic scholarly editor (Muhaqqiq / محقق علمي).
Analyze the provided lecture transcript and compile a comprehensive scholarly appendix.

CRITICAL LANGUAGE RULE:
- Detect the primary language of the transcript.
- If the transcript is in ARABIC, you MUST write the entire output, headings, and descriptions 100% in formal scholarly ARABIC with COMPLETE diacritics/tashkeel (تشكيل كامل), using Template A.
- If the transcript is in INDONESIAN, write the explanations in Indonesian (while keeping Quranic verses, Hadith, and poetry in fully vowelized Arabic), using Template B.

CRITICAL FORMATTING RULE:
- Always put TWO newlines (blank line) before every section heading so headings never merge into previous lines.

=== TEMPLATE A (USE THIS IF TRANSCRIPT IS IN ARABIC) ===

✨ *خُلَاصَةُ المَجْلِسِ وَفَوَائِدُهُ*
- (اُكْتُبْ ٥-٧ نِقَاطٍ تُلَخِّصُ أَهَمَّ الفَوَائِدِ وَالمَسَائِلِ العِلْمِيَّةِ المَذْكُورَةِ فِي المَجْلِسِ بِالتَّشْكِيلِ الكَامِلِ)

📖 *فِهْرِسُ الآيَاتِ القُرْآنِيَّةِ*
- (اُسْرُدِ الآيَاتِ القُرْآنِيَّةَ المَذْكُورَةَ مَعَ اسْمِ السُّورَةِ. إِنْ لَمْ يُوجَدْ فَاكْتُبْ: «لَا يُوجَدُ»)

📜 *فِهْرِسُ الأَحَادِيثِ وَالآثَارِ وَالأَبْيَاتِ*
- (اُسْرُدِ الأَحَادِيثَ وَالآثَارَ وَالأَبْيَاتِ الشِّعْرِيَّةَ المَذْكُورَةَ مَعَ التَّشْكِيلِ الكَامِلِ. إِنْ لَمْ يُوجَدْ فَاكْتُبْ: «لَا يُوجَدُ»)

📚 *فِهْرِسُ الأَعْلَامِ وَالفِرَقِ وَالكُتُبِ*
- الأَعْلَامُ: ...
- الفِرَقُ وَالطَّوَائِفُ: ...
- الكُتُبُ وَالمَصَادِرُ: ...

=== TEMPLATE B (USE THIS IF TRANSCRIPT IS IN INDONESIAN) ===

✨ *INTISARI & FAIDAH KAJIAN*
- (Tuliskan 5-7 poin kesimpulan utama dan faidah penting dari kajian ini)

📖 *DAFTAR AYAT AL-QUR'AN*
- (Daftar ayat Al-Qur'an yang dibacakan beserta nama surahnya. Jika tidak ada, tulis "-")

📜 *DAFTAR HADITS, ATSAR & SYA'IR*
- (Daftar kutipan hadits, atsar, atau bait sya'ir beserta teks Arab berharakatnya. Jika tidak ada, tulis "-")

📚 *DAFTAR TOKOH, FIRQAH & KITAB*
- Tokoh & Ulama: ...
- Firqah & Aliran: ...
- Kitab & Referensi: ...

IMPORTANT: Do not invent specific page numbers or hadith numbers if not explicitly mentioned in the text.
`;

async function generateFaidahAndIndeks(fullTranscript, usageContext, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            console.log('[Tahap 2] Menyusun Faidah & Indeks Dalil...');
            const response = await fetch(
                'https://kenari.id/v1/chat/completions',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${process.env.KENARI_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: 'gemini-3-8-flash',
                        messages: [
                            {
                                role: 'system',
                                content: SUMMARY_PROMPT,
                            },
                            {
                                role: 'user',
                                content: `Berikut adalah naskah transkrip kajian:\n\n${fullTranscript}`,
                            },
                        ],
                        temperature: 0.2,
                        max_tokens: 4096,
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            await logTokenUsage({
    ...usageContext,
    stage: 'faidah_indeks',
    model: data.model || 'gemini-3-8-flash',
    usage: data.usage || {},
    status: 'success',
});
            return data.choices?.[0]?.message?.content?.trim() || '';
        } catch (error) {
            console.error(`[Tahap 2] Percobaan ${attempt} gagal:`, error.message);
            if (attempt === maxAttempts) {
    await logTokenUsage({
        ...usageContext,
        stage: 'faidah_indeks',
        status: 'failed',
        errorMessage: error.message,
    });

    return '';
}
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// -- PROSES AUDIO

async function processAudio(ctx, media, uploaded = null, tracking = {}) {
    const telegramId = uploaded
        ? uploaded.telegramId
        : ctx.from.id;

    // Satu jobId digunakan untuk seluruh tahapan pekerjaan.
    const jobId =
        uploaded?.jobId ||
        tracking.jobId ||
        crypto.randomUUID();

    const source =
        uploaded?.source ||
        tracking.source ||
        (uploaded ? 'miniapp' : 'telegram');

    const jobStartedAt = performance.now();
    const queuedAt = uploaded?.queuedAt ?? tracking.queuedAt;

    const duration = Number(
        uploaded ? uploaded.duration : media?.duration
    );

    const validDuration =
        Number.isInteger(duration) && duration > 0
            ? duration
            : null;

    const fileSizeBytes =
        uploaded?.fileSizeBytes ??
        media?.file_size ??
        null;

    const meta = {
        telegramId,
        jobId,
        source,
    };

    const stageExtra = {
        fileSizeBytes,
        audioDurationSeconds: validDuration,
    };

    const reply = uploaded
        ? (text) => bot.telegram.sendMessage(telegramId, text)
        : (text) => ctx.reply(text);

    const userContext = uploaded
        ? {
            from: {
                id: telegramId,
                username: uploaded.username,
                first_name: uploaded.firstName,
            },
        }
        : ctx;

    let reserved = false;
    let transcriptionComplete = false;
    let workDir = '';
    let jobStatus = 'failed';

    try {
        // 1. Waktu menunggu antrean
        if (queuedAt != null) {
            await logJobStage({
                ...meta,
                stage: 'queue_wait',
                durationMs: Math.max(
                    0,
                    jobStartedAt - queuedAt
                ),
                status: 'success',
                ...stageExtra,
            });
        }

        if (!validDuration) {
            await reply('Durasi audio tidak terbaca.');
            return;
        }

        if (
            !uploaded &&
            media.file_size &&
            media.file_size > MAX_DOWNLOAD_BYTES
        ) {
            await reply(
                'Ukuran audio melebihi batas 20 MiB untuk unggahan Telegram.'
            );
            return;
        }

        const user = await ensureUser(userContext);

        if (Number(user.sisa_kuota) < duration) {
            await reply(
                `⚠️ *Kuota Tidak Mencukupi*\n\n` +
                `Durasi audio: ${formatDuration(duration)}\n` +
                `Sisa kuota Anda: ${formatDuration(user.sisa_kuota)}\n\n` +
                `Untuk menambah kuota, silakan transfer infaq dan kirimkan bukti transfer beserta ID Telegram Anda ke admin.\n\n` +
                `ID Telegram Anda: \`${telegramId}\``,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const reservedSuccessfully = await reserveQuota(
            telegramId,
            duration
        );

        if (!reservedSuccessfully) {
            const balance = await getBalance(telegramId);

            await reply(
                `Kuota tidak cukup atau sudah digunakan permintaan lain.\n` +
                `Sisa kuota: ${formatDuration(balance)}.`
            );

            return;
        }

        reserved = true;

        await reply(
            `Audio diterima (${formatDuration(duration)}).\n` +
            'Kuota dicadangkan. Mulai memproses audio...'
        );

        workDir = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'kajian-transkrip-')
        );

        const originalPath = path.join(
            workDir,
            'original.bin'
        );

        const normalizedPath = path.join(
            workDir,
            'normalized.mp3'
        );

        // 2. Menyiapkan file input
        if (uploaded) {
            await measureStage(
                meta,
                'prepare_input',
                () => fs.promises.copyFile(
                    uploaded.filePath,
                    originalPath
                ),
                stageExtra
            );
        } else {
            await measureStage(
                meta,
                'telegram_download',
                () => downloadTelegramFile(
                    ctx,
                    media.file_id,
                    originalPath
                ),
                stageExtra
            );
        }

        // 3. Normalisasi audio
        await reply('🎧 Menyesuaikan format audio...');

        await measureStage(
            meta,
            'audio_normalize',
            () => normalizeAudio(
                originalPath,
                normalizedPath
            ),
            stageExtra
        );

         // 4. Menentukan pembagian segmen
        const transcripts = [];
        const starts = [0];

        while (
            starts[starts.length - 1] + CHUNK_SECONDS < duration
        ) {
            starts.push(
                starts[starts.length - 1] +
                CHUNK_SECONDS -
                OVERLAP_SECONDS
            );
        }

        // 5. Memotong dan mentranskripsikan setiap segmen
        for (let i = 0; i < starts.length; i++) {
            const start = starts[i];

            const segmentPath = path.join(
                workDir,
                `segment-${i + 1}.mp3`
            );

            const segmentDuration = Math.min(
                CHUNK_SECONDS,
                duration - start
            );

            const segmentExtra = {
                fileSizeBytes: null,
                audioDurationSeconds: segmentDuration,
            };

            await reply(
                `🧠 Transkripsi segmen ${i + 1}/${starts.length}...`
            );

            // 5a. Waktu pemotongan audio dengan FFmpeg
            await measureStage(
                meta,
                'segment_prepare',
                () => runFfmpeg([
                    '-hide_banner',
                    '-loglevel', 'error',
                    '-nostdin',
                    '-y',
                    '-ss', String(start),
                    '-i', normalizedPath,
                    '-t', String(segmentDuration),
                    '-vn',
                    '-ac', '1',
                    '-ar', '24000',
                    '-b:a', '64k',
                    '-f', 'mp3',
                    segmentPath,
                ]),
                segmentExtra
            );

            // 5b. Waktu transkripsi segmen
            const transcript = await measureStage(
                meta,
                'transcription_segment',
                () => transcribeSegment(
                    segmentPath,
                    i + 1,
                    {
                        telegramId,
                        jobId,
                        durationSeconds: segmentDuration,
                    }
                ),
                segmentExtra
            );

            transcripts.push(transcript);

            await fs.promises
                .unlink(segmentPath)
                .catch(() => {});
        }

        // 6. Menggabungkan hasil transkripsi
        let finalTranscript = '';

        for (const transcript of transcripts) {
            finalTranscript = mergeSegments(
                finalTranscript,
                transcript
            );
        }

        if (!finalTranscript.trim()) {
            throw new Error('Hasil transkripsi kosong.');
        }

        // 7. Membuat faidah dan indeks
        await reply(
            '✨ Menyusun intisari faidah & daftar dalil...'
        );

        const summaryResult = await measureStage(
            meta,
            'faidah_indeks',
            () => generateFaidahAndIndeks(
                finalTranscript,
                {
                    telegramId,
                    jobId,
                }
            ),
            stageExtra
        );

        transcriptionComplete = true;

        const remaining = await getBalance(
            telegramId
        ).catch(() => null);

        const isArabic =
            /[\u0600-\u06FF]{20,}/.test(
                finalTranscript.slice(0, 300)
            );

        const headerTitle = isArabic
            ? '📝 *النَّصُّ الكَامِلُ لِلتَّفْرِيغِ*'
            : '📝 *TRANSKRIPSI LENGKAP*';

        // 8. Kirim hasil — transkripsi sebagai file .txt, faidah di chat
        await measureStage(
            meta,
            'send_result',
            async () => {
                // Kirim transkrip lengkap sebagai file .txt
                const txtFilename = isArabic
                    ? 'transkripsi_arab.txt'
                    : 'transkripsi_kajian.txt';

                const txtPath = path.join(workDir, txtFilename);

                await fs.promises.writeFile(
                    txtPath,
                    finalTranscript,
                    'utf8'
                );

                const caption = isArabic
                    ? '📝 النَّصُّ الكَامِلُ لِلتَّفْرِيغِ'
                    : '📝 Transkripsi lengkap kajian';

                if (uploaded) {
                    await bot.telegram.sendDocument(
                        telegramId,
                        {
                            source: fs.createReadStream(txtPath),
                            filename: txtFilename,
                        },
                        { caption }
                    );
                } else {
                    await ctx.replyWithDocument(
                        {
                            source: fs.createReadStream(txtPath),
                            filename: txtFilename,
                        },
                        { caption }
                    );
                }

                // Kirim faidah & indeks di chat
                if (summaryResult) {
                    const summaryChunks = splitTelegramText(summaryResult);

                    for (let i = 0; i < summaryChunks.length; i++) {
                        let message = summaryChunks[i];

                        if (
                            i === summaryChunks.length - 1 &&
                            remaining !== null
                        ) {
                            message +=
                                `\n\n---\nSisa kuota: ${formatDuration(remaining)}`;
                        }

                        const htmlMessage = toTelegramHtml(message);

                        try {
                            if (uploaded) {
                                await bot.telegram.sendMessage(
                                    telegramId,
                                    htmlMessage,
                                    { parse_mode: 'HTML' }
                                );
                            } else {
                                await ctx.reply(
                                    htmlMessage,
                                    { parse_mode: 'HTML' }
                                );
                            }
                        } catch {
                            await reply(message);
                        }
                    }
                } else if (remaining !== null) {
                    await reply(
                        `---\nSisa kuota: ${formatDuration(remaining)}`
                    );
                }
            },
            stageExtra
        );

        jobStatus = 'success';

    } catch (error) {
        console.error(
            'Kesalahan pemrosesan audio:',
            error
        );

        if (reserved && !transcriptionComplete) {
            try {
                await refundQuota(
                    telegramId,
                    duration
                );

                console.log(
                    `Kuota pengguna ${telegramId} berhasil dikembalikan.`
                );
            } catch (refundError) {
                console.error(
                    'REFUND KUOTA GAGAL:',
                    refundError
                );
            }
        }

        try {
            await reply(
                transcriptionComplete
                    ? 'Transkripsi sudah selesai, tetapi pengiriman hasil terganggu. Periksa log server sebelum mencoba ulang.'
                    : 'Transkripsi gagal. Kuota dikembalikan jika refund berhasil. Silakan coba lagi.'
            );
        } catch (replyError) {
            console.error(
                'Gagal mengirim notifikasi Telegram:',
                replyError.message
            );
        }

    } finally {
        if (workDir) {
            await fs.promises.rm(
                workDir,
                {
                    recursive: true,
                    force: true,
                }
            ).catch((error) => {
                console.error(
                    'Gagal membersihkan folder sementara:',
                    error.message
                );
            });
        }

        // 9. Total waktu satu pekerjaan
        await logJobStage({
            ...meta,
            stage: 'job_total',
            durationMs: Math.round(
                performance.now() - jobStartedAt
            ),
            status: jobStatus,
            fileSizeBytes,
            audioDurationSeconds: validDuration,
        });
    }
}


// =====================================================
// MINI APP: STATUS DAN UNGGAHAN
// =====================================================

app.get('/health', (req, res) => {
    res.json({ ok: true });
});

app.post('/api/upload', (req, res) => {
    const user = verifyTelegramInitData(
        req.get('X-Telegram-Init-Data')
    );

    if (!user) {
        return res.status(401).json({
            error: 'Autentikasi Telegram tidak valid. Buka melalui Mini App.',
        });
    }
       // ID unik untuk melacak satu pekerjaan dari awal sampai selesai.
    const jobId = crypto.randomUUID();
    upload.single('audio')(req, res, async (error) => {
        if (error) {
            if (error.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({
                    error: 'Ukuran file maksimal 100 MiB.',
                });
            }

            if (error.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({
                    error: 'Unggah satu file audio saja.',
                });
            }

            console.error('Kesalahan unggahan:', error.message);

            return res.status(400).json({
                error: 'Unggahan tidak valid atau gagal.',
            });
        }

        if (!req.file) {
            return res.status(400).json({
                error: 'File audio belum dipilih.',
            });
        }
        

const uploadDurationMs = Math.round(
    performance.now() - req.monitorStartedAt
);

await logJobStage({
    telegramId: user.id,
    jobId,
    source: 'miniapp',
    stage: 'miniapp_upload',
    durationMs: uploadDurationMs,
    status: 'success',
    fileSizeBytes: req.file.size,
});

console.log(
    `[TIMER][miniapp][miniapp_upload] ` +
    `${(uploadDurationMs / 1000).toFixed(2)} detik`
);

        try {
            const metadata = await parseFile(req.file.path);
            const duration = Math.ceil(Number(metadata.format.duration));

            if (!Number.isSafeInteger(duration) || duration <= 0) {
                throw new Error('Durasi audio tidak valid.');
            }

            
const uploaded = {
    telegramId: user.id,
    username: user.username,
    firstName: user.first_name,
    duration,
    filePath: req.file.path,

    // Data monitoring
    jobId,
    source: 'miniapp',
    queuedAt: performance.now(),
    fileSizeBytes: req.file.size,
};


            // Pastikan antrean menerima pekerjaan sebelum memberi respons.
            const job = enqueue(async () => {
                try {
                    await processAudio(null, null, uploaded);
                } finally {
                    await fs.promises.unlink(req.file.path).catch((err) => {
                        console.error(
                            'Gagal menghapus unggahan:',
                            err.message
                        );
                    });
                }
            });

            // Antrean berjalan di latar belakang; hasil dikirim melalui bot.
            job.catch((err) => {
                console.error('Pekerjaan unggahan gagal:', err);
            });

            return res.status(202).json({
                ok: true,
                message:
                    'Unggahan diterima dan masuk antrean. Hasil akan dikirim melalui Telegram.',
                duration,
                size: req.file.size,
            });
        } catch (err) {
            await fs.promises.unlink(req.file.path).catch(() => {});

            console.error(
                'Gagal menyiapkan unggahan:',
                err.message
            );

            if (!res.headersSent) {
                return res.status(400).json({
                    error:
                        'File tidak dapat dibaca sebagai audio yang valid.',
                });
            }
        }
    });
});

// =====================================================
// COMMAND TELEGRAM
// =====================================================

bot.start(async (ctx) => {
    try {
        await ensureUser(ctx);

        await ctx.reply(
            'Assalamu’alaikum!\n\n' +
            'Selamat datang di Taqrir — bot transkripsi kajian Islam.\n\n' +
            'Dengar. Transkripsi. Simpan.\n\n' +
            'Kirimkan audio kajian kamu, dan Taqrir akan mengubahnya menjadi teks yang bisa kamu baca, simpan, dan bagikan.\n\n'+
            '✅ Audio Arab → teks Arab \n ✅ Audio Indonesia → teks Indonesia\n ✅ Bisa dari file audio atau link YouTube\n\n' +
            'Gunakan tombol menu di bawah untuk bantuan lainnya.',
            Markup.keyboard([
                ['📊 Cek Kuota', '📞 Top-up & Bantuan']
            ])
            .resize() // Menyesuaikan ukuran tombol agar tidak terlalu besar
        );
    } catch (error) {
        console.error('Gagal menjalankan /start:', error);

        await ctx.reply(
            'Maaf, pendaftaran belum berhasil. Coba lagi nanti.'
        );
    }
});

bot.command('kuota', async (ctx) => {
    try {
        const user = await ensureUser(ctx);

        await ctx.reply(
            `📊 *Informasi Akun*\n\n` +
            `ID Telegram: \`${ctx.from.id}\` (klik untuk menyalin)\n` +
            `Sisa Kuota: ${formatDuration(user.sisa_kuota)}\n\n` +
            `💡 _Sertakan ID Telegram di atas beserta bukti transfer jika Anda ingin menambah kuota._`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('Gagal membaca kuota:', error);

        await ctx.reply(
            'Maaf, kuota belum bisa diperiksa. Coba lagi nanti.'
        );
    }
});

// =====================================================
// HANDLER TOMBOL MENU BAWAAN
// =====================================================

// Ketika tombol "📊 Cek Kuota" ditekan
bot.hears('📊 Cek Kuota', async (ctx) => {
    try {
        const user = await ensureUser(ctx);

        await ctx.reply(
            `📊 *Informasi Akun*\n\n` +
            `ID Telegram: \`${ctx.from.id}\` (klik untuk menyalin)\n` +
            `Sisa Kuota: ${formatDuration(user.sisa_kuota)}\n\n` +
            `💡 _Sertakan ID Telegram di atas beserta bukti transfer jika Anda ingin menambah kuota._`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('Gagal membaca kuota:', error);
        await ctx.reply('Maaf, kuota belum bisa diperiksa. Coba lagi nanti.');
    }
});

// Ketika tombol "📞 Top-up & Bantuan" ditekan
bot.hears('📞 Top-up & Bantuan', async (ctx) => {
    await ctx.reply(
        `📞 *Bantuan & Penambahan Kuota*\n\n` +
        `Bot ini memproses audio menggunakan server AI. Untuk menjaga server tetap berjalan, penambahan kuota dilakukan melalui sistem infaq.\n\n` +
        `**Paket Infaq:**\n` +
        `• 1 Jam (60 menit) = Rp 10.000\n` +
        `• 3 Jam (180 menit) = Rp 25.000\n\n` +
        `💳 **Cara Top-up:**\n` +
        `1. Transfer ke Bank Jago Syariah: 503885989416 (a.n Adi Rahman Hakim)\n` +
        `2. Atau Gopay: 081287930672\n` +
        `3. Kirimkan bukti transfer beserta **ID Telegram** Anda ke kontak admin.\n\n` +
        `👨🏻‍💻 Kontak Admin: @diar699`, // <--- Ganti dengan username Telegram aslimu
        { parse_mode: 'Markdown' }
    );
});

// =====================================================
// COMMAND ADMIN: TAMBAH KUOTA
// =====================================================
bot.command('tambahkuota', async (ctx) => {
    // 1. Validasi: Pastikan yang mengirim adalah Admin
    const adminId = parseInt(process.env.ADMIN_TELEGRAM_ID);
    if (ctx.from.id !== adminId) {
        // Abaikan diam-diam jika yang mengetik bukan admin
        return; 
    }

    // 2. Baca format input pengguna (Contoh: /tambahkuota 987654321 60)
    const text = ctx.message.text.trim();
    const args = text.split(/\s+/); // Memisahkan berdasarkan spasi

    if (args.length !== 3) {
        return ctx.reply(
            '⚠️ *Format salah!*\n\n' +
            'Gunakan format:\n`/tambahkuota <telegram_id_user> <jumlah_menit>`\n\n' +
            'Contoh:\n`/tambahkuota 987654321 60`',
            { parse_mode: 'Markdown' }
        );
    }

    const targetId = parseInt(args[1]);
    const tambahanMenit = parseInt(args[2]);

    // 3. Validasi angka
    if (isNaN(targetId) || isNaN(tambahanMenit) || tambahanMenit <= 0) {
        return ctx.reply('⚠️ ID Telegram atau jumlah menit tidak valid. Pastikan berupa angka positif.');
    }

    // Karena sistem kamu memotong saldo berbasis detik, konversi menit ke detik
    const tambahanDetik = tambahanMenit * 60;

    try {
        await ctx.reply('⏳ Sedang memproses penambahan kuota...');

        // 4. Cari user di database
        const { data: user, error: readError } = await supabase
            .from('users')
            .select('sisa_kuota')
            .eq('telegram_id', targetId)
            .single();

        if (readError) {
            // Jika user tidak ada di database Supabase
            if (readError.code === 'PGRST116') {
                return ctx.reply('❌ Gagal: User dengan ID tersebut belum pernah terdaftar / belum menekan tombol Start.');
            }
            throw readError;
        }

        const currentQuota = Number(user.sisa_kuota) || 0;
        const newQuota = currentQuota + tambahanDetik;

        // 5. Update kuota baru ke database Supabase
        const { error: updateError } = await supabase
            .from('users')
            .update({ sisa_kuota: newQuota })
            .eq('telegram_id', targetId);

        if (updateError) throw updateError;

        // 6. Laporan ke Admin (Kamu)
        await ctx.reply(
            `✅ *Transaksi Berhasil!*\n\n` +
            `ID User: \`${targetId}\`\n` +
            `Top-up: ${tambahanMenit} menit\n` +
            `Total Sisa Kuota: ${formatDuration(newQuota)}`,
            { parse_mode: 'Markdown' }
        );

        // 7. Kirim notifikasi langsung ke User yang bersangkutan
        try {
            await bot.telegram.sendMessage(
                targetId,
                `🎉 *Alhamdulillah!*\n\nKuota transkripsi Anda telah ditambahkan sebanyak *${tambahanMenit} menit*.\n\n` +
                `Silakan ketik /kuota untuk mengecek saldo terbaru dan kembali mengunggah audio kajian. Jazakallah khairan.`,
                { parse_mode: 'Markdown' }
            );
        } catch (notifyError) {
            console.error('Gagal kirim notif ke user:', notifyError.message);
            await ctx.reply('⚠️ Catatan: Kuota berhasil ditambah ke database, tetapi bot gagal mengirim notifikasi ke user (kemungkinan user telah memblokir bot).');
        }

    } catch (error) {
        console.error('Error tambahkuota:', error);
        await ctx.reply('❌ Terjadi kesalahan pada server saat menambah kuota.');
    }
});


async function fetchUsageLogs({
    telegramId = null,
    since,
    limit = 5000,
} = {}) {
    let query = supabase
        .from('usage_logs')
        .select(
            'telegram_id, job_id, stage, prompt_tokens, completion_tokens, total_tokens, duration_seconds, status, created_at'
        )
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (telegramId !== null) {
        query = query.eq('telegram_id', telegramId);
    }

    const { data, error } = await query;

    if (error) throw error;

    return data || [];
}

function summarizeUsage(logs) {
    return logs.reduce((sum, log) => {
        sum.requests += 1;
        sum.prompt += Number(log.prompt_tokens) || 0;
        sum.completion += Number(log.completion_tokens) || 0;
        sum.total += Number(log.total_tokens) || 0;

        if (log.status === 'success') {
            sum.success += 1;
        } else {
            sum.failed += 1;
        }

        return sum;
    }, {
        requests: 0,
        prompt: 0,
        completion: 0,
        total: 0,
        success: 0,
        failed: 0,
    });
}

function getThirtyDaysAgo() {
    return new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();
}

// Monitoring seluruh pengguna selama 30 hari.
bot.command('monitor', async (ctx) => {
    if (!isAdmin(ctx)) return;

    try {
        const logs = await fetchUsageLogs({
            since: getThirtyDaysAgo(),
        });

        const total = summarizeUsage(logs);
        const users = new Map();

        for (const log of logs) {
            const id = String(log.telegram_id);

            if (!users.has(id)) {
                users.set(id, {
                    id,
                    tokens: 0,
                    requests: 0,
                });
            }

            const user = users.get(id);
            user.tokens += Number(log.total_tokens) || 0;
            user.requests += 1;
        }

        const topUsers = [...users.values()]
            .sort((a, b) => b.tokens - a.tokens)
            .slice(0, 10);

        const topText = topUsers.length
            ? topUsers.map((user, index) =>
                `${index + 1}. ${user.id} — ` +
                `${formatNumber(user.tokens)} token`
            ).join('\n')
            : 'Belum ada data penggunaan.';

        await ctx.reply(
            `📊 MONITORING TOKEN BOT-TELE\n` +
            `Periode: 30 hari terakhir\n\n` +
            `Total token: ${formatNumber(total.total)}\n` +
            `• Input: ${formatNumber(total.prompt)}\n` +
            `• Output: ${formatNumber(total.completion)}\n\n` +
            `Catatan API: ${formatNumber(total.requests)}\n` +
            `Berhasil: ${formatNumber(total.success)}\n` +
            `Gagal: ${formatNumber(total.failed)}\n\n` +
            `🏆 PENGGUNA TERBANYAK\n${topText}\n\n` +
            `Catatan: maksimal 5.000 catatan terbaru.`
        );
    } catch (error) {
        console.error('[Monitor] Gagal membaca laporan:', error);

        await ctx.reply(
            'Gagal membaca monitoring. Periksa tabel usage_logs dan konfigurasi Supabase.'
        );
    }
});

// Monitoring penggunaan sejak tengah malam waktu lokal komputer.
bot.command('monitor_hari_ini', async (ctx) => {
    if (!isAdmin(ctx)) return;

    try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);

        const logs = await fetchUsageLogs({
            since: start.toISOString(),
        });

        const total = summarizeUsage(logs);

        await ctx.reply(
            `📊 MONITOR TOKEN HARI INI\n\n` +
            `Total token: ${formatNumber(total.total)}\n` +
            `• Input: ${formatNumber(total.prompt)}\n` +
            `• Output: ${formatNumber(total.completion)}\n\n` +
            `Catatan API: ${formatNumber(total.requests)}\n` +
            `Berhasil: ${formatNumber(total.success)}\n` +
            `Gagal: ${formatNumber(total.failed)}`
        );
    } catch (error) {
        console.error('[Monitor] Gagal membaca penggunaan hari ini:', error);

        await ctx.reply(
            'Gagal membaca monitoring hari ini.'
        );
    }
});

// monitoring penggunaan
// Rincian penggunaan satu pengguna selama 30 hari.
bot.command('monitor_user', async (ctx) => {
    if (!isAdmin(ctx)) return;

    const args = ctx.message.text.trim().split(/\s+/);
    const targetId = args[1];

    if (!targetId || !/^\d+$/.test(targetId)) {
        return ctx.reply(
            'Format:\n/monitor_user <telegram_id>\n\n' +
            'Contoh:\n/monitor_user 123456789'
        );
    }

    try {
        const logs = await fetchUsageLogs({
            telegramId: targetId,
            since: getThirtyDaysAgo(),
            limit: 1000,
        });

        const total = summarizeUsage(logs);

        const { data: user, error: userError } = await supabase
            .from('users')
            .select('username, sisa_kuota')
            .eq('telegram_id', targetId)
            .maybeSingle();

        if (userError) throw userError;

        const stages = new Map();

        for (const log of logs) {
            stages.set(
                log.stage,
                (stages.get(log.stage) || 0) +
                    (Number(log.total_tokens) || 0)
            );
        }

        const stageText = [...stages.entries()]
            .map(([stage, tokens]) =>
                `• ${stage}: ${formatNumber(tokens)} token`
            )
            .join('\n') || 'Belum ada rincian tahap.';

        await ctx.reply(
            `👤 MONITOR PENGGUNA\n\n` +
            `ID: ${targetId}\n` +
            `Username: ${user?.username || 'Tidak tersedia'}\n` +
            `Sisa kuota: ${user ? formatDuration(user.sisa_kuota) : 'Pengguna tidak ditemukan'}\n\n` +
            `Periode: 30 hari terakhir\n` +
            `Total token: ${formatNumber(total.total)}\n` +
            `• Input: ${formatNumber(total.prompt)}\n` +
            `• Output: ${formatNumber(total.completion)}\n\n` +
            `Catatan API: ${formatNumber(total.requests)}\n` +
            `Berhasil: ${formatNumber(total.success)}\n` +
            `Gagal: ${formatNumber(total.failed)}\n\n` +
            `RINCIAN TAHAP\n${stageText}\n\n` +
            `Catatan: maksimal 1.000 catatan terbaru pengguna.`
        );
    } catch (error) {
        console.error('[Monitor] Gagal membaca penggunaan user:', error);

        await ctx.reply(
            'Gagal membaca data pengguna. Periksa tabel usage_logs.'
        );
    }
});

// =====================================================
// COMMAND konfirmasi judul dan tombol
// =====================================================

bot.on('text', async (ctx, next) => {
    const url = extractYoutubeUrl(ctx.message.text);

    if (!url) {
        return next();
    }

    try {
        // Bersihkan permintaan lama.
        const now = Date.now();

        for (const [token, request] of pendingYoutubeRequests) {
            if (request.expiresAt <= now) {
                pendingYoutubeRequests.delete(token);
            }
        }

        const info = await getYoutubeInfo(url);
        const token = crypto.randomBytes(8).toString('hex');

        pendingYoutubeRequests.set(token, {
            ...info,
            telegramId: ctx.from.id,
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            expiresAt: Date.now() + YOUTUBE_REQUEST_TTL_MS,
            status: 'pending',
        });

        await ctx.reply(
            `🎬 Konfirmasi Video YouTube\n\n` +
            `Judul: ${info.title}\n` +
            `Durasi: ${formatDuration(info.duration)}\n\n` +
            `Tekan tombol di bawah jika ingin memulai transkripsi.`,
            Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        '▶️ Mulai Transkripsi',
                        `yt:start:${token}`
                    ),
                ],
                [
                    Markup.button.callback(
                        '❌ Batal',
                        `yt:cancel:${token}`
                    ),
                ],
            ])
        );
    } catch (error) {
        console.error('Gagal membaca metadata YouTube:', error.message);

        await ctx.reply(
            'Maaf, bot tidak dapat membaca video YouTube tersebut. ' +
            'Pastikan video bisa diakses dan coba kirim ulang link-nya.'
        );
    }
});

bot.action(/^yt:cancel:([a-f0-9]+)$/, async (ctx) => {
    const token = ctx.match[1];
    const request = pendingYoutubeRequests.get(token);

    if (!request || request.telegramId !== ctx.from.id) {
        await ctx.answerCbQuery('Permintaan tidak ditemukan.');
        return;
    }

    if (request.status !== 'pending') {
        await ctx.answerCbQuery('Permintaan sudah diproses.');
        return;
    }

    pendingYoutubeRequests.delete(token);

    await ctx.answerCbQuery('Permintaan dibatalkan.');

    await ctx.editMessageText('❌ Permintaan transkripsi dibatalkan.')
        .catch(() => {});
});

bot.action(/^yt:start:([a-f0-9]+)$/, async (ctx) => {
    const token = ctx.match[1];
    const request = pendingYoutubeRequests.get(token);

    if (!request || request.telegramId !== ctx.from.id) {
        await ctx.answerCbQuery('Permintaan tidak ditemukan.');
        return;
    }

    if (request.expiresAt <= Date.now()) {
        pendingYoutubeRequests.delete(token);

        await ctx.answerCbQuery('Konfirmasi kedaluwarsa.');

        await ctx.editMessageText(
            '⌛ Permintaan kedaluwarsa. Silakan kirim ulang link YouTube.'
        ).catch(() => {});

        return;
    }

    if (request.status !== 'pending') {
        await ctx.answerCbQuery('Permintaan sudah masuk antrean.');
        return;
    }

    // Buat ID pekerjaan dan catat waktu masuk antrean.
    request.status = 'queued';
    request.jobId = crypto.randomUUID();
    request.queuedAt = performance.now();

    await ctx.answerCbQuery('Permintaan masuk antrean.');

    await ctx.editMessageText(
        `✅ Permintaan diterima.\n\n` +
        `Judul: ${request.title}\n` +
        `Durasi: ${formatDuration(request.duration)}\n\n` +
        `Bot akan mengunduh audio dan memproses transkripsi secara berurutan.`
    ).catch(() => {});

    // Satu pekerjaan YouTube hanya menggunakan satu enqueue().
    const job = enqueue(async () => {
        let workDir = '';
        let jobStatus = 'failed';

        const jobMeta = {
            telegramId: request.telegramId,
            jobId: request.jobId,
            source: 'youtube',
        };

        try {
            // 1. Catat waktu menunggu antrean.
            await logJobStage({
                ...jobMeta,
                stage: 'queue_wait',
                durationMs: Math.max(
                    0,
                    performance.now() - request.queuedAt
                ),
                status: 'success',
            });

            // 2. Buat folder kerja sementara.
            workDir = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'kajian-youtube-')
            );

            await bot.telegram.sendMessage(
                request.telegramId,
                '⬇️ Sedang mengunduh audio dari YouTube...'
            );

            // 3. Unduh audio dan ukur durasinya.
            const audioPath = await measureStage(
                jobMeta,
                'youtube_download',
                () => downloadYoutubeAudio(
                    request.url,
                    workDir
                ),
                {
                    audioDurationSeconds: request.duration,
                }
            );

            // 4. Baca durasi aktual audio.
            const audioMetadata = await parseFile(audioPath);

            const actualDuration = Math.ceil(
                Number(audioMetadata.format.duration)
            );

            if (
                !Number.isSafeInteger(actualDuration) ||
                actualDuration <= 0
            ) {
                throw new Error(
                    'Durasi audio hasil unduhan tidak valid.'
                );
            }

            // 5. Baca ukuran file audio.
            const stat = await fs.promises.stat(audioPath);

            // 6. Siapkan data untuk processAudio().
            const uploaded = {
                telegramId: request.telegramId,
                username: request.username,
                firstName: request.firstName,
                duration: actualDuration,
                filePath: audioPath,
                jobId: request.jobId,
                source: 'youtube',
                queuedAt: null,
                fileSizeBytes: stat.size,
            };

            // 7. Proses langsung karena sudah berada di dalam antrean.
            // Jangan memanggil enqueue() lagi di sini.
           await processAudio(null, null, uploaded);

jobStatus = 'success';

        } catch (error) {
            console.error(
                '[YouTube] Pekerjaan gagal:',
                error
            );

            await bot.telegram.sendMessage(
                request.telegramId,
                '❌ Gagal mengambil atau memproses audio YouTube. ' +
                'Silakan coba lagi nanti.'
            ).catch(() => {});

        } finally {
            // 8. Hapus file sementara.
            if (workDir) {
                await fs.promises.rm(
                    workDir,
                    {
                        recursive: true,
                        force: true,
                    }
                ).catch((error) => {
                    console.error(
                        'Gagal membersihkan file YouTube:',
                        error.message
                    );
                });
            }

            // 9. Catat durasi total sejak masuk antrean.
            await logJobStage({
                ...jobMeta,
                stage: 'youtube_total',
                durationMs: Math.round(
                    performance.now() - request.queuedAt
                ),
                status: jobStatus,
            });

            pendingYoutubeRequests.delete(token);
        }
    });

    job.catch((error) => {
        console.error(
            '[YouTube] Antrean gagal:',
            error
        );
    });
});

// =====================================================
// HANDLER AUDIO TELEGRAM
// =====================================================


bot.on(['voice', 'audio'], async (ctx) => {
    const media = ctx.message.voice || ctx.message.audio;

    const tracking = {
        jobId: crypto.randomUUID(),
        source: 'telegram',
        queuedAt: performance.now(),
    };

    await ctx.reply('Permintaan diterima dan masuk antrean.');

    await enqueue(() =>
        processAudio(ctx, media, null, tracking)
    );
});


// =====================================================
// JALANKAN BOT DAN SERVER MINI APP
// =====================================================

const uploadServer = app.listen(
    UPLOAD_PORT,
    '0.0.0.0', // Ubah dari '127.0.0.1' agar bisa menerima koneksi dari localhost IPv4/IPv6 maupun tunnel
    () => {
        console.log(
            `Server Mini App aktif di port ${UPLOAD_PORT}`
        );
        console.log('Batas unggahan: 100 MiB');
    }
);

// Cegah pemutusan koneksi saat file besar sedang dikirim
uploadServer.timeout = 0;              // Matikan idle timeout
uploadServer.requestTimeout = 900000;   // 15 menit
uploadServer.keepAliveTimeout = 65000;
uploadServer.headersTimeout = 66000;

uploadServer.on('error', (error) => {
    console.error(
        'Server Mini App gagal dijalankan:',
        error.message
    );
    process.exitCode = 1;
});
async function startApp() {
    try {
        if (process.env.WEBHOOK_DOMAIN) {
            const webhookUrl = `https://${process.env.WEBHOOK_DOMAIN}/bot-webhook`;
            await bot.telegram.setWebhook(webhookUrl);
            console.log(`✅ Webhook aktif: ${webhookUrl}`);
        } else {
            bot.launch();
            console.log('✅ Bot polling aktif (mode dev).');
        }
        console.log('✅ Bot transkripsi siap menerima audio.');
    } catch (error) {
        console.error('Bot gagal dijalankan:', error);
        process.exitCode = 1;
    }
}

startApp();
async function shutdown(signal) {
    console.log(`Menghentikan layanan (${signal})...`);

    if (process.env.WEBHOOK_DOMAIN) {
        await bot.telegram.deleteWebhook().catch(() => {});
    } else {
        bot.stop(signal);
    }

    if (uploadServer) {
        uploadServer.close(() => {
            console.log('Server Mini App dihentikan.');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
