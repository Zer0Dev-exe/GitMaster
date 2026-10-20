import { spawn } from "node:child_process";
import path from "node:path";
import { logger } from "../utils/logger.js";

export interface ExecutionResult {
  success: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
}

const COMMAND_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_CHARS = 200_000;

export class BuildService {
  async executeCommand(command: string, projectPath: string, projectName: string): Promise<ExecutionResult> {
    const startTime = Date.now();
    logger.build(`Ejecutando: "${command}" en ${path.resolve(projectPath)}`, projectName);

    return new Promise((resolve, reject) => {
      // En Windows se usa shell: true para resolver scripts como pnpm.cmd
      const child = spawn(command, {
        cwd: path.resolve(projectPath),
        shell: true,
        timeout: COMMAND_TIMEOUT_MS,
        env: {
          ...process.env,
          FORCE_COLOR: "1"
        }
      });

      let outputBuffer = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        outputBuffer = (outputBuffer + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        outputBuffer = (outputBuffer + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
      });

      child.on("close", (code, signal) => {
        const durationMs = Date.now() - startTime;
        const exitCode = code ?? (signal ? 1 : 0);
        if (exitCode === 0) {
          logger.success(`Comando finalizado con éxito (${(durationMs / 1000).toFixed(2)}s)`, projectName);
          resolve({
            success: true,
            exitCode: 0,
            output: outputBuffer,
            durationMs
          });
        } else {
          const errMsg = `El comando falló con código de salida ${exitCode}.\nSalida:\n${outputBuffer.trim()}`;
          logger.error(`Error durante la ejecución del comando:`, new Error(errMsg), projectName);
          reject(new Error(errMsg));
        }
      });

      child.on("error", (err) => {
        const durationMs = Date.now() - startTime;
        logger.error(`Error al invocar el comando "${command}":`, err, projectName);
        reject(err);
      });
    });
  }
}

export const buildService = new BuildService();
