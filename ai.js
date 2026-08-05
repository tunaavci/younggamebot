const NVIDIA_AI_KEY = process.env.NVIDIA_AI_KEY || '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';
const NVIDIA_IMAGE_KEY = process.env.NVIDIA_IMAGE_KEY || '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';
const NVIDIA_IMAGE_API_URL = process.env.NVIDIA_IMAGE_API_URL || 'https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium';

// Yasaklı / +18 kelime listesi (İçerik Moderasyonu)
const FORBIDDEN_WORDS = [
  'nsfw', 'porn', 'porno', '+18', '18+', 'nude', 'çıplak', 'seks', 'sex', 'erotik', 'erotic',
  'meme', 'vagina', 'penis', 'otuzbir', '31', 'anal', 'hentai', 'boobs', 'pussy', 'dick',
  'naked', 'gore', 'kanlı', 'vahşet', 'intihar', 'suicide', 'pedofili', 'pedophile', 'rape', 'tecavüz',
  'pornografi', 'sexuality', 'cinsellik'
];

/**
 * Görsel isteğinin güvenli olup olmadığını kontrol eder (+18 vb. engelleme).
 * @param {string} prompt 
 * @returns {boolean} True ise yasaklı içerik barındırıyordur.
 */
function isForbiddenContent(prompt) {
  if (!prompt) return false;
  const lower = prompt.toLowerCase('tr');
  return FORBIDDEN_WORDS.some(word => lower.includes(word.toLowerCase()));
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

  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
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
  });

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
 * Yapay zeka ile görsel üretir (NVIDIA API / Local NIM + Yedek Motor).
 * @param {string} prompt 
 * @returns {Promise<Buffer>}
 */
async function generateAiImage(prompt) {
  // 1. Önce NVIDIA API / Local NIM sunucusu ile dene
  const urlsToTry = [
    NVIDIA_IMAGE_API_URL,
    'http://localhost:8000/v1/infer',
    'https://integrate.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3.5-large',
    'https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium'
  ];

  for (const url of urlsToTry) {
    try {
      const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      };
      if (NVIDIA_IMAGE_KEY) {
        headers['Authorization'] = `Bearer ${NVIDIA_IMAGE_KEY}`;
      }

      const nvidiaRes = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: prompt,
          mode: 'base',
          cfg_scale: 7,
          steps: 30
        })
      });

      if (nvidiaRes.ok) {
        const data = await nvidiaRes.json();
        if (data.artifacts && data.artifacts[0] && data.artifacts[0].base64) {
          return Buffer.from(data.artifacts[0].base64, 'base64');
        }
        if (data.image) {
          return Buffer.from(data.image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        }
        if (data.b64_json) {
          return Buffer.from(data.b64_json, 'base64');
        }
      }
    } catch (e) {
      // sessizce sonraki sunucuya / yedeğe geç
    }
  }

  // 2. Yüksek Kalite Görsel Motoru (Pollinations AI Generator)
  const seed = Math.floor(Math.random() * 1000000);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;
  const imgRes = await fetch(imageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!imgRes.ok) {
    throw new Error('Görsel servisi yanıt vermedi, lütfen tekrar dene kanka!');
  }

  const arrayBuffer = await imgRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  isForbiddenContent,
  generateAiChat,
  generateAiImage
};
