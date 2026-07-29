// 30+ Maddelik Eğlenceli Türkçe Kelime Havuzu
const WORDS = [
  "Uzay Gemisi",
  "Döner",
  "Kulaklık",
  "Süpermen",
  "Zürafa",
  "Bilgisayar",
  "Gözlük",
  "Dondurma",
  "Kelebek",
  "Piyano",
  "Helikopter",
  "Teleskop",
  "Gitar",
  "Şemsiye",
  "Kaktüs",
  "Denizaltı",
  "Penguen",
  "Kamera",
  "Bisiklet",
  "Timsah",
  "Ahtapot",
  "Aslan",
  "Robot",
  "Tost",
  "Pizza",
  "Rüzgar Gülü",
  "Balon",
  "Uçak",
  "Kardan Adam",
  "Korsan Gemisi",
  "Sandviç",
  "Denizfeneri",
  "Paten",
  "Televizyon",
  "Ejderha"
];

/**
 * Rastgele bir kelime seçer
 */
function getRandomWord() {
  const index = Math.floor(Math.random() * WORDS.length);
  return WORDS[index];
}

module.exports = {
  WORDS,
  getRandomWord
};
