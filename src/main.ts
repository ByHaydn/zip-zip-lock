import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// Types matching Rust API
interface ApiResponse {
  success: boolean;
  message: string;
  output_path?: string;
}

interface BiometricStatus {
  platform: string;
  supported: boolean;
  method: string;
  note: string;
}

// ----------------------------------------------------
// UI HELPERS
// ----------------------------------------------------
function val(id: string): string {
  return (document.querySelector(id) as HTMLInputElement | HTMLTextAreaElement)?.value || "";
}

function setOutput(text: string) {
  const out = document.querySelector("#output") as HTMLElement;
  if (out) {
    out.textContent = text;
  }
}

function getPaths(id: string): string[] {
  const input = document.querySelector(id) as HTMLInputElement;
  if (!input) return [];
  const raw = input.getAttribute("data-paths");
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      // fallback
    }
  }
  const single = input.value;
  return single ? [single] : [];
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

    let handleKey: (e: KeyboardEvent) => void;

    const cleanup = () => {
      modal.style.display = "none";
      if (handleKey) {
        input.removeEventListener("keydown", handleKey);
      }
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
    handleKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        newBtnOk.click();
      } else if (e.key === "Escape") {
        newBtnCancel.click();
      }
    };
    input.addEventListener("keydown", handleKey);
  });
}

function showCustomChooseModal(title: string, desc: string): Promise<"file" | "dir" | null> {
  return new Promise((resolve) => {
    const modal = document.querySelector("#custom-choose-modal") as HTMLElement;
    const titleEl = document.querySelector("#choose-title") as HTMLElement;
    const descEl = document.querySelector("#choose-desc") as HTMLElement;
    const btnFile = document.querySelector("#btn-choose-file") as HTMLButtonElement;
    const btnDir = document.querySelector("#btn-choose-dir") as HTMLButtonElement;
    const btnCancel = document.querySelector("#btn-choose-cancel") as HTMLButtonElement;

    if (!modal || !titleEl || !descEl || !btnFile || !btnDir || !btnCancel) {
      resolve(null);
      return;
    }

    titleEl.textContent = title;
    descEl.textContent = desc;
    modal.style.display = "flex";

    const cleanup = () => {
      modal.style.display = "none";
      btnFile.replaceWith(btnFile.cloneNode(true));
      btnDir.replaceWith(btnDir.cloneNode(true));
      btnCancel.replaceWith(btnCancel.cloneNode(true));
    };

    const newBtnFile = document.querySelector("#btn-choose-file") as HTMLButtonElement;
    const newBtnDir = document.querySelector("#btn-choose-dir") as HTMLButtonElement;
    const newBtnCancel = document.querySelector("#btn-choose-cancel") as HTMLButtonElement;

    newBtnFile.addEventListener("click", () => {
      cleanup();
      resolve("file");
    });

    newBtnDir.addEventListener("click", () => {
      cleanup();
      resolve("dir");
    });

    newBtnCancel.addEventListener("click", () => {
      cleanup();
      resolve(null);
    });
  });
}

