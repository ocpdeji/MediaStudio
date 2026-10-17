//! Offline speech: Whisper (whisper.cpp) transcription with word timings, and Piper text-to-speech.
use crate::{export, media, models};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Word { pub start_us: i64, pub end_us: i64, pub text: String }
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Segment { pub start_us: i64, pub end_us: i64, pub text: String, pub words: Vec<Word> }

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(default)]
pub struct TranscribeSpec {
    pub path: String, pub in_us: i64, pub out_us: i64,
    /// "auto" or an ISO-639-1 code
    pub language: String,
    /// translate to English (Whisper's built-in translation)
    pub translate: bool,
    /// whisper-base | whisper-small | whisper-turbo | "" (best installed)
    pub model: String,
    /// timeline offset added to every timestamp (clip start − source in)
    pub offset_us: i64,
}

pub fn valid_lang(l: &str) -> bool { l == "auto" || (l.len() >= 2 && l.len() <= 3 && l.chars().all(|c| c.is_ascii_lowercase())) }

fn engine(data: &Path) -> Vec<PathBuf> {
    let mut v = vec![];
    let nvidia = export::caps().hw_verified.iter().any(|e| e.contains("nvenc"));
    if nvidia { if let Some(p) = models::path_of(data, "whisper-cuda") { v.push(p); } }
    if let Some(p) = models::path_of(data, "whisper-cpu") { v.push(p); }
    v
}

fn model_file(data: &Path, want: &str) -> Option<PathBuf> {
    if !want.is_empty() { return models::path_of(data, want); }
    ["whisper-turbo", "whisper-small", "whisper-base"].iter().find_map(|id| models::path_of(data, id))
}

/// Turn whisper.cpp's full JSON (`-ojf`) into segments with word timings. Special tokens (`[_BEG_]`, `[_TT_…]`)
/// are dropped and sub-word tokens are merged into words (a word starts at a token beginning with a space).
pub fn parse_whisper_json(j: &serde_json::Value, offset_us: i64) -> Vec<Segment> {
    let mut out = vec![];
    let Some(arr) = j["transcription"].as_array() else { return out };
    for s in arr {
        let from = s["offsets"]["from"].as_i64().unwrap_or(0) * 1000 + offset_us;
        let to = s["offsets"]["to"].as_i64().unwrap_or(0) * 1000 + offset_us;
        let mut words: Vec<Word> = vec![];
        if let Some(toks) = s["tokens"].as_array() {
            for t in toks {
                let txt = t["text"].as_str().unwrap_or("");
                if txt.is_empty() || txt.starts_with("[_") || txt.starts_with("<|") { continue; }
                let (a, b) = (t["offsets"]["from"].as_i64().unwrap_or(0) * 1000 + offset_us, t["offsets"]["to"].as_i64().unwrap_or(0) * 1000 + offset_us);
                let starts_word = txt.starts_with(' ') || words.is_empty();
                let punct_only = txt.trim().chars().all(|c| c.is_ascii_punctuation());
                if starts_word && !(punct_only && !words.is_empty()) { words.push(Word { start_us: a, end_us: b.max(a), text: txt.trim().to_string() }); }
                else if let Some(w) = words.last_mut() { w.text.push_str(txt.trim_end()); w.end_us = w.end_us.max(b); }
            }
        }
        words.retain(|w| !w.text.trim().is_empty());
        let text = s["text"].as_str().unwrap_or("").trim().to_string();
        if text.is_empty() && words.is_empty() { continue; }
        let text = if text.is_empty() { words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ") } else { text };
        out.push(Segment { start_us: from, end_us: to.max(from), text, words });
    }
    out
}

pub fn transcribe(data: &Path, work: &Path, spec: &TranscribeSpec, cancel: &Arc<AtomicBool>, progress: &mut dyn FnMut(f64)) -> Result<(Vec<Segment>, String), String> {
    if !valid_lang(&spec.language) { return Err("Invalid language code".into()); }
    let engines = engine(data);
    if engines.is_empty() { return Err("Auto captions need the Whisper engine. Open Settings → AI models and install “Whisper engine”.".into()); }
    let model = model_file(data, &spec.model).ok_or("No Whisper model is installed. Open Settings → AI models and install one (Base is quick to download).")?;
    std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
    // 16 kHz mono WAV of the requested range
    let wav = work.join("speech.wav");
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into(), "-progress".into(), "pipe:1".into(), "-nostats".into(), "-loglevel".into(), "error".into()];
    if spec.in_us > 0 { a.extend(["-ss".into(), format!("{:.6}", spec.in_us as f64 / 1e6)]); }
    if spec.out_us > spec.in_us { a.extend(["-t".into(), format!("{:.6}", (spec.out_us - spec.in_us) as f64 / 1e6)]); }
    a.extend(["-i".into(), spec.path.clone(), "-map".into(), "0:a:0".into(), "-vn".into(), "-ac".into(), "1".into(), "-ar".into(), "16000".into(), "-c:a".into(), "pcm_s16le".into(), wav.to_string_lossy().into_owned()]);
    export::run_ffmpeg(&a, (spec.out_us - spec.in_us).max(1), None, cancel, &mut |p| progress(p * 0.1)).map_err(|e| if e.contains("matches no streams") { "This clip has no audio to transcribe.".to_string() } else { e })?;
    let threads = std::thread::available_parallelism().map(|n| n.get().clamp(2, 8)).unwrap_or(4).to_string();
    let mut last_err = String::new();
    for (i, exe) in engines.iter().enumerate() {
        let of = work.join(format!("out{i}"));
        let mut c = media::command(exe);
        c.current_dir(exe.parent().unwrap());
        c.args(["-m", &model.to_string_lossy(), "-f", &wav.to_string_lossy(), "-l", &spec.language, "-t", &threads, "-ojf", "-of", &of.to_string_lossy(), "-pp", "-np"]);
        if spec.translate { c.arg("-tr"); }
        c.stdout(Stdio::null()).stderr(Stdio::piped());
        let mut child = match c.spawn() { Ok(ch) => ch, Err(e) => { last_err = e.to_string(); continue; } };
        let err = child.stderr.take().unwrap();
        let tail = Arc::new(Mutex::new(Vec::<String>::new()));
        let pr = Arc::new(Mutex::new(0.0f64));
        let (t2, p2) = (tail.clone(), pr.clone());
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if let Some(idx) = line.find("progress =") { if let Ok(v) = line[idx + 10..].trim().trim_end_matches('%').trim().parse::<f64>() { *p2.lock().unwrap() = v / 100.0; } }
                let mut t = t2.lock().unwrap(); t.push(line); if t.len() > 30 { t.remove(0); }
            }
        });
        let status = loop {
            if cancel.load(Ordering::Relaxed) { let _ = child.kill(); let _ = child.wait(); return Err("cancelled".into()); }
            if let Some(s) = child.try_wait().map_err(|e| e.to_string())? { break s; }
            progress(0.1 + 0.88 * *pr.lock().unwrap());
            std::thread::sleep(std::time::Duration::from_millis(250));
        };
        let _ = reader.join();
        let json = of.with_extension("json");
        if status.success() && json.is_file() {
            let bytes = std::fs::read(&json).map_err(|e| e.to_string())?;
            let txt = String::from_utf8_lossy(&bytes);
            let j: serde_json::Value = serde_json::from_str(&txt).map_err(|e| format!("Unreadable transcript: {e}"))?;
            let lang = j["result"]["language"].as_str().unwrap_or(&spec.language).to_string();
            progress(1.0);
            return Ok((parse_whisper_json(&j, spec.offset_us + 0), lang));
        }
        last_err = media::last_lines(&tail.lock().unwrap().join("\n"), 5);
    }
    Err(format!("Transcription failed: {last_err}"))
}

