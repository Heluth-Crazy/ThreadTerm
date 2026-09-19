use anyhow::{bail, Context, Result};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
    pub credential_path: PathBuf,
    pub pipe_base: String,
}

impl RuntimeConfig {
    pub fn load() -> Result<Self> {
        let data_dir = match env::var_os("THREADTERM_V3_DATA") {
            Some(path) => PathBuf::from(path),
            None => default_data_dir()?,
        };
        fs::create_dir_all(&data_dir).context("creating V3 data directory")?;
        let user_hash = user_hash()?;
        let pipe_base = env::var("THREADTERM_V3_PIPE")
            .unwrap_or_else(|_| format!(r"\\.\pipe\threadterm-v3-{user_hash}"));
        if !pipe_base.starts_with(r"\\.\pipe\") {
            bail!("THREADTERM_V3_PIPE must be a Windows named-pipe path");
        }
        Ok(Self {
            database_path: data_dir.join("threadterm-v3.sqlite3"),
            credential_path: data_dir.join("runtime.credential"),
            data_dir,
            pipe_base,
        })
    }

    pub fn credential(&self) -> Result<String> {
        if self.credential_path.exists() {
            return Ok(fs::read_to_string(&self.credential_path)
                .context("reading runtime credential")?
                .trim()
                .to_owned());
        }
        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let value = hex::encode(bytes);
        // create_new protects the singleton bootstrap secret against a second
        // simultaneously-starting daemon. The loser reads the winner's value.
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.credential_path)
        {
            Ok(mut file) => {
                file.write_all(value.as_bytes())
                    .context("writing runtime credential")?;
                file.sync_all()?;
                #[cfg(windows)]
                crate::windows_security::restrict_file_to_current_user(&self.credential_path)?;
                Ok(value)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                fs::read_to_string(&self.credential_path)
                    .map(|v| v.trim().to_owned())
                    .context("reading concurrently created runtime credential")
            }
            Err(error) => Err(error).context("creating runtime credential"),
        }
    }

    pub fn control_pipe(&self) -> String {
        format!("{}-control", self.pipe_base)
    }
    pub fn output_pipe(&self) -> String {
        format!("{}-output", self.pipe_base)
    }
}

fn default_data_dir() -> Result<PathBuf> {
    let app_data = env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("APPDATA"))
        .context("LOCALAPPDATA or APPDATA is required for V3 runtime data")?;
    Ok(PathBuf::from(app_data).join("ThreadTermV3"))
}

fn user_hash() -> Result<String> {
    #[cfg(windows)]
    let user = crate::windows_security::current_sid()?;
    #[cfg(not(windows))]
    let user = env::var("USER").unwrap_or_else(|_| "unknown".to_owned());
    let digest = Sha256::digest(user.as_bytes());
    Ok(hex::encode(digest)[..16].to_owned())
}
