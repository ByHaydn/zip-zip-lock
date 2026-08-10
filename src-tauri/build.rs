fn main() {
    #[cfg(target_os = "macos")]
    {
        // Compile Swift helper during cargo build
        let out_dir = std::env::var("OUT_DIR").unwrap();
        let target_dir = std::path::Path::new(&out_dir)
            .parent().unwrap()
            .parent().unwrap()
            .parent().unwrap();
        
        let _ = std::process::Command::new("swiftc")
            .arg("-O")
            .arg("src/bio_auth.swift")
            .arg("-o")
            .arg(target_dir.join("bio_auth"))
            .status();

        // Also compile to the source directory for local running/shortcuts
        let _ = std::process::Command::new("swiftc")
            .arg("-O")
            .arg("src/bio_auth.swift")
            .arg("-o")
            .arg("bio_auth")
            .status();
    }
    tauri_build::build()
}
