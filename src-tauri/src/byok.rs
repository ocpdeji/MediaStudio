//! Bring-your-own-key AI and stock media. Keys live in Windows Credential Manager (never in files, never sent
//! to the UI). All network calls happen here; downloads are restricted to https and known provider hosts.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const SERVICE: &str = "MediaStudioPro";

#[derive(Serialize, Clone)]
pub struct Provider {
    pub id: &'static str, pub name: &'static str, pub caps: &'static [&'static str], pub base: &'static str, pub model: &'static str,
    pub image_model: &'static str, pub video_model: &'static str, pub tts_model: &'static str, pub needs_key: bool, pub key_url: &'static str, pub note: &'static str,
}

macro_rules! p { ($id:literal, $name:literal, [$($c:literal),*], $base:literal, $model:literal, $im:literal, $vm:literal, $tm:literal, $nk:literal, $url:literal, $note:literal) => {
    Provider { id: $id, name: $name, caps: &[$($c),*], base: $base, model: $model, image_model: $im, video_model: $vm, tts_model: $tm, needs_key: $nk, key_url: $url, note: $note }
} }

pub static PROVIDERS: &[Provider] = &[
    p!("openai", "OpenAI", ["chat", "image", "video", "tts"], "https://api.openai.com/v1", "gpt-4o-mini", "gpt-image-1", "sora-2", "gpt-4o-mini-tts", true, "https://platform.openai.com/api-keys", "Chat, GPT-Image, Sora video, natural voices"),
    p!("anthropic", "Anthropic Claude", ["chat"], "https://api.anthropic.com/v1", "claude-sonnet-5-5", "", "", "", true, "https://console.anthropic.com/settings/keys", "Scripts, captions translation, titles"),
    p!("gemini", "Google Gemini", ["chat", "image", "video"], "https://generativelanguage.googleapis.com/v1beta", "gemini-2.5-flash", "imagen-4.0-generate-001", "veo-3.0-fast-generate-001", "", true, "https://aistudio.google.com/apikey", "Free tier available. Imagen images, Veo video"),
    p!("openrouter", "OpenRouter", ["chat"], "https://openrouter.ai/api/v1", "openai/gpt-4o-mini", "", "", "", true, "https://openrouter.ai/keys", "Hundreds of models (several free) with one key"),
    p!("groq", "Groq", ["chat"], "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", "", "", "", true, "https://console.groq.com/keys", "Very fast, generous free tier"),
    p!("deepseek", "DeepSeek", ["chat"], "https://api.deepseek.com/v1", "deepseek-chat", "", "", "", true, "https://platform.deepseek.com/api_keys", ""),
    p!("mistral", "Mistral", ["chat"], "https://api.mistral.ai/v1", "mistral-small-latest", "", "", "", true, "https://console.mistral.ai/api-keys", ""),
    p!("xai", "xAI Grok", ["chat"], "https://api.x.ai/v1", "grok-3-mini", "", "", "", true, "https://console.x.ai", ""),
    p!("together", "Together AI", ["chat"], "https://api.together.xyz/v1", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "", "", "", true, "https://api.together.ai/settings/api-keys", ""),
    p!("ollama", "Ollama (local, free)", ["chat"], "http://localhost:11434/v1", "llama3.2", "", "", "", false, "https://ollama.com/download", "Runs models on this PC — no key, no cost"),
    p!("lmstudio", "LM Studio (local, free)", ["chat"], "http://localhost:1234/v1", "local-model", "", "", "", false, "https://lmstudio.ai", "Runs models on this PC — no key, no cost"),
    p!("custom", "Custom (OpenAI-compatible)", ["chat"], "", "", "", "", "", true, "", "Any OpenAI-compatible endpoint"),
    p!("elevenlabs", "ElevenLabs", ["tts"], "https://api.elevenlabs.io/v1", "eleven_multilingual_v2", "", "", "21m00Tcm4TlvDq8ikWAM", true, "https://elevenlabs.io/app/settings/api-keys", "Studio-quality voices (voice id in Model)"),
    p!("replicate", "Replicate", ["image", "video"], "https://api.replicate.com/v1", "", "black-forest-labs/flux-schnell", "kwaivgi/kling-v2.1", "", true, "https://replicate.com/account/api-tokens", "Kling, Flux, Wan, lip-sync and thousands more"),
    p!("fal", "fal.ai", ["image", "video"], "https://queue.fal.run", "", "fal-ai/flux/schnell", "fal-ai/kling-video/v2.1/standard/text-to-video", "", true, "https://fal.ai/dashboard/keys", "Kling, Flux, Veo and more"),
    p!("pexels", "Pexels", ["stock"], "https://api.pexels.com", "", "", "", "", true, "https://www.pexels.com/api/new/", "Free stock videos & photos"),
    p!("pixabay", "Pixabay", ["stock"], "https://pixabay.com/api", "", "", "", "", true, "https://pixabay.com/api/docs/", "Free stock videos & photos"),
    p!("freesound", "Freesound", ["sfx"], "https://freesound.org/apiv2", "", "", "", "", true, "https://freesound.org/apiv2/apply/", "Free sound effects (CC0 / CC BY)"),
    p!("jamendo", "Jamendo Music", ["music"], "https://api.jamendo.com/v3.0", "", "", "", "", true, "https://devportal.jamendo.com/", "Free Creative Commons music (client id)"),
];

