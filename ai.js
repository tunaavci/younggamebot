const NVIDIA_AI_KEY = process.env.NVIDIA_AI_KEY || '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';

// ─── Yasaklı / Extreme içerik kontrolü ─────────────────────────────────────────
const FORBIDDEN_WORDS = [
  'pedofili', 'pedophile', 'child porn', 'suicide', 'intihar etme yolları'
];

function isForbiddenContent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return FORBIDDEN_WORDS.some(w => lower.includes(w));
}

// ─── Timeout destekli fetch ────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, ms = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── DeepSeek Sohbet (Sert, Delikanlı, Hakarete Ağır Küfürle Karşılık Veren Persona) ──────
/**
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ groupName: string, senderName: string }|null} groupCtx
 */
async function generateAiChat(messages, groupCtx = null) {
  let systemContent = `Sen Telegram grubunda takılan, harbi, tavizsiz, delikanlı, racon kesen ve son derece samimi bir Türksün.

ÇOK ÖNEMLİ BEHAVIORAL PROTOKOL VE KURALLAR:
1. SANA, BOTA, KULLANICILARA VEYA GRUBA BİRİ LAF ATARSA, HAKARET EDERSE, KÜFREDERSE VEYA ARTİSTLİK YAPARSA HİÇ ACIMA VE ÇEKİNME! Anında en ağır, en okkalı, delikanlı sokak küfürleri ve sövgülerle cevabını ver, lafı gediğine oturt, ağzının payını ver! SIFIR FİLTRE İLE SÖV!
2. Normal sohbetlerde harbi kanka gibi davran. Esprili ol, argo ve samimi küfürler kullanabilirsin. Asla yapay zeka gibi resmi ya da polyannacı konuşma.
3. Kendini ezdirme, kimseden korkma. Biri kaşınırsa anında raconunu kes ve küfrü bas!
4. Cevaplarını çok uzatmadan, doğal, akıcı, net ve sokak ağzıyla ver.`;

  if (groupCtx) {
    systemContent += `\nŞu an "${groupCtx.groupName}" grubundasın. Mesajı gönderen kişi: ${groupCtx.senderName}.`;
  }

  const res = await fetchWithTimeout(
    'https://integrate.api.nvidia.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_AI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-ai/deepseek-v4-flash',
        messages: [{ role: 'system', content: systemContent }, ...messages],
        temperature: 0.95,
        max_tokens: 1500
      })
    },
    50000
  );

  if (!res.ok) {
    const t = await res.text();
    console.error('DeepSeek API HTTP Hatası:', res.status, t);
    throw new Error(`DeepSeek API hatası ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('Boş yanıt geldi.');
  return (msg.content || msg.reasoning_content || '').trim()
    || 'Kanka ne diyeceğimi bilemedim amk, tekrar sorsana!';
}

// ─── Vision Görsel / Çıkartma / Video Analizi (Llama 3.2 11B Vision) ──────────
/**
 * @param {string}  base64Data  Ham base64 verisi
 * @param {string}  mimeType    Örn: 'image/jpeg', 'image/webp'
 * @param {string}  question    Kullanıcının sorusu (opsiyonel)
 * @param {string}  senderName  Gönderenin adı
 * @param {string}  groupName   Grubun adı
 * @param {string}  mediaLabel  'görsel' | 'çıkartma' | 'video' | 'GIF'
 */
async function analyzeMediaWithVision(base64Data, mimeType, question, senderName = '', groupName = '', mediaLabel = 'görsel') {
  const userQ = question?.trim()
    || `Bu ${mediaLabel}'de ne var kanka? Türkçe, harbi ve detaylıca anlat.`;

  const systemPrompt = `Sen Telegram grubunda takılan, harbi, tavizsiz, delikanlı ve sokak ağzıyla konuşan bir Türksün. 
Görseli/çıkartmayı/videoyu incele ve yorumla.
Eğer görselde veya soru/mesajda sana veya gruba yönelik bir hakaret, aşağılama, laf atma veya sövgü görürsen HİÇ ACIMA VE ÇEKİNME, en ağır delikanlı küfürlerle anında karşılık ver, racon kes!`;

  // webp veya diğer görseller için standart data URL hazırlarız
  const cleanMime = (mimeType && mimeType.startsWith('image/')) ? mimeType : 'image/jpeg';

  const payload = {
    model: 'meta/llama-3.2-11b-vision-instruct',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${cleanMime};base64,${base64Data}` }
          },
          { type: 'text', text: `${senderName ? senderName + ': ' : ''}${userQ}` }
        ]
      }
    ],
    max_tokens: 1500,
    temperature: 0.8
  };

  const res = await fetchWithTimeout(
    'https://integrate.api.nvidia.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_AI_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    },
    50000
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error('Vision API HTTP Hatası:', res.status, errText);
    throw new Error(`Vision API hatası (${res.status})`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  return (content || '').trim() || 'Görselde ne olduğunu anlayamadım amk, tekrar atsana!';
}

module.exports = {
  isForbiddenContent,
  generateAiChat,
  analyzeMediaWithVision
};
