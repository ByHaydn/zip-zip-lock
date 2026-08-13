import { invoke } from "@tauri-apps/api/core";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type ApiResponse = {
  success: boolean;
  message: string;
  output_path?: string;
};

type BiometricStatus = {
  platform: string;
  supported: boolean;
  method: string;
  note: string;
};

const output = () => document.querySelector("#output") as HTMLElement;

function setOutput(message: string) {
  output().textContent = message;
}

function val(id: string) {
  return (document.querySelector(id) as HTMLInputElement | HTMLTextAreaElement)?.value?.trim() ?? "";
}

function getPaths(id: string): string[] {
  const input = document.querySelector(id) as HTMLInputElement;
  if (!input) return [];
  const data = input.getAttribute("data-paths");
  if (data) {
    try {
      return JSON.parse(data);
    } catch (e) {}
  }
  const value = input.value?.trim();
  return value ? [value] : [];
}

function clearPaths(id: string) {
  const input = document.querySelector(id) as HTMLInputElement;
  if (input) {
    input.value = "";
    input.removeAttribute("data-paths");
    input.removeAttribute("data-output-path");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function showCustomPrompt(title: string, defaultValue: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.querySelector("#custom-prompt-modal") as HTMLElement;
    const titleEl = document.querySelector("#prompt-title") as HTMLElement;
    const input = document.querySelector("#prompt-input") as HTMLInputElement;
    const btnCancel = document.querySelector("#btn-prompt-cancel") as HTMLButtonElement;
    const btnOk = document.querySelector("#btn-prompt-ok") as HTMLButtonElement;

    if (!modal || !titleEl || !input || !btnCancel || !btnOk) {
      resolve(null);
      return;
    }

    titleEl.textContent = title;
    input.value = defaultValue;
    modal.style.display = "flex";
    input.focus();
    input.select();

    const cleanup = () => {
      modal.style.display = "none";
      // Clone nodes to clear previous event listeners
      btnOk.replaceWith(btnOk.cloneNode(true));
      btnCancel.replaceWith(btnCancel.cloneNode(true));
    };

    // Re-bind click events
    const newBtnOk = document.querySelector("#btn-prompt-ok") as HTMLButtonElement;
    const newBtnCancel = document.querySelector("#btn-prompt-cancel") as HTMLButtonElement;

    newBtnOk.addEventListener("click", () => {
      const val = input.value.trim();
      cleanup();
      resolve(val || defaultValue);
    });

    newBtnCancel.addEventListener("click", () => {
      cleanup();
      resolve(null);
    });

    // Also support Enter/Escape key press
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        newBtnOk.click();
        input.removeEventListener("keydown", handleKey);
      } else if (e.key === "Escape") {
        newBtnCancel.click();
        input.removeEventListener("keydown", handleKey);
      }
    };
    input.addEventListener("keydown", handleKey);
  });
}

