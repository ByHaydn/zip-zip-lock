use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, Result};
use bip39::{Language, Mnemonic};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Serialize)]
struct ApiResponse {
    success: bool,
    message: String,
    output_path: Option<String>,
}

#[derive(Serialize)]
struct BiometricStatus {
    platform: String,
    supported: bool,
    method: String,
    note: String,
}

#[derive(Deserialize)]
struct ZipRequest {
    source_paths: Vec<String>,
    output_zip_path: String,
}

#[derive(Deserialize)]
struct UnzipRequest {
    zip_path: String,
    output_dir: String,
}

#[derive(Deserialize)]
struct LockRequest {
    input_paths: Vec<String>,
    output_path: String,
    passphrase: String,
}

#[derive(Deserialize)]
struct UnlockRequest {
    input_path: String,
    output_path: String,
    passphrase: String,
}

#[derive(Deserialize)]
struct SeedVerifyRequest {
    phrase: String,
}

fn zip_path(src_dir: &Path, path: &Path) -> Result<String> {
    let rel = path.strip_prefix(src_dir)?;
    let mut name = rel.to_string_lossy().replace('\\', "/");
    if path.is_dir() && !name.ends_with('/') {
        name.push('/');
    }
    Ok(name)
}


fn reveal_in_finder(path: &Path) {
    let p = path.to_path_buf();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("open")
                .arg("-R")
                .arg(&p)
                .status();
        }
        #[cfg(target_os = "windows")]
        {
            let win_path = p.to_string_lossy().replace('/', "\\");
            let _ = std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", win_path))
                .status();
        }
    });
}

fn get_unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let file_stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let extension = path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    
    let mut counter = 1;
    loop {
        let new_name = if extension.is_empty() {
            format!("{} ({})", file_stem, counter)
        } else {
            format!("{} ({}).{}", file_stem, counter, extension)
        };
        let new_path = parent.join(new_name);
        if !new_path.exists() {
            return new_path;
        }
        counter += 1;
    }
}

fn tag_file(_path: &Path, _color_index: u8) {
    // Disabled to respect user's custom Finder tags
}

fn set_file_immutable_macos(path: &Path, immutable: bool) {
    #[cfg(target_os = "macos")]
    {
        let flag = if immutable { "uchg" } else { "nouchg" };
        let _ = std::process::Command::new("chflags")
            .arg(flag)
            .arg(path)
            .status();
    }
}

fn get_seed_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".zip_zip_lock_seed")
}

fn save_seed(phrase: &str) -> Result<()> {
    fs::write(get_seed_path(), phrase)?;
    Ok(())
}

fn load_seed() -> Result<String> {
    let path = get_seed_path();
    if path.exists() {
        let content = fs::read_to_string(path)?;
        Ok(content.trim().to_string())
    } else {
        Err(anyhow!("12 kelimelik seed tohumu bulunamadı. Lütfen önce seed üretin veya doğrulayın."))
    }
}

fn get_vault_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".zip_zip_lock_vault")
}

fn save_file_password_multi(file_path: &Path, uuid: &str, password: &str) -> Result<()> {
    let vault_path = get_vault_path();
    let mut map = if vault_path.exists() {
        let content = fs::read_to_string(&vault_path)?;
        serde_json::from_str::<std::collections::HashMap<String, String>>(&content).unwrap_or_default()
    } else {
        std::collections::HashMap::new()
    };
    
    let path_key = file_path.to_string_lossy().to_string();
    map.insert(path_key, password.to_string());
    map.insert(uuid.to_string(), password.to_string());
    
    let serialized = serde_json::to_string(&map)?;
    fs::write(&vault_path, serialized)?;
    Ok(())
}

fn get_file_password_multi(file_path: &Path, uuid: Option<&str>) -> Option<String> {
    let vault_path = get_vault_path();
    if vault_path.exists() {
        if let Ok(content) = fs::read_to_string(&vault_path) {
            if let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, String>>(&content) {
                if let Some(uid) = uuid {
                    if let Some(pass) = map.get(uid) {
                        return Some(pass.clone());
                    }
                }
                let path_key = file_path.to_string_lossy().to_string();
                return map.get(&path_key).cloned();
            }
        }
    }
    None
}