pub fn provider(id: &str) -> Result<&'static Provider, String> { PROVIDERS.iter().find(|p| p.id == id).ok_or_else(|| format!("Unknown provider '{id}'")) }

// ---------------------------------------------------------------- key storage

fn entry(id: &str) -> Result<keyring::Entry, String> { provider(id)?; keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string()) }
pub fn set_key(id: &str, key: &str) -> Result<(), String> {
    let k = key.trim();
    if k.is_empty() { return delete_key(id); }
    if k.len() > 4096 || k.chars().any(|c| c.is_control()) { return Err("That doesn't look like an API key".into()); }
    entry(id)?.set_password(k).map_err(|e| format!("Could not store the key in Windows Credential Manager: {e}"))
}
pub fn delete_key(id: &str) -> Result<(), String> { match entry(id)?.delete_credential() { Ok(_) | Err(keyring::Error::NoEntry) => Ok(()), Err(e) => Err(e.to_string()) } }
pub fn get_key(id: &str) -> Option<String> { entry(id).ok()?.get_password().ok().filter(|k| !k.is_empty()) }
pub fn has_key(id: &str) -> bool { get_key(id).is_some() }

/// Non-secret per-provider settings (endpoint and model overrides).
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Cfg { pub base: String, pub model: String, pub image_model: String, pub video_model: String, pub tts_model: String }

pub struct Conn { pub p: &'static Provider, pub base: String, pub model: String, pub image_model: String, pub video_model: String, pub tts_model: String, key: Option<String> }

pub fn connect(id: &str, cfg: &Cfg) -> Result<Conn, String> {
    let p = provider(id)?;
    let pick = |a: &str, b: &str| if a.trim().is_empty() { b.to_string() } else { a.trim().to_string() };
    let base = pick(&cfg.base, p.base).trim_end_matches('/').to_string();
    if base.is_empty() { return Err(format!("Set an endpoint URL for {} in Settings → AI keys", p.name)); }
    let local = base.starts_with("http://localhost") || base.starts_with("http://127.0.0.1");
    if !base.starts_with("https://") && !local { return Err("Endpoints must use https (or be on localhost)".into()); }
    let key = get_key(id);
    if p.needs_key && key.is_none() { return Err(format!("Add your {} API key in Settings → AI keys (get one at {}).", p.name, p.key_url)); }
    Ok(Conn { p, base, model: pick(&cfg.model, p.model), image_model: pick(&cfg.image_model, p.image_model), video_model: pick(&cfg.video_model, p.video_model), tts_model: pick(&cfg.tts_model, p.tts_model), key })
}

fn agent(timeout_s: u64) -> ureq::Agent { ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(20)).timeout_read(std::time::Duration::from_secs(timeout_s)).user_agent("MediaStudioPro/0.2").build() }

fn err_of(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, r) => {
            let body = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&body).ok().and_then(|j| j["error"]["message"].as_str().or(j["error"].as_str()).or(j["detail"].as_str()).or(j["message"].as_str()).map(String::from)).unwrap_or_else(|| body.chars().take(300).collect());
            match code { 401 | 403 => format!("The provider rejected the API key ({code}): {msg}"), 429 => format!("Rate limit or quota reached (429): {msg}"), _ => format!("Provider error {code}: {msg}") }
        }
        ureq::Error::Transport(t) => format!("Network error: {t}"),
    }
}

