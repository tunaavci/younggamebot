require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { getRandomWord } = require('./words');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

// HTTPS Güvencesi: Telegram WebApp butonları SADECE https:// kabul eder!
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
 * Oyun Durum Haritası (In-Memory Game State)
 * Key: chatId (Grup ID)
 */
const games = new Map();

/**
 * Çizen Kullanıcı Eşleşmesi
 * Key: drawerId (number)
 * Value: { chatId: number, messageId: number }
 */
const drawerToGroup = new Map();

// ─── Statik Dosya MIME Tablosu ─────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// ─── HTTP Sunucusu: Statik Dosya + Canvas Resim Yükleme API ─────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // TWA Canvas Resim Gönderim API Endpoint (HTTP POST)
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
          res.end(JSON.stringify({ error: 'Çizim kabul edilmedi veya süre doldu' }));
        }
      } catch (err) {
        console.error('HTTP Resim Gönderim Hatası:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sunucu hatası' }));
      }
    });
    return;
  }

  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  const requestedFile = req.url.split('?')[0];
  const filePath = path.join(__dirname, requestedFile === '/' ? 'index.html' : requestedFile);
  serveFile(res, filePath);
});

function serveFile(res, filePath) {
  const ext = path.extname(filePath) || '.html';
  const resolvedPath = ext === '.html' && !filePath.endsWith('.html') ? filePath + '.html' : filePath;

  fs.readFile(resolvedPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ─── Bot Komutları ─────────────────────────────────────────────────────────────

/**
 * /start — DM Karşılama
 */
bot.start(async (ctx) => {
  const firstName = ctx.from.first_name || 'Oyuncu';
  return ctx.replyWithMarkdown(
    `👋 *Merhaba ${firstName}!* Çiz Tahmin Et oyun botuna hoş geldin!\n\n` +
    `🎮 *Nasıl Oynanır?*\n` +
    `1. Beni bir Telegram grubuna ekle.\n` +
    `2. Grupta */oyunbaslat* yazarak lobiyi aç.\n` +
    `3. Oyuncular katıldıktan sonra oyunu başlatın.\n` +
    `4. Çizen seçildiğinde DM'ine gelen çizim butonuna basıp çizimini yap!\n\n` +
    `🚀 Hazırsın! Gruplarda oynamaya başlayabilirsin.`,
    Markup.inlineKeyboard([
      [Markup.button.url('👥 Grubuna Ekle', `https://t.me/${botUsername}?startgroup=true`)]
    ])
  );
});

/**
 * /help — Yardım
 */
bot.command('help', (ctx) => {
  return ctx.replyWithMarkdown(
    `🎨 *Çiz Tahmin Et — Yardım*\n\n` +
    `📋 *Komutlar:*\n` +
    `• /oyunbaslat — Grupta katılım lobisini açar\n` +
    `• /iptal — Devam eden oyunu iptal eder _(yöneticiler)_\n` +
    `• /help — Yardım menüsü`
  );
});

/**
 * /oyunbaslat — Lobi Oluşturma
 */
bot.command('oyunbaslat', async (ctx) => {
  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

  if (!isGroup) {
    return ctx.reply('⚠️ Bu komut yalnızca Telegram gruplarında kullanılabilir!');
  }

  let game = games.get(chatId);
  if (!game) {
    game = {
      status: 'idle',
      players: new Map(),
      drawer: null,
      word: null,
      timer: null,
      scores: new Map()
    };
    games.set(chatId, game);
  }

  if (game.status !== 'idle') {
    return ctx.reply('⚠️ Bu grupta zaten aktif bir oyun veya lobi var! İptal etmek için /iptal yazın.');
  }

  // Lobiyi Başlat
  game.status = 'lobby';
  game.players.clear();

  // Komutu atan oyuncuyu otomatik lobiye ekle
  const starter = ctx.from;
  const starterName = starter.username ? `@${starter.username}` : starter.first_name;
  game.players.set(starter.id, { id: starter.id, username: starterName, name: starter.first_name });

  await renderLobbyMessage(ctx, chatId);
});

/**
 * Lobi Mesajını Güncelleyen Yardımcı Fonksiyon
 */
async function renderLobbyMessage(ctx, chatId) {
  const game = games.get(chatId);
  if (!game || game.status !== 'lobby') return;

  let playerListText = '';
  let count = 1;
  game.players.forEach(p => {
    playerListText += `${count++}. ${p.username}\n`;
  });

  const lobbyText =
    `🎮 *ÇİZ TAHMİN ET OYUNU LOBİSİ*\n\n` +
    `👥 *Katılan Oyuncular (${game.players.size}):*\n` +
    `${playerListText}\n` +
    `📌 *Not:* Sadece oyuna katılan oyuncuların tahminleri geçerli sayılacaktır!`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🙋‍♂️ Katıl', `join_lobby_${chatId}`),
      Markup.button.callback('🚪 Ayrıl', `leave_lobby_${chatId}`)
    ],
    [
      Markup.button.callback('▶️ Oyunu Başlat', `start_game_${chatId}`)
    ]
  ]);

  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(lobbyText, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(lobbyText, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (err) {
    // Mesaj değişmediğinde oluşan hatayı yut
  }
}

/**
 * Lobiye Katıl Butonu
 */
bot.action(/^join_lobby_(.+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1], 10);
  const game = games.get(chatId);

  if (!game || game.status !== 'lobby') {
    return ctx.answerCbQuery('⚠️ Lobi süresi dolmuş veya oyun başlamış.', { show_alert: true });
  }

  const user = ctx.from;
  const userName = user.username ? `@${user.username}` : user.first_name;

  if (game.players.has(user.id)) {
    return ctx.answerCbQuery('ℹ️ Zaten oyuna katıldınız!', { show_alert: false });
  }

  game.players.set(user.id, { id: user.id, username: userName, name: user.first_name });
  await ctx.answerCbQuery('✅ Oyuna başarıyla katıldınız!');
  await renderLobbyMessage(ctx, chatId);
});