fn remove_file_password_multi(file_path: &Path, uuid: Option<&str>) {
    let vault_path = get_vault_path();
    if vault_path.exists() {
        if let Ok(content) = fs::read_to_string(&vault_path) {
            if let Ok(mut map) = serde_json::from_str::<std::collections::HashMap<String, String>>(&content) {
                let path_key = file_path.to_string_lossy().to_string();
                map.remove(&path_key);
                if let Some(uid) = uuid {
                    map.remove(uid);
                }
                if let Ok(serialized) = serde_json::to_string(&map) {
                    let _ = fs::write(&vault_path, serialized);
                }
            }
        }
    }
}

fn create_zip_impl(source_path: &str, output_zip_path: &str) -> Result<String> {
    let src = PathBuf::from(source_path);
    if !src.exists() {
        return Err(anyhow!("Kaynak bulunamadı: {}", source_path));
    }

    let mut out_path = if output_zip_path.trim().is_empty() {
        let mut auto_path = src.clone();
        if src.is_file() {
            auto_path.set_extension("zip");
        } else {
            let name = src.file_name().ok_or_else(|| anyhow!("Klasör adı çözümlenemedi"))?;
            let mut name_str = name.to_string_lossy().to_string();
            name_str.push_str(".zip");
            if let Some(parent) = src.parent() {
                auto_path = parent.join(name_str);
            } else {
                auto_path = PathBuf::from(name_str);
            }
        }
        auto_path
    } else {
        PathBuf::from(output_zip_path)
    };

    out_path = get_unique_path(out_path);

    let out_file = File::create(&out_path)?;
    let mut zip = ZipWriter::new(std::io::BufWriter::new(out_file));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(5))
        .unix_permissions(0o755);

    if src.is_file() {
        let name = src
            .file_name()
            .ok_or_else(|| anyhow!("Dosya adı çözümlenemedi"))?
            .to_string_lossy()
            .to_string();
        zip.start_file(name, options)?;
        let mut f = File::open(&src)?;
        std::io::copy(&mut f, &mut zip)?;
    } else {
        let base_dir = src.parent().unwrap_or(&src);
        for entry in WalkDir::new(&src) {
            let entry = entry?;
            let path = entry.path();
            if path == base_dir {
                continue;
            }
            let name = zip_path(base_dir, path)?;
            if path.is_file() {
                zip.start_file(name, options)?;
                let mut f = File::open(path)?;
                std::io::copy(&mut f, &mut zip)?;
            } else if !name.is_empty() {
                zip.add_directory(name, options)?;
            }
        }
    }

    zip.finish()?;
    tag_file(&out_path, 1); // Tag with Orange (index 1)
    Ok(format!("ZIP oluşturuldu: {}", out_path.to_string_lossy()))
}

fn create_zip_from_files(files: &[String], output_zip_path: &str) -> Result<String> {
    if files.is_empty() {
        return Err(anyhow!("Hiçbir dosya seçilmedi"));
    }
    let out_path = PathBuf::from(output_zip_path);
    let out_path = get_unique_path(out_path);

    let out_file = File::create(&out_path)?;
    let mut zip = ZipWriter::new(std::io::BufWriter::new(out_file));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(5))
        .unix_permissions(0o755);

    for path_str in files {
        let file_path = PathBuf::from(path_str);
        if file_path.exists() {
            if file_path.is_file() {
                let name = file_path
                    .file_name()
                    .ok_or_else(|| anyhow!("Dosya adı çözümlenemedi"))?
                    .to_string_lossy()
                    .to_string();
                zip.start_file(name, options)?;
                let mut f = File::open(&file_path)?;
                std::io::copy(&mut f, &mut zip)?;
            } else {
                let base_dir = file_path.parent().unwrap_or(&file_path);
                for entry in WalkDir::new(&file_path) {
                    let entry = entry?;
                    let path = entry.path();
                    if path == base_dir {
                        continue;
                    }
                    let name = zip_path(base_dir, path)?;
                    if path.is_file() {
                        zip.start_file(name, options)?;
                        let mut f = File::open(path)?;
                        std::io::copy(&mut f, &mut zip)?;
                    } else if !name.is_empty() {
                        zip.add_directory(name, options)?;
                    }
                }
            }
        }
    }

    zip.finish()?;
    tag_file(&out_path, 1);
    let out_path_str = out_path.to_string_lossy().to_string();
    Ok(format!("ZIP oluşturuldu: {}", out_path_str))
}