impl Conn {
    fn bearer(&self, r: ureq::Request) -> ureq::Request { match &self.key { Some(k) => r.set("Authorization", &format!("Bearer {k}")), None => r } }
    fn post(&self, url: &str, body: &Value, timeout: u64) -> Result<Value, String> {
        let mut r = agent(timeout).post(url).set("Content-Type", "application/json");
        r = match self.p.id {
            "anthropic" => r.set("x-api-key", self.key.as_deref().unwrap_or("")).set("anthropic-version", "2023-06-01"),
            "gemini" => r.set("x-goog-api-key", self.key.as_deref().unwrap_or("")),
            "elevenlabs" => r.set("xi-api-key", self.key.as_deref().unwrap_or("")),
            "fal" => r.set("Authorization", &format!("Key {}", self.key.as_deref().unwrap_or(""))),
            "replicate" => self.bearer(r).set("Prefer", "wait=55"),
            _ => self.bearer(r),
        };
        r.send_json(body.clone()).map_err(err_of)?.into_json::<Value>().map_err(|e| format!("Unreadable response: {e}"))
    }
    fn get(&self, url: &str) -> Result<Value, String> {
        let mut r = agent(60).get(url);
        r = match self.p.id { "gemini" => r.set("x-goog-api-key", self.key.as_deref().unwrap_or("")), "fal" => r.set("Authorization", &format!("Key {}", self.key.as_deref().unwrap_or(""))), _ => self.bearer(r) };
        r.call().map_err(err_of)?.into_json::<Value>().map_err(|e| format!("Unreadable response: {e}"))
    }
    fn get_bytes(&self, url: &str, auth: bool) -> Result<Vec<u8>, String> {
        let mut r = agent(300).get(url);
        if auth { r = match self.p.id { "gemini" => r.set("x-goog-api-key", self.key.as_deref().unwrap_or("")), _ => self.bearer(r) }; }
        let resp = r.call().map_err(err_of)?;
        let mut b = vec![]; resp.into_reader().take(2_000_000_000).read_to_end(&mut b).map_err(|e| e.to_string())?; Ok(b)
    }
}

// ---------------------------------------------------------------- chat

pub fn chat(c: &Conn, system: &str, user: &str) -> Result<String, String> {
    if !c.p.caps.contains(&"chat") { return Err(format!("{} can't do text/chat", c.p.name)); }
    let r = match c.p.id {
        "anthropic" => {
            let j = c.post(&format!("{}/messages", c.base), &json!({"model": c.model, "max_tokens": 8192, "system": system, "messages": [{"role": "user", "content": user}]}), 180)?;
            j["content"].as_array().map(|a| a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("")).unwrap_or_default()
        }
        "gemini" => {
            let j = c.post(&format!("{}/models/{}:generateContent", c.base, c.model), &json!({"systemInstruction": {"parts": [{"text": system}]}, "contents": [{"role": "user", "parts": [{"text": user}]}]}), 180)?;
            j["candidates"][0]["content"]["parts"].as_array().map(|a| a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("")).unwrap_or_default()
        }
        _ => {
            let j = c.post(&format!("{}/chat/completions", c.base), &json!({"model": c.model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "temperature": 0.4}), 180)?;
            j["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string()
        }
    };
    if r.trim().is_empty() { return Err("The model returned an empty answer".into()); }
    Ok(r)
}

// ---------------------------------------------------------------- generation (image / video / speech)

const ALLOWED_HOSTS: &[&str] = &["replicate.delivery", "replicate.com", "fal.media", "fal.run", "fal.ai", "googleapis.com", "googleusercontent.com", "openai.com", "oaiusercontent.com", "blob.core.windows.net",
    "pexels.com", "pixabay.com", "vimeocdn.com", "vimeo.com", "freesound.org", "jamendo.com", "storage.jamendo.com", "elevenlabs.io"];

pub fn allowed_download(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").split(':').next().unwrap_or("").to_ascii_lowercase();
    !host.is_empty() && ALLOWED_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

fn b64(s: &str) -> Result<Vec<u8>, String> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut map = [255u8; 256]; for (i, c) in T.iter().enumerate() { map[*c as usize] = i as u8; } map[b'-' as usize] = 62; map[b'_' as usize] = 63;
    let mut out = Vec::with_capacity(s.len() * 3 / 4); let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes() { if c == b'=' || c.is_ascii_whitespace() { continue; } let v = map[c as usize]; if v == 255 { return Err("bad base64".into()); } acc = (acc << 6) | v as u32; bits += 6; if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); } }
    Ok(out)
}

