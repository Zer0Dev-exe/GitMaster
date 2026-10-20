import fs from "node:fs";
import readline from "node:readline";
import chalk, { ChalkInstance } from "chalk";
import { GitMasterConfig, ProjectConfig } from "./types.js";
import { gitService } from "./core/gitService.js";
import { pm2Service, Pm2ProcessInfo } from "./core/pm2Service.js";
import { watcher } from "./core/watcher.js";
import { logger } from "./utils/logger.js";

type Phase = "idle" | "checking" | "updating";

interface Row {
  project: ProjectConfig;
  phase: Phase;
  behind: number | null;
  commit?: string;
  branch?: string;
  dirty: boolean;
  error?: string;
  checkedAt?: number;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SELECTED_BG = "#26324d";
const ACCENT = chalk.hex("#7dcfff");
const ANSI = /\x1b\[[0-9;]*m/g;

const vlen = (s: string) => s.replace(ANSI, "").length;
const fit = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s);
const pad = (s: string, w: number) => fit(s, w).padEnd(w);
const padAnsi = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vlen(s)));

function ago(ts?: number): string {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)}m`;
  return `hace ${Math.floor(s / 3600)}h`;
}

function box(title: string, inner: string[], width: number, focus = false): string[] {
  const border = focus ? ACCENT : chalk.gray;
  const w = width - 2;
  const head = `─ ${title} `;
  const top = border("╭" + head) + border("─".repeat(Math.max(0, w - head.length)) + "╮");
  const body = inner.map((l) => border("│") + padAnsi(" " + l, w) + border("│"));
  return [top, ...body, border("╰" + "─".repeat(w) + "╯")];
}

function readLogTail(file: string, maxBytes = 32_768): string[] {
  try {
    const fd = fs.openSync(file, "r");
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const LEVEL_STYLE: Record<string, ChalkInstance> = {
  INFO: chalk.cyan,
  GIT: chalk.blue,
  BUILD: chalk.yellow,
  PM2: chalk.magentaBright,
  SUCCESS: chalk.green,
  WARN: chalk.yellowBright,
  ERROR: chalk.red,
};

export async function runTui(config: GitMasterConfig): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("El TUI necesita una terminal interactiva.");
  }

  const rows: Row[] = config.projects.map((project) => ({ project, phase: "idle", behind: null, dirty: false }));
  let pm2List: Pm2ProcessInfo[] = [];
  let selected = 0;
  let showLogs = true;
  let filterLogs = false;
  let quitting = false;
  let frame = 0;
  let lastFrame = "";
  let logLines: string[] = [];

  // El logger escribe a fichero (que el panel lee); su salida por consola rompería la pantalla
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};

  const out = (s: string) => process.stdout.write(s);
  const logFile = logger.getLogFilePath();

  async function refreshRow(row: Row): Promise<void> {
    if (!row.project.enabled || row.phase !== "idle") return;
    row.phase = "checking";
    try {
      const validation = await gitService.validateRepository(row.project);
      if (!validation.valid) throw new Error(validation.reason);
      const st = await gitService.checkForUpdates(row.project);
      row.behind = st.commitsBehind;
      row.commit = st.currentCommit.slice(0, 7);
      row.branch = st.branch;
      row.dirty = await gitService.hasLocalChanges(row.project);
      row.error = watcher.getLastError(row.project.name);
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    } finally {
      row.checkedAt = Date.now();
      row.phase = "idle";
    }
  }

  async function refreshPm2(): Promise<void> {
    pm2List = await pm2Service.getProcessList();
  }

  async function pool(items: Row[], size: number, fn: (r: Row) => Promise<void>): Promise<void> {
    const queue = [...items];
    await Promise.all(
      Array.from({ length: Math.min(size, queue.length) }, async () => {
        for (let r = queue.shift(); r; r = queue.shift()) await fn(r);
      })
    );
  }

  const refreshAll = () => {
    void refreshPm2();
    void pool(rows, config.concurrency, refreshRow);
  };

  async function updateRow(row: Row): Promise<void> {
    if (!row.project.enabled || row.phase !== "idle") return;
    row.phase = "updating";
    try {
      await watcher.processProject(row.project);
    } finally {
      row.phase = "idle";
    }
    await refreshRow(row);
    row.error = watcher.getLastError(row.project.name) ?? row.error;
    void refreshPm2();
  }

  const pm2Of = (row: Row) =>
    row.project.pm2 ? pm2List.find((p) => p.name.toLowerCase() === row.project.pm2!.processName.toLowerCase()) : undefined;

  function render(): string {
    const cols = process.stdout.columns || 100;
    const lines = process.stdout.rows || 30;
    const width = Math.max(60, cols);
    const spin = SPINNER[frame % SPINNER.length];

    const count = {
      ok: rows.filter((r) => r.project.enabled && !r.error && r.behind === 0).length,
      pending: rows.filter((r) => (r.behind ?? 0) > 0).length,
      err: rows.filter((r) => r.error).length,
    };
    const title = chalk.bold.hex("#bb9af7")(" ◆ ") + chalk.bold.hex("#7dcfff")("GitMaster");
    const summary =
      chalk.gray(`${rows.length} proyectos  `) +
      chalk.green(`✔ ${count.ok}  `) +
      (count.pending ? chalk.yellow(`↓ ${count.pending}  `) : chalk.gray(`↓ 0  `)) +
      (count.err ? chalk.red(`✖ ${count.err} `) : chalk.gray(`✖ 0 `));
    const header = title + " ".repeat(Math.max(1, width - vlen(title) - vlen(summary))) + summary;

    // --- Tabla ---
    const nameW = Math.min(20, Math.max(8, ...rows.map((r) => r.project.name.length)));
    const branchW = Math.min(12, Math.max(6, ...rows.map((r) => (r.branch ?? r.project.branch ?? "").length)));
    const pm2W = Math.min(22, Math.max(10, ...rows.map((r) => (r.project.pm2?.processName.length ?? 0) + 9)));
    const innerW = width - 4;

    const avail = lines - 3;
    const detailH = 6;
    const logMin = 6;
    let tableH = Math.min(rows.length + 3, Math.max(5, avail - detailH - (showLogs ? logMin : 0)));
    const visible = Math.max(1, tableH - 3);
    tableH = visible + 3;
    const offset = Math.min(Math.max(0, selected - visible + 1), Math.max(0, rows.length - visible));

    const head = chalk.gray.bold(
      "  " + pad("PROYECTO", nameW) + "  " + pad("RAMA", branchW) + "  " + pad("COMMIT", 7) + "  " + pad("PM2", pm2W) + "  ESTADO"
    );
    const tableLines = [head];
    for (let i = offset; i < Math.min(rows.length, offset + visible); i++) {
      const r = rows[i];
      const sel = i === selected;
      const bg = (c: ChalkInstance) => (sel ? c.bgHex(SELECTED_BG) : c);
      const dim = !r.project.enabled;

      const proc = pm2Of(r);
      let pm2Text = "—";
      let pm2Style = chalk.gray;
      if (r.project.pm2) {
        if (!proc) { pm2Text = `○ ${r.project.pm2.processName}`; pm2Style = chalk.gray; }
        else if (proc.status === "online") { pm2Text = `● ${proc.name}`; pm2Style = chalk.green; }
        else { pm2Text = `● ${proc.name}`; pm2Style = chalk.red; }
      }

      let stateText: string;
      let stateStyle: ChalkInstance;
      if (dim) { stateText = "desactivado"; stateStyle = chalk.gray; }
      else if (r.phase === "checking") { stateText = `${spin} revisando…`; stateStyle = chalk.cyan; }
      else if (r.phase === "updating") { stateText = `${spin} actualizando…`; stateStyle = chalk.yellow.bold; }
      else if (r.error) { stateText = `✖ ${r.error.split("\n")[0]}`; stateStyle = chalk.red; }
      else if ((r.behind ?? 0) > 0) { stateText = `↓ ${r.behind} pendiente${r.behind === 1 ? "" : "s"}`; stateStyle = chalk.yellow; }
      else if (r.behind === 0) { stateText = "✔ al día"; stateStyle = chalk.green; }
      else { stateText = "· sin datos"; stateStyle = chalk.gray; }
      if (r.dirty && !dim && r.phase === "idle" && !r.error) stateText += "  ⚠ cambios locales";

      const stateW = Math.max(8, innerW - (2 + nameW + 2 + branchW + 2 + 7 + 2 + pm2W + 2));
      const sp = bg(chalk);
      const line =
        bg(sel ? ACCENT : chalk.gray)(sel ? "▌ " : "  ") +
        bg(dim ? chalk.gray : chalk.bold.white)(pad(r.project.name, nameW)) + sp("  ") +
        bg(chalk.blue)(pad(r.branch ?? r.project.branch ?? "—", branchW)) + sp("  ") +
        bg(chalk.gray)(pad(r.commit ?? "—", 7)) + sp("  ") +
        bg(pm2Style)(pad(pm2Text, pm2W)) + sp("  ") +
        bg(stateStyle)(pad(stateText, stateW));
      tableLines.push(line);
    }
    const tableBox = box(`Proyectos`, tableLines, width, true);
    while (tableBox.length < tableH) tableBox.splice(tableBox.length - 1, 0, chalk.gray("│") + " ".repeat(width - 2) + chalk.gray("│"));

    // --- Detalle ---
    const cur = rows[selected];
    const detail: string[] = [];
    if (cur) {
      const p = cur.project;
      const k = (s: string) => chalk.gray(s.padEnd(9));
      const proc = pm2Of(cur);
      detail.push(k("Ruta") + chalk.white(fit(p.path, innerW - 10)));
      detail.push(k("Remoto") + chalk.white(`${p.remote}/${p.branch ?? "auto"}`) + chalk.gray("   cada ") + chalk.white(`${p.intervalSeconds ?? config.defaultIntervalSeconds}s`) + chalk.gray("   revisado ") + chalk.white(ago(cur.checkedAt)));
      detail.push(k("Pipeline") + chalk.white(fit([p.installDepsOnPull ? `install: ${p.installCommand || "—"}` : "install: off", `build: ${p.buildCommand || "—"}`].join("   "), innerW - 10)));
      detail.push(k("PM2") + (p.pm2 ? chalk.white(`${p.pm2.processName} · ${p.pm2.action}`) + (proc ? chalk.gray(`   id ${proc.pm_id} · ${proc.status}`) : chalk.gray("   no registrado")) : chalk.gray("ninguno")));
      if (watcher.hasPendingPipeline(p.name)) detail.push(chalk.yellow("⚠ pipeline pendiente: se reintentará en el próximo ciclo"));
    }
    while (detail.length < detailH - 2) detail.push("");
    const detailBox = box(cur ? cur.project.name : "Detalle", detail.slice(0, detailH - 2), width);

    // --- Logs ---
    let logBox: string[] = [];
    const used = tableBox.length + detailBox.length;
    const logH = avail - used;
    if (showLogs && logH >= 4) {
      const n = logH - 2;
      const name = cur?.project.name;
      const parsed = logLines
        .map((l) => /^\[([^\]]+)\] \[(\w+)\] (?:\[([^\]]+)\] )?(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .filter((m) => !filterLogs || m[3] === name)
        .slice(-n);
      const shown = parsed.map((m) => {
        const time = new Date(m[1]).toLocaleTimeString("es-ES", { hour12: false });
        const lvl = m[2];
        const style = LEVEL_STYLE[lvl] ?? chalk.white;
        const proj = m[3] ? chalk.bold.magenta(pad(m[3], nameW)) + " " : "";
        const used = 8 + 1 + 7 + 1 + (m[3] ? nameW + 1 : 0);
        return chalk.gray(time) + " " + style(pad(lvl, 7)) + " " + proj + style(fit(m[4].replace(/\s+/g, " "), Math.max(10, innerW - used)));
      });
      while (shown.length < n) shown.unshift("");
      logBox = box(filterLogs ? `Logs · ${name}` : "Logs", shown, width);
    }

    // --- Pie ---
    const key = (k: string, t: string) => ACCENT.bold(k) + chalk.gray(` ${t}  `);
    const full =
      " " + key("↑↓", "mover") + key("enter", "actualizar") + key("a", "actualizar todo") + key("r", "revisar") +
      key("l", `logs ${showLogs ? "on" : "off"}`) + key("f", filterLogs ? "todos" : "filtrar") + key("q", "salir");
    const compact =
      " " + key("↑↓", "mover") + key("⏎", "update") + key("a", "todo") + key("r", "refresh") + key("l", "logs") + key("f", "filtro") + key("q", "salir");
    const footer = vlen(full) <= width ? full : compact;

    return [header, ...tableBox, ...detailBox, ...logBox, quitting ? chalk.yellow(" Esperando a que terminen las tareas en curso… (Ctrl+C para forzar)") : footer].join("\x1b[K\n") + "\x1b[K";
  }

  function paint() {
    frame++;
    const f = render();
    if (f !== lastFrame) {
      lastFrame = f;
      out("\x1b[H" + f + "\x1b[J");
    }
  }

  function cleanup() {
    clearInterval(timers.paint); clearInterval(timers.log); clearInterval(timers.auto); clearInterval(timers.pm2);
    console.log = original.log; console.warn = original.warn; console.error = original.error;
    out("\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }

  async function quit(force = false) {
    if (force || rows.every((r) => r.phase !== "updating")) {
      cleanup();
      process.exit(0);
    }
    quitting = true;
    const wait = setInterval(() => {
      if (rows.every((r) => r.phase !== "updating")) { clearInterval(wait); cleanup(); process.exit(0); }
    }, 300);
  }

  const timers = {
    paint: setInterval(paint, 120),
    log: setInterval(() => { logLines = readLogTail(logFile); }, 1000),
    auto: setInterval(refreshAll, 60_000),
    pm2: setInterval(() => void refreshPm2(), 10_000),
  };

  out("\x1b[?1049h\x1b[?25l");
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.on("resize", () => { lastFrame = ""; out("\x1b[2J"); paint(); });
  process.on("SIGTERM", () => void quit(true));

  process.stdin.on("keypress", (_s, key) => {
    if (!key) return;
    if (key.ctrl && key.name === "c") return void quit(quitting);
    if (quitting) return;
    switch (key.name) {
      case "up": case "k": selected = (selected - 1 + rows.length) % rows.length; break;
      case "down": case "j": selected = (selected + 1) % rows.length; break;
      case "home": selected = 0; break;
      case "end": selected = rows.length - 1; break;
      case "return": case "u": if (rows[selected]) void updateRow(rows[selected]); break;
      case "a": void pool(rows.filter((r) => (r.behind ?? 0) > 0 || watcher.hasPendingPipeline(r.project.name)), config.concurrency, updateRow); break;
      case "r": refreshAll(); break;
      case "l": showLogs = !showLogs; break;
      case "f": filterLogs = !filterLogs; break;
      case "q": void quit(); break;
    }
    paint();
  });

  logLines = readLogTail(logFile);
  refreshAll();
  paint();
  await new Promise<void>(() => {});
}