fn unzip_impl(zip_path: &str, output_dir: &str) -> Result<(String, PathBuf)> {
    let src = PathBuf::from(zip_path);
    if !src.exists() {
        return Err(anyhow!("ZIP dosyası bulunamadı: {}", zip_path));
    }

    let zip_file = File::open(zip_path)?;
    let mut archive = ZipArchive::new(zip_file)?;

    // Detect if ZIP contains a single root folder
    let has_single_root = {
        let mut common_root: Option<String> = None;
        let mut has_files = false;
        let mut ok = true;
        for i in 0..archive.len() {
            if let Ok(file) = archive.by_index(i) {
                let name = file.name();
                if name.starts_with("__MACOSX") || name.contains(".DS_Store") {
                    continue;
                }
                has_files = true;
                // If it does not contain a slash, it is a file at the root, not inside a root folder!
                if !name.contains('/') {
                    ok = false;
                    break;
                }
                if let Some(first_part) = name.split('/').next() {
                    if first_part.is_empty() {
                        ok = false;
                        break;
                    }
                    if let Some(ref root) = common_root {
                        if root != first_part {
                            ok = false;
                            break;
                        }
                    } else {
                        common_root = Some(first_part.to_string());
                    }
                } else {
                    ok = false;
                    break;
                }
            }
        }
        ok && has_files && common_root.is_some()
    };

    let output_path = if output_dir.trim().is_empty() {
        let parent = src.parent().ok_or_else(|| anyhow!("ZIP dosyasının üst dizini bulunamadı"))?;
        if has_single_root {
            parent.to_path_buf()
        } else {
            let stem = src.file_stem().ok_or_else(|| anyhow!("ZIP dosyasının adı okunamadı"))?;
            get_unique_path(parent.join(stem))
        }
    } else {
        PathBuf::from(output_dir)
    };

    fs::create_dir_all(&output_path)?;

    let mut first_item: Option<PathBuf> = None;
    let mut resolved_tops: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        
        let rel_name = file.name();
        if rel_name.starts_with("__MACOSX") || rel_name.contains(".DS_Store") {
            continue;
        }
        let first_part = rel_name.split('/').next().unwrap_or(rel_name).to_string();
        
        let resolved_top = resolved_tops.entry(first_part.clone()).or_insert_with(|| {
            let initial_top_path = output_path.join(&first_part);
            get_unique_path(initial_top_path)
        }).clone();
        
        let outpath = if rel_name.contains('/') {
            let remaining_path: PathBuf = rel_name.split('/').skip(1).collect();
            resolved_top.join(remaining_path)
        } else {
            resolved_top.clone()
        };

        // Security check
        if !outpath.starts_with(&output_path) {
            return Err(anyhow!("Geçersiz dosya yolu (Zip Slip)"));
        }

        if first_item.is_none() {
            first_item = Some(resolved_top.clone());
        }

        if file.name().ends_with('/') {
            fs::create_dir_all(&outpath)?;
        } else {
            if let Some(p) = outpath.parent() {
                fs::create_dir_all(p)?;
            }
            let mut outfile = File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
        }
    }

    if let Some(path) = first_item {
        tag_file(&path, 6); // Tag with Green (index 6) for unzipped items!
        let _ = reveal_in_finder(&path);
    }
    Ok((format!("ZIP açıldı: {}", output_path.to_string_lossy()), output_path))
}