fn first_url(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if s.starts_with("https://") => Some(s.clone()),
        Value::Array(a) => a.iter().find_map(first_url),
        Value::Object(o) => ["url", "video", "images", "image", "output", "audio", "file"].iter().find_map(|k| o.get(*k).and_then(first_url)).or_else(|| o.values().find_map(first_url)),
        _ => None,
    }
}

fn wait_poll(cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64), started: std::time::Instant, expect_s: f64) -> Result<(), String> {
    for _ in 0..20 { if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); } std::thread::sleep(std::time::Duration::from_millis(250)); }
    progress((started.elapsed().as_secs_f64() / expect_s).min(0.9));
    if started.elapsed().as_secs() > 1800 { return Err("The provider took longer than 30 minutes; check its dashboard".into()); }
    Ok(())
}

fn replicate_run(c: &Conn, model: &str, input: Value, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64), expect_s: f64) -> Result<String, String> {
    if model.is_empty() || model.contains("..") || model.chars().any(|ch| !(ch.is_ascii_alphanumeric() || "-_./:".contains(ch))) { return Err("Enter a Replicate model like owner/name".into()); }
    let url = if let Some((m, ver)) = model.split_once(':') { let _ = m; (format!("{}/predictions", c.base), Some(ver.to_string())) } else { (format!("{}/models/{model}/predictions", c.base), None) };
    let body = match url.1 { Some(v) => json!({"version": v, "input": input}), None => json!({"input": input}) };
    let mut j = c.post(&url.0, &body, 90)?;
    let started = std::time::Instant::now();
    loop {
        match j["status"].as_str().unwrap_or("") {
            "succeeded" => return first_url(&j["output"]).ok_or_else(|| "Replicate returned no file".into()),
            "failed" | "canceled" => return Err(format!("Replicate: {}", j["error"].as_str().unwrap_or("prediction failed"))),
            _ => {}
        }
        wait_poll(cancel, progress, started, expect_s)?;
        let get = j["urls"]["get"].as_str().ok_or("Replicate returned no status URL")?.to_string();
        j = c.get(&get)?;
    }
}

fn fal_run(c: &Conn, model: &str, input: Value, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64), expect_s: f64) -> Result<String, String> {
    if model.is_empty() || model.contains("..") || model.chars().any(|ch| !(ch.is_ascii_alphanumeric() || "-_./".contains(ch))) { return Err("Enter a fal model like fal-ai/flux/schnell".into()); }
    let j = c.post(&format!("{}/{model}", c.base), &input, 90)?;
    let status = j["status_url"].as_str().ok_or("fal returned no status URL")?.to_string();
    let resp = j["response_url"].as_str().ok_or("fal returned no response URL")?.to_string();
    let started = std::time::Instant::now();
    loop {
        let s = c.get(&status)?;
        match s["status"].as_str().unwrap_or("") { "COMPLETED" => break, "FAILED" | "ERROR" => return Err(format!("fal: {}", s["error"].as_str().unwrap_or("request failed"))), _ => {} }
        wait_poll(cancel, progress, started, expect_s)?;
    }
    first_url(&c.get(&resp)?).ok_or_else(|| "fal returned no file".into())
}

