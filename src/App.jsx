import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import {
  ActionIcon,
  AppShell,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronDown,
  IconChevronUp,
  IconDeviceFloppy,
  IconFolderOpen,
  IconMusic,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRewindForward15,
  IconTrash,
} from "@tabler/icons-react";

const EMPTY_METADATA = {
  title: "",
  artist: "",
  album: "",
  genre: "",
  track_number: "",
  year: "",
};

const DEFAULT_GENRE_CONFIG = {
  baseline: [
    { label: "Dark", value: "b:D", auto_replace: [] },
    { label: "Light", value: "b:L", auto_replace: [] },
    { label: "wubtech", value: "b:WW", auto_replace: [] },
    { label: "Break Beat", value: "b:BB", auto_replace: [] },
  ],
  baseline_tags: [{ label: "Groove", value: "grv", auto_replace: ["groove", "Groove", "funk"] }],
  vocal_tags: [
    { label: "Full Vocals", value: "v:fv", auto_replace: [] },
    { label: "Some vocals", value: "v:sv", auto_replace: [] },
    { label: "No vocals", value: "v:0v", auto_replace: [] },
  ],
  track_energy: [
    { label: "Chill", value: "e:chill", auto_replace: [] },
    { label: "Dance", value: "e:dance", auto_replace: [] },
    { label: "Rave", value: "e:rave", auto_replace: [] },
  ],
  other_tags: [
    { label: "Disco", value: "g:disco", auto_replace: [] },
    { label: "Sing Along", value: "t:SL", auto_replace: [] },
    { label: "Girlz", value: "g:girlz", auto_replace: [] },
  ],
};

const EDITABLE_FIELDS = [
  ["title", "Title"],
  ["artist", "Artist"],
  ["album", "Album"],
  ["genre", "Genre"],
  ["track_number", "Track"],
  ["year", "Year"],
];

const EMPTY_SELECT_VALUE = "__empty__";
const EMPTY_SELECT_OPTION = { label: "---", value: EMPTY_SELECT_VALUE, disabled: true };

function getDraft(track) {
  return { ...EMPTY_METADATA, ...track.metadata, ...track.draft };
}

function hasChanges(track) {
  const draft = getDraft(track);
  return EDITABLE_FIELDS.some(([field]) => String(draft[field] ?? "") !== String(track.metadata[field] ?? ""));
}

function changedSummary(track) {
  const draft = getDraft(track);
  return EDITABLE_FIELDS.filter(([field]) => String(draft[field] ?? "") !== String(track.metadata[field] ?? ""));
}

function fallbackTitle(track) {
  return track.metadata.title || track.file_name || "Untitled track";
}