fn key_from_passphrase(passphrase: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(passphrase.as_bytes());
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result[..32]);
    key
}

fn encrypt_bytes(data: &[u8], passphrase: &str, is_dir: bool, uuid_bytes: &[u8; 16]) -> Result<Vec<u8>> {
    let key = key_from_passphrase(passphrase);
    let cipher = Aes256Gcm::new_from_slice(&key)?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let encrypted = cipher
        .encrypt(nonce, data)
        .map_err(|_| anyhow!("Şifreleme başarısız"))?;
    let mut out = b"ZZL2".to_vec();
    out.push(if is_dir { 1 } else { 0 }); // 1 byte directory flag
    out.extend_from_slice(uuid_bytes);    // 16 bytes UUID
    out.extend_from_slice(&nonce_bytes);  // 12 bytes nonce
    out.extend_from_slice(&encrypted);
    Ok(out)
}

fn decrypt_bytes(data: &[u8], passphrase: &str) -> Result<(Vec<u8>, bool, Option<String>)> {
    if data.len() < 17 {
        return Err(anyhow!("Geçersiz kilitli dosya formatı"));
    }
    if &data[0..4] == b"ZZL2" {
        if data.len() < 33 {
            return Err(anyhow!("Geçersiz kilitli dosya formatı"));
        }
        let is_dir = data[4] == 1;
        let mut uuid_bytes = [0u8; 16];
        uuid_bytes.copy_from_slice(&data[5..21]);
        let file_uuid_hex = uuid_bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>();
        
        let key = key_from_passphrase(passphrase);
        let cipher = Aes256Gcm::new_from_slice(&key)?;
        let nonce = Nonce::from_slice(&data[21..33]);
        let ciphertext = &data[33..];
        let decrypted = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| anyhow!("Şifre çözme başarısız"))?;
        Ok((decrypted, is_dir, Some(file_uuid_hex)))
    } else if &data[0..4] == b"ZZL1" {
        let is_dir = data[4] == 1;
        let key = key_from_passphrase(passphrase);
        let cipher = Aes256Gcm::new_from_slice(&key)?;
        let nonce = Nonce::from_slice(&data[5..17]);
        let ciphertext = &data[17..];
        let decrypted = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| anyhow!("Şifre çözme başarısız"))?;
        Ok((decrypted, is_dir, None))
    } else {
        Err(anyhow!("Bilinmeyen dosya formatı"))
    }
}

