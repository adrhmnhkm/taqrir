require('dotenv').config();

async function cekModel() {
    console.log("⏳ Sedang menghubungi server Google...");
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        const data = await response.json();
        
        console.log("\n✅ BERHASIL! Ini daftar model yang bisa Anda gunakan:\n");
        
        data.models.forEach(model => {
            // Hanya tampilkan model Gemini yang mendukung fitur generateContent
            if (model.name.includes('gemini') && model.supportedGenerationMethods.includes('generateContent')) {
                // Hapus tulisan "models/" di depannya agar mudah disalin
                const namaModel = model.name.replace('models/', '');
                console.log(`- ${namaModel}`);
            }
        });
        
    } catch (error) {
        console.log("❌ Gagal mengecek:", error);
    }
}

cekModel();