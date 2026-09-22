import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Pm2Config } from "../types.js";
import { logger } from "../utils/logger.js";

const execAsync = promisify(exec);

export interface Pm2ProcessInfo {
  name: string;
  pm_id: number;
  status: string;
}

export class Pm2Service {
  async getProcessList(): Promise<Pm2ProcessInfo[]> {
    try {
      const { stdout } = await execAsync("pm2 jlist", { windowsHide: true });
      const rawList = JSON.parse(stdout);
      if (!Array.isArray(rawList)) {
        return [];
      }
      return rawList.map((item: any) => ({
        name: item.name,
        pm_id: item.pm_id,
        status: item.pm2_env?.status || "unknown"
      }));
    } catch (err: any) {
      if (err.code === "ENOENT" || err.message?.includes("pm2")) {
        logger.warn("El comando 'pm2' no parece estar disponible en el PATH del sistema.");
      }
      return [];
    }
  }

  async findProcess(processIdentifier: string): Promise<Pm2ProcessInfo | null> {
    const list = await this.getProcessList();
    const idNum = parseInt(processIdentifier, 10);

    const found = list.find(
      (proc) =>
        proc.name.toLowerCase() === processIdentifier.toLowerCase() ||
        (!Number.isNaN(idNum) && proc.pm_id === idNum)
    );

    return found || null;
  }

  async handlePm2Restart(pm2Config: Pm2Config, projectName: string): Promise<boolean> {
    const { processName, action, startIfNotRunning } = pm2Config;

    try {
      const existing = await this.findProcess(processName);

      if (!existing) {
        if (startIfNotRunning) {
          logger.pm2(`El proceso '${processName}' no existe en PM2. Intentando iniciar...`, projectName);
          await execAsync(`pm2 start ${processName}`, { windowsHide: true });
          logger.success(`Proceso '${processName}' iniciado en PM2.`, projectName);
          return true;
        }

        logger.info(
          `El proceso '${processName}' no está registrado en PM2. No se requiere reinicio.`,
          projectName
        );
        return false;
      }

      const isOnline = existing.status === "online";

      if (!isOnline) {
        if (startIfNotRunning) {
          logger.pm2(
            `El proceso '${processName}' está en estado '${existing.status}'. Iniciando...`,
            projectName
          );
          await execAsync(`pm2 start ${existing.pm_id}`, { windowsHide: true });
          logger.success(`Proceso '${processName}' iniciado en PM2.`, projectName);
          return true;
        }

        logger.info(
          `El proceso '${processName}' no está encendido en PM2 (estado: ${existing.status}). No se reinicia.`,
          projectName
        );
        return false;
      }

      // Si está encendido (online), realizar restart o reload
      logger.pm2(`Proceso '${processName}' está encendido en PM2. Ejecutando ${action}...`, projectName);
      const command = `pm2 ${action} ${existing.pm_id}`;
      await execAsync(command, { windowsHide: true });
      logger.success(`Proceso '${processName}' reiniciado con éxito en PM2.`, projectName);
      return true;
    } catch (error: any) {
      logger.error(`Error gestionando PM2 para '${processName}':`, error, projectName);
      return false;
    }
  }
}

export const pm2Service = new Pm2Service();