fn lock_file_impl(input_paths: &[String], output_path: &str, passphrase: &str) -> Result<(String, String)> {
    if input_paths.is_empty() {
        return Err(anyhow!("Hiçbir dosya veya klasör seçilmedi"));
    }

    let src = PathBuf::from(&input_paths[0]);
    if !src.exists() {
        return Err(anyhow!("Dosya veya klasör bulunamadı: {}", input_paths[0]));
    }

    let is_dir = input_paths.len() > 1 || src.is_dir();

    let resolved_passphrase = if passphrase == "__TOUCH_ID_SEED__" {
        if let Ok(seed) = load_seed() {
            seed
        } else {
            use bip39::{Mnemonic, Language};
            use rand::RngCore;
            let mut entropy = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut entropy);
            match Mnemonic::from_entropy_in(Language::English, &entropy) {
                Ok(m) => {
                    let phrase = m.to_string();
                    let _ = save_seed(&phrase);
                    phrase
                }
                Err(e) => return Err(anyhow!("Otomatik seed üretilemedi: {}", e)),
            }
        }
    } else {
        passphrase.to_string()
    };

    let mut out_path = if output_path.trim().is_empty() {
        let mut auto_path = src.clone();
        if input_paths.len() > 1 {
            if let Some(parent) = src.parent() {
                auto_path = parent.join("locked_files.zzl");
            } else {
                auto_path = PathBuf::from("locked_files.zzl");
            }
        } else {
            let mut ext = auto_path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
            if !ext.is_empty() {
                ext.push_str(".zzl");
                auto_path.set_extension(ext);
            } else {
                auto_path.set_extension("zzl");
            }
        }
        auto_path
    } else {
        PathBuf::from(output_path)
    };

    out_path = get_unique_path(out_path);

    let data = if input_paths.len() > 1 {
        let temp_zip = std::env::temp_dir().join(format!("temp_lock_{}.zip", rand::random::<u32>()));
        let _ = create_zip_from_files(input_paths, &temp_zip.to_string_lossy())?;
        let bytes = fs::read(&temp_zip)?;
        let _ = fs::remove_file(&temp_zip);
        bytes
    } else if src.is_dir() {
        let temp_zip = std::env::temp_dir().join(format!("temp_lock_{}.zip", rand::random::<u32>()));
        create_zip_impl(&input_paths[0], &temp_zip.to_string_lossy())?;
        let bytes = fs::read(&temp_zip)?;
        let _ = fs::remove_file(&temp_zip);
        bytes
    } else {
        fs::read(&src)?
    };

    let mut uuid_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut uuid_bytes);
    let file_uuid_hex = uuid_bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>();

    let enc = encrypt_bytes(&data, &resolved_passphrase, is_dir, &uuid_bytes)?;
    fs::write(&out_path, enc)?;
    
    // Save the file password to the vault under path and UUID
    let _ = save_file_password_multi(&out_path, &file_uuid_hex, &resolved_passphrase);

    // Lock the zzl file so it cannot be deleted/trashed without auth
    set_file_immutable_macos(&out_path, true);

    // Delete the original source files
    for path_str in input_paths {
        let p = PathBuf::from(path_str);
        if p.exists() {
            if p.is_dir() {
                let _ = fs::remove_dir_all(&p);
            } else {
                let _ = fs::remove_file(&p);
            }
        }
    }

    tag_file(&out_path, 2); // Tag with Red (index 2) for locked files!
    reveal_in_finder(&out_path);
    let out_path_str = out_path.to_string_lossy().to_string();
    Ok((format!("Dosyalar kilitlendi: {}", out_path_str), out_path_str))
}

fn unlock_file_impl(input_path: &str, output_path: &str, passphrase: &str) -> Result<(String, String)> {
    let src = PathBuf::from(input_path);
    if !src.exists() {
        return Err(anyhow!("Kilitli dosya bulunamadı: {}", input_path));
    }

    let encrypted_data = fs::read(&src)?;

    // Read UUID if it's a ZZL2 file
    let file_uuid = if encrypted_data.len() >= 21 && &encrypted_data[0..4] == b"ZZL2" {
        let mut uuid_bytes = [0u8; 16];
        uuid_bytes.copy_from_slice(&encrypted_data[5..21]);
        Some(uuid_bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>())
    } else {
        None
    };

    let resolved_passphrase = if passphrase == "__TOUCH_ID_SEED__" {
        if let Some(vault_pass) = get_file_password_multi(&src, file_uuid.as_deref()) {
            vault_pass
        } else {
            load_seed()?
        }
    } else {
        passphrase.to_string()
    };

    let mut out_path = if output_path.trim().is_empty() {
        let name_str = src.to_string_lossy().to_string();
        if name_str.ends_with(".zzl") {
            PathBuf::from(&name_str[..name_str.len() - 4])
        } else {
            let mut new_name = name_str;
            new_name.push_str(".unlocked");
            PathBuf::from(new_name)
        }
    } else {
        PathBuf::from(output_path)
    };

    out_path = get_unique_path(out_path);

    let (decrypted_data, is_dir, parsed_uuid) = decrypt_bytes(&encrypted_data, &resolved_passphrase)?;

    if is_dir {
        let temp_zip = std::env::temp_dir().join(format!("temp_unlock_{}.zip", rand::random::<u32>()));
        fs::write(&temp_zip, &decrypted_data)?;
        
        let parent_dir = out_path.parent().ok_or_else(|| anyhow!("Üst dizin bulunamadı"))?;
        let _ = unzip_impl(&temp_zip.to_string_lossy(), &parent_dir.to_string_lossy())?;
        
        let _ = fs::remove_file(&temp_zip);
    } else {
        fs::write(&out_path, decrypted_data)?;
    }

    tag_file(&out_path, 4); // Tag with Blue (index 4) for unlocked files/folders!
    reveal_in_finder(&out_path);

    // Unlock the zzl file first so it can be deleted
    set_file_immutable_macos(&src, false);
    let _ = fs::remove_file(&src);

    // Remove the password from the vault
    remove_file_password_multi(&src, parsed_uuid.as_deref());

    let out_path_str = out_path.to_string_lossy().to_string();
    Ok((format!("Dosya açıldı: {}", out_path_str), out_path_str))
}