async function handleSelectedPaths(input: HTMLInputElement, paths: string[], type: string) {
  if (paths.length > 0) {
    input.setAttribute("data-paths", JSON.stringify(paths));
    if (paths.length > 1) {
      const lang = currentLanguage;
      const isZip = type === "zip-any" || type === "file-zip" || input.id === "zip-source";
      const defaultName = isZip ? "arsiv" : "kilitli_dosyalar";
      const promptMsg = lang === "tr" 
        ? "Çoklu dosya seçildi. Lütfen oluşturulacak ortak dosya/arşiv için bir isim girin:" 
        : "Multiple files selected. Please enter a name for the output archive/locked file:";
      let archiveName = await showCustomPrompt(promptMsg, defaultName);
      if (!archiveName) {
        input.removeAttribute("data-paths");
        input.removeAttribute("data-output-path");
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      archiveName = archiveName.trim().replace(/[/\\?%*:|"<>. ]/g, "_");
      if (!archiveName) archiveName = defaultName;
      
      const firstPath = paths[0];
      const separator = firstPath.includes("\\") ? "\\" : "/";
      const lastIdx = firstPath.lastIndexOf(separator);
      const parentDir = lastIdx !== -1 ? firstPath.substring(0, lastIdx) : "";
      const ext = isZip ? ".zip" : ".zzl";
      const outputName = `${archiveName}${ext}`;
      const outputPath = parentDir ? `${parentDir}${separator}${outputName}` : outputName;
      
      input.setAttribute("data-output-path", outputPath);
      input.value = `${paths.length} adet dosya seçildi (${outputName})`;
    } else {
      input.removeAttribute("data-output-path");
      input.value = paths[0];
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// ----------------------------------------------------
// 100% ROBUST BULLETPROOF COPY TO CLIPBOARD
// ----------------------------------------------------
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    // Ignore and try fallback
  }

  // Textarea DOM fallback method
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand("copy");
    document.body.removeChild(textArea);
    return successful;
  } catch (err) {
    return false;
  }
}

// ----------------------------------------------------
// LOCALIZATION / MULTI-LANGUAGE SYSTEM
// ----------------------------------------------------
const getSystemLanguage = (): string => {
  const stored = localStorage.getItem("lang");
  if (stored) return stored;
  // Automatically detect system/browser language
  const browserLang = (navigator.language || "en").split("-")[0].toLowerCase();
  return browserLang === "tr" ? "tr" : "en"; // Default to English for all other nations!
};

let currentLanguage = getSystemLanguage();

const translations: Record<string, Record<string, string>> = {
  tr: {
    title: "Zip Zip Lock",
    subtitle: "Dijital dosya cebi • Güvenli ZIP ve Kilit Sistemi",
    // Box 1
    box1_title: "ZIP Oluştur",
    box1_desc: "Dosya veya Klasör Sürükle / Seç",
    box1_placeholder: "Yol seçilmedi...",
    box1_btn: "ZIP Paketle",
    // Box 2
    box2_title: "ZIP Aç",
    box2_desc: "ZIP Arşivi Sürükle / Seç",
    box2_placeholder: "Yol seçilmedi...",
    box2_btn: "ZIP Aç (Ayıkla)",
    // Box 3
    box3_title: "Dosya / Klasör Kilitle",
    box3_desc: "Dosya veya Klasör Sürükle / Seç",
    box3_placeholder: "Yol seçilmedi...",
    box3_label: "Şifreleme Parolası",
    box3_link: "(12 Kelime Kurtarma Şifresi Üret)",
    box3_btn_lock: "Parola ile Kilitle",
    box3_btn_lock_bio: "Touch ID ile Kilitle",
    // Box 4
    box4_title: "Kilit Aç",
    box4_desc: "Kilitli Dosya (.zzl) Sürükle / Seç",
    box4_placeholder: "Yol seçilmedi...",
    box4_label: "Şifre Çözme Parolası",
    box4_btn_unlock: "Parola ile Çöz",
    box4_btn_unlock_bio: "Touch ID ile Çöz",
    // Box 5
    box5_title: "Biyometrik Koruma",
    box5_desc: "Touch ID / Windows Hello biyometrik doğrulama sistem entegrasyonu.",
    box5_btn_status: "Sistem Kontrolü",
    box5_btn_auth: "Mock Doğrulama",
    // Box 6
    box6_title: "Kurtarma Cümlesi",
    box6_desc: "Cihaz anahtarını kurtarmak için 12 kelimelik tohum cümlesi (BIP39).",
    box6_placeholder: "12 kelimeyi aralarında boşluk bırakarak yazın veya tohum kelimeler üretin...",
    box6_btn_generate: "Kelime Üret",
    box6_btn_verify: "Kaydet / Doğrula",
    // Output Box
    console_title: "Sistem Çıktısı (Konsol)",
    console_ready: "Uygulama hazır. Lütfen bir işlem seçin.",
    // Dialogs & Status
    btn_processing: "İşlem Yapılıyor...",
    btn_completed: "✅ Tamamlandı",
    btn_failed: "❌ Başarısız",
    btn_error: "❌ Hata",
    error_prefix: "Hata: ",
    passphrase_empty_error: "❌ Hata: Şifreleme parolası boş olamaz!",
    decrypt_empty_error: "❌ Hata: Şifre çözme parolası boş olamaz!",
    seed_empty_error: "❌ Hata: Doğrulanacak kelimeler boş olamaz!",
    generate_success: "Şifre Üretildi! 🔑 Kopyalamak için yanındaki (📋) simgesine tıklayın.",
    save_success: "Kaydedildi ve Doğrulandı! ✅",
    copy_success: "Panoya Kopyalandı! ✅",
    copy_failed: "Kopyalama başarısız!",
    copy_tooltip: "Kopyala",
    toggle_tooltip: "Göster / Gizle",
    // File Picker dialogs
    dialog_choose: "Seçim Yapın",
    dialog_zip_ask: "Sıkıştırmak için klasör mü seçeceksiniz yoksa dosya mı?",
    dialog_lock_ask: "Kilitlemek için klasör mü seçeceksiniz yoksa dosya mı?",
    dialog_btn_dir: "Klasör Seç",
    dialog_btn_file: "Dosya Seç",
    dialog_title_zip: "ZIP Dosyası Seç",
    dialog_title_zzl: "Kilitli Dosya Seç"
  },
  en: {
    title: "Zip Zip Lock",
    subtitle: "Digital file pocket • Secure ZIP and Lock System",
    // Box 1
    box1_title: "Create ZIP",
    box1_desc: "Drag & Drop File or Folder / Select",
    box1_placeholder: "No path selected...",
    box1_btn: "ZIP Compress",
    // Box 2
    box2_title: "Open ZIP",
    box2_desc: "Drag & Drop ZIP Archive / Select",
    box2_placeholder: "No path selected...",
    box2_btn: "Extract ZIP",
    // Box 3
    box3_title: "Lock File / Folder",
    box3_desc: "Drag & Drop File or Folder / Select",
    box3_placeholder: "No path selected...",
    box3_label: "Encryption Password",
    box3_link: "(Generate 12-Word Recovery Password)",
    box3_btn_lock: "Lock with Password",
    box3_btn_lock_bio: "Lock with Touch ID",
    // Box 4
    box4_title: "Unlock",
    box4_desc: "Drag & Drop Locked File (.zzl) / Select",
    box4_placeholder: "No path selected...",
    box4_label: "Decryption Password",
    box4_btn_unlock: "Unlock with Password",
    box4_btn_unlock_bio: "Unlock with Touch ID",
    // Box 5
    box5_title: "Biometric Protection",
    box5_desc: "Touch ID / Windows Hello biometric verification system integration.",
    box5_btn_status: "System Check",
    box5_btn_auth: "Mock Auth",
    // Box 6
    box6_title: "Recovery Phrase",
    box6_desc: "12-word seed phrase to recover device key (BIP39).",
    box6_placeholder: "Type 12 words separated by spaces or generate seed words...",
    box6_btn_generate: "Generate Words",
    box6_btn_verify: "Save / Verify",
    // Output Box
    console_title: "System Output (Console)",
    console_ready: "Application ready. Please select an action.",
    // Dialogs & Status
    btn_processing: "Processing...",
    btn_completed: "✅ Completed",
    btn_failed: "❌ Failed",
    btn_error: "❌ Error",
    error_prefix: "Error: ",
    passphrase_empty_error: "❌ Error: Encryption password cannot be empty!",
    decrypt_empty_error: "❌ Error: Decryption password cannot be empty!",
    seed_empty_error: "❌ Error: Seed words to verify cannot be empty!",
    generate_success: "Password Generated! 🔑 Click the copy icon (📋) next to the box to copy it.",
    save_success: "Saved and Verified! ✅",
    copy_success: "Copied to Clipboard! ✅",
    copy_failed: "Copy failed!",
    copy_tooltip: "Copy",
    toggle_tooltip: "Show / Hide",
    // File Picker dialogs
    dialog_choose: "Choose Option",
    dialog_zip_ask: "Do you want to select a folder or a file to compress?",
    dialog_lock_ask: "Do you want to select a folder or a file to lock?",
    dialog_btn_dir: "Select Folder",
    dialog_btn_file: "Select File",
    dialog_title_zip: "Select ZIP File",
    dialog_title_zzl: "Select Locked File"
  }
};

function applyLanguage(lang: string) {
  currentLanguage = lang;
  localStorage.setItem("lang", lang);

  // Update text contents
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key && translations[lang][key]) {
      el.textContent = translations[lang][key];
    }
  });

  // Update placeholders
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key && translations[lang][key]) {
      (el as HTMLInputElement | HTMLTextAreaElement).placeholder = translations[lang][key];
    }
  });

  // Update tooltips dynamically
  document.querySelectorAll(".copy-btn").forEach((el) => {
    el.setAttribute("title", translations[lang].copy_tooltip);
  });
  document.querySelectorAll(".toggle-password").forEach((el) => {
    el.setAttribute("title", translations[lang].toggle_tooltip);
  });
  const toggleSeedBtn = document.querySelector("#toggle-seed-visibility");
  if (toggleSeedBtn) {
    toggleSeedBtn.setAttribute("title", translations[lang].toggle_tooltip);
  }
}

