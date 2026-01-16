import { execSync, spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import React, { useState, useEffect } from "react";
import { render, Text, Box, useInput, useApp } from "ink";

// Cache directory for LLM summaries
const CACHE_DIR = join(homedir(), ".cache", "tmux-sessions");

// Claude brand colors for animation
const CLAUDE_COLORS = ["#D97706", "#DC8A4F", "#E9A178"];

// LLM prompt and model for cache key generation
const LLM_PROMPT =
  'Summarize what this Claude Code session is working on in 10 words or less. Just output the summary, nothing else. If unclear, say "unclear"';
const LLM_MODEL = "claude-3-haiku";

// Check if colorpath is available
let colorpathAvailable = null;
function checkColorpath() {
  if (colorpathAvailable === null) {
    try {
      execSync("which colorpath", { stdio: "pipe" });
      colorpathAvailable = true;
    } catch {
      colorpathAvailable = false;
    }
  }
  return colorpathAvailable;
}

// Parse ANSI-colored output from colorpath into segments
// Returns array of { text, color } objects
function parseColorpathOutput(output) {
  const segments = [];
  // ANSI color map
  const colorMap = {
    "36": "cyan",     // alias
    "34": "blue",     // intermediate
    "35": "magenta",  // final
  };

  // Match ANSI sequences and text between them
  const regex = /\x1b\[(\d+)m([^\x1b]*)/g;
  let match;
  let currentColor = null;

  while ((match = regex.exec(output)) !== null) {
    const code = match[1];
    const text = match[2];

    if (code === "0") {
      currentColor = null;
    } else if (colorMap[code]) {
      currentColor = colorMap[code];
    }

    if (text) {
      segments.push({ text, color: currentColor });
    }
  }

  return segments;
}

// Get formatted path using colorpath, returns { segments, raw }
function getFormattedPath(rawPath) {
  if (!rawPath) return { segments: [], raw: "" };

  if (checkColorpath()) {
    try {
      const output = execSync(`colorpath "${rawPath}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const segments = parseColorpathOutput(output);
      if (segments.length > 0) {
        return { segments, raw: null };
      }
    } catch {}
  }

  // Fallback: return raw path with no coloring
  return { segments: [], raw: rawPath };
}

// Ensure cache directory exists
function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// Generate cache key from pane content
function getCacheKey(paneContent) {
  const hash = createHash("md5");
  hash.update(paneContent + LLM_PROMPT + LLM_MODEL);
  return hash.digest("hex");
}

// Get cached summary
function getCachedSummary(paneContent) {
  try {
    ensureCacheDir();
    const cacheKey = getCacheKey(paneContent);
    const cacheFile = join(CACHE_DIR, `${cacheKey}.txt`);
    if (existsSync(cacheFile)) {
      return readFileSync(cacheFile, "utf-8").trim();
    }
  } catch {}
  return null;
}

// Save summary to cache
function saveSummaryToCache(paneContent, summary) {
  try {
    ensureCacheDir();
    const cacheKey = getCacheKey(paneContent);
    const cacheFile = join(CACHE_DIR, `${cacheKey}.txt`);
    writeFileSync(cacheFile, summary);
  } catch {}
}

// Get tmux session data with panes
function getTmuxSessions() {
  try {
    // Get all sessions
    const sessionData = execSync(
      `tmux list-sessions -F '#{session_name}|#{session_attached}|#{session_created}' 2>/dev/null`,
      { encoding: "utf-8" },
    ).trim();

    if (!sessionData) return [];

    const now = Math.floor(Date.now() / 1000);
    const sessions = [];

    for (const line of sessionData.split("\n")) {
      const [name, attached, created] = line.split("|");

      // Format age
      const ageSecs = now - parseInt(created);
      const days = Math.floor(ageSecs / 86400);
      const hours = Math.floor((ageSecs % 86400) / 3600);
      const mins = Math.floor((ageSecs % 3600) / 60);
      let age;
      if (days > 0) age = `${days}d ${hours}h`;
      else if (hours > 0) age = `${hours}h ${mins}m`;
      else age = `${mins}m`;

      // Get panes for this session using list-panes -s
      let panes = [];
      try {
        const paneData = execSync(
          `tmux list-panes -s -t "${name}" -F '#{window_index}|#{pane_current_path}|#{pane_current_command}|#{pane_id}' 2>/dev/null`,
          { encoding: "utf-8" },
        ).trim();

        // Show all panes
        let paneIndex = 0;
        for (const paneLine of paneData.split("\n")) {
          const [windowIndex, rawPath, cmd, paneId] = paneLine.split("|");
          const formattedPath = getFormattedPath(rawPath);
          const isClaudeCode = cmd === "node" || /^\d+\.\d+\.\d+$/.test(cmd);
          panes.push({
            index: paneIndex,
            windowIndex: parseInt(windowIndex),
            path: formattedPath,
            rawPath,
            command: isClaudeCode ? "claude" : cmd,
            isClaudeCode,
            paneId,
            summary: null,
            loadingSummary: isClaudeCode,
            paneContent: null,
          });
          paneIndex++;
        }
      } catch {}

      sessions.push({
        name,
        attached: parseInt(attached) > 0,
        age,
        panes,
      });
    }

    return sessions;
  } catch {
    return [];
  }
}

// Track spawned processes for cleanup
const spawnedProcesses = [];

// Get visible pane content
function getPaneContent(paneId) {
  try {
    return execSync(
      `tmux capture-pane -t "${paneId}" -p 2>/dev/null | tail -50`,
      { encoding: "utf-8" },
    ).trim();
  } catch {
    return null;
  }
}

// Get summary with LLM (checks cache first)
async function getClaudeSummary(paneId) {
  try {
    const paneContent = getPaneContent(paneId);
    if (!paneContent) return { summary: null, paneContent: null };

    // Check cache first
    const cached = getCachedSummary(paneContent);
    if (cached) {
      return { summary: cached, paneContent };
    }

    return new Promise((resolve) => {
      const llm = spawn("llm", ["-m", LLM_MODEL, LLM_PROMPT], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: false,
      });

      spawnedProcesses.push(llm);

      let output = "";
      llm.stdout.on("data", (data) => {
        output += data.toString();
      });
      llm.on("close", () => {
        const summary = output.trim() || null;
        if (summary && paneContent) {
          saveSummaryToCache(paneContent, summary);
        }
        resolve({ summary, paneContent });
      });
      llm.on("error", () => resolve({ summary: null, paneContent }));

      llm.stdin.write(paneContent);
      llm.stdin.end();

      // Timeout after 10s
      setTimeout(() => {
        llm.kill();
        resolve({ summary: null, paneContent });
      }, 10000);
    });
  } catch {
    return { summary: null, paneContent: null };
  }
}

// Cleanup function
function cleanup() {
  spawnedProcesses.forEach((p) => {
    try {
      p.kill();
    } catch {}
  });
}

// Session header component
function SessionHeader({ session, isSelected }) {
  const prefix = isSelected ? "> " : "  ";

  return (
    <Text>
      {prefix}
      <Text bold={isSelected}>{session.name}</Text>
      <Text dimColor> started {session.age} ago</Text>
      {session.attached && <Text dimColor> (attached)</Text>}
    </Text>
  );
}

// Render path with colors from colorpath segments or fallback to plain
function formatPath(pathObj) {
  if (pathObj.raw !== null) {
    // Fallback: plain path with no coloring
    return <Text>{pathObj.raw}</Text>;
  }

  // Render colorpath segments
  return pathObj.segments.map((seg, i) => (
    <Text key={i} color={seg.color}>{seg.text}</Text>
  ));
}

// Pane row component
function PaneRow({ pane, isSelected, claudeColorIndex, multiLine }) {
  const prefix = isSelected ? ">   " : "    ";
  // Only animate color while loading, otherwise use first color
  const claudeColor = pane.loadingSummary ? CLAUDE_COLORS[claudeColorIndex] : CLAUDE_COLORS[0];

  const summaryPart = pane.isClaudeCode && (
    <>
      <Text color={claudeColor}> *</Text>
      {pane.loadingSummary && !pane.summary && (
        <Text> → <Text color="gray">Summarizing...</Text></Text>
      )}
      {pane.summary && <Text> → <Text color="#CCCC66">{pane.summary}</Text></Text>}
    </>
  );

  if (multiLine && pane.isClaudeCode) {
    return (
      <Box flexDirection="column">
        <Text>
          {prefix}
          <Text bold={isSelected}>{pane.index}</Text>{" "}
          {formatPath(pane.path)}
        </Text>
        <Text>      {summaryPart}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        {prefix}
        <Text bold={isSelected}>{pane.index}</Text>{" "}
        {formatPath(pane.path)}
        {summaryPart}
      </Text>
    </Box>
  );
}

// New session row
function NewSessionRow({ isSelected }) {
  const prefix = isSelected ? "> " : "  ";
  const color = isSelected ? "cyan" : "green";

  return (
    <Text color={color}>
      {prefix}
      <Text bold={isSelected}>+ new session</Text>
    </Text>
  );
}

// Build flat list of navigable rows
function buildRowList(sessions) {
  const rows = [];
  for (const session of sessions) {
    rows.push({ type: "session", session });
    for (const pane of session.panes) {
      rows.push({ type: "pane", session, pane });
    }
  }
  rows.push({ type: "new" });
  return rows;
}

// Calculate if any pane line would exceed terminal width
function shouldUseMultiLine(sessions, termWidth) {
  for (const session of sessions) {
    for (const pane of session.panes) {
      if (!pane.isClaudeCode) continue;
      // Estimate line length: "    0 " (6) + path + " * → " (5) + summary
      // Use rawPath length or sum of segment text lengths
      const pathLen = pane.path.raw !== null
        ? pane.path.raw.length
        : pane.path.segments.reduce((sum, s) => sum + s.text.length, 0);
      const summaryLen = pane.summary ? pane.summary.length : 14; // "Summarizing..."
      const lineLen = 6 + pathLen + 5 + summaryLen;
      if (lineLen > termWidth) return true;
    }
  }
  return false;
}

// Main app with keyboard navigation
function App() {
  const [sessions, setSessions] = useState(() => getTmuxSessions());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmingKill, setConfirmingKill] = useState(null);
  const [claudeColorIndex, setClaudeColorIndex] = useState(0);
  const { exit } = useApp();

  // Build navigable row list
  const rows = buildRowList(sessions);
  const termWidth = process.stdout.columns || 80;
  const multiLine = shouldUseMultiLine(sessions, termWidth);
  const totalItems = rows.length;

  // Animate Claude indicator color
  useEffect(() => {
    const interval = setInterval(() => {
      setClaudeColorIndex((prev) => (prev + 1) % CLAUDE_COLORS.length);
    }, 400);
    return () => clearInterval(interval);
  }, []);

  // Fetch summaries for Claude panes
  useEffect(() => {
    sessions.forEach((session, sessionIdx) => {
      session.panes.forEach((pane, paneIdx) => {
        if (pane.isClaudeCode && pane.loadingSummary && !pane.summary) {
          getClaudeSummary(pane.paneId).then(({ summary }) => {
            setSessions((prev) => {
              const updated = JSON.parse(JSON.stringify(prev));
              if (updated[sessionIdx] && updated[sessionIdx].panes[paneIdx]) {
                updated[sessionIdx].panes[paneIdx].summary = summary;
                updated[sessionIdx].panes[paneIdx].loadingSummary = false;
              }
              return updated;
            });
          });
        }
      });
    });
  }, [sessions.length]);

  const killSession = (sessionName) => {
    try {
      execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`);
      const newSessions = getTmuxSessions();
      setSessions(newSessions);
      const newRows = buildRowList(newSessions);
      if (selectedIndex >= newRows.length) {
        setSelectedIndex(Math.max(0, newRows.length - 1));
      }
    } catch {}
  };

  const createNewSession = () => {
    cleanup();
    exit();
    setTimeout(() => {
      try {
        execSync("tmux new-session", { stdio: "inherit" });
      } catch {
        process.exit(1);
      }
    }, 50);
  };

  const attachToSession = (sessionName, pane = null) => {
    cleanup();
    exit();
    setTimeout(() => {
      try {
        // Select window and pane BEFORE attaching (attach blocks until detach)
        if (pane !== null) {
          execSync(`tmux select-window -t "${sessionName}:${pane.windowIndex}"`, {
            stdio: "pipe",
          });
          execSync(`tmux select-pane -t "${pane.paneId}"`, {
            stdio: "pipe",
          });
        }
        execSync(`tmux attach-session -t "${sessionName}"`, {
          stdio: "inherit",
        });
      } catch {
        process.exit(1);
      }
    }, 50);
  };

  useInput((input, key) => {
    // Handle confirmation prompt
    if (confirmingKill) {
      if (input === "y" || input === "Y") {
        killSession(confirmingKill);
        setConfirmingKill(null);
      } else if (input === "n" || input === "N" || key.escape) {
        setConfirmingKill(null);
      }
      return;
    }

    if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => (prev === 0 ? totalItems - 1 : prev - 1));
    } else if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => (prev === totalItems - 1 ? 0 : prev + 1));
    } else if (key.return) {
      const row = rows[selectedIndex];
      if (row.type === "new") {
        createNewSession();
      } else if (row.type === "session") {
        attachToSession(row.session.name);
      } else if (row.type === "pane") {
        attachToSession(row.session.name, row.pane);
      }
    } else if (input === "x" || input === "d") {
      const row = rows[selectedIndex];
      if (row.type === "session" || row.type === "pane") {
        setConfirmingKill(row.session.name);
      }
    } else if (input === "q" || key.escape) {
      cleanup();
      exit();
      process.exit(0);
    }
  });

  // Track which sessions are being rendered to know where to place selected marker
  let currentRowIndex = 0;

  return (
    <Box flexDirection="column">
      <Text dimColor>
        j/k: navigate | enter: attach | x: kill session | q: quit
      </Text>
      <Text> </Text>
      {sessions.map((session) => {
        const sessionRowIndex = currentRowIndex;
        currentRowIndex++;

        const paneComponents = session.panes.map((pane) => {
          const paneRowIndex = currentRowIndex;
          currentRowIndex++;
          return (
            <PaneRow
              key={`pane-${session.name}-${pane.paneId}`}
              pane={pane}
              isSelected={selectedIndex === paneRowIndex}
              claudeColorIndex={claudeColorIndex}
              multiLine={multiLine}
            />
          );
        });

        return (
          <Box key={session.name} flexDirection="column" marginBottom={1}>
            <SessionHeader
              session={session}
              isSelected={selectedIndex === sessionRowIndex}
            />
            {paneComponents}
          </Box>
        );
      })}
      <Box marginBottom={1}>
        <NewSessionRow isSelected={selectedIndex === rows.length - 1} />
      </Box>
      {confirmingKill && (
        <Box marginTop={1}>
          <Text color="red">Kill session "{confirmingKill}"? (y/n)</Text>
        </Box>
      )}
    </Box>
  );
}

// Handle direct session name argument
const args = process.argv.slice(2);
if (args.length > 0) {
  const sessionArg = args[0];
  try {
    execSync(`tmux attach-session -t "${sessionArg}"`, { stdio: "inherit" });
  } catch {
    process.exit(1);
  }
} else if (process.env.TMUX) {
  // Already inside tmux - can't attach to nested sessions, just list them
  const sessions = getTmuxSessions();
  if (sessions.length === 0) {
    console.log("No tmux sessions found.");
  } else {
    console.log("Inside tmux - listing sessions (can't attach from here):\n");
    sessions.forEach((s) => {
      const attachedStr = s.attached ? " (attached)" : "";
      console.log(`  ${s.name} started ${s.age} ago${attachedStr}`);
      s.panes.forEach((p) => {
        const claudeMark = p.isClaudeCode ? " *" : "";
        // Use rawPath for plain text output
        console.log(`    ${p.index} ${p.rawPath}${claudeMark}`);
      });
    });
  }
} else {
  render(<App />);
}