#[tauri::command]
fn create_zip(req: ZipRequest) -> ApiResponse {
    if req.source_paths.is_empty() {
        return ApiResponse {
            success: false,
            message: "Hiçbir dosya seçilmedi".to_string(),
            output_path: None,
        };
    }
    
    let res = if req.source_paths.len() > 1 {
        create_zip_from_files(&req.source_paths, &req.output_zip_path)
    } else {
        create_zip_impl(&req.source_paths[0], &req.output_zip_path)
    };

    match res {
        Ok(message) => {
            let out_zip = if req.output_zip_path.trim().is_empty() {
                let src = PathBuf::from(&req.source_paths[0]);
                let mut auto_path = src.clone();
                auto_path.set_extension("zip");
                auto_path
            } else {
                PathBuf::from(&req.output_zip_path)
            };
            let _ = reveal_in_finder(&out_zip);
            let out_zip_str = out_zip.to_string_lossy().to_string();
            ApiResponse {
                success: true,
                message,
                output_path: Some(out_zip_str),
            }
        },
        Err(e) => ApiResponse {
            success: false,
            message: format!("ZIP hatası: {}", e),
            output_path: None,
        },
    }
}

#[tauri::command]
fn unzip_file(req: UnzipRequest) -> ApiResponse {
    match unzip_impl(&req.zip_path, &req.output_dir) {
        Ok((message, out_path)) => ApiResponse {
            success: true,
            message,
            output_path: Some(out_path.to_string_lossy().to_string()),
        },
        Err(e) => ApiResponse {
            success: false,
            message: format!("Açma hatası: {}", e),
            output_path: None,
        },
    }
}

#[tauri::command]
fn lock_file(req: LockRequest) -> ApiResponse {
    match lock_file_impl(&req.input_paths, &req.output_path, &req.passphrase) {
        Ok((message, out_path)) => ApiResponse {
            success: true,
            message,
            output_path: Some(out_path),
        },
        Err(e) => ApiResponse {
            success: false,
            message: format!("Kilitleme hatası: {}", e),
            output_path: None,
        },
    }
}

#[tauri::command]
fn unlock_file(req: UnlockRequest) -> ApiResponse {
    match unlock_file_impl(&req.input_path, &req.output_path, &req.passphrase) {
        Ok((message, out_path)) => ApiResponse {
            success: true,
            message,
            output_path: Some(out_path),
        },
        Err(e) => ApiResponse {
            success: false,
            message: format!("Kilit açma hatası: {}", e),
            output_path: None,
        },
    }
}

#[tauri::command]
fn generate_seed_phrase() -> ApiResponse {
    let mut entropy = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut entropy);
    match Mnemonic::from_entropy_in(Language::English, &entropy) {
        Ok(m) => {
            let phrase = m.to_string();
            let _ = save_seed(&phrase);
            ApiResponse {
                success: true,
                message: phrase,
                output_path: None,
            }
        }
        Err(e) => ApiResponse {
            success: false,
            message: format!("Seed üretim hatası: {}", e),
            output_path: None,
        },
    }
}

