//! Read-only CC Switch import. Never log source settings or parser diagnostics.
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub source_id: String,
    pub app_type: String,
    pub name: String,
    pub current: bool,
    pub provider_kind: String,
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    pub issue: Option<String>,
    pub warning: Option<String>,
}

fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned()
}

pub fn parse_provider(
    id: String,
    app: String,
    name: String,
    current: bool,
    settings: &str,
) -> Candidate {
    let mut c = Candidate {
        source_id: id,
        app_type: app,
        name,
        current,
        provider_kind: String::new(),
        base_url: String::new(),
        api_key: String::new(),
        models: vec![],
        issue: None,
        warning: None,
    };
    let Ok(v) = serde_json::from_str::<Value>(settings) else {
        c.issue = Some("invalid_config".into());
        return c;
    };
    let env = &v["env"];
    match c.app_type.as_str() {
        "claude" => {
            c.provider_kind = "anthropic".into();
            c.base_url = text(env, "ANTHROPIC_BASE_URL");
            if c.base_url.is_empty() {
                c.base_url = "https://api.anthropic.com".into();
            }
            c.api_key = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
                .iter()
                .map(|key| text(env, key))
                .find(|s| !s.is_empty())
                .unwrap_or_default();
            for key in [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            ] {
                let model = text(env, key);
                if !model.is_empty() && !c.models.contains(&model) {
                    c.models.push(model);
                }
            }
        }
        "gemini" => {
            c.provider_kind = "gemini".into();
            c.base_url = text(env, "GOOGLE_GEMINI_BASE_URL");
            if c.base_url.is_empty() {
                c.base_url = "https://generativelanguage.googleapis.com".into();
            }
            c.api_key = ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
                .iter()
                .map(|key| text(env, key))
                .find(|s| !s.is_empty())
                .unwrap_or_default();
            let model = text(env, "GEMINI_MODEL");
            if !model.is_empty() {
                c.models.push(model);
            }
        }
        "codex" => {
            c.provider_kind = "openai-compatible".into();
            c.api_key = text(&v["auth"], "OPENAI_API_KEY");
            let Ok(config) = toml::from_str::<toml::Value>(&text(&v, "config")) else {
                c.issue = Some("invalid_config".into());
                return c;
            };
            let provider = config
                .get("model_provider")
                .and_then(toml::Value::as_str)
                .unwrap_or("openai");
            let definition = config.get("model_providers").and_then(|p| p.get(provider));
            c.base_url = definition
                .and_then(|p| p.get("base_url"))
                .and_then(toml::Value::as_str)
                .unwrap_or("")
                .to_owned();
            if provider == "openai" && c.base_url.is_empty() {
                c.base_url = "https://api.openai.com/v1".into();
            }
            let wire = definition
                .and_then(|p| p.get("wire_api"))
                .and_then(toml::Value::as_str)
                .unwrap_or("responses");
            if wire == "responses" {
                c.warning = Some("responses_as_chat".into());
            } else if wire != "chat" {
                c.issue = Some("unsupported_protocol".into());
            }
            if let Some(model) = config.get("model").and_then(toml::Value::as_str) {
                c.models.push(model.to_owned());
            }
        }
        _ => c.issue = Some("unsupported_app".into()),
    }
    if c.issue.is_none() && c.api_key.is_empty() {
        c.issue = Some("missing_key".into());
    }
    if c.issue.is_none() {
        match url::Url::parse(&c.base_url) {
            Ok(u)
                if matches!(u.scheme(), "http" | "https")
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.query().is_none()
                    && u.fragment().is_none() => {}
            _ => c.issue = Some("invalid_endpoint".into()),
        }
    }
    c
}

