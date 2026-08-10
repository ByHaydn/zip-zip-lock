// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    // Write debug log
    if let Some(home) = std::env::var_os("HOME") {
        let log_path = std::path::PathBuf::from(home).join("Desktop").join("zip_zip_loop_debug.log");
        let _ = std::fs::write(&log_path, format!("Args: {:?}\n", args));
    }

    if args.len() > 1 {
        let target = &args[1];
        let target_str = target.to_string_lossy().to_string();
        if !target_str.starts_with('-') {
            let path = std::path::Path::new(target);
            if path.exists() {
                let mut processed = false;
                if let Some(ext) = path.extension() {
                    let ext_str = ext.to_string_lossy().to_lowercase();
                    if ext_str == "zip" {
                        let _ = zip_zip_loop_lib::unzip_headless(&target_str);
                        std::thread::sleep(std::time::Duration::from_millis(600));
                        std::process::exit(0);
                    } else if ext_str == "zzl" {
                        if let Ok(_) = zip_zip_loop_lib::unlock_headless(&target_str) {
                            std::thread::sleep(std::time::Duration::from_millis(600));
                            std::process::exit(0);
                        }
                        processed = true;
                    }
                }
                
                if !processed {
                    let _ = zip_zip_loop_lib::zip_headless(&target_str);
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    std::process::exit(0);
                }
            }
        }
    }

    zip_zip_loop_lib::run()
}