#[tauri::command]
fn verify_seed_phrase(req: SeedVerifyRequest) -> ApiResponse {
    match Mnemonic::parse_in_normalized(Language::English, &req.phrase) {
        Ok(m) => {
            let _ = save_seed(&req.phrase);
            let bytes = m.to_entropy();
            ApiResponse {
                success: true,
                message: format!("Seed geçerli ({} byte entropy) ve uygulamaya kaydedildi", bytes.len()),
                output_path: None,
            }
        }
        Err(e) => ApiResponse {
            success: false,
            message: format!("Geçersiz seed: {}", e),
            output_path: None,
        },
    }
}

#[tauri::command]
fn biometric_status() -> BiometricStatus {
    let platform = std::env::consts::OS.to_string();
    if platform == "macos" {
        BiometricStatus {
            platform,
            supported: true,
            method: "Touch ID".to_string(),
            note: "v1: mock doğrulama. v2: native LocalAuthentication entegrasyonu".to_string(),
        }
    } else if platform == "windows" {
        BiometricStatus {
            platform,
            supported: true,
            method: "Windows Hello".to_string(),
            note: "v1: mock doğrulama. v2: native Windows Biometric Framework entegrasyonu"
                .to_string(),
        }
    } else {
        BiometricStatus {
            platform,
            supported: false,
            method: "N/A".to_string(),
            note: "Bu platformda biyometrik desteği hedeflenmiyor".to_string(),
        }
    }
}

fn run_biometric_auth() -> Result<bool> {
    let mut bio_auth_bin = PathBuf::from("bio_auth");
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            // Check macOS Bundle Contents/Resources folder
            if let Some(contents) = parent.parent() {
                let res_bin = contents.join("Resources").join("bio_auth");
                if res_bin.exists() {
                    bio_auth_bin = res_bin;
                }
            }
            
            // Fallback to same folder as exe (Windows/Dev)
            let target_bin = parent.join("bio_auth");
            if target_bin.exists() && bio_auth_bin == PathBuf::from("bio_auth") {
                bio_auth_bin = target_bin;
            }
        }
    }
    
    // Fallback to current working directory or src-tauri if not found yet
    if bio_auth_bin == PathBuf::from("bio_auth") {
        if let Ok(cwd) = std::env::current_dir() {
            let local_bin = cwd.join("bio_auth");
            if local_bin.exists() {
                bio_auth_bin = local_bin;
            } else {
                let src_bin = cwd.join("src-tauri").join("bio_auth");
                if src_bin.exists() {
                    bio_auth_bin = src_bin;
                }
            }
        }
    }
    
    let status = std::process::Command::new(&bio_auth_bin)
        .status()?;
    Ok(status.success())
}