pub fn read_database(path: &Path) -> Result<Vec<Candidate>, String> {
    let metadata = std::fs::metadata(path).map_err(|_| "CC_SWITCH_NOT_FOUND")?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Err("CC_SWITCH_FILE_TOO_LARGE".into());
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "CC_SWITCH_DATABASE_UNAVAILABLE")?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "CC_SWITCH_DATABASE_UNAVAILABLE")?;
    // Do not use immutable mode: it would ignore active WAL data.
    let mut stmt = conn
        .prepare("SELECT id, app_type, name, is_current, settings_config FROM providers LIMIT 201")
        .map_err(|_| "CC_SWITCH_UNSUPPORTED_SCHEMA")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|_| "CC_SWITCH_READ_FAILED")?;
    let mut result = vec![];
    for row in rows {
        let (id, app, name, current, settings) = row.map_err(|_| "CC_SWITCH_READ_FAILED")?;
        if settings.len() > 1024 * 1024 {
            return Err("CC_SWITCH_CONFIG_TOO_LARGE".into());
        }
        result.push(parse_provider(id, app, name, current, &settings));
    }
    if result.len() > 200 {
        return Err("CC_SWITCH_TOO_MANY_PROVIDERS".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(app: &str, config: Value) -> Candidate {
        parse_provider(
            "id".into(),
            app.into(),
            "test".into(),
            true,
            &config.to_string(),
        )
    }
    #[test]
    fn maps_claude_and_gemini_without_guessing_models() {
        let c = parse(
            "claude",
            serde_json::json!({"env":{"ANTHROPIC_AUTH_TOKEN":"test-key","ANTHROPIC_MODEL":"model-a","ANTHROPIC_DEFAULT_SONNET_MODEL":"model-a"}}),
        );
        assert_eq!(c.models, vec!["model-a"]);
        assert_eq!(c.provider_kind, "anthropic");
        assert!(c.issue.is_none());
        let c = parse(
            "gemini",
            serde_json::json!({"env":{"GOOGLE_API_KEY":"test-key"}}),
        );
        assert!(c.models.is_empty());
        assert_eq!(c.provider_kind, "gemini");
    }
    #[test]
    fn codex_protocol_and_parser_errors_are_explicit_and_redacted() {
        let c = parse(
            "codex",
            serde_json::json!({"auth":{"OPENAI_API_KEY":"test-key"},"config":"model = 'm'\nmodel_provider = 'p'\n[model_providers.p]\nbase_url = 'https://example.com/v1'\nwire_api = 'chat'"}),
        );
        assert!(c.issue.is_none());
        assert_eq!(c.models, vec!["m"]);
        let c = parse(
            "codex",
            serde_json::json!({"auth":{"OPENAI_API_KEY":"test-key"},"config":"model = 'm'\nmodel_provider = 'p'\n[model_providers.p]\nbase_url = 'https://example.com/v1'\nwire_api = 'responses'"}),
        );
        assert!(c.issue.is_none());
        assert_eq!(c.warning.as_deref(), Some("responses_as_chat"));
        assert_eq!(c.base_url, "https://example.com/v1");
        let c = parse(
            "codex",
            serde_json::json!({"auth":{"OPENAI_API_KEY":"secret"},"config":"model='m'"}),
        );
        assert!(c.issue.is_none());
        assert_eq!(c.warning.as_deref(), Some("responses_as_chat"));
        let c = parse("codex", serde_json::json!({"config":"secret invalid toml"}));
        assert_eq!(c.issue.as_deref(), Some("invalid_config"));
    }
    #[test]
    fn reads_live_wal_and_never_updates_provider_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cc-switch.db");
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE providers(id TEXT, app_type TEXT, name TEXT, is_current INTEGER, settings_config TEXT);").unwrap();
        writer
            .execute(
                "INSERT INTO providers VALUES ('id','claude','Name',1,?1)",
                ["{\"env\":{\"ANTHROPIC_API_KEY\":\"test-key\"}}"],
            )
            .unwrap();
        assert_eq!(read_database(&path).unwrap().len(), 1);
        assert_eq!(
            writer
                .query_row("SELECT COUNT(*) FROM providers", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