/**
 * Lobiden Ayrıl Butonu
 */
bot.action(/^leave_lobby_(.+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1], 10);
  const game = games.get(chatId);

  if (!game || game.status !== 'lobby') {
    return ctx.answerCbQuery('⚠️ Lobi bulunamadı.', { show_alert: true });
  }

  const user = ctx.from;
  if (!game.players.has(user.id)) {
    return ctx.answerCbQuery('ℹ️ Zaten lobide değilsiniz.', { show_alert: false });
  }

  game.players.delete(user.id);
  await ctx.answerCbQuery('🚪 Lobiden ayrıldınız.');
  await renderLobbyMessage(ctx, chatId);
});

/**
 * Oyunu Başlat Butonu
 */
bot.action(/^start_game_(.+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1], 10);
  const game = games.get(chatId);

  if (!game || game.status !== 'lobby') {
    return ctx.answerCbQuery('⚠️ Lobi aktif değil.', { show_alert: true });
  }

  if (game.players.size < 1) {
    return ctx.answerCbQuery('⚠️ Oyunu başlatmak için en az 1 oyuncu olmalı!', { show_alert: true });
  }

  await ctx.answerCbQuery('🚀 Oyun başlatılıyor...');
  startNewTurn(chatId);
});

/**
 * Yeni Tur Başlatma Fonksiyonu
 */
async function startNewTurn(chatId) {
  const game = games.get(chatId);
  if (!game) return;

  const playerArray = Array.from(game.players.values());
  const drawerUser = playerArray[Math.floor(Math.random() * playerArray.length)];
  const secretWord = getRandomWord();

  game.status = 'drawing';
  game.drawer = drawerUser;
  game.word = secretWord;

  // Grupta Yalnızca "Çizime Başla" Butonu Kalsın
  await bot.telegram.sendMessage(
    chatId,
    `🎨 *TUR BAŞLADI!*\n\n` +
    `👤 *Çizen:* ${drawerUser.username}\n` +
    `👥 *Oyundaki Tahminciler:* ${playerArray.map(p => p.username).join(', ')}\n\n` +
    `📩 ${drawerUser.username} için özel mesaja çizim linki gönderildi!`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Çizime Başla', `get_dm_btn_${chatId}`)]
      ])
    }
  );

  // Otomatik DM Gönder
  await sendDrawerDM(drawerUser.id, secretWord, chatId);

  // 90 Saniyelik Çizim Süresi Zamanlayıcısı
  if (game.timer) clearTimeout(game.timer);
  game.timer = setTimeout(() => {
    if (game.status === 'drawing') {
      bot.telegram.sendMessage(
        chatId,
        `⌛ *Süre Doldu!* ${drawerUser.username} çizimini göndermedi. Tur iptal edildi.`,
        { parse_mode: 'Markdown' }
      );
      resetGame(chatId);
    }
  }, 90000);
}