#[tauri::command]
fn biometric_mock_auth() -> ApiResponse {
    #[cfg(target_os = "macos")]
    {
        match run_biometric_auth() {
            Ok(true) => ApiResponse {
                success: true,
                message: "Touch ID doğrulaması başarılı".to_string(),
                output_path: None,
            },
            _ => ApiResponse {
                success: false,
                message: "Touch ID doğrulaması başarısız veya iptal edildi".to_string(),
                output_path: None,
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        ApiResponse {
            success: true,
            message: "Bu platformda Touch ID simüle edildi".to_string(),
            output_path: None,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            create_zip,
            unzip_file,
            lock_file,
            unlock_file,
            generate_seed_phrase,
            verify_seed_phrase,
            biometric_status,
            biometric_mock_auth,
            get_cli_arg
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub fn unzip_headless(zip_path: &str) -> Result<String> {
    unzip_impl(zip_path, "").map(|(msg, _)| msg)
}

pub fn zip_headless(source_path: &str) -> Result<String> {
    create_zip_impl(source_path, "")
}

pub fn unlock_headless(input_path: &str) -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        match run_biometric_auth() {
            Ok(true) => {},
            _ => return Err(anyhow!("Biyometrik doğrulama başarısız veya iptal edildi")),
        }
    }
    unlock_file_impl(input_path, "", "__TOUCH_ID_SEED__").map(|(msg, _)| msg)
}

#[tauri::command]
fn get_cli_arg() -> Option<String> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.len() > 1 {
        let target = &args[1];
        let target_str = target.to_string_lossy().to_string();
        if !target_str.starts_with('-') && Path::new(&target_str).exists() {
            return Some(target_str);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_create_zip_and_unzip() {
        let temp_dir = std::env::temp_dir().join("zip_test_dir");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        let file_path = temp_dir.join("test.txt");
        fs::write(&file_path, b"hello zip").unwrap();

        // 1. Test zipping
        let zip_res = create_zip_impl(&file_path.to_string_lossy(), "").unwrap();
        println!("Zip Result: {}", zip_res);

        let expected_zip = temp_dir.join("test.zip");
        assert!(expected_zip.exists(), "Zip file was not created!");

        // Remove original file before unzipping
        fs::remove_file(&file_path).unwrap();

        // 2. Test unzipping
        println!("Expected Zip Exists: {}", expected_zip.exists());
        let res = unzip_impl(&expected_zip.to_string_lossy(), "");
        if let Err(ref e) = res {
            println!("Unzip Error: {:?}", e);
        }
        let unzip_res = res.unwrap().0;
        println!("Unzip Result: {}", unzip_res);
        
        let extracted_file = temp_dir.join("test").join("test.txt");
        assert!(extracted_file.exists(), "Extracted file does not exist!");
        
        let content = fs::read_to_string(&extracted_file).unwrap();
        assert_eq!(content, "hello zip");

        // Clean up
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_lock_and_unlock_file_and_folder() {
        let temp_dir = std::env::temp_dir().join("lock_test_dir");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        // 1. Test Single File Locking & Unlocking
        let file_path = temp_dir.join("secret.txt");
        fs::write(&file_path, b"super secret content").unwrap();

        let lock_res = lock_file_impl(&file_path.to_string_lossy(), "", "password123").unwrap().0;
        println!("Lock File Result: {}", lock_res);

        let locked_file = temp_dir.join("secret.txt.zzl");
        assert!(locked_file.exists(), "Locked file was not created!");

        // Verify original file was deleted after locking
        assert!(!file_path.exists(), "Original file was not deleted!");

        let unlock_res = unlock_file_impl(&locked_file.to_string_lossy(), "", "password123").unwrap().0;
        println!("Unlock File Result: {}", unlock_res);

        assert!(file_path.exists(), "Unlocked file was not created!");
        let content = fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "super secret content");

        // 2. Test Folder Locking & Unlocking
        let folder_path = temp_dir.join("secret_folder");
        fs::create_dir_all(&folder_path).unwrap();
        let sub_file = folder_path.join("inner.txt");
        fs::write(&sub_file, b"inside folder content").unwrap();

        let folder_lock_res = lock_file_impl(&folder_path.to_string_lossy(), "", "password123").unwrap().0;
        println!("Lock Folder Result: {}", folder_lock_res);

        let locked_folder = temp_dir.join("secret_folder.zzl");
        assert!(locked_folder.exists(), "Locked folder file was not created!");

        // Verify original folder was deleted after locking
        assert!(!folder_path.exists(), "Original folder was not deleted!");

        let folder_unlock_res = unlock_file_impl(&locked_folder.to_string_lossy(), "", "password123").unwrap().0;
        println!("Unlock Folder Result: {}", folder_unlock_res);

        assert!(folder_path.exists(), "Unlocked folder was not created!");
        assert!(sub_file.exists(), "Unlocked sub-file does not exist!");
        let sub_content = fs::read_to_string(&sub_file).unwrap();
        assert_eq!(sub_content, "inside folder content");

        // Clean up
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