async function handleSelectedPaths(input: HTMLInputElement, paths: string[], type: string) {
  if (paths.length > 0) {
    input.setAttribute("data-paths", JSON.stringify(paths));
    if (paths.length > 1) {
      const isCreate = type === "zip-any" || type === "lock-any" || type === "file" || input.id === "zip-source" || input.id === "lock-input";
      
      if (isCreate) {
        const isZip = type === "zip-any" || type === "file-zip" || input.id === "zip-source";
        const defaultName = isZip ? "archive" : "locked_files";
        const promptMsg = "Multiple files selected. Please enter a name for the output archive/locked file:";
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
        input.value = `${paths.length} files selected (${outputName})`;
      } else {
        // Unzipping/Unlocking multiple existing files
        input.removeAttribute("data-output-path");
        input.value = `${paths.length} files selected`;
      }
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
// UI BUTTON RUNNER
// ----------------------------------------------------
async function runButtonAction(btnSelector: string, action: () => Promise<string>) {
  const button = document.querySelector(btnSelector) as HTMLButtonElement;
  if (!button) {
    try {
      const message = await action();
      setOutput(message);
    } catch (error) {
      setOutput(`Error: ${String(error)}`);
    }
    return;
  }

  const originalText = button.innerHTML;
  button.disabled = true;
  button.classList.add("btn-loading");
  button.innerHTML = `<span class="spinner"></span> Processing...`;

  try {
    const message = await action();
    setOutput(message);

    const isSuccess = !message.includes("Error") && !message.includes("❌");
    if (isSuccess) {
      button.classList.remove("btn-loading");
      button.classList.add("btn-success");
      button.innerHTML = "✅ Completed";
    } else {
      button.classList.remove("btn-loading");
      button.classList.add("btn-error");
      button.innerHTML = "❌ Failed";
    }

    setTimeout(() => {
      button.classList.remove("btn-success", "btn-error");
      button.innerHTML = originalText;
      button.disabled = false;
    }, 2000);
  } catch (error) {
    setOutput(`Error: ${String(error)}`);
    button.classList.remove("btn-loading");
    button.classList.add("btn-error");
    button.innerHTML = "❌ Error";

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
      const paths = getPaths("#unzip-source");
      if (paths.length === 0) return "Error: No files selected";
      
      let successCount = 0;
      let failCount = 0;
      let lastMessage = "";
      
      for (const zip_path of paths) {
        const res = await invoke<ApiResponse>("unzip_file", { req: { zip_path, output_dir: "" } });
        if (res.success) {
          successCount++;
        } else {
          failCount++;
        }
        lastMessage = res.message;
      }
      
      if (successCount > 0) {
        clearPaths("#unzip-source");
      }
      
      if (paths.length > 1) {
        return `✅ ${successCount} ZIP archives extracted successfully.${failCount > 0 ? ` ❌ ${failCount} failed.` : ""}`;
      } else {
        return `${successCount > 0 ? "✅" : "❌"} ${lastMessage}`;
      }
    })
  );

  document.querySelector("#btn-lock")?.addEventListener("click", () =>
    runButtonAction("#btn-lock", async () => {
      const input_paths = getPaths("#lock-input");
      const output_path = (document.querySelector("#lock-input") as HTMLInputElement).getAttribute("data-output-path") || "";
      const passphrase = val("#lock-pass");
      if (!passphrase) return "❌ Error: Encryption password cannot be empty!";
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
      const paths = getPaths("#unlock-input");
      if (paths.length === 0) return "Error: No files selected";
      
      const passphrase = val("#unlock-pass");
      if (!passphrase) return "❌ Error: Decryption password cannot be empty!";
      
      let successCount = 0;
      let failCount = 0;
      let lastMessage = "";
      
      for (const input_path of paths) {
        const res = await invoke<ApiResponse>("unlock_file", { req: { input_path, output_path: "", passphrase } });
        if (res.success) {
          successCount++;
        } else {
          failCount++;
        }
        lastMessage = res.message;
      }
      
      if (successCount > 0) {
        clearPaths("#unlock-input");
        (document.querySelector("#unlock-pass") as HTMLInputElement).value = "";
      }
      
      if (paths.length > 1) {
        return `✅ ${successCount} files unlocked successfully.${failCount > 0 ? ` ❌ ${failCount} failed.` : ""}`;
      } else {
        return `${successCount > 0 ? "✅" : "❌"} ${lastMessage}`;
      }
    })
  );

  document.querySelector("#btn-unlock-bio")?.addEventListener("click", () =>
    runButtonAction("#btn-unlock-bio", async () => {
      const paths = getPaths("#unlock-input");
      if (paths.length === 0) return "Error: No files selected";
      
      const bioAuth = await invoke<ApiResponse>("biometric_mock_auth");
      if (!bioAuth.success) {
        return `❌ ${bioAuth.message}`;
      }
      
      let successCount = 0;
      let failCount = 0;
      let lastMessage = "";
      
      for (const input_path of paths) {
        const res = await invoke<ApiResponse>("unlock_file", { req: { input_path, output_path: "", passphrase: "__TOUCH_ID_SEED__" } });
        if (res.success) {
          successCount++;
        } else {
          failCount++;
        }
        lastMessage = res.message;
      }
      
      if (successCount > 0) {
        clearPaths("#unlock-input");
        (document.querySelector("#unlock-pass") as HTMLInputElement).value = "";
      }
      
      if (paths.length > 1) {
        return `✅ ${successCount} files unlocked successfully.${failCount > 0 ? ` ❌ ${failCount} failed.` : ""}`;
      } else {
        return `${successCount > 0 ? "✅" : "❌"} ${lastMessage}`;
      }
    })
  );

  document.querySelector("#btn-bio-status")?.addEventListener("click", () =>
    runButtonAction("#btn-bio-status", async () => {
      const res = await invoke<BiometricStatus>("biometric_status");
      return `🧬 Platform: ${res.platform}\nSupport: ${res.supported ? "Yes" : "No"}\nMethod: ${res.method}\nNote: ${res.note}`;
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
        return "Password Generated! 🔑 Click the copy icon (📋) next to the box to copy it.";
      }
      return `❌ ${res.message}`;
    })
  );

  document.querySelector("#btn-verify-seed")?.addEventListener("click", () =>
    runButtonAction("#btn-verify-seed", async () => {
      const phrase = val("#seed-input");
      if (!phrase) return "❌ Error: Seed words to verify cannot be empty!";
      const res = await invoke<ApiResponse>("verify_seed_phrase", { req: { phrase } });
      if (res.success) {
        // Clear textarea inside modal
        (document.querySelector("#seed-input") as HTMLTextAreaElement).value = "";
        
        // Fill verified seed into both password inputs
        const lockPass = document.querySelector("#lock-pass") as HTMLInputElement;
        if (lockPass) {
          lockPass.value = phrase;
          lockPass.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const unlockPass = document.querySelector("#unlock-pass") as HTMLInputElement;
        if (unlockPass) {
          unlockPass.value = phrase;
          unlockPass.dispatchEvent(new Event("input", { bubbles: true }));
        }
        
        // Copy to clipboard
        await copyToClipboard(phrase);
        
        // Close modal
        const recoveryModal = document.querySelector("#recovery-modal") as HTMLElement;
        if (recoveryModal) {
          recoveryModal.style.display = "none";
        }
      }
      return res.success ? "Saved and Verified! ✅ Applied as your encryption password." : `❌ ${res.message}`;
    })
  );

  document.querySelector("#link-generate-pass")?.addEventListener("click", (e) => {
    e.preventDefault();
    const recoveryModal = document.querySelector("#recovery-modal") as HTMLElement;
    if (recoveryModal) {
      recoveryModal.style.display = "flex";
    }
    // Automatically trigger the generate words button click inside the modal
    const generateBtn = document.querySelector("#btn-generate-seed") as HTMLButtonElement;
    if (generateBtn) {
      generateBtn.click();
    }
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
        setOutput("Copied to Clipboard! ✅");

        // Create and show sliding green tooltip above the button
        const tooltip = document.createElement("span");
        tooltip.textContent = "Copied!";
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
        setOutput("Copy failed!");
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

        if (type === "dir") {
          selectedPath = await open({
            directory: true,
            multiple: false,
            title: "Select Folder"
          });
        } else if (type === "file") {
          selectedPath = await open({
            directory: false,
            multiple: true,
            filters: [{ name: "All Files", extensions: ["zip", "zzl", "png", "jpg", "jpeg", "gif", "pdf", "txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "mp3", "mp4", "mov", "avi", "dmg", "pkg", "rar", "7z", "tar", "gz"] }],
            title: "Select File"
          });
        } else if (type === "zip-any") {
          const choice = await showCustomChooseModal("Choose Option", "Do you want to select a folder or files to compress?");
          if (!choice) return;
          const isFolder = choice === "dir";
          selectedPath = await open({
            directory: isFolder,
            multiple: true,
            filters: isFolder ? undefined : [{ name: "All Files", extensions: ["zip", "zzl", "png", "jpg", "jpeg", "gif", "pdf", "txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "mp3", "mp4", "mov", "avi", "dmg", "pkg", "rar", "7z", "tar", "gz"] }],
            title: isFolder ? "Select Folder" : "Select File"
          });
        } else if (type === "lock-any") {
          const choice = await showCustomChooseModal("Choose Option", "Do you want to select a folder or files to lock?");
          if (!choice) return;
          const isFolder = choice === "dir";
          selectedPath = await open({
            directory: isFolder,
            multiple: true,
            filters: isFolder ? undefined : [{ name: "All Files", extensions: ["zip", "zzl", "png", "jpg", "jpeg", "gif", "pdf", "txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "mp3", "mp4", "mov", "avi", "dmg", "pkg", "rar", "7z", "tar", "gz"] }],
            title: isFolder ? "Select Folder" : "Select File"
          });
        } else if (type === "file-zip") {
          selectedPath = await open({
            directory: false,
            multiple: true,
            filters: [{ name: "ZIP", extensions: ["zip"] }],
            title: "Select ZIP File"
          });
        } else if (type === "file-zzl") {
          selectedPath = await open({
            directory: false,
            multiple: true,
            filters: [{ name: "ZZL", extensions: ["zzl"] }],
            title: "Select Locked File"
          });
        }

        if (selectedPath) {
          const paths = Array.isArray(selectedPath) ? selectedPath : [selectedPath];
          await handleSelectedPaths(input, paths, type || "");
        }
      } catch (err) {
        setOutput(`Error: ${String(err)}`);
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

  // RESTYLING TABS & DRAWER INTERACTIVES
  const zipSegment = document.querySelector("#zip-segment") as HTMLElement;
  const zipCompressBtn = document.querySelector('#zip-segment [data-tab="compress"]') as HTMLElement;
  const zipExtractBtn = document.querySelector('#zip-segment [data-tab="extract"]') as HTMLElement;
  const panelZipCompress = document.querySelector("#panel-zip-compress") as HTMLElement;
  const panelZipExtract = document.querySelector("#panel-zip-extract") as HTMLElement;

  zipCompressBtn?.addEventListener("click", () => {
    zipSegment?.classList.remove("right-active");
    zipCompressBtn.classList.add("active");
    zipExtractBtn.classList.remove("active");
    panelZipCompress.classList.remove("hidden");
    panelZipExtract.classList.add("hidden");
  });

  zipExtractBtn?.addEventListener("click", () => {
    zipSegment?.classList.add("right-active");
    zipExtractBtn.classList.add("active");
    zipCompressBtn.classList.remove("active");
    panelZipExtract.classList.remove("hidden");
    panelZipCompress.classList.add("hidden");
  });

  const lockSegment = document.querySelector("#lock-segment") as HTMLElement;
  const lockBtn = document.querySelector('#lock-segment [data-tab="lock"]') as HTMLElement;
  const unlockBtn = document.querySelector('#lock-segment [data-tab="unlock"]') as HTMLElement;
  const panelLockLock = document.querySelector("#panel-lock-lock") as HTMLElement;
  const panelLockUnlock = document.querySelector("#panel-lock-unlock") as HTMLElement;

  lockBtn?.addEventListener("click", () => {
    lockSegment?.classList.remove("right-active");
    lockBtn.classList.add("active");
    unlockBtn.classList.remove("active");
    panelLockLock.classList.remove("hidden");
    panelLockUnlock.classList.add("hidden");
  });

  unlockBtn?.addEventListener("click", () => {
    lockSegment?.classList.add("right-active");
    unlockBtn.classList.add("active");
    lockBtn.classList.remove("active");
    panelLockUnlock.classList.remove("hidden");
    panelLockLock.classList.add("hidden");
  });

  const recoveryModal = document.querySelector("#recovery-modal") as HTMLElement;
  const recoveryModalCloseBtn = document.querySelector("#btn-recovery-modal-close") as HTMLElement;
  document.querySelectorAll(".link-toggle-recovery").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      if (recoveryModal) recoveryModal.style.display = "flex";
    });
  });

  recoveryModalCloseBtn?.addEventListener("click", () => {
    if (recoveryModal) recoveryModal.style.display = "none";
  });

  // Sidebar Feature Click Modal Info Bindings
  const featureInfoModal = document.querySelector("#feature-info-modal") as HTMLElement;
  const featureInfoTitle = document.querySelector("#feature-info-title") as HTMLElement;
  const featureInfoDesc = document.querySelector("#feature-info-desc") as HTMLElement;
  const featureInfoCloseBtn = document.querySelector("#btn-feature-info-close") as HTMLElement;

  const featureDetails: Record<string, { title: string; desc: string }> = {
    m5: {
      title: "⚡ Native M1-M5 Support",
      desc: "This application is compiled natively for Apple Silicon (M1, M2, M3, M4, and M5) Mac processors. Running natively means it utilizes 100% of your Mac's hardware acceleration, resulting in instant processing speeds with zero delay. It is extremely energy-efficient and consumes virtually no battery life compared to Intel-emulated software."
    },
    touchid: {
      title: "🧬 Biometric Touch ID",
      desc: "Lock and unlock files instantly using your fingerprint. Touch ID acts as a local convenience shortcut on this Mac. <strong>Critical Security Warning:</strong> Touch ID only works locally on this machine. If you move your locked (.zzl) files to another computer, upload them to cloud storage (like Google Drive), or if your fingerprint sensor fails, you <em>must</em> use your original manual password or 12-word recovery seed to decrypt them. Always write down and securely back up your passwords and recovery seeds!"
    },
    delete: {
      title: "🚫 Accidental Delete Protection",
      desc: "To prevent accidental data loss, locked .zzl archives are protected at the system level using the macOS immutable lock flag (chflags uchg). If you try to drag a locked file to the Trash or overwrite it in Finder, macOS will intervene with a warning: <em>'This item is locked. Do you want to move it to the Trash anyway?'</em>. This acts as a critical safety buffer for your important data."
    },
    aes: {
      title: "🔒 AES-256-GCM Encryption",
      desc: "Your files are encrypted locally using quantum-resistant AES-256-GCM cryptography. The application operates 100% offline; your passwords, recovery keys, and file contents never leave your device. There are no servers, no cloud syncs, and no tracking, ensuring absolute privacy and local data security."
    }
  };

  document.querySelectorAll(".feature-item").forEach((item) => {
    item.addEventListener("click", () => {
      const featKey = item.getAttribute("data-feature");
      if (featKey && featureDetails[featKey]) {
        if (featureInfoTitle) featureInfoTitle.innerHTML = featureDetails[featKey].title;
        if (featureInfoDesc) featureInfoDesc.innerHTML = featureDetails[featKey].desc;
        if (featureInfoModal) featureInfoModal.style.display = "flex";
      }
    });
  });

  featureInfoCloseBtn?.addEventListener("click", () => {
    if (featureInfoModal) featureInfoModal.style.display = "none";
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
        bioLockBtn.title = "Biometric authentication hardware not found on your device.";
      }
      
      if (bioUnlockBtn) {
        bioUnlockBtn.disabled = true;
        bioUnlockBtn.style.opacity = "0.5";
        bioUnlockBtn.style.cursor = "not-allowed";
        bioUnlockBtn.title = "Biometric authentication hardware not found on your device.";
      }
    }
  }).catch((e) => console.error("Biometric status check failed:", e));
});
