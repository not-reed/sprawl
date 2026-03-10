import { useRef, useState, useEffect } from "react";
import type { Message } from "../lib/types";

interface ChatMessageProps {
  message: Message;
  audioUrl?: string;
  onGenerateAudio?: () => Promise<string | null>;
}

function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (
      lines[i].trim().startsWith("|") &&
      i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])
    ) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push(renderTable(tableLines));
    } else if (/^[-*] .+$/.test(lines[i])) {
      let listHtml = "<ul>";
      while (i < lines.length && /^[-*] .+$/.test(lines[i])) {
        listHtml += `<li>${inlineFormat(lines[i].slice(2))}</li>`;
        i++;
      }
      listHtml += "</ul>";
      blocks.push(listHtml);
    } else {
      blocks.push(renderLine(lines[i]));
      i++;
    }
  }

  return blocks.join("");
}

const parseRow = (line: string) =>
  line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());

function renderTable(lines: string[]): string {
  if (lines.length < 2) return lines.map(renderLine).join("");

  const headers = parseRow(lines[0]);
  const rows = lines.slice(2).map(parseRow);

  let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
  for (const h of headers) html += `<th>${inlineFormat(h)}</th>`;
  html += "</tr></thead><tbody>";
  for (const row of rows) {
    html += "<tr>";
    for (let c = 0; c < headers.length; c++) html += `<td>${inlineFormat(row[c] ?? "")}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table></div>";
  return html;
}

function inlineFormat(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function renderLine(line: string): string {
  if (/^### (.+)$/.test(line)) return `<h3>${inlineFormat(line.slice(4))}</h3>`;
  if (/^## (.+)$/.test(line)) return `<h2>${inlineFormat(line.slice(3))}</h2>`;
  if (/^# (.+)$/.test(line)) return `<h1>${inlineFormat(line.slice(2))}</h1>`;
  if (line.trim() === "") return "<br/>";
  return inlineFormat(line) + "<br/>";
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function ChatMessage({
  message,
  audioUrl: initialAudioUrl,
  onGenerateAudio,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioUrl, setAudioUrl] = useState(initialAudioUrl);
  const [generating, setGenerating] = useState(false);

  // Sync prop changes
  useEffect(() => {
    if (initialAudioUrl) setAudioUrl(initialAudioUrl);
  }, [initialAudioUrl]);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const ensureAudio = () => {
    if (audioRef.current) return audioRef.current;
    if (!audioUrl) return null;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    audio.addEventListener("loadedmetadata", () => setDuration(audio.duration));
    audio.addEventListener("timeupdate", () => setCurrentTime(audio.currentTime));
    audio.addEventListener("ended", () => {
      setPlaying(false);
      setCurrentTime(0);
    });
    audio.addEventListener("error", () => setPlaying(false));
    return audio;
  };

  const togglePlay = () => {
    const audio = ensureAudio();
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play();
      setPlaying(true);
    }
  };

  const skip = (delta: number) => {
    const audio = ensureAudio();
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta));
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = ensureAudio();
    if (!audio) return;
    audio.currentTime = Number(e.target.value);
    setCurrentTime(audio.currentTime);
  };

  const handleGenerate = async () => {
    if (!onGenerateAudio || generating) return;
    setGenerating(true);
    try {
      const url = await onGenerateAudio();
      if (url) {
        setAudioUrl(url);
        // Auto-play after generation
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.addEventListener("loadedmetadata", () => setDuration(audio.duration));
        audio.addEventListener("timeupdate", () => setCurrentTime(audio.currentTime));
        audio.addEventListener("ended", () => {
          setPlaying(false);
          setCurrentTime(0);
        });
        audio.addEventListener("error", () => setPlaying(false));
        audio.play();
        setPlaying(true);
      }
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className={`chat-message ${isUser ? "chat-message-user" : "chat-message-gm"}`}>
      <div className="chat-message-header">
        <span className="chat-message-role">{isUser ? "You" : "GM"}</span>
      </div>
      {isUser ? (
        <div className="chat-message-content">{message.content}</div>
      ) : (
        <div
          className="chat-message-content"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        />
      )}
      {!isUser && audioUrl && (
        <div className="audio-controls">
          <button className="audio-btn" onClick={() => skip(-5)} title="Back 5s">
            {"\u23EA"}
          </button>
          <button
            className="audio-btn audio-btn-play"
            onClick={togglePlay}
            title={playing ? "Pause" : "Play"}
          >
            {playing ? "\u23F8" : "\u25B6"}
          </button>
          <button className="audio-btn" onClick={() => skip(5)} title="Forward 5s">
            {"\u23E9"}
          </button>
          <input
            type="range"
            className="audio-scrubber"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={seek}
          />
          <span className="audio-time">
            {formatTime(currentTime)}/{formatTime(duration)}
          </span>
        </div>
      )}
      {!isUser && !audioUrl && onGenerateAudio && (
        <button className="btn-generate-audio" onClick={handleGenerate} disabled={generating}>
          {generating ? "Generating..." : "\uD83D\uDD0A Generate Audio"}
        </button>
      )}
    </div>
  );
}