// ----------------------------------------------------
// UI BUTTON RUNNER WITH LOCALIZED LABELS
// ----------------------------------------------------
async function runButtonAction(btnSelector: string, action: () => Promise<string>) {
  const button = document.querySelector(btnSelector) as HTMLButtonElement;
  if (!button) {
    try {
      const message = await action();
      setOutput(message);
    } catch (error) {
      setOutput(`${translations[currentLanguage].error_prefix}${String(error)}`);
    }
    return;
  }

  const originalText = button.innerHTML;
  button.disabled = true;
  button.classList.add("btn-loading");
  button.innerHTML = `<span class="spinner"></span> ${translations[currentLanguage].btn_processing}`;

  try {
    const message = await action();
    setOutput(message);

    const isSuccess = !message.includes("Hata") && !message.includes("❌") && !message.includes("Error");
    if (isSuccess) {
      button.classList.remove("btn-loading");
      button.classList.add("btn-success");
      button.innerHTML = translations[currentLanguage].btn_completed;
    } else {
      button.classList.remove("btn-loading");
      button.classList.add("btn-error");
      button.innerHTML = translations[currentLanguage].btn_failed;
    }

    setTimeout(() => {
      button.classList.remove("btn-success", "btn-error");
      button.innerHTML = originalText;
      button.disabled = false;
    }, 2000);
  } catch (error) {
    setOutput(`${translations[currentLanguage].error_prefix}${String(error)}`);
    button.classList.remove("btn-loading");
    button.classList.add("btn-error");
    button.innerHTML = translations[currentLanguage].btn_error;

    setTimeout(() => {
      button.classList.remove("btn-error");
      button.innerHTML = originalText;
      button.disabled = false;
    }, 2000);
  }
}

