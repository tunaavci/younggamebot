require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { getRandomWord } = require('./words');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

// HTTPS Güvencesi
let rawWebAppUrl = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
rawWebAppUrl = rawWebAppUrl.trim().replace(/\/$/, '');
if (!rawWebAppUrl.startsWith('http://') && !rawWebAppUrl.startsWith('https://')) {
  rawWebAppUrl = 'https://' + rawWebAppUrl;
}
if (rawWebAppUrl.startsWith('http://') && !rawWebAppUrl.includes('localhost')) {
  rawWebAppUrl = rawWebAppUrl.replace('http://', 'https://');
}
const WEBAPP_URL = rawWebAppUrl;

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('❌ HATA: BOT_TOKEN tanımlı değil!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
let botUsername = '';

/**
 * Status Açıklamaları:
 * 'idle'          → Oyun yok
 * 'lobby'         → Lobi açık, oyuncu katılım bekliyor
 * 'drawing'       → Çizen kişi çizim yapıyor
 * 'guessing'      → Tahmin aşaması
 * 'transitioning' → Turlar arası geçiş (hiçbir event kabul edilmez!)
 */

const games = new Map();
// drawerId → { chatId, messageId }
const drawerToGroup = new Map();

// ─── Statik Dosya Sunucusu ─────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/api/submit-drawing') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { image, chatId, userId } = payload;
        const drawerIdNum = parseInt(userId, 10);
        const dmData = drawerToGroup.get(drawerIdNum);
        const targetChatId = parseInt(chatId, 10) || (dmData ? dmData.chatId : null);

        if (!targetChatId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Grup ID bulunamadı' }));
          return;
        }

        const success = await processDrawingSubmission(targetChatId, drawerIdNum, image);
        if (success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Çizim kabul edilmedi' }));
        }
      } catch (err) {
        console.error('HTTP Submit Hatası:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sunucu hatası' }));
      }
    });
    return;
  }

  if (req.url === '/healthz') { res.writeHead(200); res.end('OK'); return; }

  const filePath = path.join(__dirname, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  const ext = path.extname(filePath) || '.html';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ─── Yardımcı: Diziyi Karıştır ────────────────────────────────────────────────
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Yardımcı: Güvenli Timer Temizle ──────────────────────────────────────────
function clearGameTimer(game) {
  if (game.timer) {
    clearTimeout(game.timer);
    game.timer = null;
  }
}

// ─── Bot Komutları ─────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const firstName = ctx.from.first_name || 'Oyuncu';
  return ctx.replyWithMarkdown(
    `👋 *Merhaba ${firstName}!* Çiz Tahmin Et oyun botuna hoş geldin!\n\n` +
    `🎮 *Nasıl Oynanır?*\n` +
    `1. Beni bir Telegram grubuna ekle ve yönetici yap.\n` +
    `2. Grupta */oyunbaslat* yazarak lobiyi aç.\n` +
    `3. Oyuncular katıldıktan sonra oyunu başlatın.\n` +
    `4. Sıra sana gelince DM'ine gelen butonla çizimini yap!\n` +
    `5. Oyun */iptal* yazana kadar sürekli döner.\n\n` +
    `🚀 Hazırsın!`,
    Markup.inlineKeyboard([[Markup.button.url('👥 Grubuna Ekle', `https://t.me/${botUsername}?startgroup=true`)]])
  );
});

bot.command('help', (ctx) => ctx.replyWithMarkdown(
  `🎨 *Çiz Tahmin Et — Yardım*\n\n` +
  `• /oyunbaslat — Lobi açar\n` +
  `• /iptal — Oyunu bitirir _(yöneticiler)_\n` +
  `• /help — Bu menü\n\n` +
  `⚠️ Botun grup mesajlarını okuyabilmesi için **yönetici** yapılması gerekmektedir.`
));

bot.command('oyunbaslat', async (ctx) => {
  const chatId = ctx.chat.id;
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return ctx.reply('⚠️ Bu komut yalnızca Telegram gruplarında kullanılabilir!');
  }

  let game = games.get(chatId);
  if (game && game.status !== 'idle') {
    return ctx.reply('⚠️ Zaten aktif bir oyun veya lobi var! İptal için /iptal yazın.');
  }

  game = {
    status: 'lobby',
    players: new Map(),      // userId → { id, username }
    playerOrder: [],          // Karıştırılmış sıralı oyuncu listesi
    currentDrawerIndex: 0,   // Sıradaki çizeni gösteren index
    roundNumber: 0,          // Toplam oynanan tur sayısı
    drawer: null,
    word: null,
    timer: null,
    scores: new Map()
  };
  games.set(chatId, game);

  const starter = ctx.from;
  const starterName = starter.username ? `@${starter.username}` : starter.first_name;
  game.players.set(starter.id, { id: starter.id, username: starterName });

  await renderLobbyMessage(ctx, chatId);
});