pub struct Generated { pub bytes: Vec<u8>, pub ext: &'static str }

fn fetch(c: &Conn, url: &str) -> Result<Vec<u8>, String> { if !allowed_download(url) { return Err(format!("Refusing to download from an unexpected host: {url}")); } c.get_bytes(url, false) }

pub fn image(c: &Conn, prompt: &str, aspect: &str, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64)) -> Result<Generated, String> {
    if !c.p.caps.contains(&"image") { return Err(format!("{} can't generate images", c.p.name)); }
    let size = match aspect { "9:16" => "1024x1536", "16:9" => "1536x1024", _ => "1024x1024" };
    let bytes = match c.p.id {
        "openai" => {
            let j = c.post(&format!("{}/images/generations", c.base), &json!({"model": c.image_model, "prompt": prompt, "size": size, "n": 1}), 240)?;
            if let Some(b) = j["data"][0]["b64_json"].as_str() { b64(b)? } else { fetch(c, j["data"][0]["url"].as_str().ok_or("No image returned")?)? }
        }
        "gemini" => {
            if c.image_model.starts_with("gemini") {
                let j = c.post(&format!("{}/models/{}:generateContent", c.base, c.image_model), &json!({"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]}}), 240)?;
                let d = j["candidates"][0]["content"]["parts"].as_array().and_then(|a| a.iter().find_map(|p| p["inlineData"]["data"].as_str().map(String::from))).ok_or("Gemini returned no image (the prompt may have been blocked)")?;
                b64(&d)?
            } else {
                let j = c.post(&format!("{}/models/{}:predict", c.base, c.image_model), &json!({"instances": [{"prompt": prompt}], "parameters": {"sampleCount": 1, "aspectRatio": if aspect.is_empty() { "1:1" } else { aspect }}}), 240)?;
                b64(j["predictions"][0]["bytesBase64Encoded"].as_str().ok_or("Imagen returned no image (the prompt may have been blocked)")?)?
            }
        }
        "replicate" => { let u = replicate_run(c, &c.image_model, json!({"prompt": prompt, "aspect_ratio": if aspect.is_empty() { "1:1" } else { aspect }}), cancel, progress, 20.0)?; fetch(c, &u)? }
        "fal" => { let u = fal_run(c, &c.image_model, json!({"prompt": prompt, "image_size": match aspect { "9:16" => "portrait_16_9", "16:9" => "landscape_16_9", _ => "square_hd" }}), cancel, progress, 20.0)?; fetch(c, &u)? }
        _ => return Err("Unsupported provider".into()),
    };
    let ext = if bytes.starts_with(&[0x89, b'P']) { "png" } else if bytes.starts_with(&[0xFF, 0xD8]) { "jpg" } else if bytes.len() > 12 && &bytes[8..12] == b"WEBP" { "webp" } else { return Err("The provider returned something that isn't an image".into()) };
    Ok(Generated { bytes, ext })
}

pub fn video(c: &Conn, prompt: &str, aspect: &str, seconds: u32, image: Option<&Path>, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64)) -> Result<Generated, String> {
    if !c.p.caps.contains(&"video") { return Err(format!("{} can't generate video", c.p.name)); }
    let started = std::time::Instant::now();
    let img_uri = match image { Some(p) => { let b = std::fs::read(p).map_err(|e| e.to_string())?; if b.len() > 20_000_000 { return Err("The reference image is too large (max 20 MB)".into()); } Some(format!("data:image/{};base64,{}", if b.starts_with(&[0x89, b'P']) { "png" } else { "jpeg" }, b64enc(&b))) } None => None };
    let bytes = match c.p.id {
        "openai" => {
            let size = if aspect == "9:16" { "720x1280" } else { "1280x720" };
            let secs = [4u32, 8, 12].into_iter().min_by_key(|s| s.abs_diff(seconds)).unwrap_or(8).to_string();
            let mut j = c.post(&format!("{}/videos", c.base), &json!({"model": c.video_model, "prompt": prompt, "size": size, "seconds": secs}), 120)?;
            let id = j["id"].as_str().ok_or("OpenAI returned no video id")?.to_string();
            loop {
                match j["status"].as_str().unwrap_or("") { "completed" => break, "failed" => return Err(format!("OpenAI video failed: {}", j["error"]["message"].as_str().unwrap_or(""))), _ => {} }
                wait_poll(cancel, progress, started, 120.0)?;
                j = c.get(&format!("{}/videos/{id}", c.base))?;
            }
            c.get_bytes(&format!("{}/videos/{id}/content", c.base), true)?
        }
        "gemini" => {
            let mut inst = json!({"prompt": prompt});
            if let Some(u) = &img_uri { let (mime, data) = u.trim_start_matches("data:").split_once(";base64,").unwrap_or(("image/png", "")); inst["image"] = json!({"bytesBase64Encoded": data, "mimeType": mime}); }
            let op = c.post(&format!("{}/models/{}:predictLongRunning", c.base, c.video_model), &json!({"instances": [inst], "parameters": {"aspectRatio": if aspect == "9:16" { "9:16" } else { "16:9" }}}), 120)?;
            let name = op["name"].as_str().ok_or("Veo returned no operation")?.to_string();
            if name.contains("..") { return Err("bad operation".into()); }
            let res = loop {
                let s = c.get(&format!("{}/{name}", c.base))?;
                if s["done"].as_bool() == Some(true) { if let Some(e) = s["error"]["message"].as_str() { return Err(format!("Veo: {e}")); } break s; }
                wait_poll(cancel, progress, started, 90.0)?;
            };
            let uri = res["response"]["generateVideoResponse"]["generatedSamples"][0]["video"]["uri"].as_str().ok_or("Veo returned no video (the prompt may have been blocked)")?.to_string();
            if !allowed_download(&uri) { return Err("Unexpected video host".into()); }
            c.get_bytes(&uri, true)?
        }
        "replicate" => {
            let mut input = json!({"prompt": prompt, "duration": seconds.clamp(3, 10), "aspect_ratio": if aspect.is_empty() { "16:9" } else { aspect }});
            if let Some(u) = &img_uri { input["start_image"] = json!(u); input["image"] = json!(u); }
            let u = replicate_run(c, &c.video_model, input, cancel, progress, 180.0)?; fetch(c, &u)?
        }
        "fal" => {
            let mut input = json!({"prompt": prompt, "duration": if seconds > 7 { "10" } else { "5" }, "aspect_ratio": if aspect.is_empty() { "16:9" } else { aspect }});
            if let Some(u) = &img_uri { input["image_url"] = json!(u); }
            let u = fal_run(c, &c.video_model, input, cancel, progress, 180.0)?; fetch(c, &u)?
        }
        _ => return Err("Unsupported provider".into()),
    };
    if bytes.len() < 1000 { return Err("The provider returned an empty video".into()); }
    let ext = if bytes.len() > 8 && &bytes[4..8] == b"ftyp" { "mp4" } else if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) { "webm" } else { "mp4" };
    Ok(Generated { bytes, ext })
}

pub fn tts(c: &Conn, text: &str, voice: &str) -> Result<Generated, String> {
    if !c.p.caps.contains(&"tts") { return Err(format!("{} can't make voiceovers", c.p.name)); }
    let text: String = text.chars().take(5000).collect();
    let r = match c.p.id {
        "openai" => agent(180).post(&format!("{}/audio/speech", c.base)).set("Authorization", &format!("Bearer {}", c.key.as_deref().unwrap_or(""))).send_json(json!({"model": c.tts_model, "voice": if voice.is_empty() { "alloy" } else { voice }, "input": text, "response_format": "mp3"})),
        "elevenlabs" => {
            let v = if voice.is_empty() { c.tts_model.clone() } else { voice.to_string() };
            if !v.chars().all(|ch| ch.is_ascii_alphanumeric()) { return Err("Invalid ElevenLabs voice id".into()); }
            agent(180).post(&format!("{}/text-to-speech/{v}?output_format=mp3_44100_128", c.base)).set("xi-api-key", c.key.as_deref().unwrap_or("")).send_json(json!({"text": text, "model_id": c.model}))
        }
        _ => return Err("Unsupported provider".into()),
    }.map_err(err_of)?;
    let mut b = vec![]; r.into_reader().take(200_000_000).read_to_end(&mut b).map_err(|e| e.to_string())?;
    if b.len() < 200 { return Err("The provider returned no audio".into()); }
    Ok(Generated { bytes: b, ext: "mp3" })
}

fn b64enc(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(b.len() * 4 / 3 + 4);
    for ch in b.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18 & 63) as usize] as char); s.push(T[(n >> 12 & 63) as usize] as char);
        s.push(if ch.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' }); s.push(if ch.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    s
}

