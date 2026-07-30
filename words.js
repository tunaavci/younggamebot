// 200+ Maddelik Geniş ve Eğlenceli Türkçe Kelime Havuzu
const WORDS = [
  // Nesneler & Eşyalar
  "Kulaklık", "Bilgisayar", "Gözlük", "Piyano", "Teleskop", "Gitar", "Şemsiye", "Kaktüs", "Kamera", "Bisiklet",
  "Televizyon", "Saat", "Ayakkabı", "Anahtar", "Çanta", "Ayna", "Radyo", "Bavul", "Mikrofon", "Lambader",
  "Yastık", "Koltuk", "Sandalye", "Masa", "Tablo", "Pencere", "Kilit", "Makas", "Tarak", "Fırça",
  "Kupa", "Tabak", "Çatal", "Kaşık", "Bıçak", "Tencere", "Tava", "Şişe", "Bardak", "Mum",
  "Şamdan", "Pusula", "Harita", "Kitap", "Defter", "Kalem", "Silgi", "Cetvel", "Zarf", "Mektup",

  // Taşıtlar & Ulaşım
  "Uzay Gemisi", "Helikopter", "Denizaltı", "Rüzgar Gülü", "Balon", "Uçak", "Korsan Gemisi", "Paten", "Taksi", "Otobüs",
  "Tren", "Metro", "Vapur", "Yat", "Kamyon", "Traktör", "Kepçe", "Ambulans", "İtfaiye", "Polis Arabası",
  "Motosiklet", "Scooter", "Teleferik", "Fayton", "Zepelin", "Yelkenli", "Karavan", "Roket", "Uçan Daire", "Bisiklet",

  // Yemekler & İçecekler
  "Döner", "Dondurma", "Tost", "Pizza", "Sandviç", "Kahve", "Çay", "Hamburger", "Patates Kızartması", "Lahmacun",
  "Pide", "Baklava", "Künefe", "Pasta", "Kek", "Kurabiye", "Simit", "Poğaça", "Waffle", "Krep",
  "Çorba", "Köfte", "Makarna", "Suşi", "Taco", "Kuru Fasulye", "Pilav", "Sarma", "Mantı", "İskender",
  "Limonata", "Ayran", "Meyve Suyu", "Karpuz", "Kavun", "Elma", "Armut", "Muz", "Çilek", "Portakal",

  // Hayvanlar
  "Zürafa", "Kelebek", "Penguen", "Timsah", "Ahtapot", "Aslan", "Ejderha", "Kaplan", "Fil", "Zebra",
  "Zürafa", "Maymun", "Ayı", "Kutup Ayısı", "Kurt", "Tilki", "Tavşan", "Sincap", "Kirpi", "Yılan",
  "Kertenkele", "Kaplumbağa", "Kurbağa", "Yunus", "Balina", "Köpekbalığı", "Denizanası", "Denizatı", "Papağan", "Kartal",
  "Baykuş", "Güvercin", "Tavuk", "Horoz", "Ördek", "Kuğu", "Kedi", "Köpek", "At", "Eşek",

  // Karakterler & Meslekler
  "Süpermen", "Kardan Adam", "Batman", "Spiderman", "Korsan", "Astronot", "Ressam", "Müzisyen", "Doktor", "Hemşire",
  "Polis", "İtfaiyeci", "Aşçı", "Mimar", "Mühendis", "Öğretmen", "Pilot", "Kaptan", "Büyücü", "Kral",
  "Kraliçe", "Prens", "Prenses", "Şövalye", "Ninja", "Samurai", "Vampir", "Zombi", "Uzaylı", "Robot",

  // Doğa, Yerler & Yapılar
  "Denizfeneri", "Yanardağ", "Şelale", "Mağara", "Çöl", "Orman", "Ada", "Piramit", "Kale", "Saray",
  "Gökdelen", "Köprü", "Değirmen", "Çadır", "İglu", "Güneş", "Ay", "Yıldız", "Bulut", "Gökkuşağı",
  "Şimşek", "Kar", "Yağmur", "Kasırga", "Tsunami", "Göl", "Nehir", "Buzdağı", "Gezegen", "Galaksi"
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
