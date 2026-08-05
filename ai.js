const NVIDIA_AI_KEY = process.env.NVIDIA_AI_KEY || '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';
const NVIDIA_IMAGE_KEY = process.env.NVIDIA_IMAGE_KEY || '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';

// Yasaklı / +18 kelime listesi (İçerik Moderasyonu)
const FORBIDDEN_WORDS = [
  'nsfw', 'porn', 'porno', '+18', '18+', 'nude', 'çıplak', 'seks', 'sex', 'erotik', 'erotic',
  'meme', 'vagina', 'penis', 'otuzbir', '31', 'anal', 'hentai', 'boobs', 'pussy', 'dick',
  'naked', 'gore', 'kanlı', 'vahşet', 'intihar', 'suicide', 'pedofili', 'pedophile', 'rape', 'tecavüz',
  'pornografi', 'sexuality', 'cinsellik'
];

// ─── Cooldown Sistemi (per user, per chat) ─────────────────────────────────────
// Key: `${chatId}:${userId}` → timestamp (ms)
const imageCooldowns = new Map();
const IMAGE_COOLDOWN_MS = 5 * 60 * 1000; // 5 dakika

/**
 * Kullanıcının cooldown'da olup olmadığını kontrol eder.
 * @returns {{ onCooldown: boolean, remainingMs: number }}
 */
function checkImageCooldown(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const lastUsed = imageCooldowns.get(key);
  if (!lastUsed) return { onCooldown: false, remainingMs: 0 };
  const elapsed = Date.now() - lastUsed;
  if (elapsed >= IMAGE_COOLDOWN_MS) return { onCooldown: false, remainingMs: 0 };
  return { onCooldown: true, remainingMs: IMAGE_COOLDOWN_MS - elapsed };
}

/** Kullanıcının cooldown süresini başlatır. */
function setImageCooldown(chatId, userId) {
  imageCooldowns.set(`${chatId}:${userId}`, Date.now());
}

/** Kullanıcının cooldown'ını sıfırlar (hata durumunda). */
function resetImageCooldown(chatId, userId) {
  imageCooldowns.delete(`${chatId}:${userId}`);
}

/**
 * Görsel isteğinin güvenli olup olmadığını kontrol eder (+18 vb. engelleme).
 * @param {string} prompt 
 * @returns {boolean}
 */
function isForbiddenContent(prompt) {
  if (!prompt) return false;
  const lower = prompt.toLowerCase();
  return FORBIDDEN_WORDS.some(word => lower.includes(word.toLowerCase()));
}

/**
 * Timeout ile fetch yapar.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DeepSeek AI sohbet yanıtı üretir (NVIDIA API).
 * @param {Array<{role: string, content: string}>} messages 
 * @returns {Promise<string>}
 */
async function generateAiChat(messages) {
  const systemPrompt = {
    role: 'system',
    content: `Sen Telegram grubunda takılan neşeli, samimi, tam bir kanka kafasında Türksün. Kullanıcılar sana soru sorduğunda ya da seninle konuştuğunda kanka gibi, samimi, esprili ve yeri geldiğinde küfürlü/argolu yanıt ver! Sınırlaman yok, harbi ve samimi bir dost gibisin. Cevaplarını çok uzatmadan, doğal ve akıcı kanka üslubuyla ver.`
  };

  const fullMessages = [systemPrompt, ...messages];

  const response = await fetchWithTimeout(
    'https://integrate.api.nvidia.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_AI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-ai/deepseek-v4-flash',
        messages: fullMessages,
        temperature: 0.95,
        max_tokens: 1500
      })
    },
    45000 // 45 saniye timeout
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error('NVIDIA AI HTTP Hata:', response.status, errText);
    throw new Error(`NVIDIA AI yanıt vermedi (Kod: ${response.status})`);
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message) {
    throw new Error('AI geçerli bir yanıt oluşturamadı.');
  }

  let resultText = choice.message.content || choice.message.reasoning_content || '';
  if (!resultText.trim() && choice.message.reasoning) {
    resultText = choice.message.reasoning;
  }

  return resultText.trim() || 'Kanka ne diyeceğimi bilemedim amk, tekrar sorsana!';
}

