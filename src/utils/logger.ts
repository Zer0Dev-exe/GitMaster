import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class Logger {
  private logFilePath: string;

  constructor() {
    const logsDir = path.resolve(process.env.GITMASTER_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    this.logFilePath = path.join(logsDir, "gitmaster.log");
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  private getTimestamp(): string {
    const now = new Date();
    return chalk.gray(`[${now.toLocaleTimeString()}]`);
  }

  private writeToFile(level: string, message: string, projectName?: string): void {
    const now = new Date().toISOString();
    const prefix = projectName ? `[${projectName}] ` : "";
    const line = `[${now}] [${level}] ${prefix}${message}\n`;
    try {
      fs.appendFileSync(this.logFilePath, line, "utf8");
    } catch {
      // Ignorar fallo de escritura si el log está bloqueado
    }
  }

  info(message: string, projectName?: string): void {
    const tag = chalk.cyan("[INFO]");
    const project = projectName ? chalk.bold.magenta(`[${projectName}] `) : "";
    console.log(`${this.getTimestamp()} ${tag} ${project}${message}`);
    this.writeToFile("INFO", message, projectName);
  }

  git(message: string, projectName?: string): void {
    const tag = chalk.blue("[GIT]");
    const project = projectName ? chalk.bold.magenta(`[${projectName}] `) : "";
    console.log(`${this.getTimestamp()} ${tag} ${project}${message}`);
    this.writeToFile("GIT", message, projectName);
  }

  build(message: string, projectName?: string): void {
    const tag = chalk.yellow("[BUILD]");
    const project = projectName ? chalk.bold.magenta(`[${projectName}] `) : "";
    console.log(`${this.getTimestamp()} ${tag} ${project}${message}`);
    this.writeToFile("BUILD", message, projectName);
  }

  pm2(message: string, projectName?: string): void {
    const tag = chalk.magentaBright("[PM2]");
    const project = projectName ? chalk.bold.magenta(`[${projectName}] `) : "";
    console.log(`${this.getTimestamp()} ${tag} ${project}${message}`);
    this.writeToFile("PM2", message, projectName);
  }

  success(message: string, projectName?: string): void {
    const tag = chalk.green("[SUCCESS]");
    const project = projectName ? chalk.bold.magenta(`[${projectName}] `) : "";
    console.log(`${this.getTimestamp()} ${tag} ${project}${chalk.green(message)}`);
    this.writeToFile("SUCCESS", message, projectName);
  }

  warn(message: string, projectName?: string): void {
    const tag = chalk.yellowBright("[WARN]");
    const project = projectName ? chalk.bold.magenta(`[${projectName}] `) : "";
    console.warn(`${this.getTimestamp()} ${tag} ${project}${chalk.yellow(message)}`);
    this.writeToFile("WARN", message, projectName);
  }

  error(message: string, error?: unknown, projectName?: string): void {
    const tag = chalk.red("[ERROR]");
    const project = projectName ? chalk.bold.magenta(`[${projectName}] `) : "";
    const errDetails = error instanceof Error ? ` - ${error.message}` : error ? ` - ${String(error)}` : "";
    console.error(`${this.getTimestamp()} ${tag} ${project}${chalk.red(message + errDetails)}`);
    this.writeToFile("ERROR", message + errDetails, projectName);
  }
}

export const logger = new Logger();