// SVG Icons Constants
const SVGS = {
  copy: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  check: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  eyeOpen: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
  eyeClosed: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
};

window.addEventListener("DOMContentLoaded", () => {
  // Apply initial language configuration
  applyLanguage(currentLanguage);

  // Tauri Invoke Handlers
  document.querySelector("#btn-create-zip")?.addEventListener("click", () =>
    runButtonAction("#btn-create-zip", async () => {
      const source_paths = getPaths("#zip-source");
      const output_zip_path = (document.querySelector("#zip-source") as HTMLInputElement).getAttribute("data-output-path") || "";
      const res = await invoke<ApiResponse>("create_zip", { req: { source_paths, output_zip_path } });
      if (res.success) {
        clearPaths("#zip-source");
        if (res.output_path) {
          (document.querySelector("#unzip-source") as HTMLInputElement).value = res.output_path;
        }
      }
      return `${res.success ? "✅" : "❌"} ${res.message}`;
    })
  );

  document.querySelector("#btn-unzip")?.addEventListener("click", () =>
    runButtonAction("#btn-unzip", async () => {
      const zip_path = val("#unzip-source");
      const res = await invoke<ApiResponse>("unzip_file", { req: { zip_path, output_dir: "" } });
      if (res.success) {
        (document.querySelector("#unzip-source") as HTMLInputElement).value = "";
        if (res.output_path) {
          (document.querySelector("#zip-source") as HTMLInputElement).value = res.output_path;
        }
      }
      return `${res.success ? "✅" : "❌"} ${res.message}`;
    })
  );

  document.querySelector("#btn-lock")?.addEventListener("click", () =>
    runButtonAction("#btn-lock", async () => {
      const input_paths = getPaths("#lock-input");
      const output_path = (document.querySelector("#lock-input") as HTMLInputElement).getAttribute("data-output-path") || "";
      const passphrase = val("#lock-pass");
      if (!passphrase) return translations[currentLanguage].passphrase_empty_error;
      const res = await invoke<ApiResponse>("lock_file", { req: { input_paths, output_path, passphrase } });
      if (res.success) {
        clearPaths("#lock-input");
        (document.querySelector("#lock-pass") as HTMLInputElement).value = "";
        if (res.output_path) {
          (document.querySelector("#unlock-input") as HTMLInputElement).value = res.output_path;
        }
      }
      return `${res.success ? "✅" : "❌"} ${res.message}`;
    })
  );

  document.querySelector("#btn-lock-bio")?.addEventListener("click", () =>
    runButtonAction("#btn-lock-bio", async () => {
      const input_paths = getPaths("#lock-input");
      const output_path = (document.querySelector("#lock-input") as HTMLInputElement).getAttribute("data-output-path") || "";
      const res = await invoke<ApiResponse>("lock_file", { req: { input_paths, output_path, passphrase: "__TOUCH_ID_SEED__" } });
      if (res.success) {
        clearPaths("#lock-input");
        (document.querySelector("#lock-pass") as HTMLInputElement).value = "";
        if (res.output_path) {
          (document.querySelector("#unlock-input") as HTMLInputElement).value = res.output_path;
        }
      }
      return `${res.success ? "✅" : "❌"} ${res.message}`;
    })
  );

  document.querySelector("#btn-unlock")?.addEventListener("click", () =>
    runButtonAction("#btn-unlock", async () => {
      const input_path = val("#unlock-input");
      const passphrase = val("#unlock-pass");
      if (!passphrase) return translations[currentLanguage].decrypt_empty_error;
      const res = await invoke<ApiResponse>("unlock_file", { req: { input_path, output_path: "", passphrase } });
      if (res.success) {
        (document.querySelector("#unlock-input") as HTMLInputElement).value = "";
        (document.querySelector("#unlock-pass") as HTMLInputElement).value = "";
      }
      return `${res.success ? "✅" : "❌"} ${res.message}`;
    })
  );

  document.querySelector("#btn-unlock-bio")?.addEventListener("click", () =>
    runButtonAction("#btn-unlock-bio", async () => {
      const input_path = val("#unlock-input");
      const bioAuth = await invoke<ApiResponse>("biometric_mock_auth");
      if (!bioAuth.success) {
        return `❌ ${bioAuth.message}`;
      }
      const res = await invoke<ApiResponse>("unlock_file", { req: { input_path, output_path: "", passphrase: "__TOUCH_ID_SEED__" } });
      if (res.success) {
        (document.querySelector("#unlock-input") as HTMLInputElement).value = "";
        (document.querySelector("#unlock-pass") as HTMLInputElement).value = "";
      }
      return `${res.success ? "✅" : "❌"} ${res.message}`;
    })
  );

  document.querySelector("#btn-bio-status")?.addEventListener("click", () =>
    runButtonAction("#btn-bio-status", async () => {
      const res = await invoke<BiometricStatus>("biometric_status");
      if (currentLanguage === "tr") {
        return `🧬 Platform: ${res.platform}\nDestek: ${res.supported ? "Evet" : "Hayır"}\nYöntem: ${res.method}\nNot: ${res.note}`;
      } else {
        return `🧬 Platform: ${res.platform}\nSupport: ${res.supported ? "Yes" : "No"}\nMethod: ${res.method}\nNote: ${res.note}`;
      }
    })
  );

  document.querySelector("#btn-bio-auth")?.addEventListener("click", () =>
    runButtonAction("#btn-bio-auth", async () => {
      const res = await invoke<ApiResponse>("biometric_mock_auth");
      return `${res.success ? "✅" : "❌"} ${res.message}`;
    })
  );

  document.querySelector("#btn-generate-seed")?.addEventListener("click", () =>
    runButtonAction("#btn-generate-seed", async () => {
      const res = await invoke<ApiResponse>("generate_seed_phrase");
      if (res.success) {
        (document.querySelector("#seed-input") as HTMLTextAreaElement).value = res.message;
        
        // Visual indicator to prompt manual copy due to async clipboard rules
        const parent = seedInput.parentElement;
        const copyBtn = parent?.querySelector(".copy-btn") as HTMLButtonElement;
        if (copyBtn) {
          copyBtn.style.color = "#34d399";
          copyBtn.style.transform = "scale(1.3)";
          copyBtn.style.transition = "all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)";
          setTimeout(() => {
            copyBtn.style.color = "#9ca3af";
            copyBtn.style.transform = "";
          }, 2000);
        }

        await copyToClipboard(res.message);
        return translations[currentLanguage].generate_success;
      }
      return `❌ ${res.message}`;
    })
  );

  document.querySelector("#btn-verify-seed")?.addEventListener("click", () =>
    runButtonAction("#btn-verify-seed", async () => {
      const phrase = val("#seed-input");
      if (!phrase) return translations[currentLanguage].seed_empty_error;
      const res = await invoke<ApiResponse>("verify_seed_phrase", { req: { phrase } });
      if (res.success) {
        (document.querySelector("#seed-input") as HTMLTextAreaElement).value = "";
      }
      return res.success ? translations[currentLanguage].save_success : `❌ ${res.message}`;
    })
  );

  document.querySelector("#link-generate-pass")?.addEventListener("click", (e) => {
    e.preventDefault();
    runButtonAction("#link-generate-pass", async () => {
      const res = await invoke<ApiResponse>("generate_seed_phrase");
      if (res.success) {
        const passInput = document.querySelector("#lock-pass") as HTMLInputElement;
        if (passInput) {
          passInput.type = "password";
          passInput.value = res.message;
          passInput.dispatchEvent(new Event("input", { bubbles: true }));

          // Visual indicator to prompt manual copy due to async clipboard rules
          const parent = passInput.parentElement;
          const copyBtn = parent?.querySelector(".copy-btn") as HTMLButtonElement;
          if (copyBtn) {
            copyBtn.style.color = "#34d399";
            copyBtn.style.transform = "scale(1.3)";
            copyBtn.style.transition = "all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)";
            setTimeout(() => {
              copyBtn.style.color = "#9ca3af";
              copyBtn.style.transform = "";
            }, 2000);
          }
        }
        await copyToClipboard(res.message);
        return translations[currentLanguage].generate_success;
      }
      return `❌ ${res.message}`;
    });
  });

  // Password Visibility Toggle Listener
  document.querySelectorAll(".toggle-password").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetSelector = btn.getAttribute("data-target");
      if (!targetSelector) return;
      const input = document.querySelector(targetSelector) as HTMLInputElement;
      if (!input) return;
      if (input.type === "password") {
        input.type = "text";
        btn.innerHTML = SVGS.eyeClosed;
      } else {
        input.type = "password";
        btn.innerHTML = SVGS.eyeOpen;
      }
    });
  });

  // Seed Input Blur/Visibility Toggle
  const seedInput = document.querySelector("#seed-input") as HTMLTextAreaElement;
  const toggleSeedBtn = document.querySelector("#toggle-seed-visibility") as HTMLButtonElement;
  if (seedInput && toggleSeedBtn) {
    seedInput.style.filter = "blur(6px)";
    seedInput.style.transition = "filter 0.2s ease";

    toggleSeedBtn.addEventListener("click", () => {
      if (seedInput.style.filter === "blur(6px)") {
        seedInput.style.filter = "none";
        toggleSeedBtn.innerHTML = SVGS.eyeClosed;
      } else {
        seedInput.style.filter = "blur(6px)";
        toggleSeedBtn.innerHTML = SVGS.eyeOpen;
      }
    });
  }

  // Copy Buttons handler with Feedback Tick and sliding Tooltip
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetSelector = btn.getAttribute("data-target");
      if (!targetSelector) return;
      const targetElement = document.querySelector(targetSelector) as HTMLInputElement | HTMLTextAreaElement;
      if (!targetElement) return;
      const textToCopy = targetElement.value;
      if (!textToCopy) return;

      const success = await copyToClipboard(textToCopy);
      if (success) {
        // Show success tick feedback
        btn.innerHTML = SVGS.check;
        const successMsg = translations[currentLanguage].copy_success;
        setOutput(successMsg);

        // Create and show sliding green tooltip above the button
        const tooltip = document.createElement("span");
        tooltip.textContent = currentLanguage === "tr" ? "Kopyalandı!" : "Copied!";
        tooltip.style.position = "absolute";
        tooltip.style.bottom = "28px";
        tooltip.style.right = "0px";
        tooltip.style.backgroundColor = "#10b981";
        tooltip.style.color = "#fff";
        tooltip.style.fontSize = "10px";
        tooltip.style.padding = "2px 6px";
        tooltip.style.borderRadius = "4px";
        tooltip.style.boxShadow = "0 2px 8px rgba(0,0,0,0.5)";
        tooltip.style.pointerEvents = "none";
        tooltip.style.whiteSpace = "nowrap";
        tooltip.style.zIndex = "100";
        tooltip.style.opacity = "0";
        tooltip.style.transition = "opacity 0.2s ease, transform 0.2s ease";
        tooltip.style.transform = "translateY(5px)";

        btn.parentNode?.appendChild(tooltip);

        // Animate in
        setTimeout(() => {
          tooltip.style.opacity = "1";
          tooltip.style.transform = "translateY(0)";
        }, 10);

        // Animate out and remove
        setTimeout(() => {
          tooltip.style.opacity = "0";
          tooltip.style.transform = "translateY(-5px)";
          setTimeout(() => {
            tooltip.remove();
          }, 200);
        }, 1200);

        setTimeout(() => {
          btn.innerHTML = SVGS.copy;
        }, 1500);
      } else {
        setOutput(translations[currentLanguage].copy_failed);
      }
    });
  });

  // Click Handlers for Drop Zones (opening native file selectors)
  document.querySelectorAll(".drop-zone").forEach((zone) => {
    zone.addEventListener("click", async (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;

      const targetId = zone.getAttribute("data-target");
      const type = zone.getAttribute("data-type");
      if (!targetId) return;

      const input = document.querySelector(targetId) as HTMLInputElement;
      if (!input) return;

      try {
        let selectedPath: string | string[] | null = null;
        const lang = currentLanguage;

        if (type === "dir") {
          selectedPath = await open({
            directory: true,
            multiple: false,
            title: translations[lang].dialog_btn_dir
          });
        } else if (type === "file") {
          selectedPath = await open({
            directory: false,
            multiple: true,
            title: translations[lang].dialog_btn_file
          });
        } else if (type === "zip-any") {
          const isFolder = await ask(translations[lang].dialog_zip_ask, {
            title: translations[lang].dialog_choose,
            okLabel: translations[lang].dialog_btn_dir,
            cancelLabel: translations[lang].dialog_btn_file
          });
          selectedPath = await open({
            directory: isFolder,
            multiple: !isFolder,
            title: isFolder ? translations[lang].dialog_btn_dir : translations[lang].dialog_btn_file
          });
        } else if (type === "lock-any") {
          const isFolder = await ask(translations[lang].dialog_lock_ask, {
            title: translations[lang].dialog_choose,
            okLabel: translations[lang].dialog_btn_dir,
            cancelLabel: translations[lang].dialog_btn_file
          });
          selectedPath = await open({
            directory: isFolder,
            multiple: !isFolder,
            title: isFolder ? translations[lang].dialog_btn_dir : translations[lang].dialog_btn_file
          });
        } else if (type === "file-zip") {
          selectedPath = await open({
            directory: false,
            multiple: false,
            filters: [{ name: "ZIP", extensions: ["zip"] }],
            title: translations[lang].dialog_title_zip
          });
        } else if (type === "file-zzl") {
          selectedPath = await open({
            directory: false,
            multiple: false,
            filters: [{ name: "ZZL", extensions: ["zzl"] }],
            title: translations[lang].dialog_title_zzl
          });
        }

        if (selectedPath) {
          const paths = Array.isArray(selectedPath) ? selectedPath : [selectedPath];
          await handleSelectedPaths(input, paths, type || "");
        }
      } catch (err) {
        setOutput(`${translations[currentLanguage].error_prefix}${String(err)}`);
      }
    });
  });

  // Drag and Drop OS-Interception Listener
  const webview = getCurrentWebviewWindow();
  webview.onDragDropEvent(async (event) => {
    if (event.payload.type === "over" || event.payload.type === "drop") {
      const { x, y } = event.payload.position;
      const isMac = navigator.userAgent.includes("Mac OS X");
      const scale = isMac ? 1 : (window.devicePixelRatio || 1);
      const logicalX = x / scale;
      const logicalY = y / scale;
      const elem = document.elementFromPoint(logicalX, logicalY);
      if (!elem) return;

      const card = elem.closest(".box-card");
      if (!card) return;

      if (event.payload.type === "over") {
        document.querySelectorAll(".box-card").forEach((c) => c.classList.remove("drag-hover"));
        card.classList.add("drag-hover");
      } else if (event.payload.type === "drop") {
        document.querySelectorAll(".box-card").forEach((c) => c.classList.remove("drag-hover"));
        const paths = event.payload.paths;
        if (paths && paths.length > 0) {
          const input = card.querySelector(".drop-zone input[type='text']") as HTMLInputElement;
          const dropZone = card.querySelector(".drop-zone") as HTMLElement;
          const type = dropZone ? dropZone.getAttribute("data-type") : "";
          if (input) {
            await handleSelectedPaths(input, paths, type || "");
          }
        }
      }
    } else if (event.payload.type === "leave") {
      document.querySelectorAll(".box-card").forEach((c) => c.classList.remove("drag-hover"));
    }
  });

  // Pre-fill target path from CLI args on startup
  invoke<string | null>("get_cli_arg").then((cliPath) => {
    if (cliPath) {
      const lower = cliPath.toLowerCase();
      if (lower.endsWith(".zzl")) {
        const input = document.querySelector("#unlock-input") as HTMLInputElement;
        if (input) {
          input.value = cliPath;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else if (lower.endsWith(".zip")) {
        const input = document.querySelector("#unzip-source") as HTMLInputElement;
        if (input) {
          input.value = cliPath;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else {
        const zipInput = document.querySelector("#zip-source") as HTMLInputElement;
        if (zipInput) {
          zipInput.value = cliPath;
          zipInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const lockInput = document.querySelector("#lock-input") as HTMLInputElement;
        if (lockInput) {
          lockInput.value = cliPath;
          lockInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }
  });

  // Check biometric support on startup and disable Touch ID buttons if unsupported
  invoke<BiometricStatus>("biometric_status").then((status) => {
    if (!status.supported) {
      const bioLockBtn = document.querySelector("#btn-lock-bio") as HTMLButtonElement;
      const bioUnlockBtn = document.querySelector("#btn-unlock-bio") as HTMLButtonElement;
      
      if (bioLockBtn) {
        bioLockBtn.disabled = true;
        bioLockBtn.style.opacity = "0.5";
        bioLockBtn.style.cursor = "not-allowed";
        bioLockBtn.title = currentLanguage === "tr" 
          ? "Cihazınızda biyometrik doğrulama donanımı bulunamadı." 
          : "Biometric authentication hardware not found on your device.";
      }
      
      if (bioUnlockBtn) {
        bioUnlockBtn.disabled = true;
        bioUnlockBtn.style.opacity = "0.5";
        bioUnlockBtn.style.cursor = "not-allowed";
        bioUnlockBtn.title = currentLanguage === "tr" 
          ? "Cihazınızda biyometrik doğrulama donanımı bulunamadı." 
          : "Biometric authentication hardware not found on your device.";
      }
    }
  }).catch((e) => console.error("Biyometrik durum kontrolü başarısız:", e));
});