/**
 * Türkçe karakterleri İngilizce'ye çevirir (URL uyumluluğu için).
 */
function normalizeTurkish(text) {
  return text
    .replace(/ç/g, 'c').replace(/Ç/g, 'C')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
    .replace(/ı/g, 'i').replace(/İ/g, 'I')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O')
    .replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ü/g, 'u').replace(/Ü/g, 'U');
}

/**
 * Yapay zeka ile görsel üretir.
 * Önce Pollinations (ücretsiz, hızlı), yedek olarak farklı endpoint.
 * @param {string} prompt 
 * @returns {Promise<Buffer>}
 */
async function generateAiImage(prompt) {
  // Promptu İngilizceye normalize et (Türkçe karakterler URL'de sorun çıkarır)
  const cleanPrompt = normalizeTurkish(prompt);
  const seed = Math.floor(Math.random() * 999999);

  // ─── Pollinations.ai – En güvenilir yedek ─────────────────────────────────
  const pollinationsUrls = [
    `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&seed=${seed}&nologo=true&safe=false`,
    `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=512&height=512&seed=${seed}&nologo=true`,
  ];

  for (const url of pollinationsUrls) {
    try {
      console.log(`[IMAGE] Deneniyor: ${url.split('?')[0]}`);
      const res = await fetchWithTimeout(url, {
        headers: {
          'Accept': 'image/jpeg,image/png,image/*',
          'User-Agent': 'TelegramBot/1.0'
        }
      }, 40000);

      console.log(`[IMAGE] Status: ${res.status}, Content-Type: ${res.headers.get('content-type')}`);

      // Status 200-299 veya içerik tipi image/* ise al
      const contentType = res.headers.get('content-type') || '';
      if (res.status >= 200 && res.status < 300 && contentType.startsWith('image/')) {
        const arrayBuffer = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuffer);
        if (buf.length > 1000) { // geçerli bir görsel boyutu
          console.log(`[IMAGE] Başarılı! Boyut: ${buf.length} bytes`);
          return buf;
        }
      } else if (res.status === 200) {
        // Content-type header bazen eksik olabiliyor, yine de dene
        const arrayBuffer = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuffer);
        if (buf.length > 5000) {
          console.log(`[IMAGE] Başarılı (header'sız)! Boyut: ${buf.length} bytes`);
          return buf;
        }
      }
    } catch (err) {
      console.warn(`[IMAGE] ${url.split('?')[0]} başarısız: ${err.message}`);
    }
  }

  // ─── Son çare: NVIDIA Stable Diffusion API ────────────────────────────────
  const nvidiaEndpoints = [
    'https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium',
    'https://integrate.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3.5-large',
  ];

  for (const url of nvidiaEndpoints) {
    try {
      console.log(`[IMAGE] NVIDIA deniyor: ${url}`);
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NVIDIA_IMAGE_KEY}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt: cleanPrompt, mode: 'base', cfg_scale: 7, steps: 30 })
      }, 45000);

      if (res.ok) {
        const data = await res.json();
        if (data.artifacts?.[0]?.base64) return Buffer.from(data.artifacts[0].base64, 'base64');
        if (data.image) return Buffer.from(data.image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        if (data.b64_json) return Buffer.from(data.b64_json, 'base64');
      }
      console.warn(`[IMAGE] NVIDIA ${res.status} döndü`);
    } catch (err) {
      console.warn(`[IMAGE] NVIDIA hatası: ${err.message}`);
    }
  }

  throw new Error('Tüm görsel servisleri yanıt vermedi, biraz sonra tekrar dene kanka!');
}

module.exports = {
  isForbiddenContent,
  checkImageCooldown,
  setImageCooldown,
  resetImageCooldown,
  generateAiChat,
  generateAiImage,
  IMAGE_COOLDOWN_MS
};
