require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { getRandomWord } = require('./words');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

// Railway'de PORT ve WEBAPP_URL otomatik gelir
// WEBAPP_URL = https://PROJE-ADINIZ.up.railway.app
const WEBAPP_URL = (process.env.WEBAPP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('❌ HATA: BOT_TOKEN tanımlı değil!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
let botUsername = '';

// ─── In-Memory Oyun Durumu ────────────────────────────────────────────────────
const games = new Map();        // chatId → gameState
const drawerToGroup = new Map(); // drawerId → chatId

// ─── Statik Dosya MIME Tablosu ─────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// ─── HTTP Sunucusu: Statik Dosya + Sağlık Kontrolü ────────────────────────────
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Sağlık kontrolü (Railway bunu kullanır)
  if (req.url === '/healthz' || req.url === '/') {
    // Kök isteğinde index.html döndür
    serveFile(res, path.join(__dirname, 'index.html'));
    return;
  }

  // Diğer statik dosyalar (örn. /index.html, /style.css)
  const filePath = path.join(__dirname, req.url.split('?')[0]);
  serveFile(res, filePath);
});

function serveFile(res, filePath) {
  const ext = path.extname(filePath) || '.html';
  const resolvedPath = ext === '.html' && !filePath.endsWith('.html')
    ? filePath + '.html'
    : filePath;

  fs.readFile(resolvedPath, (err, data) => {
    if (err) {
      // Bulunamazsa index.html döndür (SPA fallback)
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
 * /start — DM karşılama mesajı
 */
bot.start(async (ctx) => {
  const firstName = ctx.from.first_name || 'Oyuncu';
  return ctx.replyWithMarkdown(
    `👋 *Merhaba ${firstName}!* Çiz Tahmin Et oyun botuna hoş geldin!\n\n` +
    `🎮 *Nasıl Oynanır?*\n` +
    `1. Beni bir Telegram grubuna ekle.\n` +
    `2. Grupta */oyunbaslat* komutunu yaz.\n` +
    `3. Sıra sana geldiğinde bu sohbete çizim butonu gelir, çiz ve "Gönder" e bas!\n\n` +
    `🚀 Hazırsın!`,
    Markup.inlineKeyboard([
      [Markup.button.url('👥 Grubuna Ekle', `https://t.me/${botUsername}?startgroup=true`)]
    ])
  );
});

/**
 * /help
 */
bot.command('help', (ctx) => {
  return ctx.replyWithMarkdown(
    `🎨 *Çiz Tahmin Et — Yardım*\n\n` +
    `📋 *Komutlar:*\n` +
    `• /oyunbaslat — Yeni tur başlatır\n` +
    `• /iptal — Turu iptal eder _(sadece yöneticiler)_\n` +
    `• /help — Bu menü`
  );
});

/**
 * /oyunbaslat
 */
bot.command('oyunbaslat', async (ctx) => {
  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

  if (!isGroup) {
    return ctx.reply('⚠️ Bu komut yalnızca gruplarda kullanılabilir!');
  }

  let game = games.get(chatId);
  if (!game) {
    game = { status: 'idle', drawer: null, word: null, timer: null, scores: new Map() };
    games.set(chatId, game);
  }

  if (game.status !== 'idle') {
    return ctx.reply('⚠️ Zaten aktif bir tur var! İptal için /iptal yazın.');
  }

  const drawerUser = ctx.from;
  const drawerName = drawerUser.username ? `@${drawerUser.username}` : drawerUser.first_name;
  const secretWord = getRandomWord();

  game.status  = 'drawing';
  game.drawer  = { id: drawerUser.id, username: drawerName, firstName: drawerUser.first_name };
  game.word    = secretWord;
  drawerToGroup.set(drawerUser.id, chatId);

  // Gruba duyuru + DM başlatma butonu
  await ctx.reply(
    `🎨 *${drawerName}* sıradaki çizen oldu!\n\n` +
    `⏱️ Çizime başlamak için aşağıdaki butona basın:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Çizime Başla (DM Gönder)', `start_draw_${chatId}`)],
        [Markup.button.url('💬 Bota /start ver (gerekirse)', `https://t.me/${botUsername}?start=1`)]
      ])
    }
  );

  // DM göndermeyi dene
  await sendDrawerDM(drawerUser.id, secretWord, chatId);

  // 90 saniyelik çizim süresi (60s çizim + 30s tolerans)
  game.timer = setTimeout(() => {
    if (game.status === 'drawing') {
      bot.telegram.sendMessage(
        chatId,
        `⌛ *Süre doldu!* ${drawerName} çizimini göndermedi, tur iptal edildi.`,
        { parse_mode: 'Markdown' }
      );
      resetGame(chatId);
    }
  }, 90_000);
});

/**
 * Inline buton: "Çizime Başla" — DM gönderir
 */
bot.action(/^start_draw_(.+)$/, async (ctx) => {
  const targetChatId = parseInt(ctx.match[1], 10);
  const game = games.get(targetChatId);
  const clickerId = ctx.from.id;

  if (!game || game.status !== 'drawing') {
    return ctx.answerCbQuery('⚠️ Bu tur sona ermiş veya iptal edilmiş.', { show_alert: true });
  }
  if (game.drawer.id !== clickerId) {
    return ctx.answerCbQuery('⚠️ Sıradaki çizen sen değilsin!', { show_alert: true });
  }

  const success = await sendDrawerDM(clickerId, game.word, targetChatId);
  if (success) {
    ctx.answerCbQuery('📩 DM kutuna çizim butonu gönderildi!', { show_alert: true });
  } else {
    ctx.answerCbQuery(
      '⚠️ Sana DM gönderemedim!\nLütfen önce bota gidip /start komutunu gönder, sonra tekrar dene.',
      { show_alert: true }
    );
  }
});

/**
 * DM — ReplyKeyboard webApp butonu gönder
 * ÖNEMLİ: tg.sendData() YALNIZCA ReplyKeyboard ile açılan WebApp'ta çalışır!
 */
async function sendDrawerDM(drawerId, secretWord, chatId) {
  const twaUrl = `${WEBAPP_URL}?word=${encodeURIComponent(secretWord)}&chatId=${chatId}&userId=${drawerId}`;

  try {
    await bot.telegram.sendMessage(
      drawerId,
      `🎯 *Gizli Kelimen:* \`${secretWord}\`\n\n` +
      `Aşağıdaki butona bas, çizimini yap ve "Gönder" e bas — resim otomatik gruba gidecek!`,
      { parse_mode: 'Markdown' }
    );

    // ReplyKeyboardMarkup ile webApp butonu — sendData bu sayede çalışır
    await bot.telegram.sendMessage(drawerId, '👇 Çizim ekranını aç:', {
      reply_markup: {
        keyboard: [[{ text: '🎨 Çizmeye Başla', web_app: { url: twaUrl } }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });

    return true;
  } catch (err) {
    console.error('DM gönderilemedi:', err.message);
    return false;
  }
}

/**
 * /iptal
 */
bot.command('iptal', async (ctx) => {
  const chatId = ctx.chat.id;
  const game   = games.get(chatId);

  if (!game || game.status === 'idle') {
    return ctx.reply('ℹ️ Aktif bir tur yok.');
  }

  const userId = ctx.from.id;
  let isAdmin  = false;
  try {
    const member = await ctx.getChatMember(userId);
    if (['administrator', 'creator'].includes(member.status) || userId === game.drawer?.id) {
      isAdmin = true;
    }
  } catch (_) {}

  if (!isAdmin) {
    return ctx.reply('⛔ Sadece grup yöneticileri veya çizen kişi turu iptal edebilir!');
  }

  resetGame(chatId);
  return ctx.reply('🛑 Tur iptal edildi.');
});

/**
 * web_app_data — Çizim geldiğinde tetiklenir (ReplyKeyboard webApp)
 */
bot.on('web_app_data', async (ctx) => {
  try {
    const drawerId  = ctx.from.id;
    const rawData   = ctx.message.web_app_data.data;
    const payload   = JSON.parse(rawData);

    // Grup ID: payload'dan veya drawerToGroup haritasından al
    const targetChatId = parseInt(payload.chatId, 10) || drawerToGroup.get(drawerId);
    if (!targetChatId) {
      return ctx.reply('⚠️ Hangi gruba ait olduğu bulunamadı.');
    }

    const game = games.get(targetChatId);
    if (!game || game.status !== 'drawing' || game.drawer.id !== drawerId) {
      return ctx.reply('⚠️ Çizim süresi dolmuş veya tur iptal edilmiş.');
    }

    // Zamanlayıcıyı durdur
    if (game.timer) clearTimeout(game.timer);

    if (!payload.image) return ctx.reply('❌ Çizim verisi boş geldi!');

    // Base64 → Buffer → Telegram sendPhoto
    const base64  = payload.image.replace(/^data:image\/\w+;base64,/, '');
    const buffer  = Buffer.from(base64, 'base64');

    await bot.telegram.sendPhoto(targetChatId, { source: buffer }, {
      caption:
        `🎨 *${game.drawer.username}* çizimini gönderdi!\n\n` +
        `💬 Tahminlerinizi yazın! ⏱️ *60 saniye*`,
      parse_mode: 'Markdown'
    });

    // Çizenden klavyeyi kaldır
    await ctx.reply('✅ Çiziminiz gruba gönderildi!', {
      reply_markup: { remove_keyboard: true }
    });

    // Tahmin aşaması başlat
    game.status = 'guessing';
    game.timer  = setTimeout(() => {
      if (game.status === 'guessing') {
        bot.telegram.sendMessage(
          targetChatId,
          `⌛ *Süre doldu!* Kimse bilemedi.\n🔑 Cevap: *${game.word}*`,
          { parse_mode: 'Markdown' }
        );
        resetGame(targetChatId);
      }
    }, 60_000);

  } catch (err) {
    console.error('web_app_data hatası:', err);
    ctx.reply('❌ Bir hata oluştu.');
  }
});

/**
 * Tahmin kontrolü — guessing durumundaki grup mesajları
 */
bot.on('text', (ctx, next) => {
  const chatId = ctx.chat.id;
  const game   = games.get(chatId);

  if (!game || game.status !== 'guessing') return next();

  const guesser = ctx.from;
  if (guesser.id === game.drawer.id) return next();

  const guess  = ctx.message.text.trim().toLocaleLowerCase('tr');
  const answer = game.word.trim().toLocaleLowerCase('tr');

  if (guess === answer) {
    if (game.timer) clearTimeout(game.timer);

    const name = guesser.username ? `@${guesser.username}` : guesser.first_name;
    const sc   = game.scores.get(guesser.id) || { username: name, points: 0 };
    sc.points += 10;
    game.scores.set(guesser.id, sc);

    let board = '\n\n🏆 *Puan Tablosu:*\n';
    game.scores.forEach(s => { board += `• ${s.username}: *${s.points} puan*\n`; });

    ctx.reply(
      `🎉 *Tebrikler ${name}!* Doğru tahmin!\n🔑 Kelime: *${game.word}* (+10 puan)` + board,
      { parse_mode: 'Markdown' }
    );

    resetGame(chatId);
  } else {
    return next();
  }
});

// ─── Yardımcı: Oyunu Sıfırla ──────────────────────────────────────────────────
function resetGame(chatId) {
  const game = games.get(chatId);
  if (game) {
    if (game.timer)  clearTimeout(game.timer);
    if (game.drawer) drawerToGroup.delete(game.drawer.id);
    game.status = 'idle';
    game.drawer = null;
    game.word   = null;
    game.timer  = null;
  }
}

// ─── Başlat ───────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`🌐 HTTP Sunucusu ${PORT} portunda aktif (statik dosyalar + healthcheck)`);

  const me = await bot.telegram.getMe();
  botUsername = me.username;
  console.log(`🤖 Bot başlatıldı: @${botUsername}`);
  console.log(`🔗 WebApp URL: ${WEBAPP_URL}`);

  bot.launch();
});

process.once('SIGINT',  () => { bot.stop('SIGINT');  server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
