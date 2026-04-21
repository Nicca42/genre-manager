use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::{Accessor, TagExt};
use lofty::read_from_path;
use lofty::tag::{ItemKey, Tag, TagType};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TrackMetadata {
    title: String,
    artist: String,
    album: String,
    genre: String,
    track_number: String,
    year: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrackSummary {
    path: String,
    file_name: String,
    metadata: TrackMetadata,
    duration_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GenreOption {
    label: String,
    value: String,
    #[serde(default)]
    auto_replace: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GenreConfig {
    baseline: Vec<GenreOption>,
    baseline_tags: Vec<GenreOption>,
    #[serde(default = "default_vocal_tags")]
    vocal_tags: Vec<GenreOption>,
    #[serde(default = "default_track_energy")]
    track_energy: Vec<GenreOption>,
    other_tags: Vec<GenreOption>,
}

#[tauri::command]
fn pick_music_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose music folder")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn scan_music_folder(path: String) -> Result<Vec<TrackSummary>, String> {
    let root = PathBuf::from(path);
    if !root.exists() {
        return Err("Selected folder does not exist".to_string());
    }

    let mut tracks = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let path = entry.path();
        if is_supported_audio(path) {
            match read_track(path) {
                Ok(track) => tracks.push(track),
                Err(_) => tracks.push(fallback_track(path)),
            }
        }
    }

    tracks.sort_by(|left, right| {
        left.metadata
            .artist
            .cmp(&right.metadata.artist)
            .then(left.metadata.album.cmp(&right.metadata.album))
            .then(left.metadata.track_number.cmp(&right.metadata.track_number))
            .then(left.file_name.cmp(&right.file_name))
    });
    Ok(tracks)
}

#[tauri::command]
fn read_track_metadata(path: String) -> Result<TrackSummary, String> {
    read_track(Path::new(&path))
}

#[tauri::command]
fn save_track_metadata(path: String, edits: TrackMetadata) -> Result<TrackSummary, String> {
    let path_buf = PathBuf::from(&path);
    let mut tagged_file = read_from_path(&path_buf).map_err(|err| err.to_string())?;
    let tag_type = tagged_file.primary_tag_type();

    if tagged_file.primary_tag().is_none() {
        tagged_file.insert_tag(Tag::new(tag_type));
    }

    let tag_types = tag_types_to_update(&tagged_file);
    if tag_types.is_empty() {
        return Err("Could not create a writable metadata tag for this file".to_string());
    }

    for tag_type in tag_types {
        if let Some(tag) = tagged_file.tag_mut(tag_type) {
            apply_metadata_to_tag(tag, &edits);
            tag.save_to_path(&path_buf, WriteOptions::default())
                .map_err(|err| err.to_string())?;
        }
    }

    read_track(&path_buf)
}

#[tauri::command]
fn load_genre_config() -> Result<GenreConfig, String> {
    let path = genre_config_path()?;
    if !path.exists() {
        return Ok(default_genre_config());
    }

    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&content).map_err(|err| err.to_string())
}

#[tauri::command]
fn save_genre_config(config: GenreConfig) -> Result<GenreConfig, String> {
    let path = genre_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let normalized = normalize_genre_config(config);
    let content = serde_json::to_string_pretty(&normalized).map_err(|err| err.to_string())?;
    fs::write(path, content).map_err(|err| err.to_string())?;
    Ok(normalized)
}

fn read_track(path: &Path) -> Result<TrackSummary, String> {
    let tagged_file = read_from_path(path).map_err(|err| err.to_string())?;
    let properties = tagged_file.properties();
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
    let metadata = tag.map(metadata_from_tag).unwrap_or_default();

    Ok(TrackSummary {
        path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown file".to_string()),
        metadata,
        duration_seconds: properties.duration().as_secs(),
    })
}

fn fallback_track(path: &Path) -> TrackSummary {
    TrackSummary {
        path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown file".to_string()),
        metadata: TrackMetadata::default(),
        duration_seconds: 0,
    }
}

