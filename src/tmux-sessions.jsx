import { execSync, spawn } from "child_process";
import React, { useState, useEffect } from "react";
import { render, Text, Box, useInput, useApp } from "ink";

// Get tmux session data
function getTmuxSessions() {
  try {
    const data = execSync(
      `tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}|#{session_created}|#{pane_current_command}' 2>/dev/null`,
      { encoding: "utf-8" },
    ).trim();

    if (!data) return [];

    const now = Math.floor(Date.now() / 1000);

    return data.split("\n").map((line) => {
      const [name, windows, attached, created, cmd] = line.split("|");

      // Get pane path
      let path = "";
      try {
        path = execSync(
          `tmux display-message -t "${name}" -p '#{pane_current_path}' 2>/dev/null`,
          { encoding: "utf-8" },
        ).trim();
        path = path.replace(process.env.HOME, "~");
      } catch {}

      // Format age
      const ageSecs = now - parseInt(created);
      const days = Math.floor(ageSecs / 86400);
      const hours = Math.floor((ageSecs % 86400) / 3600);
      const mins = Math.floor((ageSecs % 3600) / 60);
      let age;
      if (days > 0) age = `${days}d ${hours}h`;
      else if (hours > 0) age = `${hours}h ${mins}m`;
      else age = `${mins}m`;

      // Normalize command - detect Claude Code (shows as node or version like 2.0.61)
      const isClaudeCode = cmd === "node" || /^\d+\.\d+\.\d+$/.test(cmd);
      const command = isClaudeCode ? "claude" : cmd;

      return {
        name,
        windows: parseInt(windows),
        attached: attached === "1",
        age,
        command,
        path,
        summary: null,
        loadingSummary: command === "claude",
      };
    });
  } catch {
    return [];
  }
}

// Track spawned processes for cleanup
const spawnedProcesses = [];

// Get visible pane content and summarize with LLM
async function getClaudeSummary(sessionName) {
  try {
    const paneContent = execSync(
      `tmux capture-pane -t "${sessionName}" -p 2>/dev/null | tail -50`,
      { encoding: "utf-8" },
    ).trim();

    if (!paneContent) return null;

    return new Promise((resolve) => {
      const llm = spawn(
        "llm",
        [
          "-m",
          "claude-3-haiku",
          'Summarize what this Claude Code session is working on in 10 words or less. Just output the summary, nothing else. If unclear, say "unclear"',
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          detached: false,
        },
      );

      spawnedProcesses.push(llm);

      let output = "";
      llm.stdout.on("data", (data) => {
        output += data.toString();
      });
      llm.on("close", () => resolve(output.trim() || null));
      llm.on("error", () => resolve(null));

      llm.stdin.write(paneContent);
      llm.stdin.end();

      // Timeout after 10s
      setTimeout(() => {
        llm.kill();
        resolve(null);
      }, 10000);
    });
  } catch {
    return null;
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

// Session row component
function SessionRow({ session, isSelected }) {
  const attachedStr = session.attached ? " (attached)" : "";
  const windowWord = session.windows === 1 ? "window" : "windows";
  const prefix = isSelected ? "> " : "  ";

  return (
    <Box flexDirection="column">
      <Text>
        {prefix}
        <Text bold={isSelected}>{session.name}</Text>
        {attachedStr} | {session.windows} {windowWord} | {session.age} old |{" "}
        <Text color="blue">{session.path}</Text> | {session.command}
      </Text>
      {session.loadingSummary && !session.summary && (
        <Text color="gray"> → summarizing...</Text>
      )}
      {session.summary && <Text color="yellow"> → {session.summary}</Text>}
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

// Main app with keyboard navigation
function App() {
  const [sessions, setSessions] = useState(getTmuxSessions);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [summaryCache, setSummaryCache] = useState({});
  const [confirmingKill, setConfirmingKill] = useState(null);
  const { exit } = useApp();

  // Total items = sessions + 1 for "new session"
  const totalItems = sessions.length + 1;
  const newSessionIndex = sessions.length;

  useEffect(() => {
    // Fetch summaries for claude sessions in parallel, using cache
    sessions.forEach((session, idx) => {
      if (session.command === "claude" && !summaryCache[session.name]) {
        getClaudeSummary(session.name).then((summary) => {
          setSummaryCache((prev) => ({ ...prev, [session.name]: summary }));
          setSessions((prev) => {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], summary, loadingSummary: false };
            return updated;
          });
        });
      } else if (summaryCache[session.name]) {
        // Use cached summary
        setSessions((prev) => {
          const updated = [...prev];
          if (updated[idx].loadingSummary) {
            updated[idx] = {
              ...updated[idx],
              summary: summaryCache[session.name],
              loadingSummary: false,
            };
          }
          return updated;
        });
      }
    });
  }, [sessions.length]);

  const killSession = (sessionName) => {
    try {
      execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`);
      // Refresh sessions list
      const newSessions = getTmuxSessions();
      setSessions(newSessions);
      // Adjust selection if needed
      if (selectedIndex >= newSessions.length) {
        setSelectedIndex(Math.max(0, newSessions.length));
      }
    } catch {}
  };

  const createNewSession = () => {
    exit();
    setTimeout(() => {
      try {
        execSync("tmux new-session", { stdio: "inherit" });
      } catch {
        process.exit(1);
      }
    }, 50);
  };

  const attachToSession = (sessionName) => {
    exit();
    setTimeout(() => {
      try {
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
      // Ignore other keys while confirming
      return;
    }

    if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => Math.min(totalItems - 1, prev + 1));
    } else if (key.return) {
      if (selectedIndex === newSessionIndex) {
        createNewSession();
      } else {
        const session = sessions[selectedIndex];
        if (session) {
          attachToSession(session.name);
        }
      }
    } else if (input === "x" || input === "d") {
      // Kill selected session (not "new session" row)
      if (selectedIndex < sessions.length) {
        const session = sessions[selectedIndex];
        if (session) {
          setConfirmingKill(session.name);
        }
      }
    } else if (input === "q" || key.escape) {
      cleanup();
      exit();
      process.exit(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>
        j/k: navigate | enter: attach | x: kill session | q: quit
      </Text>
      <Text> </Text>
      {sessions.map((session, idx) => (
        <Box key={session.name} marginBottom={1}>
          <SessionRow session={session} isSelected={idx === selectedIndex} />
        </Box>
      ))}
      <Box marginBottom={1}>
        <NewSessionRow isSelected={selectedIndex === newSessionIndex} />
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
} else {
  render(<App />);
}