// ---------------------------------------------------------------- stock media

#[derive(Serialize, Clone, Debug)]
pub struct StockItem { pub id: String, pub kind: String, pub title: String, pub thumb: String, pub preview: String, pub url: String, pub duration: f64, pub width: i64, pub height: i64, pub author: String, pub license: String }

fn enc(q: &str) -> String { q.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect() }

pub fn stock_search(id: &str, kind: &str, query: &str, page: u32) -> Result<Vec<StockItem>, String> {
    let c = connect(id, &Cfg::default())?;
    let key = c.key.clone().unwrap_or_default();
    let q = enc(query.trim()); let page = page.clamp(1, 50);
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let mut out = vec![];
    match id {
        "pexels" => {
            let video = kind == "video";
            let url = if video { format!("https://api.pexels.com/videos/search?query={q}&per_page=40&page={page}") } else { format!("https://api.pexels.com/v1/search?query={q}&per_page=40&page={page}") };
            let j: Value = agent(30).get(&url).set("Authorization", &key).call().map_err(err_of)?.into_json().map_err(|e| e.to_string())?;
            if video { for v in j["videos"].as_array().into_iter().flatten() {
                let files = v["video_files"].as_array().cloned().unwrap_or_default();
                let best = files.iter().filter(|f| f["file_type"] == "video/mp4").max_by_key(|f| { let h = f["height"].as_i64().unwrap_or(0); if h > 1080 { 0 } else { h } });
                let small = files.iter().filter(|f| f["file_type"] == "video/mp4").min_by_key(|f| f["height"].as_i64().unwrap_or(9999));
                if let Some(b) = best { out.push(StockItem { id: v["id"].to_string(), kind: "video".into(), title: format!("Pexels {}", v["id"]), thumb: s(&v["image"]), preview: small.map(|f| s(&f["link"])).unwrap_or_default(), url: s(&b["link"]), duration: v["duration"].as_f64().unwrap_or(0.0), width: b["width"].as_i64().unwrap_or(0), height: b["height"].as_i64().unwrap_or(0), author: s(&v["user"]["name"]), license: "Pexels License (free)".into() }); }
            } } else { for p in j["photos"].as_array().into_iter().flatten() {
                out.push(StockItem { id: p["id"].to_string(), kind: "image".into(), title: s(&p["alt"]), thumb: s(&p["src"]["medium"]), preview: s(&p["src"]["large"]), url: s(&p["src"]["original"]), duration: 0.0, width: p["width"].as_i64().unwrap_or(0), height: p["height"].as_i64().unwrap_or(0), author: s(&p["photographer"]), license: "Pexels License (free)".into() });
            } }
        }
        "pixabay" => {
            let video = kind == "video";
            let url = if video { format!("https://pixabay.com/api/videos/?key={}&q={q}&per_page=40&page={page}&safesearch=true", enc(&key)) } else { format!("https://pixabay.com/api/?key={}&q={q}&per_page=40&page={page}&safesearch=true", enc(&key)) };
            let j: Value = agent(30).get(&url).call().map_err(err_of)?.into_json().map_err(|e| e.to_string())?;
            for h in j["hits"].as_array().into_iter().flatten() {
                if video { let v = &h["videos"]; let pick = if v["large"]["url"].as_str().unwrap_or("").is_empty() { &v["medium"] } else { &v["large"] };
                    out.push(StockItem { id: h["id"].to_string(), kind: "video".into(), title: s(&h["tags"]), thumb: s(&v["tiny"]["thumbnail"]), preview: s(&v["tiny"]["url"]), url: s(&pick["url"]), duration: h["duration"].as_f64().unwrap_or(0.0), width: pick["width"].as_i64().unwrap_or(0), height: pick["height"].as_i64().unwrap_or(0), author: s(&h["user"]), license: "Pixabay Content License".into() }); }
                else { out.push(StockItem { id: h["id"].to_string(), kind: "image".into(), title: s(&h["tags"]), thumb: s(&h["previewURL"]), preview: s(&h["webformatURL"]), url: s(&h["largeImageURL"]), duration: 0.0, width: h["imageWidth"].as_i64().unwrap_or(0), height: h["imageHeight"].as_i64().unwrap_or(0), author: s(&h["user"]), license: "Pixabay Content License".into() }); }
            }
        }
        "freesound" => {
            let url = format!("https://freesound.org/apiv2/search/text/?query={q}&page={page}&page_size=40&fields=id,name,duration,license,username,previews,images&token={}", enc(&key));
            let j: Value = agent(30).get(&url).call().map_err(err_of)?.into_json().map_err(|e| e.to_string())?;
            for r in j["results"].as_array().into_iter().flatten() {
                let lic = s(&r["license"]); let lic = if lic.contains("zero") { "CC0".to_string() } else if lic.contains("by-nc") { "CC BY-NC (non-commercial)".into() } else if lic.contains("/by/") { "CC BY (credit the author)".into() } else { lic };
                out.push(StockItem { id: r["id"].to_string(), kind: "audio".into(), title: s(&r["name"]), thumb: s(&r["images"]["waveform_m"]), preview: s(&r["previews"]["preview-lq-mp3"]), url: s(&r["previews"]["preview-hq-mp3"]), duration: r["duration"].as_f64().unwrap_or(0.0), width: 0, height: 0, author: s(&r["username"]), license: lic });
            }
        }
        "jamendo" => {
            let url = format!("https://api.jamendo.com/v3.0/tracks/?client_id={}&format=json&limit=40&offset={}&search={q}&audioformat=mp32&include=licenses", enc(&key), (page - 1) * 40);
            let j: Value = agent(30).get(&url).call().map_err(err_of)?.into_json().map_err(|e| e.to_string())?;
            if j["headers"]["status"] == "failed" { return Err(format!("Jamendo: {}", s(&j["headers"]["error_message"]))); }
            for r in j["results"].as_array().into_iter().flatten() {
                out.push(StockItem { id: s(&r["id"]), kind: "audio".into(), title: format!("{} — {}", s(&r["name"]), s(&r["artist_name"])), thumb: s(&r["album_image"]), preview: s(&r["audio"]), url: { let d = s(&r["audiodownload"]); if d.is_empty() { s(&r["audio"]) } else { d } }, duration: r["duration"].as_f64().unwrap_or(0.0), width: 0, height: 0, author: s(&r["artist_name"]), license: s(&r["license_ccurl"]) });
            }
        }
        _ => return Err("Not a stock provider".into()),
    }
    out.retain(|i| allowed_download(&i.url));
    Ok(out)
}

