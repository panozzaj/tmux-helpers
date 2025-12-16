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
        },
      );

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

// Session row component
function SessionRow({ session, isSelected }) {
  const attachedStr = session.attached ? " (attached)" : "";
  const windowWord = session.windows === 1 ? "window" : "windows";
  const prefix = isSelected ? "> " : "  ";
  const color = isSelected ? "cyan" : undefined;

  return (
    <Box flexDirection="column">
      <Text color={color}>
        {prefix}
        <Text bold={isSelected}>{session.name}</Text>
        {attachedStr} | {session.windows} {windowWord} | {session.age} old |{" "}
        <Text color={isSelected ? "cyan" : "blue"}>{session.path}</Text> |{" "}
        {session.command}
      </Text>
      {session.loadingSummary && !session.summary && (
        <Text color="gray"> → summarizing...</Text>
      )}
      {session.summary && <Text color="yellow"> → {session.summary}</Text>}
    </Box>
  );
}

// Main app with keyboard navigation
function App() {
  const [sessions, setSessions] = useState(getTmuxSessions);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { exit } = useApp();

  useEffect(() => {
    // Fetch summaries for claude sessions in parallel
    sessions.forEach((session, idx) => {
      if (session.command === "claude") {
        getClaudeSummary(session.name).then((summary) => {
          setSessions((prev) => {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], summary, loadingSummary: false };
            return updated;
          });
        });
      }
    });
  }, []);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => Math.min(sessions.length - 1, prev + 1));
    } else if (key.return) {
      // Attach to selected session
      const session = sessions[selectedIndex];
      if (session) {
        exit();
        // Use setTimeout to let ink cleanup before exec
        setTimeout(() => {
          try {
            execSync(`tmux attach-session -t "${session.name}"`, {
              stdio: "inherit",
            });
          } catch {
            process.exit(1);
          }
        }, 50);
      }
    } else if (input === "q" || key.escape) {
      exit();
    }
  });

  if (sessions.length === 0) {
    return <Text>No tmux sessions found</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>
        j/k or arrows to navigate, enter to attach, q to quit
      </Text>
      <Text> </Text>
      {sessions.map((session, idx) => (
        <Box key={session.name} marginBottom={1}>
          <SessionRow session={session} isSelected={idx === selectedIndex} />
        </Box>
      ))}
    </Box>
  );
}

// Handle direct session name argument
const sessionArg = process.argv[2];
if (sessionArg) {
  try {
    execSync(`tmux attach-session -t "${sessionArg}"`, { stdio: "inherit" });
  } catch {
    process.exit(1);
  }
} else {
  render(<App />);
}