/**
 * Gruptan "✏️ Çizime Başla" Butonuna Basıldığında DM Gönder
 */
bot.action(/^get_dm_btn_(.+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1], 10);
  const game = games.get(chatId);
  const clickerId = ctx.from.id;

  if (!game || game.status !== 'drawing') {
    return ctx.answerCbQuery('⚠️ Aktif çizim turu yok.', { show_alert: true });
  }

  if (game.drawer.id !== clickerId) {
    return ctx.answerCbQuery('⚠️ Sıradaki çizen oyuncu sen değilsin!', { show_alert: true });
  }

  const success = await sendDrawerDM(clickerId, game.word, chatId);
  if (success) {
    ctx.answerCbQuery('📩 Özel mesajına çizim linki gönderildi!', { show_alert: false });
  } else {
    ctx.answerCbQuery('⚠️ Özel mesaj gönderilemiyor. Lütfen bota özel mesaj atıp /start yapın.', { show_alert: true });
  }
});

/**
 * DM Üzerinden Çizene Mesaj Gönder
 */
async function sendDrawerDM(drawerId, secretWord, chatId) {
  const twaUrl = `${WEBAPP_URL}/index.html?word=${encodeURIComponent(secretWord)}&chatId=${chatId}&userId=${drawerId}`;

  // Varsa önceki DM mesajını sil
  const oldDm = drawerToGroup.get(drawerId);
  if (oldDm && oldDm.messageId) {
    try {
      await bot.telegram.deleteMessage(drawerId, oldDm.messageId);
    } catch (_) {}
  }

  try {
    const sentMsg = await bot.telegram.sendMessage(
      drawerId,
      `🎯 *Gizli Kelimen:* \`${secretWord}\`\n\n` +
      `Aşağıdaki *🎨 Çizmeye Başla* butonuna basarak çizimini yap ve "Gönder" butonuna bas!\n` +
      `_📌 Çizimini gönderdiğin an bu mesaj otomatik silinecektir._`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp('🎨 Çizmeye Başla', twaUrl)]
        ])
      }
    );

    drawerToGroup.set(drawerId, { chatId, messageId: sentMsg.message_id });
    return true;
  } catch (err) {
    console.error(`DM gönderilemedi (User ID: ${drawerId}):`, err.message);
    return false;
  }
}

/**
 * Çizim Tamamlandığında Resim İşleme ve DM Mesajını Silme
 */
async function processDrawingSubmission(chatId, drawerId, base64ImageData) {
  const game = games.get(chatId);
  if (!game || game.status !== 'drawing') return false;

  if (game.timer) clearTimeout(game.timer);

  // DM Mesajını Sil
  const dmData = drawerToGroup.get(drawerId);
  if (dmData && dmData.messageId) {
    try {
      await bot.telegram.deleteMessage(drawerId, dmData.messageId);
    } catch (e) {
      console.warn('DM mesajı silinemedi:', e.message);
    }
  }

  const cleanBase64 = base64ImageData.replace(/^data:image\/\w+;base64,/, '');
  const imageBuffer = Buffer.from(cleanBase64, 'base64');

  await bot.telegram.sendPhoto(
    chatId,
    { source: imageBuffer },
    {
      caption:
        `🎨 *${game.drawer.username}* çizimini gönderdi!\n\n` +
        `💬 Sadece oyuna katılanların tahminleri geçerlidir!\n` +
        `⏱️ Tahmin Süresi: *60 saniye*`,
      parse_mode: 'Markdown'
    }
  );

  game.status = 'guessing';

  game.timer = setTimeout(() => {
    if (game.status === 'guessing') {
      bot.telegram.sendMessage(
        chatId,
        `⌛ *Süre Doldu!* Kimse doğru tahmini yapamadı.\n🔑 Cevap: *${game.word}* idi!`,
        { parse_mode: 'Markdown' }
      );
      resetGame(chatId);
    }
  }, 60000);

  return true;
}