async function renderLobbyMessage(ctx, chatId) {
  const game = games.get(chatId);
  if (!game || game.status !== 'lobby') return;

  let list = '';
  let i = 1;
  game.players.forEach(p => { list += `${i++}. ${p.username}\n`; });

  const text =
    `🎮 *ÇİZ TAHMİN ET — LOBİ*\n\n` +
    `👥 *Katılan Oyuncular (${game.players.size}):*\n${list}\n` +
    `📌 Oyun başladıktan sonra sırayla herkes çizer.\n` +
    `_/iptal yazana kadar oyun sürer._`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🙋‍♂️ Katıl', `join_${chatId}`), Markup.button.callback('🚪 Ayrıl', `leave_${chatId}`)],
    [Markup.button.callback('▶️ Oyunu Başlat', `startgame_${chatId}`)]
  ]);

  try {
    if (ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb });
    else await ctx.reply(text, { parse_mode: 'Markdown', ...kb });
  } catch (_) {}
}

bot.action(/^join_(.+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1], 10);
  const game = games.get(chatId);
  if (!game || game.status !== 'lobby') return ctx.answerCbQuery('⚠️ Lobi aktif değil.', { show_alert: true });
  if (game.players.has(ctx.from.id)) return ctx.answerCbQuery('ℹ️ Zaten katıldınız!');

  const userName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  game.players.set(ctx.from.id, { id: ctx.from.id, username: userName });
  await ctx.answerCbQuery('✅ Katıldınız!');
  await renderLobbyMessage(ctx, chatId);
});

bot.action(/^leave_(.+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1], 10);
  const game = games.get(chatId);
  if (!game || game.status !== 'lobby') return ctx.answerCbQuery('⚠️ Lobi aktif değil.', { show_alert: true });
  if (!game.players.has(ctx.from.id)) return ctx.answerCbQuery('ℹ️ Lobide değilsiniz.');

  game.players.delete(ctx.from.id);
  await ctx.answerCbQuery('🚪 Ayrıldınız.');
  await renderLobbyMessage(ctx, chatId);
});

bot.action(/^startgame_(.+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1], 10);
  const game = games.get(chatId);
  if (!game || game.status !== 'lobby') return ctx.answerCbQuery('⚠️ Lobi aktif değil.', { show_alert: true });
  if (game.players.size < 1) return ctx.answerCbQuery('⚠️ En az 1 oyuncu gerekli!', { show_alert: true });

  await ctx.answerCbQuery('🚀 Oyun başlatılıyor...');

  // Oyuncu sırasını karıştır
  game.playerOrder = shuffleArray(Array.from(game.players.keys()));
  game.currentDrawerIndex = 0;
  game.roundNumber = 0;
  game.status = 'transitioning';

  startNextTurn(chatId);
});

// ─── Tur Motoru ────────────────────────────────────────────────────────────────
async function startNextTurn(chatId) {
  const game = games.get(chatId);
  if (!game) return;
  if (game.status !== 'transitioning') return; // Çift tetiklenme koruması

  clearGameTimer(game);

  // Oyuncu kalmadıysa (hepsi ayrıldıysa) oyunu bitir
  if (game.players.size === 0) {
    games.delete(chatId);
    return;
  }

  // playerOrder içinde olmayan oyuncuları temizle (ayrılanlar)
  game.playerOrder = game.playerOrder.filter(id => game.players.has(id));
  if (game.playerOrder.length === 0) {
    games.delete(chatId);
    return;
  }

  // Index taştıysa başa dön (sonsuz döngü)
  if (game.currentDrawerIndex >= game.playerOrder.length) {
    game.currentDrawerIndex = 0;
  }

  const drawerId = game.playerOrder[game.currentDrawerIndex];
  const drawerUser = game.players.get(drawerId);
  game.currentDrawerIndex = (game.currentDrawerIndex + 1) % game.playerOrder.length;

  const secretWord = getRandomWord();
  game.roundNumber++;
  game.status = 'drawing';
  game.drawer = drawerUser;
  game.word = secretWord;

  await bot.telegram.sendMessage(
    chatId,
    `🎨 *TUR ${game.roundNumber} BAŞLADI!*\n\n` +
    `👤 *Çizen:* ${drawerUser.username}\n` +
    `👥 *Tahminciler:* ${Array.from(game.players.values()).map(p => p.username).join(', ')}\n\n` +
    `📩 ${drawerUser.username} özel mesajına çizim linki gönderildi!`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Çizime Başla', `getdm_${chatId}`)]])
    }
  );

  await sendDrawerDM(drawerId, secretWord, chatId);

  // 135s sunucu timer (client 120s'de oto-gönderir, 15s buffer)
  clearGameTimer(game);
  game.timer = setTimeout(() => {
    if (game.status !== 'drawing') return;
    console.log(`[${chatId}] Çizim süresi doldu, geçiliyor...`);
    game.status = 'transitioning';
    bot.telegram.sendMessage(
      chatId,
      `⌛ *Süre Doldu!* ${drawerUser.username} çizimini gönderemediyse sonraki tura geçiliyor...\n⏳ 5 saniye...`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    setTimeout(() => startNextTurn(chatId), 5000);
  }, 135000);
}

