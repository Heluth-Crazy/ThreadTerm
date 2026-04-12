use crate::db;
use anyhow::Result;
use chrono::Utc;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

/// JWT claims embedded in every token.
#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: i64,       // user id
    username: String,
    exp: usize,     // expiration (unix timestamp)
    iat: usize,     // issued at
}

/// Response returned on successful login/register.
#[derive(Debug, Serialize, Clone)]
pub struct LoginResponse {
    pub token: String,
    pub user: UserInfo,
}

/// Public user information.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserInfo {
    pub id: i64,
    pub username: String,
    pub created_at: Option<String>,
    pub has_completed_onboarding: bool,
}

/// Token lifetime: 7 days.
const TOKEN_EXPIRY_SECS: i64 = 7 * 24 * 60 * 60;

/// Retrieve (or generate on first run) the JWT secret from the settings table.
fn jwt_secret() -> Result<String, String> {
    match db::get_setting("jwt_secret").map_err(|e| format!("DB error: {e}"))? {
        Some(secret) => Ok(secret),
        None => {
            let secret = uuid::Uuid::new_v4().to_string();
            db::set_setting("jwt_secret", &secret)
                .map_err(|e| format!("Failed to persist JWT secret: {e}"))?;
            Ok(secret)
        }
    }
}

/// Generate a JWT for the given user.
fn generate_token(user_id: i64, username: &str) -> Result<String, String> {
    let now = Utc::now().timestamp() as usize;
    let claims = Claims {
        sub: user_id,
        username: username.to_string(),
        exp: now + TOKEN_EXPIRY_SECS as usize,
        iat: now,
    };
    let secret = jwt_secret()?;
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("Failed to generate token: {e}"))
}

/// Verify a JWT and return its claims.
fn verify_token(token: &str) -> Result<Claims, String> {
    let secret = jwt_secret()?;
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|e| format!("Invalid token: {e}"))?;
    Ok(data.claims)
}

/// Persist a token into the sessions table.
fn insert_session(token: &str, user_id: i64) -> Result<(), String> {
    let conn = db::get_db()?;
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, datetime('now', '+7 days'))",
        rusqlite::params![token, user_id],
    )
    .map_err(|e| format!("Failed to insert session: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn auth_login(username: String, password: String) -> Result<LoginResponse, String> {
    let conn = db::get_db()?;

    let row = conn
        .query_row(
            "SELECT id, username, password_hash, has_completed_onboarding, created_at
             FROM users WHERE username = ?1 AND is_active = 1",
            [&username],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3).unwrap_or(false),
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .map_err(|_| "Invalid username or password".to_string())?;

    let (id, uname, hash, onboarded, created_at) = row;

    let valid = bcrypt::verify(&password, &hash)
        .map_err(|e| format!("Password verification error: {e}"))?;

    if !valid {
        return Err("Invalid username or password".to_string());
    }

    // Update last_login (non-fatal)
    let _ = conn.execute(
        "UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?1",
        [id],
    );

    let token = generate_token(id, &uname)?;
    insert_session(&token, id)?;

    Ok(LoginResponse {
        token,
        user: UserInfo {
            id,
            username: uname,
            created_at,
            has_completed_onboarding: onboarded,
        },
    })
}

#[tauri::command]
pub async fn auth_register(username: String, password: String) -> Result<LoginResponse, String> {
    if password.trim().is_empty() {
        return Err("Password cannot be empty".into());
    }
    if password.len() < 6 {
        return Err("Password must be at least 6 characters".into());
    }

    let hash =
        bcrypt::hash(&password, bcrypt::DEFAULT_COST).map_err(|e| format!("Hash error: {e}"))?;

    let conn = db::get_db()?;
    conn.execute(
        "INSERT INTO users (username, password_hash) VALUES (?1, ?2)",
        rusqlite::params![&username, &hash],
    )
    .map_err(|e| format!("Registration failed (username may already exist): {e}"))?;

    let id = conn.last_insert_rowid();
    let token = generate_token(id, &username)?;
    insert_session(&token, id)?;

    Ok(LoginResponse {
        token,
        user: UserInfo {
            id,
            username,
            created_at: Some(Utc::now().to_rfc3339()),
            has_completed_onboarding: false,
        },
    })
}

#[tauri::command]
pub async fn auth_verify(token: String) -> Result<UserInfo, String> {
    let claims = verify_token(&token)?;

    let conn = db::get_db()?;

    // Verify session exists and is not expired
    let session_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE token = ?1 AND expires_at > CURRENT_TIMESTAMP",
            [&token],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);

    if !session_exists {
        return Err("Session expired or logged out".to_string());
    }

    let user = conn
        .query_row(
            "SELECT id, username, created_at, has_completed_onboarding
             FROM users WHERE id = ?1 AND is_active = 1",
            [claims.sub],
            |row| {
                Ok(UserInfo {
                    id: row.get(0)?,
                    username: row.get(1)?,
                    created_at: row.get(2)?,
                    has_completed_onboarding: row.get::<_, bool>(3).unwrap_or(false),
                })
            },
        )
        .map_err(|_| "User not found".to_string())?;

    Ok(user)
}

#[tauri::command]
pub async fn auth_logout(token: String) -> Result<(), String> {
    let conn = db::get_db()?;
    conn.execute("DELETE FROM sessions WHERE token = ?1", [&token])
        .map_err(|e| format!("Logout failed: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
pub struct CliAuthStatus {
    pub authenticated: bool,
    pub email: Option<String>,
    pub provider: String,
}

#[tauri::command]
pub async fn get_cli_auth_status(provider: String) -> Result<CliAuthStatus, String> {
    match provider.as_str() {
        "claude" => {
            let home = dirs::home_dir().ok_or("no home dir")?;
            let auth_path = home.join(".claude").join("auth.json");
            let creds_path = home.join(".claude").join(".credentials.json");

            for p in [&auth_path, &creds_path] {
                if p.exists() {
                    if let Ok(content) = std::fs::read_to_string(p) {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                            let email = json["email"].as_str()
                                .or_else(|| json["account"]["emailAddress"].as_str())
                                .map(String::from);
                            let has_token = json["oauthToken"].is_object()
                                || json["access_token"].is_string()
                                || json["token"].is_string();
                            if has_token || email.is_some() {
                                return Ok(CliAuthStatus {
                                    authenticated: true,
                                    email,
                                    provider,
                                });
                            }
                        }
                    }
                }
            }
            Ok(CliAuthStatus { authenticated: false, email: None, provider })
        }
        "codex" => {
            let home = dirs::home_dir().ok_or("no home dir")?;
            let auth_path = home.join(".codex").join("auth.json");
            if auth_path.exists() {
                if let Ok(content) = std::fs::read_to_string(&auth_path) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        let email = json["email"].as_str().map(String::from);
                        let has_token = json["token"].is_string()
                            || json["access_token"].is_string()
                            || json["api_key"].is_string();
                        if has_token || email.is_some() {
                            return Ok(CliAuthStatus {
                                authenticated: true,
                                email,
                                provider,
                            });
                        }
                    }
                }
            }
            Ok(CliAuthStatus { authenticated: false, email: None, provider })
        }
        _ => Ok(CliAuthStatus { authenticated: false, email: None, provider }),
    }
}