/**
 * Telegram WebApp sendData Karşılayıcısı
 */
bot.on('web_app_data', async (ctx) => {
  try {
    const drawerId = ctx.from.id;
    const rawData = ctx.message.web_app_data.data;
    const payload = JSON.parse(rawData);

    const dmData = drawerToGroup.get(drawerId);
    const targetChatId = parseInt(payload.chatId, 10) || (dmData ? dmData.chatId : null);

    if (!targetChatId) return ctx.reply('⚠️ Grup bulunamadı.');

    await processDrawingSubmission(targetChatId, drawerId, payload.image);
  } catch (err) {
    console.error('web_app_data Hatası:', err);
  }
});

/**
 * Tahmin Kontrolü
 */
bot.on('text', (ctx, next) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game || game.status !== 'guessing') return next();

  const guesser = ctx.from;

  if (guesser.id === game.drawer.id) return next();

  if (!game.players.has(guesser.id)) {
    return next();
  }

  const guess = ctx.message.text.trim().toLocaleLowerCase('tr');
  const answer = game.word.trim().toLocaleLowerCase('tr');

  if (guess === answer) {
    if (game.timer) clearTimeout(game.timer);

    const guesserName = guesser.username ? `@${guesser.username}` : guesser.first_name;
    const sc = game.scores.get(guesser.id) || { username: guesserName, points: 0 };
    sc.points += 10;
    game.scores.set(guesser.id, sc);

    let board = '\n\n🏆 *Puan Tablosu:*\n';
    game.scores.forEach(s => { board += `• ${s.username}: *${s.points} Puan*\n`; });

    ctx.reply(
      `🎉 *TEBRİKLER ${guesserName}!* Doğru tahmin!\n` +
      `🔑 Kelime: *${game.word}* (+10 Puan)` + board,
      { parse_mode: 'Markdown' }
    );

    resetGame(chatId);
  } else {
    return next();
  }
});

/**
 * /iptal Komutu
 */
bot.command('iptal', async (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game || game.status === 'idle') {
    return ctx.reply('ℹ️ Aktif bir tur veya lobi bulunmuyor.');
  }

  const userId = ctx.from.id;
  let isAdmin = false;
  try {
    const member = await ctx.getChatMember(userId);
    if (['administrator', 'creator'].includes(member.status) || userId === game.drawer?.id) {
      isAdmin = true;
    }
  } catch (_) {}

  if (!isAdmin) {
    return ctx.reply('⛔ Oyunu sadece grup yöneticileri veya o an çizen kişi iptal edebilir!');
  }

  resetGame(chatId);
  return ctx.reply('🛑 Oyun turu ve lobi iptal edildi.');
});

function resetGame(chatId) {
  const game = games.get(chatId);
  if (game) {
    if (game.timer) clearTimeout(game.timer);
    if (game.drawer) {
      const dmData = drawerToGroup.get(game.drawer.id);
      if (dmData && dmData.messageId) {
        bot.telegram.deleteMessage(game.drawer.id, dmData.messageId).catch(() => {});
      }
      drawerToGroup.delete(game.drawer.id);
    }
    game.status = 'idle';
    game.players.clear();
    game.drawer = null;
    game.word = null;
    game.timer = null;
  }
}

// ─── Sunucu & Bot Başlat ──────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`🌐 HTTP Sunucusu ${PORT} portunda aktif!`);
  const me = await bot.telegram.getMe();
  botUsername = me.username;
  console.log(`🤖 Bot Başlatıldı: @${botUsername}`);
  console.log(`🔗 WebApp HTTPS Bağlantısı: ${WEBAPP_URL}`);
  bot.launch();
});

process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