// ─── DM Gönder ─────────────────────────────────────────────────────────────────
async function sendDrawerDM(drawerId, secretWord, chatId) {
  const twaUrl = `${WEBAPP_URL}/index.html?word=${encodeURIComponent(secretWord)}&chatId=${chatId}&userId=${drawerId}`;

  // Önceki DM mesajını sil
  const oldDm = drawerToGroup.get(drawerId);
  if (oldDm?.messageId) {
    bot.telegram.deleteMessage(drawerId, oldDm.messageId).catch(() => {});
  }

  try {
    const sentMsg = await bot.telegram.sendMessage(
      drawerId,
      `🎯 *Gizli Kelimen:* \`${secretWord}\`\n\n` +
      `Aşağıdaki butona basarak çizimini yap ve "Gönder"e bas!\n` +
      `_📌 Çizim gönderildiğinde bu mesaj otomatik silinecek._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.webApp('🎨 Çizmeye Başla', twaUrl)]])
      }
    );
    drawerToGroup.set(drawerId, { chatId, messageId: sentMsg.message_id });
    return true;
  } catch (err) {
    console.error(`DM gönderilemedi (${drawerId}):`, err.message);
    return false;
  }
}

// ─── Çizim Gönderim İşleyicisi ─────────────────────────────────────────────────
async function processDrawingSubmission(chatId, drawerId, base64Image) {
  const game = games.get(chatId);
  if (!game) { console.log(`[${chatId}] processDrawing: game yok`); return false; }
  if (game.status !== 'drawing') { console.log(`[${chatId}] processDrawing: status=${game.status}, beklenen=drawing`); return false; }

  console.log(`[${chatId}] Çizim alındı, gruba gönderiliyor...`);
  clearGameTimer(game);

  // DM sil
  const dmData = drawerToGroup.get(drawerId);
  if (dmData?.messageId) {
    bot.telegram.deleteMessage(drawerId, dmData.messageId).catch(() => {});
    drawerToGroup.delete(drawerId);
  }

  const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
  const imageBuffer = Buffer.from(cleanBase64, 'base64');

  try {
    await bot.telegram.sendPhoto(
      chatId,
      { source: imageBuffer },
      {
        caption:
          `🎨 *${game.drawer.username}* çizimini gönderdi!\n\n` +
          `💬 Sadece lobiye katılanların tahminleri geçerlidir!\n` +
          `⏱️ Tahmin Süresi: *60 saniye*`,
        parse_mode: 'Markdown'
      }
    );
  } catch (err) {
    console.error(`[${chatId}] Fotoğraf gönderilemedi:`, err.message);
    return false;
  }

  // Status guessing yap
  game.status = 'guessing';
  const currentWord = game.word;
  const currentDrawer = game.drawer;

  // 60s tahmin timer
  clearGameTimer(game);
  game.timer = setTimeout(() => {
    if (game.status !== 'guessing') return;
    console.log(`[${chatId}] Tahmin süresi doldu`);
    game.status = 'transitioning';
    bot.telegram.sendMessage(
      chatId,
      `⌛ *Süre Doldu!* Kimse bilemedi.\n🔑 Cevap: *${currentWord}* idi!\n\n⏳ 5 saniye içinde sonraki tur...`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    setTimeout(() => startNextTurn(chatId), 5000);
  }, 60000);

  return true;
}

// ─── Tahmin Handler ─────────────────────────────────────────────────────────────
bot.on('text', (ctx, next) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  // Sadece guessing modunda işle
  if (!game || game.status !== 'guessing') return next();

  const guesser = ctx.from;
  if (guesser.id === game.drawer?.id) return next(); // Çizen tahmin edemez
  if (!game.players.has(guesser.id)) return next();  // Lobiye katılmayanlar geçersiz

  const guess = ctx.message.text.trim().toLocaleLowerCase('tr');
  const answer = (game.word || '').trim().toLocaleLowerCase('tr');

  if (guess === answer) {
    // ÖNCE kilitle!
    game.status = 'transitioning';
    clearGameTimer(game);

    const guesserName = guesser.username ? `@${guesser.username}` : guesser.first_name;
    const sc = game.scores.get(guesser.id) || { username: guesserName, points: 0 };
    sc.points += 10;
    game.scores.set(guesser.id, sc);

    let board = '\n\n📊 *Puan Durumu:*\n';
    const sorted = Array.from(game.scores.values()).sort((a, b) => b.points - a.points);
    sorted.forEach(s => { board += `• ${s.username}: *${s.points} Puan*\n`; });

    ctx.reply(
      `🎉 *TEBRİKLER ${guesserName}!* Doğru!\n🔑 Kelime: *${game.word}* (+10 Puan)` + board +
      `\n⏳ 5 saniye içinde sonraki tur...`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});

    setTimeout(() => startNextTurn(chatId), 5000);
  } else {
    return next();
  }
});

// ─── DM Butonu (Gruptan) ───────────────────────────────────────────────────────
bot.action(/^getdm_(.+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1], 10);
  const game = games.get(chatId);

  if (!game || game.status !== 'drawing') {
    return ctx.answerCbQuery('⚠️ Aktif çizim turu yok.', { show_alert: true });
  }
  if (game.drawer?.id !== ctx.from.id) {
    return ctx.answerCbQuery('⚠️ Sıra sende değil!', { show_alert: true });
  }

  const ok = await sendDrawerDM(ctx.from.id, game.word, chatId);
  ctx.answerCbQuery(ok ? '📩 DM\'ine gönderildi!' : '⚠️ DM gönderilemedi, bota /start yaz.', { show_alert: !ok });
});

// ─── web_app_data ───────────────────────────────────────────────────────────────
bot.on('web_app_data', async (ctx) => {
  try {
    const drawerId = ctx.from.id;
    const payload = JSON.parse(ctx.message.web_app_data.data);
    const dmData = drawerToGroup.get(drawerId);
    const targetChatId = parseInt(payload.chatId, 10) || (dmData ? dmData.chatId : null);
    if (!targetChatId) return;
    await processDrawingSubmission(targetChatId, drawerId, payload.image);
  } catch (err) {
    console.error('web_app_data hatası:', err);
  }
});

// ─── /iptal ────────────────────────────────────────────────────────────────────
bot.command('iptal', async (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);
  if (!game || game.status === 'idle') return ctx.reply('ℹ️ Aktif oyun yok.');

  const userId = ctx.from.id;
  let isAdmin = false;
  try {
    const m = await ctx.getChatMember(userId);
    if (['administrator', 'creator'].includes(m.status) || userId === game.drawer?.id) isAdmin = true;
  } catch (_) {}

  if (!isAdmin) return ctx.reply('⛔ Sadece yöneticiler veya çizen kişi iptal edebilir!');

  // Final skor tablosu
  const sorted = Array.from(game.scores.values()).sort((a, b) => b.points - a.points);
  let finalText = '🛑 *Oyun İptal Edildi!*\n\n';
  if (sorted.length > 0) {
    finalText += '🏆 *Final Skor Tablosu:*\n';
    sorted.forEach((s, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
      finalText += `${medal} ${s.username}: *${s.points} Puan*\n`;
    });
  }

  resetGame(chatId);
  return ctx.replyWithMarkdown(finalText);
});

function resetGame(chatId) {
  const game = games.get(chatId);
  if (!game) return;

  clearGameTimer(game);

  if (game.drawer) {
    const dmData = drawerToGroup.get(game.drawer.id);
    if (dmData?.messageId) {
      bot.telegram.deleteMessage(game.drawer.id, dmData.messageId).catch(() => {});
    }
    drawerToGroup.delete(game.drawer.id);
  }

  games.delete(chatId);
}

// ─── Başlat ────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`🌐 HTTP Sunucusu ${PORT} portunda aktif!`);
  const me = await bot.telegram.getMe();
  botUsername = me.username;
  console.log(`🤖 Bot Başlatıldı: @${botUsername}`);
  console.log(`🔗 WebApp URL: ${WEBAPP_URL}`);
  bot.launch();
});

process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
