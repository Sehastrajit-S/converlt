// Integrated terminal: real pseudo-terminals (ConPTY on Windows) via node-pty, one per tab.
import os from "node:os";
import { spawn, type IPty } from "node-pty";

export interface TerminalHooks {
  data(id: number, data: string): void;
  exit(id: number, code: number): void;
}

function defaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

export class Terminals {
  private next = 1;
  private ptys = new Map<number, IPty>();

  constructor(private hooks: TerminalHooks) {}

  create(cwd: string | undefined, cols: number, rows: number): { id: number; shell: string } {
    const id = this.next++;
    const shell = defaultShell();
    // VS Code-style terminals inherit this, and it would make Electron start as plain Node.
    const { ELECTRON_RUN_AS_NODE: _x, ...env } = process.env;
    const pty = spawn(shell, [], {
      name: "xterm-256color",
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 1),
      cwd: cwd ?? os.homedir(),
      env: { ...env, TERM_PROGRAM: "Converlt", COLORTERM: "truecolor" } as Record<string, string>,
    });
    pty.onData((d) => this.hooks.data(id, d));
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(id);
      this.hooks.exit(id, exitCode);
    });
    this.ptys.set(id, pty);
    return { id, shell: shell.replace(/\.exe$/i, "").split(/[\\/]/).pop()! };
  }

  write(id: number, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 1));
    } catch {
      // the process may have just exited
    }
  }

  kill(id: number): void {
    this.ptys.get(id)?.kill();
    this.ptys.delete(id);
  }

  dispose(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}
