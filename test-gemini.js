
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');

async function main() {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const model = genAI.getGenerativeModel({
        model: 'gemini-3.8-flash'
    });

    const result = await model.generateContent('Balas satu kata: BERHASIL');

    console.log(result.response.text());
}

main().catch(error => {
    console.error('Tes Gemini gagal:', error);
});
