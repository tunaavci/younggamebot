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

// Oyuncu başına kaç kez çizim hakkı verileceği (Varsayılan: Her oyuncu 2 kez çizer)
const MAX_CYCLES_PER_GAME = 2;

/**
 * Oyun Durum Haritası (In-Memory Game State)
 * Key: chatId (Grup ID)
 */
const games = new Map();
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
    `4. Her oyuncu sırayla çizim yapar, tur döngüleri bittiğinde en çok puanı toplayan kazanır!\n\n` +
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
      drawnPlayerIds: new Set(),
      cycleCount: 1,
      totalRoundsPlayed: 0,
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

  // Lobiyi Sıfırla ve Başlat
  game.status = 'lobby';
  game.players.clear();
  game.drawnPlayerIds.clear();
  game.cycleCount = 1;
  game.totalRoundsPlayed = 0;
  game.scores.clear();

  // Komutu atan oyuncuyu lobiye ekle
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
    `📌 *Oyun Düzeni:* Her oyuncu toplam *${MAX_CYCLES_PER_GAME} kez* çizecektir!`;

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
  } catch (err) {}
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
  game.drawnPlayerIds.clear();
  game.cycleCount = 1;
  game.totalRoundsPlayed = 0;
  startNextTurn(chatId);
});

/**
 * Sıradaki Turu Başlatma Motoru (Döngü Destekli)
 */
async function startNextTurn(chatId) {
  const game = games.get(chatId);
  if (!game) return;

  // Mevcut döngüde henüz çizmeyen oyuncuları bul
  const remainingPlayersInCycle = Array.from(game.players.values()).filter(p => !game.drawnPlayerIds.has(p.id));

  // Mevcut döngüdeki herkes çizdiyse:
  if (remainingPlayersInCycle.length === 0) {
    // Eğer tüm döngüler henüz tamamlanmadıysa bir sonraki döngüyü başlat!
    if (game.cycleCount < MAX_CYCLES_PER_GAME) {
      game.cycleCount++;
      game.drawnPlayerIds.clear(); // Çizim hakkı sıfırlandı

      await bot.telegram.sendMessage(
        chatId,
        `🔄 *${game.cycleCount}. DÖNGÜ BAŞLIYOR!*\n` +
        `Her oyuncu birer kez daha çizecektir.\n` +
        `⏳ 5 saniye içinde yeni tur başlıyor...`,
        { parse_mode: 'Markdown' }
      );

      setTimeout(() => { startNextTurn(chatId); }, 5000);
      return;
    }

    // TÜM DÖNGÜLER BİTTİ -> OYUNU BİTİR VE ŞAMPİYONU İLAN ET!
    let finalBoardText = '🏆 *OYUN BİTTİ! NİHAİ SKOR TABLOSU:*\n\n';
    const sortedScores = Array.from(game.scores.values()).sort((a, b) => b.points - a.points);

    if (sortedScores.length > 0) {
      sortedScores.forEach((s, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '•';
        finalBoardText += `${medal} ${s.username}: *${s.points} Puan*\n`;
      });
      finalBoardText += `\n🎉 *Tebrikler ${sortedScores[0].username}! Oyunu 1. sırada tamamladın!*`;
    } else {
      finalBoardText += `Puan kazanan oyuncu olmadı.`;
    }

    await bot.telegram.sendMessage(chatId, finalBoardText, { parse_mode: 'Markdown' });
    resetGame(chatId);
    return;
  }

  // Sıradaki çizen oyuncuyu seç
  const drawerUser = remainingPlayersInCycle[Math.floor(Math.random() * remainingPlayersInCycle.length)];
  game.drawnPlayerIds.add(drawerUser.id);
  game.totalRoundsPlayed++;

  const totalGameRounds = game.players.size * MAX_CYCLES_PER_GAME;
  const secretWord = getRandomWord();

  game.status = 'drawing';
  game.drawer = drawerUser;
  game.word = secretWord;

  await bot.telegram.sendMessage(
    chatId,
    `🎨 *TUR ${game.totalRoundsPlayed}/${totalGameRounds} BAŞLADI!* (Döngü ${game.cycleCount}/${MAX_CYCLES_PER_GAME})\n\n` +
    `👤 *Çizen:* ${drawerUser.username}\n` +
    `👥 *Oyundaki Tahminciler:* ${Array.from(game.players.values()).map(p => p.username).join(', ')}\n\n` +
    `📩 ${drawerUser.username} için özel mesaja çizim linki gönderildi!`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Çizime Başla', `get_dm_btn_${chatId}`)]
      ])
    }
  );

  // DM Gönder
  await sendDrawerDM(drawerUser.id, secretWord, chatId);

  // 90 Saniyelik Çizim Süresi Zamanlayıcısı
  if (game.timer) clearTimeout(game.timer);
  game.timer = setTimeout(() => {
    if (game.status === 'drawing') {
      bot.telegram.sendMessage(
        chatId,
        `⌛ *Süre Doldu!* ${drawerUser.username} çizimini zamanında göndermedi.\n` +
        `⏳ 5 saniye içinde sonraki tura geçiliyor...`,
        { parse_mode: 'Markdown' }
      );
      
      setTimeout(() => { startNextTurn(chatId); }, 5000);
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
    ctx.answerCbQuery('⚠️ Özel mesaj gönderilemiyor. Lütfen bota özel mesaj atıp /start basın.', { show_alert: true });
  }
});

/**
 * DM Üzerinden Çizene Mesaj Gönder
 */
async function sendDrawerDM(drawerId, secretWord, chatId) {
  const twaUrl = `${WEBAPP_URL}/index.html?word=${encodeURIComponent(secretWord)}&chatId=${chatId}&userId=${drawerId}`;

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
    } catch (e) {}
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

  // 60 Saniyelik Tahmin Süresi
  game.timer = setTimeout(() => {
    if (game.status === 'guessing') {
      bot.telegram.sendMessage(
        chatId,
        `⌛ *Süre Doldu!* Kimse doğru tahmini yapamadı.\n🔑 Cevap: *${game.word}* idi!\n\n` +
        `⏳ 5 saniye içinde sonraki tura geçiliyor...`,
        { parse_mode: 'Markdown' }
      );
      
      setTimeout(() => { startNextTurn(chatId); }, 5000);
    }
  }, 60000);

  return true;
}

/**
 * Tahmin Kontrolü & Sonraki Tura Otomatik Geçiş
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

  // DOĞRU TAHMİN!
  if (guess === answer) {
    if (game.timer) clearTimeout(game.timer);

    const guesserName = guesser.username ? `@${guesser.username}` : guesser.first_name;
    const sc = game.scores.get(guesser.id) || { username: guesserName, points: 0 };
    sc.points += 10;
    game.scores.set(guesser.id, sc);

    let board = '\n\n📊 *Mevcut Puan Durumu:*\n';
    game.scores.forEach(s => { board += `• ${s.username}: *${s.points} Puan*\n`; });

    ctx.reply(
      `🎉 *TEBRİKLER ${guesserName}!* Doğru tahmin!\n` +
      `🔑 Kelime: *${game.word}* (+10 Puan)` + board +
      `\n⏳ *5 saniye içinde sonraki tur başlayacak...*`,
      { parse_mode: 'Markdown' }
    );

    // 5 Saniye Sonra Otomatik Sonraki Oyuncunun Turunu Başlat!
    setTimeout(() => {
      startNextTurn(chatId);
    }, 5000);
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
    game.drawnPlayerIds.clear();
    game.cycleCount = 1;
    game.totalRoundsPlayed = 0;
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