function displayRuntime(seconds) {
  if (!seconds) return "--:--";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function splitGenreTags(genre) {
  return String(genre ?? "")
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function formatGenreTags(tags, config) {
  const cleanTags = tags.filter(Boolean);
  if (cleanTags.length === 0) return "";

  const firstTag = cleanTags[0];
  const firstTagBaseline = parseBaselineCompoundTag(firstTag, config);
  if (firstTagBaseline?.stinky && cleanTags.length > 1) {
    return `${firstTag} ${cleanTags.slice(1).join(", ")}`;
  }

  return cleanTags.join(", ");
}

function getKnownGenreValues(config) {
  return {
    baseline: new Set(config.baseline.map((option) => option.value)),
    all: new Set([...config.baseline, ...config.baseline_tags, ...config.vocal_tags, ...config.track_energy, ...config.other_tags].map((option) => option.value)),
  };
}

function getGrooveTagValue(config) {
  return config.baseline_tags.find((option) => option.value === "grv" || option.label.toLowerCase() === "groove")?.value ?? "";
}

function getValidBaselineTags(tags, config) {
  const allowed = new Set(config.baseline_tags.map((option) => option.value));
  return tags.filter((tag) => allowed.has(tag));
}

function selectorOptions(options) {
  return [EMPTY_SELECT_OPTION, ...options.map((option) => ({ label: option.label, value: option.value }))];
}

function selectorValue(value) {
  return value || EMPTY_SELECT_VALUE;
}

function selectTagValue(value) {
  return value === EMPTY_SELECT_VALUE ? "" : value || "";
}

function parseBaselineCompoundTag(tag, config) {
  const baselines = [...config.baseline.map((option) => option.value)].sort((a, b) => b.length - a.length);
  const grooveTag = getGrooveTagValue(config);

  for (const baseline of baselines) {
    if (!tag.startsWith(baseline)) continue;

    let suffix = tag.slice(baseline.length);
    const parsed = { baseline, stinky: false, baselineTags: [] };

    if (grooveTag && suffix.startsWith(grooveTag)) {
      parsed.baselineTags.push(grooveTag);
      suffix = suffix.slice(grooveTag.length);
    }

    if (suffix === "s;") {
      parsed.stinky = true;
      suffix = "";
    }

    if (suffix === "") return parsed;
  }

  return null;
}

function isKnownGenreTag(tag, config) {
  const known = getKnownGenreValues(config);
  if (known.all.has(tag)) return true;
  if (tag === "s;") return true;
  return Boolean(parseBaselineCompoundTag(tag, config));
}

function getUnknownGenreTags(genre, config) {
  return [...new Set(splitGenreTags(genre).filter((tag) => !isKnownGenreTag(tag, config)))];
}

function hasBaselineTag(genre, config) {
  return splitGenreTags(genre).some((tag) => Boolean(parseBaselineCompoundTag(tag, config)));
}

function hasEnergyTag(genre, config) {
  const energyValues = new Set(config.track_energy.map((option) => option.value));
  return splitGenreTags(genre).some((tag) => energyValues.has(tag));
}

function needsSingleEdit(track, config) {
  const genre = track?.metadata?.genre ?? "";
  return !hasBaselineTag(genre, config) || !hasEnergyTag(genre, config);
}

function sortTracksForTagging(tracks, config) {
  return tracks
    .map((track, index) => ({ track, index }))
    .sort((left, right) => {
      const leftComplete = !needsSingleEdit(left.track, config);
      const rightComplete = !needsSingleEdit(right.track, config);
      if (leftComplete !== rightComplete) return leftComplete ? 1 : -1;
      return left.index - right.index;
    })
    .map(({ track }) => track);
}

function findNextSingleEditIndex(tracks, config, startIndex = 0) {
  const start = Math.max(0, startIndex);
  for (let index = start; index < tracks.length; index += 1) {
    if (needsSingleEdit(tracks[index], config)) return index;
  }
  return -1;
}

function findPreviousSingleEditIndex(tracks, config, startIndex) {
  const start = Math.min(tracks.length - 1, startIndex);
  for (let index = start; index >= 0; index -= 1) {
    if (needsSingleEdit(tracks[index], config)) return index;
  }
  return -1;
}

function getTrackRowClass(genre, config) {
  if (hasBaselineTag(genre, config)) return "baseline-genre-row";
  if (getUnknownGenreTags(genre, config).length > 0) return "unknown-genre-row";
  return undefined;
}

function parseGenreToSingleState(genre, config) {
  const tags = splitGenreTags(genre);
  const state = {
    baseline: "",
    stinky: false,
    baselineTags: [],
    vocalTags: "",
    trackEnergy: "",
    otherTags: [],
  };
  const groups = [
    ["baselineTags", config.baseline_tags],
    ["otherTags", config.other_tags],
  ];
  const vocalTagValues = new Set(config.vocal_tags.map((option) => option.value));
  const trackEnergyValues = new Set(config.track_energy.map((option) => option.value));

  tags.forEach((tag) => {
    const baselineCompound = parseBaselineCompoundTag(tag, config);
    if (baselineCompound) {
      state.baseline = baselineCompound.baseline;
      state.stinky = baselineCompound.stinky;
      baselineCompound.baselineTags.forEach((baselineTag) => {
        if (!state.baselineTags.includes(baselineTag)) state.baselineTags.push(baselineTag);
      });
      return;
    }
    if (trackEnergyValues.has(tag)) {
      state.trackEnergy = tag;
      return;
    }
    if (vocalTagValues.has(tag)) {
      state.vocalTags = tag;
      return;
    }

    groups.forEach(([stateKey, options]) => {
      if (options.some((option) => option.value === tag) && !state[stateKey].includes(tag)) {
        state[stateKey].push(tag);
      }
    });
  });

  return state;
}

function normalizeGenreConfig(config) {
  return {
    baseline: normalizeGenreOptions(config?.baseline ?? DEFAULT_GENRE_CONFIG.baseline),
    baseline_tags: normalizeGenreOptions(config?.baseline_tags ?? DEFAULT_GENRE_CONFIG.baseline_tags),
    vocal_tags: normalizeGenreOptions(config?.vocal_tags ?? DEFAULT_GENRE_CONFIG.vocal_tags),
    track_energy: normalizeGenreOptions(config?.track_energy ?? DEFAULT_GENRE_CONFIG.track_energy),
    other_tags: normalizeGenreOptions(config?.other_tags ?? DEFAULT_GENRE_CONFIG.other_tags),
  };
}

function normalizeGenreOptions(options) {
  return options.map((option) => ({
    label: option.label ?? "",
    value: option.value ?? "",
    auto_replace: Array.isArray(option.auto_replace) ? option.auto_replace : parseAutoReplaceInput(option.auto_replace),
  }));
}

function prepareGenreConfigForSave(config) {
  return {
    baseline: prepareGenreOptionsForSave(config.baseline),
    baseline_tags: prepareGenreOptionsForSave(config.baseline_tags),
    vocal_tags: prepareGenreOptionsForSave(config.vocal_tags),
    track_energy: prepareGenreOptionsForSave(config.track_energy),
    other_tags: prepareGenreOptionsForSave(config.other_tags),
  };
}

function prepareGenreOptionsForSave(options) {
  return options.map((option) => ({
    ...option,
    auto_replace: Array.isArray(option.auto_replace) ? option.auto_replace : parseAutoReplaceInput(option.auto_replace),
  }));
}

function parseAutoReplaceInput(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function applyAutoReplaceToGenre(genre, config) {
  const replacements = new Map();
  [...config.baseline, ...config.baseline_tags, ...config.vocal_tags, ...config.track_energy, ...config.other_tags].forEach((option) => {
    const autoReplace = Array.isArray(option.auto_replace) ? option.auto_replace : parseAutoReplaceInput(option.auto_replace);
    autoReplace.forEach((match) => {
      if (match.trim()) replacements.set(match.trim(), option.value);
    });
  });

  if (replacements.size === 0) return genre;

  let changed = false;
  const replacedTags = splitGenreTags(genre).map((tag) => {
    const replacement = replacements.get(tag);
    if (replacement && replacement !== tag) {
      changed = true;
      return replacement;
    }
    return tag;
  });

  return changed ? formatGenreTags(replacedTags, config) : genre;
}

function applyAutoReplacementsToTrack(track, config) {
  const nextGenre = applyAutoReplaceToGenre(track.metadata.genre, config);
  if (nextGenre === track.metadata.genre) {
    return {
      ...track,
      draft: {},
    };
  }

  return {
    ...track,
    draft: {
      ...track.draft,
      genre: nextGenre,
    },
  };
}

async function reanalyzeLoadedTracks(tracks, config) {
  const refreshed = await Promise.all(
    tracks.map(async (track) => {
      try {
        const fresh = await invoke("read_track_metadata", { path: track.path });
        return applyAutoReplacementsToTrack({ ...fresh, draft: {}, error: "" }, config);
      } catch (err) {
        return { ...track, error: `Could not re-analyze file: ${String(err)}` };
      }
    }),
  );
  return refreshed;
}

function App() {
  const [folderPath, setFolderPath] = useState("");
  const [tracks, setTracks] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [savingPath, setSavingPath] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [playingPath, setPlayingPath] = useState("");
  const [genreConfig, setGenreConfig] = useState(DEFAULT_GENRE_CONFIG);
  const [genreConfigDraft, setGenreConfigDraft] = useState(DEFAULT_GENRE_CONFIG);
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("mass");
  const audioRef = useRef(null);
  const savedTimerRef = useRef(null);

  useEffect(() => {
    invoke("load_genre_config")
      .then((config) => {
        const normalized = normalizeGenreConfig(config);
        setGenreConfig(normalized);
        setGenreConfigDraft(normalized);
        setTracks((current) => sortTracksForTagging(current.map((track) => applyAutoReplacementsToTrack(track, normalized)), normalized));
      })
      .catch(() => {
        const normalized = normalizeGenreConfig(DEFAULT_GENRE_CONFIG);
        setGenreConfig(normalized);
        setGenreConfigDraft(normalized);
        setTracks((current) => sortTracksForTagging(current.map((track) => applyAutoReplacementsToTrack(track, normalized)), normalized));
      });
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  async function pickFolder() {
    setError("");
    if (!isTauri()) {
      setError("Direct in-place editing requires the Tauri desktop app. Start it with `yarn tauri dev`; browser preview cannot edit existing files.");
      return;
    }

    try {
      const selected = await invoke("pick_music_folder");
      if (selected) {
        setFolderPath(selected);
        await scanFolder(selected);
      }
    } catch (err) {
      setError(`Could not open folder picker: ${String(err)}`);
    }
  }

  async function scanFolder(path = folderPath) {
    if (!path) return;
    setLoading(true);
    setError("");
    try {
      const scanned = await invoke("scan_music_folder", { path });
      const scannedTracks = sortTracksForTagging(
        scanned.map((track) => applyAutoReplacementsToTrack({ ...track, draft: {}, error: "" }, genreConfig)),
        genreConfig,
      );
      setTracks(scannedTracks);
      setActiveIndex(Math.max(0, findPreviousSingleEditIndex(scannedTracks, genreConfig, scannedTracks.length - 1)));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function updateDraft(path, field, value) {
    if (savedPath === path) {
      setSavedPath("");
    }
    setTracks((current) =>
      current.map((track) =>
        track.path === path
          ? {
              ...track,
              draft: { ...track.draft, [field]: value ?? "" },
              error: "",
            }
          : track,
      ),
    );
  }

  function replaceTrack(updated) {
    setTracks((current) =>
      sortTracksForTagging(
        current.map((track) =>
          track.path === updated.path ? { ...track, metadata: updated.metadata, duration_seconds: updated.duration_seconds, draft: {}, error: "" } : track,
        ),
        genreConfig,
      ),
    );
  }

  async function saveTrack(track, options = {}) {
    if (!hasChanges(track)) return;
    setSavingPath(track.path);
    try {
      const updated = await invoke("save_track_metadata", {
        path: track.path,
        edits: getDraft(track),
      });
      replaceTrack(updated);
      setSavedPath(updated.path);
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = setTimeout(() => {
        setSavedPath((current) => (current === updated.path ? "" : current));
        if (options.advanceAfterSave) {
          setActiveIndex((currentIndex) => {
            const updatedTracks = sortTracksForTagging(
              tracks.map((item) =>
                item.path === updated.path ? { ...item, metadata: updated.metadata, duration_seconds: updated.duration_seconds, draft: {}, error: "" } : item,
              ),
              genreConfig,
            );
            const savedIndex = updatedTracks.findIndex((item) => item.path === updated.path);
            const anchorIndex = savedIndex === -1 ? currentIndex : savedIndex;
            const nextIndex = findPreviousSingleEditIndex(updatedTracks, genreConfig, anchorIndex - 1);
            if (nextIndex !== -1) return nextIndex;

            const previousIndex = findNextSingleEditIndex(updatedTracks, genreConfig, anchorIndex + 1);
            return previousIndex !== -1 ? previousIndex : anchorIndex;
          });
        }
      }, 2000);
    } catch (err) {
      setTracks((current) => current.map((item) => (item.path === track.path ? { ...item, error: String(err) } : item)));
    } finally {
      setSavingPath("");
    }
  }

  function playTrack(track) {
    if (!audioRef.current) return;
    if (playingPath === track.path) {
      audioRef.current.pause();
      setPlayingPath("");
      return;
    }
    audioRef.current.src = convertFileSrc(track.path);
    audioRef.current
      .play()
      .then(() => setPlayingPath(track.path))
      .catch((err) => {
        setPlayingPath("");
        setTracks((current) => current.map((item) => (item.path === track.path ? { ...item, error: `Playback failed: ${err.message}` } : item)));
      });
  }

  function skipForward(track, seconds = 15) {
    if (!audioRef.current || playingPath !== track.path) return;
    const duration = Number.isFinite(audioRef.current.duration) ? audioRef.current.duration : null;
    audioRef.current.currentTime = duration
      ? Math.min(audioRef.current.currentTime + seconds, duration)
      : audioRef.current.currentTime + seconds;
  }

  function playTrackFromStart(track) {
    if (!audioRef.current || !track) return;
    audioRef.current.pause();
    audioRef.current.src = convertFileSrc(track.path);
    audioRef.current.currentTime = 0;
    audioRef.current
      .play()
      .then(() => setPlayingPath(track.path))
      .catch((err) => {
        setPlayingPath("");
        setTracks((current) => current.map((item) => (item.path === track.path ? { ...item, error: `Playback failed: ${err.message}` } : item)));
      });
  }

  function updateGenreConfig(group, index, key, value) {
    setGenreConfigDraft((current) => ({
      ...current,
      [group]: current[group].map((option, optionIndex) => (optionIndex === index ? { ...option, [key]: value } : option)),
    }));
    setConfigDirty(true);
  }

  function addGenreOption(group) {
    setGenreConfigDraft((current) => ({
      ...current,
      [group]: [...current[group], { label: "", value: "", auto_replace: [] }],
    }));
    setConfigDirty(true);
  }

  function removeGenreOption(group, index) {
    setGenreConfigDraft((current) => ({
      ...current,
      [group]: current[group].filter((_, optionIndex) => optionIndex !== index),
    }));
    setConfigDirty(true);
  }

  function reorderGenreOption(group, fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    setGenreConfigDraft((current) => {
      const nextOptions = [...current[group]];
      const [moved] = nextOptions.splice(fromIndex, 1);
      nextOptions.splice(toIndex, 0, moved);
      return {
        ...current,
        [group]: nextOptions,
      };
    });
    setConfigDirty(true);
  }

  async function persistGenreConfig(configToSave) {
    setConfigSaving(true);
    try {
      const saved = await invoke("save_genre_config", { config: prepareGenreConfigForSave(configToSave) });
      const normalized = normalizeGenreConfig(saved);
      setGenreConfig(normalized);
      setGenreConfigDraft(normalized);
      const refreshedTracks = await reanalyzeLoadedTracks(tracks, normalized);
      const sortedTracks = sortTracksForTagging(refreshedTracks, normalized);
      setTracks(sortedTracks);
      setActiveIndex(Math.max(0, findPreviousSingleEditIndex(sortedTracks, normalized, sortedTracks.length - 1)));
      setConfigDirty(false);
      return normalized;
    } finally {
      setConfigSaving(false);
    }
  }

  async function saveGenreConfig() {
    await persistGenreConfig(genreConfigDraft);
  }

  async function addUnknownTag(tag, group) {
    const cleanTag = tag.trim();
    if (!cleanTag) return;

    const nextConfig = {
      ...genreConfig,
      [group]: genreConfig[group].some((option) => option.value === cleanTag)
        ? genreConfig[group]
        : [...genreConfig[group], { label: cleanTag, value: cleanTag, auto_replace: [] }],
    };

    await persistGenreConfig(nextConfig);
  }

  const singleTrackIndex = useMemo(() => {
    if (savedPath) return tracks.findIndex((track) => track.path === savedPath);
    if (needsSingleEdit(tracks[activeIndex], genreConfig)) return activeIndex;

    const previousFromActive = findPreviousSingleEditIndex(tracks, genreConfig, activeIndex);
    if (previousFromActive !== -1) return previousFromActive;
    return findPreviousSingleEditIndex(tracks, genreConfig, tracks.length - 1);
  }, [tracks, genreConfig, activeIndex, savedPath]);
  useEffect(() => {
    if (!savedPath && singleTrackIndex !== -1 && singleTrackIndex !== activeIndex) {
      setActiveIndex(singleTrackIndex);
    }
  }, [singleTrackIndex, activeIndex, savedPath]);
  const activeTrack = singleTrackIndex === -1 ? null : tracks[singleTrackIndex] ?? null;
  const previousSingleIndex = singleTrackIndex === -1 ? -1 : findNextSingleEditIndex(tracks, genreConfig, singleTrackIndex + 1);
  const nextSingleIndex = singleTrackIndex === -1 ? -1 : findPreviousSingleEditIndex(tracks, genreConfig, singleTrackIndex - 1);

  return (
    <AppShell header={{ height: 70 }} padding="md">
      <AppShell.Header className="app-header">
        <Container size="xl" className="header-inner">
          <Group gap="sm">
            <div className="brand-mark">
              <IconMusic size={20} />
            </div>
            <div>
              <Title order={3}>Genera Manager</Title>
              <Text size="sm" c="dimmed">
                Offline music metadata editor
              </Text>
            </div>
          </Group>
          <Group gap="sm" className="header-controls" wrap="nowrap">
            <div className="header-status">
              <Group gap={6} wrap="nowrap">
                <Text size="sm" fw={600} className="header-folder-path" title={folderPath || "No folder selected"}>
                  {folderPath || "No folder selected"}
                </Text>
                {loading && <Loader size="xs" />}
              </Group>
              <Text size="xs" c="dimmed" className="header-file-count">
                {tracks.length} file{tracks.length === 1 ? "" : "s"} loaded
              </Text>
            </div>
            <Button leftSection={<IconFolderOpen size={18} />} variant="light" onClick={pickFolder}>
              Choose folder
            </Button>
            <Button variant="subtle" onClick={() => scanFolder()} disabled={!folderPath || loading}>
              Rescan
            </Button>
          </Group>
        </Container>
      </AppShell.Header>

      <AppShell.Main>
        <Container size="xl">
          <Stack gap="md">
            {error && <Text c="red" size="sm">{error}</Text>}

            <Tabs value={activeTab} onChange={(value) => setActiveTab(value || "mass")}>
              <Tabs.List>
                <Tabs.Tab value="mass">Mass edits</Tabs.Tab>
                <Tabs.Tab value="single">Single edits</Tabs.Tab>
                <Tabs.Tab value="genre">Genre edits</Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="mass" pt="md">
                <MassEdits
                  tracks={tracks}
                  genreConfig={genreConfig}
                  playingPath={playingPath}
                  savingPath={savingPath}
                  savedPath={savedPath}
                  onPlay={playTrack}
                  onSkipForward={skipForward}
                  onSave={(track) => saveTrack(track)}
                  onDraft={updateDraft}
                />
              </Tabs.Panel>

              <Tabs.Panel value="single" pt="md">
                <SingleEdits
                  track={activeTrack}
                  index={singleTrackIndex}
                  total={tracks.length}
                  previousIndex={previousSingleIndex}
                  nextIndex={nextSingleIndex}
                  genreConfig={genreConfig}
                  isActive={activeTab === "single"}
                  playingPath={playingPath}
                  savingPath={savingPath}
                  savedPath={savedPath}
                  onPlay={playTrack}
                  onAutoPlay={playTrackFromStart}
                  onSkipForward={skipForward}
                  onSave={(track) => saveTrack(track, { advanceAfterSave: true })}
                  onDraft={updateDraft}
                  onNavigate={setActiveIndex}
                  onAddUnknownTag={addUnknownTag}
                />
              </Tabs.Panel>

              <Tabs.Panel value="genre" pt="md">
                <GenreEdits
                  config={genreConfigDraft}
                  dirty={configDirty}
                  saving={configSaving}
                  onChange={updateGenreConfig}
                  onAdd={addGenreOption}
                  onRemove={removeGenreOption}
                  onReorder={reorderGenreOption}
                  onSave={saveGenreConfig}
                />
              </Tabs.Panel>
            </Tabs>
          </Stack>
        </Container>
      </AppShell.Main>
      <audio ref={audioRef} onEnded={() => setPlayingPath("")} />
    </AppShell>
  );
}

function MassEdits({ tracks, genreConfig, playingPath, savingPath, savedPath, onPlay, onSkipForward, onSave, onDraft }) {
  if (tracks.length === 0) {
    return <EmptyState />;
  }

  return (
    <Paper className="panel">
      <ScrollArea>
        <Table className="tracks-table" verticalSpacing={7} horizontalSpacing={4} highlightOnHover>
          <Table.Thead>
              <Table.Tr>
                <Table.Th>Play</Table.Th>
              <Table.Th className="track-title-column">Track</Table.Th>
                <Table.Th className="artist-column">Artist</Table.Th>
                <Table.Th className="genre-column">Genre</Table.Th>
              <Table.Th>Runtime</Table.Th>
              <Table.Th className="changes-cell">Changes</Table.Th>
              <Table.Th className="save-spacer" />
              <Table.Th className="save-cell">Save</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tracks.map((track) => (
              <TrackRow
                key={track.path}
                track={track}
                genreConfig={genreConfig}
                playing={playingPath === track.path}
                saving={savingPath === track.path}
                saved={savedPath === track.path}
                onPlay={onPlay}
                onSkipForward={onSkipForward}
                onSave={onSave}
                onDraft={onDraft}
              />
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Paper>
  );
}

function TrackRow({ track, genreConfig, playing, saving, saved, onPlay, onSkipForward, onSave, onDraft }) {
  const draft = getDraft(track);
  const changes = changedSummary(track);
  const unknownTags = getUnknownGenreTags(draft.genre, genreConfig);
  const genreOnlyChange = changes.length === 1 && changes[0][0] === "genre";
  const changed = hasChanges(track);

  return (
    <Table.Tr className={getTrackRowClass(draft.genre, genreConfig)}>
      <Table.Td>
        <Group gap={2} wrap="nowrap">
          <Tooltip label={playing ? "Pause" : "Play"}>
            <ActionIcon variant="subtle" aria-label={playing ? "Pause" : "Play"} onClick={() => onPlay(track)}>
              {playing ? <IconPlayerPause size={18} /> : <IconPlayerPlay size={18} />}
            </ActionIcon>
          </Tooltip>
          {playing && (
            <Tooltip label="Skip 15 seconds">
              <ActionIcon variant="subtle" aria-label="Skip 15 seconds forward" onClick={() => onSkipForward(track)}>
                <IconRewindForward15 size={18} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Table.Td>
      <Table.Td className="track-title-column">
        <TextInput value={draft.title} placeholder={track.file_name} onChange={(event) => onDraft(track.path, "title", event.currentTarget.value)} />
      </Table.Td>
      <Table.Td className="artist-column">
        <Text size="sm" className="readonly-cell-text">
          {draft.artist || "blank"}
        </Text>
      </Table.Td>
      <Table.Td className="genre-column">
        <GenreField value={draft.genre} unknownTags={unknownTags} onChange={(value) => onDraft(track.path, "genre", value)} />
      </Table.Td>
      <Table.Td>
        <Badge variant="light">{displayRuntime(track.duration_seconds)}</Badge>
      </Table.Td>
      <Table.Td className="changes-cell">
        <Stack gap={2}>
          {changes.length === 0 ? (
            <Text size="xs" c="dimmed">No changes</Text>
          ) : (
            changes.map(([field, label]) => (
              <div className="change-item" key={field}>
                {!genreOnlyChange && (
                  <Text size="xs" fw={700}>
                    {label}
                  </Text>
                )}
                <Text size="xs">
                  <s>{track.metadata[field] || "blank"}</s>
                </Text>
                <Text size="xs">{draft[field] || "blank"}</Text>
              </div>
            ))
          )}
          {track.error && <Text size="xs" c="red">{track.error}</Text>}
        </Stack>
      </Table.Td>
      <Table.Td className="save-spacer" />
      <Table.Td className="save-cell">
        <Button
          size="xs"
          color={saved ? "green" : undefined}
          className={changed && !saved ? "unsaved-save-button" : undefined}
          variant={saved || changed ? "filled" : "light"}
          leftSection={<IconDeviceFloppy size={14} />}
          disabled={!changed && !saved}
          loading={saving}
          onClick={() => onSave(track)}
        >
          {saved ? "Saved" : "Save"}
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

function GenreField({ value, unknownTags, onChange }) {
  return (
    <div className={unknownTags.length > 0 ? "genre-editor has-unknown-tags" : "genre-editor"}>
      <Textarea
        autosize
        minRows={1}
        maxRows={8}
        classNames={{ input: "genre-input" }}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {unknownTags.length > 0 && (
        <Group gap={6} className="unknown-tag-strip">
          {unknownTags.map((tag) => (
            <Badge key={tag} className="unknown-tag-badge" variant="filled">
              {tag}
            </Badge>
          ))}
        </Group>
      )}
    </div>
  );
}

function SingleEdits({
  track,
  index,
  total,
  previousIndex,
  nextIndex,
  genreConfig,
  isActive,
  playingPath,
  savingPath,
  savedPath,
  onPlay,
  onAutoPlay,
  onSkipForward,
  onSave,
  onDraft,
  onNavigate,
  onAddUnknownTag,
}) {
  const [baseline, setBaseline] = useState("");
  const [stinky, setStinky] = useState(false);
  const [baselineTags, setBaselineTags] = useState([]);
  const [vocalTags, setVocalTags] = useState("");
  const [trackEnergy, setTrackEnergy] = useState("");
  const [otherTags, setOtherTags] = useState([]);
  const [selectorSourcePath, setSelectorSourcePath] = useState("");
  const suppressGeneratedDraftRef = useRef("");
  const lastAutoPlayedPathRef = useRef("");

  const generatedGenre = useMemo(() => {
    const cleanBaselineTags = getValidBaselineTags(baselineTags, genreConfig);
    const grooveTag = getGrooveTagValue(genreConfig);
    const hasGroove = Boolean(grooveTag && cleanBaselineTags.includes(grooveTag));
    const remainingBaselineTags = cleanBaselineTags.filter((tag) => tag !== grooveTag);
    const head = baseline ? `${baseline}${hasGroove ? grooveTag : ""}${stinky ? "s;" : ""}` : "";
    const tail = [...remainingBaselineTags, vocalTags, ...otherTags, trackEnergy].filter(Boolean);

    if (head && stinky && tail.length > 0) return `${head} ${tail.join(", ")}`;
    return [head, ...tail].filter(Boolean).join(", ");
  }, [baseline, stinky, baselineTags, vocalTags, trackEnergy, otherTags, genreConfig]);

  useEffect(() => {
    if (!track) return;
    const parsed = parseGenreToSingleState(getDraft(track).genre, genreConfig);
    suppressGeneratedDraftRef.current = track.path;
    setBaseline(parsed.baseline);
    setStinky(parsed.stinky);
    setBaselineTags(parsed.baselineTags);
    setVocalTags(parsed.vocalTags);
    setTrackEnergy(parsed.trackEnergy);
    setOtherTags(parsed.otherTags);
    setSelectorSourcePath(track.path);
    if (isActive && lastAutoPlayedPathRef.current !== track.path) {
      lastAutoPlayedPathRef.current = track.path;
      onAutoPlay(track);
    }
  }, [track?.path, genreConfig, isActive]);

  useEffect(() => {
    if (!track) return;
    if (selectorSourcePath !== track.path) return;
    if (suppressGeneratedDraftRef.current === track.path) {
      suppressGeneratedDraftRef.current = "";
      return;
    }
    onDraft(track.path, "genre", generatedGenre);
  }, [generatedGenre, selectorSourcePath, track?.path]);

  if (!track) return <EmptyState />;

  const originalUnknownTags = getUnknownGenreTags(track.metadata.genre, genreConfig);
  const trackChanged = hasChanges(track);

  return (
    <Stack gap="md">
      <Paper className="panel single-panel">
        <Group justify="space-between" mb="md">
          <Group gap="xs">
            <ActionIcon variant="subtle" disabled={previousIndex === -1} onClick={() => onNavigate(previousIndex)}>
              <IconChevronLeft size={18} />
            </ActionIcon>
            <ActionIcon variant="subtle" disabled={nextIndex === -1} onClick={() => onNavigate(nextIndex)}>
              <IconChevronRight size={18} />
            </ActionIcon>
            <div>
              <Text fw={700}>{fallbackTitle(track)}</Text>
              <Text size="xs" c="dimmed">
                {index + 1} of {total} · {track.path}
              </Text>
            </div>
          </Group>
          <Group gap="xs">
            <Button variant="light" leftSection={playingPath === track.path ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />} onClick={() => onPlay(track)}>
              {playingPath === track.path ? "Pause" : "Play"}
            </Button>
            {playingPath === track.path && (
              <Tooltip label="Skip 15 seconds">
                <ActionIcon variant="light" size={36} aria-label="Skip 15 seconds forward" onClick={() => onSkipForward(track)}>
                  <IconRewindForward15 size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            <Button
              color={savedPath === track.path ? "green" : undefined}
              className={trackChanged && savedPath !== track.path ? "unsaved-save-button" : undefined}
              variant={savedPath === track.path || trackChanged ? "filled" : "light"}
              leftSection={<IconDeviceFloppy size={16} />}
              disabled={!trackChanged && savedPath !== track.path}
              loading={savingPath === track.path}
              onClick={() => onSave(track)}
            >
              {savedPath === track.path ? "Saved" : "Save"}
            </Button>
          </Group>
        </Group>
        <MassEdits
          tracks={[track]}
          genreConfig={genreConfig}
          playingPath={playingPath}
          savingPath={savingPath}
          savedPath={savedPath}
          onPlay={onPlay}
          onSkipForward={onSkipForward}
          onSave={onSave}
          onDraft={onDraft}
        />
      </Paper>

      <Paper className="panel">
        <Stack gap="md">
          <Group align="flex-end">
            <Select
              label="Baseline"
              data={selectorOptions(genreConfig.baseline)}
              value={selectorValue(baseline)}
              placeholder="Select baseline"
              allowDeselect={false}
              onChange={(value) => setBaseline(selectTagValue(value))}
            />
            <Select
              label="Track Energy"
              data={selectorOptions(genreConfig.track_energy)}
              value={selectorValue(trackEnergy)}
              placeholder="Select energy"
              allowDeselect={false}
              onChange={(value) => setTrackEnergy(selectTagValue(value))}
            />
            <Select
              label="Vocals"
              data={selectorOptions(genreConfig.vocal_tags)}
              value={selectorValue(vocalTags)}
              placeholder="Select vocals"
              allowDeselect={false}
              onChange={(value) => setVocalTags(selectTagValue(value))}
            />
          </Group>
          <div>
            <Text size="sm" fw={500}>Baseline Tags</Text>
            <Group mt="xs">
              <Checkbox label="Stinky" checked={stinky} onChange={(event) => setStinky(event.currentTarget.checked)} />
              <Checkbox.Group value={baselineTags} onChange={(value) => setBaselineTags(getValidBaselineTags(value, genreConfig))}>
                <Group>
                  {genreConfig.baseline_tags.map((option) => (
                    <Checkbox key={option.value} label={option.label} value={option.value} />
                  ))}
                </Group>
              </Checkbox.Group>
            </Group>
          </div>
          <Checkbox.Group label="Other Tags" value={otherTags} onChange={setOtherTags}>
            <Group mt="xs">
              {genreConfig.other_tags.map((option) => (
                <Checkbox key={option.value} label={option.label} value={option.value} />
              ))}
            </Group>
          </Checkbox.Group>
        </Stack>
      </Paper>
      {originalUnknownTags.length > 0 && (
        <UnknownTagPromoter unknownTags={originalUnknownTags} onAddUnknownTag={onAddUnknownTag} />
      )}
    </Stack>
  );
}

function UnknownTagPromoter({ unknownTags, onAddUnknownTag }) {
  return (
    <Paper className="panel unknown-tag-panel">
      <Stack gap="sm">
        <div>
          <Title order={4}>Unknown genre tags</Title>
          <Text size="sm" c="dimmed">
            Add these tags to the Single edits selector list.
          </Text>
        </div>
        {unknownTags.map((tag) => (
          <UnknownTagPromoterRow key={tag} tag={tag} onAddUnknownTag={onAddUnknownTag} />
        ))}
      </Stack>
    </Paper>
  );
}

function UnknownTagPromoterRow({ tag, onAddUnknownTag }) {
  const [group, setGroup] = useState("other_tags");
  const [saving, setSaving] = useState(false);

  async function addTag() {
    setSaving(true);
    try {
      await onAddUnknownTag(tag, group);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Group align="flex-end" className="unknown-tag-promoter-row">
      <Badge className="unknown-tag-badge" variant="filled">
        {tag}
      </Badge>
      <Select
        label="Add this tag as"
        value={group}
        allowDeselect={false}
        onChange={(value) => setGroup(value || "other_tags")}
        data={[
          { value: "baseline", label: "Baseline" },
          { value: "baseline_tags", label: "Base tag" },
          { value: "vocal_tags", label: "Vocal tag" },
          { value: "track_energy", label: "Track Energy" },
          { value: "other_tags", label: "Other tag" },
        ]}
      />
      <Button size="sm" variant="light" loading={saving} onClick={addTag}>
        Add tag
      </Button>
    </Group>
  );
}

function GenreEdits({ config, dirty, saving, onChange, onAdd, onRemove, onReorder, onSave }) {
  return (
    <Paper className="panel">
      <Stack gap="lg">
        <Group justify="space-between">
          <div>
            <Title order={4}>Single edit selectors</Title>
            <Text size="sm" c="dimmed">
              These options are stored locally and work offline.
            </Text>
          </div>
          <Button leftSection={<IconDeviceFloppy size={16} />} disabled={!dirty} loading={saving} onClick={onSave}>
            Save Settings
          </Button>
        </Group>
        <OptionEditor title="Baseline" group="baseline" options={config.baseline} onChange={onChange} onAdd={onAdd} onRemove={onRemove} onReorder={onReorder} />
        <OptionEditor title="Baseline Tags" group="baseline_tags" options={config.baseline_tags} onChange={onChange} onAdd={onAdd} onRemove={onRemove} onReorder={onReorder} />
        <OptionEditor title="Vocal Tags" group="vocal_tags" options={config.vocal_tags} onChange={onChange} onAdd={onAdd} onRemove={onRemove} onReorder={onReorder} />
        <OptionEditor title="Track Energy" group="track_energy" options={config.track_energy} onChange={onChange} onAdd={onAdd} onRemove={onRemove} onReorder={onReorder} />
        <OptionEditor title="Other Tags" group="other_tags" options={config.other_tags} onChange={onChange} onAdd={onAdd} onRemove={onRemove} onReorder={onReorder} />
      </Stack>
    </Paper>
  );
}

function OptionEditor({ title, group, options, onChange, onAdd, onRemove, onReorder }) {
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text fw={700}>{title}</Text>
        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => onAdd(group)}>
          Add
        </Button>
      </Group>
      <Table className="settings-table" verticalSpacing="xs" horizontalSpacing={4}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th className="settings-drag-cell" />
            <Table.Th>Selector name</Table.Th>
            <Table.Th>Inserted string</Table.Th>
            <Table.Th>Auto replace</Table.Th>
            <Table.Th className="settings-action-cell" />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {options.map((option, index) => (
            <Table.Tr key={`${group}-${index}`}>
              <Table.Td className="settings-drag-cell">
                <Group gap={2} wrap="nowrap" justify="center">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    disabled={index === 0}
                    onClick={() => onReorder(group, index, index - 1)}
                    aria-label={`Move ${option.label || "option"} up`}
                  >
                    <IconChevronUp size={14} />
                  </ActionIcon>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    disabled={index === options.length - 1}
                    onClick={() => onReorder(group, index, index + 1)}
                    aria-label={`Move ${option.label || "option"} down`}
                  >
                    <IconChevronDown size={14} />
                  </ActionIcon>
                </Group>
              </Table.Td>
              <Table.Td>
                <TextInput value={option.label} onChange={(event) => onChange(group, index, "label", event.currentTarget.value)} />
              </Table.Td>
              <Table.Td>
                <TextInput value={option.value} onChange={(event) => onChange(group, index, "value", event.currentTarget.value)} />
              </Table.Td>
              <Table.Td>
                <TextInput
                  className="auto-replace-input"
                  placeholder="groove, Groove, funk"
                  value={Array.isArray(option.auto_replace) ? option.auto_replace.join(", ") : option.auto_replace ?? ""}
                  onChange={(event) => onChange(group, index, "auto_replace", event.currentTarget.value)}
                />
              </Table.Td>
              <Table.Td className="settings-action-cell">
                <ActionIcon color="red" variant="subtle" onClick={() => onRemove(group, index)} aria-label={`Remove ${option.label || "option"}`}>
                  <IconTrash size={18} />
                </ActionIcon>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function EmptyState() {
  return (
    <Paper className="empty-state">
      <IconMusic size={42} stroke={1.5} />
      <Text fw={700}>Choose a music folder to begin</Text>
      <Text size="sm" c="dimmed">
        MP3, WAV, and FLAC files will appear here.
      </Text>
    </Paper>
  );
}

export default App;