fn metadata_from_tag(tag: &Tag) -> TrackMetadata {
    TrackMetadata {
        title: tag.title().map(|value| value.to_string()).unwrap_or_default(),
        artist: tag.artist().map(|value| value.to_string()).unwrap_or_default(),
        album: tag.album().map(|value| value.to_string()).unwrap_or_default(),
        genre: tag.genre().map(|value| value.to_string()).unwrap_or_default(),
        track_number: tag
            .get_string(&ItemKey::TrackNumber)
            .map(|value| value.to_string())
            .unwrap_or_default(),
        year: tag
            .get_string(&ItemKey::Year)
            .map(|value| value.to_string())
            .unwrap_or_default(),
    }
}

fn apply_metadata_to_tag(tag: &mut Tag, edits: &TrackMetadata) {
    tag.set_title(edits.title.clone());
    tag.set_artist(edits.artist.clone());
    tag.set_album(edits.album.clone());
    tag.set_genre(edits.genre.clone());
    set_optional_text(tag, ItemKey::TrackNumber, edits.track_number.clone());
    set_optional_text(tag, ItemKey::Year, edits.year.clone());
}

fn tag_types_to_update(tagged_file: &impl TaggedFileExt) -> Vec<TagType> {
    let mut tag_types = Vec::new();
    let primary = tagged_file.primary_tag_type();

    if tagged_file.tag(primary).is_some() {
        tag_types.push(primary);
    }

    for tag in tagged_file.tags() {
        let tag_type = tag.tag_type();
        if !tag_types.contains(&tag_type) {
            tag_types.push(tag_type);
        }
    }

    tag_types
}

fn set_optional_text(tag: &mut Tag, key: ItemKey, value: String) {
    tag.remove_key(&key);
    if !value.trim().is_empty() {
        tag.insert_text(key, value);
    }
}

fn is_supported_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "mp3" | "wav" | "flac"))
        .unwrap_or(false)
}

fn genre_config_path() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|path| path.join("genera-manager").join("genre-config.json"))
        .ok_or_else(|| "Could not find a local config directory".to_string())
}

fn normalize_genre_config(config: GenreConfig) -> GenreConfig {
    GenreConfig {
        baseline: clean_options(config.baseline),
        baseline_tags: clean_options(config.baseline_tags),
        vocal_tags: clean_options(config.vocal_tags),
        track_energy: clean_options(config.track_energy),
        other_tags: clean_options(config.other_tags),
    }
}

fn clean_options(options: Vec<GenreOption>) -> Vec<GenreOption> {
    options
        .into_iter()
        .map(|option| GenreOption {
            label: option.label.trim().to_string(),
            value: option.value.trim().to_string(),
            auto_replace: option
                .auto_replace
                .into_iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect(),
        })
        .filter(|option| !option.label.is_empty() && !option.value.is_empty())
        .collect()
}

fn default_genre_config() -> GenreConfig {
    GenreConfig {
        baseline: vec![
            option("Dark", "b:D"),
            option("Light", "b:L"),
            option("wubtech", "b:WW"),
            option("Break Beat", "b:BB"),
        ],
        baseline_tags: vec![option_with_auto("Groove", "grv", &["groove", "Groove", "funk"])],
        vocal_tags: default_vocal_tags(),
        track_energy: default_track_energy(),
        other_tags: vec![
            option("Disco", "g:disco"),
            option("Sing Along", "t:SL"),
            option("Girlz", "g:girlz"),
        ],
    }
}

fn default_vocal_tags() -> Vec<GenreOption> {
    vec![
        option("Full Vocals", "v:fv"),
        option("Some vocals", "v:sv"),
        option("No vocals", "v:0v"),
    ]
}

fn default_track_energy() -> Vec<GenreOption> {
    vec![
        option("Chill", "e:chill"),
        option("Dance", "e:dance"),
        option("Rave", "e:rave"),
    ]
}

fn option(label: &str, value: &str) -> GenreOption {
    GenreOption {
        label: label.to_string(),
        value: value.to_string(),
        auto_replace: Vec::new(),
    }
}

fn option_with_auto(label: &str, value: &str, auto_replace: &[&str]) -> GenreOption {
    GenreOption {
        label: label.to_string(),
        value: value.to_string(),
        auto_replace: auto_replace.iter().map(|value| value.to_string()).collect(),
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pick_music_folder,
            scan_music_folder,
            read_track_metadata,
            save_track_metadata,
            load_genre_config,
            save_genre_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running Genera Manager");
}