/// Download a stock/AI file into `dir` (validated host, size limit, unique name).
pub fn download_to(url: &str, dir: &Path, name: &str, cancel: &Arc<AtomicBool>) -> Result<PathBuf, String> {
    if !allowed_download(url) { return Err(format!("Refusing to download from an unexpected host: {url}")); }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let resp = agent(300).get(url).call().map_err(err_of)?;
    let mut r = resp.into_reader().take(4_000_000_000);
    let mut buf = vec![]; let mut chunk = vec![0u8; 1 << 16];
    loop { if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); } let n = r.read(&mut chunk).map_err(|e| e.to_string())?; if n == 0 { break; } buf.extend_from_slice(&chunk[..n]); }
    if buf.len() < 100 { return Err("Downloaded file is empty".into()); }
    crate::ops::write_atomic(dir, name, &buf, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn download_host_allowlist() {
        assert!(allowed_download("https://videos.pexels.com/video-files/1/a.mp4"));
        assert!(allowed_download("https://replicate.delivery/xyz/out.mp4"));
        assert!(!allowed_download("http://videos.pexels.com/a.mp4"));
        assert!(!allowed_download("https://evil.com/pexels.com/a.mp4"));
        assert!(!allowed_download("https://pexels.com.evil.com/a.mp4"));
        assert!(!allowed_download("file:///C:/Windows/win.ini"));
    }
    #[test] fn base64_roundtrip() { let d = b"Media Studio Pro \x00\xff"; assert_eq!(b64(&b64enc(d)).unwrap(), d.to_vec()); }
    #[test] fn connect_requires_https_and_key() {
        assert!(connect("custom", &Cfg { base: "http://example.com".into(), ..Default::default() }).is_err());
        assert!(connect("ollama", &Cfg::default()).is_ok(), "local providers need no key");
        assert!(provider("nope").is_err());
    }
    #[test] fn first_url_finds_nested() { assert_eq!(first_url(&serde_json::json!({"video": {"url": "https://fal.media/x.mp4"}})).as_deref(), Some("https://fal.media/x.mp4")); }
}