// ---------------------------------------------------------------- Piper TTS

#[derive(Serialize)]
pub struct Voice { pub id: String, pub name: String, pub installed: bool }

pub fn voices(data: &Path) -> Vec<Voice> {
    models::CATALOG.iter().filter(|d| d.id.starts_with("voice-")).map(|d| Voice { id: d.id.into(), name: d.name.into(), installed: models::find(data, d.dir, d.marker).is_some() }).collect()
}

/// Synthesize `text` with a Piper voice into `out` (WAV). Text goes through stdin, never the command line.
pub fn piper(data: &Path, voice: &str, text: &str, speed: f64, out: &Path) -> Result<(), String> {
    let exe = models::path_of(data, "piper").ok_or("Text-to-speech needs the Piper engine. Install it in Settings → AI models.")?;
    if !voice.starts_with("voice-") { return Err("Unknown voice".into()); }
    let model = models::path_of(data, voice).ok_or("That voice isn't installed yet. Install it in Settings → AI models.")?;
    let text: String = text.chars().filter(|c| !c.is_control() || *c == '\n').take(20_000).collect();
    if text.trim().is_empty() { return Err("Type some text to turn into speech".into()); }
    let ls = format!("{:.3}", (1.0 / speed.clamp(0.5, 2.0)));
    let mut c = media::command(&exe);
    c.current_dir(exe.parent().unwrap());
    c.args(["--model", &model.to_string_lossy(), "--output_file", &out.to_string_lossy(), "--length_scale", &ls, "--sentence_silence", "0.25"]);
    c.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("Could not start Piper: {e}"))?;
    child.stdin.take().unwrap().write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    let mut err = String::new(); let _ = child.stderr.take().unwrap().read_to_string(&mut err);
    let st = child.wait().map_err(|e| e.to_string())?;
    if !st.success() || !out.is_file() { return Err(format!("Speech synthesis failed: {}", media::last_lines(&err, 4))); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn words_merge_subword_tokens_and_drop_specials() {
        let j = json!({"transcription":[{"offsets":{"from":0,"to":1500},"text":" Hello wonderful world.","tokens":[
            {"text":"[_BEG_]","offsets":{"from":0,"to":0}},
            {"text":" Hello","offsets":{"from":0,"to":400}},
            {"text":" wonder","offsets":{"from":400,"to":700}},
            {"text":"ful","offsets":{"from":700,"to":900}},
            {"text":" world","offsets":{"from":900,"to":1300}},
            {"text":".","offsets":{"from":1300,"to":1400}},
            {"text":"[_TT_75]","offsets":{"from":1500,"to":1500}}]}]});
        let s = parse_whisper_json(&j, 2_000_000);
        assert_eq!(s.len(), 1);
        let w: Vec<&str> = s[0].words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(w, vec!["Hello", "wonderful", "world."]);
        assert_eq!(s[0].words[1].start_us, 2_400_000); assert_eq!(s[0].words[1].end_us, 2_900_000);
        assert_eq!(s[0].start_us, 2_000_000); assert_eq!(s[0].text, "Hello wonderful world.");
    }
    #[test] fn languages() { assert!(valid_lang("auto") && valid_lang("en") && valid_lang("yor")); assert!(!valid_lang("en;x") && !valid_lang("E") && !valid_lang("")); }
}
