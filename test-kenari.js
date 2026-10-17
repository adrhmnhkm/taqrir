
require('dotenv').config();

async function main() {
    const apiKey = process.env.KENARI_API_KEY;

    if (!apiKey) {
        throw new Error('KENARI_API_KEY tidak ditemukan di .env');
    }

    const response = await fetch(
        'https://kenari.id/v1/chat/completions',
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gemini-3-8-flash',
                messages: [
                    {
                        role: 'user',
                        content: 'Balas hanya dengan: Koneksi Kenari berhasil.',
                    },
                ],
            }),
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status}: ${JSON.stringify(data)}`
        );
    }

    console.log('Respons model:', data.choices?.[0]?.message?.content);
    console.log('ID permintaan:', response.headers.get('x-request-id'));
}

main().catch(error => {
    console.error('Tes gagal:', error.message);
});
