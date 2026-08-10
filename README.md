# 🦘 Zip Zip Lock

**Zip Zip Lock**, ultra-fast file compression (ZIP) and biometric-locked encryption (.zzl) software for macOS and Windows. Keep your sensitive files safe using Apple Touch ID or Windows Hello, backed by BIP39 12-word seed recovery phrases.

*Zip Zip Lock, macOS ve Windows için ultra hızlı dosya sıkıştırma (ZIP) ve biyometrik kilitli şifreleme (.zzl) yazılımıdır. Hassas dosyalarınızı Apple Touch ID veya Windows Hello kullanarak koruyun, BIP39 12 kelimelik kurtarma şifreleri ile yedekleyin.*

---

## 🚀 Features / Özellikler

- **Super-Fast ZIP:** Level 9 maximum deflate compression ratio. *(Maksimum seviye 9 sıkıştırma oranı.)*
- **Biometric Encryption:** Lock any file or folder with **Touch ID** or **Windows Hello**. *(Herhangi bir dosya/klasörü Touch ID veya Windows Hello ile kilitleyin.)*
- **12-Word Recovery (BIP39):** Secure device-key backup. Lose your Mac? Recover files on Windows using your 12 words. *(Güvenli cihaz anahtarı yedeği. Mac'inizi mi kaybettiniz? 12 kelimenizle dosyalarınızı Windows'ta kurtarın.)*
- **Privacy First:** Passwords and keys are never shown as open text, masked by default with easy copy buttons and blurs. *(Şifreler asla açık gösterilmez, maskeli ve kopyalama korumalıdır.)*
- **Dynamic Localization:** Automatically runs in **Turkish** for Turkish locales, and defaults to **English** for the rest of the world. *(Otomatik sistem dili algılama; Türkçe dışındaki tüm dünyada İngilizce çalışır.)*
- **macOS Quick Actions (Right-Click):** Automatically locks/unlocks directly from Finder. *(Finder üzerinden sağ tıkla otomatik kilitleme ve kilit açma.)*

---

## 🛠️ Installation & Building / Kurulum ve Derleme

### Prerequisites / Gereksinimler
Make sure you have Node.js (v18+) and Rust installed on your machine. *(Bilgisayarınızda Node.js ve Rust derleyicisinin kurulu olduğundan emin olun.)*

### 1. Install Dependencies / Bağımlılıkları Yükle
```bash
npm install
```

### 2. Compile and Package / Kurulum Paketlerini Derle
This command will automatically package the release bundles (`.dmg` for macOS, `.msi` for Windows). *(Bu komut final sürüm kurulum paketlerini otomatik olarak oluşturur.)*
```bash
npm run tauri build
```
- **macOS output location:** `src-tauri/target/release/bundle/dmg/Zip Zip Lock_0.1.0_x64.dmg`
- **Windows output location:** `src-tauri/target/release/bundle/msi/Zip Zip Lock_0.1.0_x64.msi`

---

## 📖 User Guide / Kullanım Kılavuzu

### How to use the GUI / Arayüz Kullanımı:
1. **Compress to ZIP:** Drag & drop any folder or file to the first card, and click **ZIP Compress** / **ZIP Paketle**.
2. **Biometric Lock (.zzl):** 
   - Drag & drop a file/folder.
   - Click **Touch ID ile Kilitle** (Lock with Touch ID).
   - The file is encrypted into a secure `.zzl` file and original folder is compressed.
3. **Unlock:** 
   - Drag & drop a `.zzl` file.
   - Click **Touch ID ile Çöz** (Unlock with Touch ID).
   - Place your finger on the sensor. The file decrypts instantly!

### macOS Finder Integration (Right-Click / Hızlı Eylemler):
You can secure any file from Finder using macOS Shortcuts:
1. Open the macOS **Shortcuts (Kestirmeler)** app.
2. Create a new Quick Action shortcut named **"Zip Zip Lock"**.
3. Set "Girişi Geçir" (Pass Input) to `değişken olarak` (as arguments).
4. Add a "Run Shell Script" action with the following command:
   ```bash
   /Applications/Zip\ Zip\ Lock.app/Contents/MacOS/zip-zip-lock "$1"
   ```
5. Right-click any file in Finder -> **Quick Actions (Hızlı Eylemler) -> Zip Zip Lock**. It will instantly prompt for your fingerprint and lock/unlock!
