const NVIDIA_AI_KEY  = process.env.NVIDIA_AI_KEY  || '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';
const KIMI_API_KEY   = process.env.KIMI_API_KEY   || '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';

// ─── Yasaklı / +18 içerik filtresi ───────────────────────────────────────────
const FORBIDDEN_WORDS = [
  'nsfw','porn','porno','+18','18+','nude','çıplak','seks','sex','erotik','erotic',
  'vagina','penis','otuzbir','31','anal','hentai','boobs','pussy','dick',
  'naked','gore','vahşet','intihar','suicide','pedofili','pedophile','rape','tecavüz'
];

function isForbiddenContent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return FORBIDDEN_WORDS.some(w => lower.includes(w));
}

// ─── Timeout destekli fetch ────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── DeepSeek Sohbet (kanka modu) ─────────────────────────────────────────────
/**
 * @param {Array<{role,content}>} messages
 * @param {{ groupName:string, senderName:string, memberCount?:number }|null} groupCtx
 */
async function generateAiChat(messages, groupCtx = null) {
  let systemContent = 'Sen Telegram\'da takılan, neşeli, samimi, kanka kafasındaki bir Türksün. ' +
    'Yeri gelince küfürlü/argolu konuşabilirsin, sansürsüzsün. ' +
    'Cevaplarını çok uzatma, doğal kanka üslubuyla ver.';

  if (groupCtx) {
    systemContent +=
      ` Şu an "${groupCtx.groupName}" grubundasın.` +
      ` ${groupCtx.senderName} seninle konuşuyor.` +
      (groupCtx.memberCount ? ` Grupta yaklaşık ${groupCtx.memberCount} üye var.` : '');
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
    throw new Error(`DeepSeek API hatası ${res.status}: ${t.slice(0,200)}`);
  }

  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('Boş yanıt geldi.');
  return (msg.content || msg.reasoning_content || '').trim()
    || 'Kanka ne diyeceğimi bilemedim amk, tekrar sorsana!';
}

// ─── Kimi K2.6 Görsel / Video Analizi ─────────────────────────────────────────
/**
 * @param {string}  base64Data  Ham base64 verisi (prefix yok)
 * @param {string}  mimeType    Örn: 'image/jpeg'
 * @param {string}  question    Kullanıcının sorusu (opsiyonel)
 * @param {string}  senderName  Gönderenin adı
 * @param {string}  groupName   Grubun adı
 * @param {string}  mediaLabel  'görsel' | 'video' | 'GIF' vb.
 */
async function analyzeMediaWithKimi(base64Data, mimeType, question, senderName = '', groupName = '', mediaLabel = 'görsel') {
  const userQ = question?.trim()
    || `Bu ${mediaLabel}de ne var? Türkçe, kısaca ve kanka üslubuyla anlat.`;

  const payload = {
    model: 'moonshotai/kimi-k2.6',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64Data}` }
          },
          { type: 'text', text: userQ }
        ]
      }
    ],
    max_tokens: 2048,
    temperature: 0.8,
    top_p: 1,
    stream: false
  };

  const res = await fetchWithTimeout(
    'https://integrate.api.nvidia.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KIMI_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    },
    60000
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kimi API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim()
    || 'Görseli analiz edemedim kanka, tekrar dene.';
}

module.exports = { isForbiddenContent, generateAiChat, analyzeMediaWithKimi };
