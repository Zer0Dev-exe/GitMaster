import { ProjectConfig, GitMasterConfig } from "../types.js";
import { gitService } from "./gitService.js";
import { buildService } from "./buildService.js";
import { pm2Service } from "./pm2Service.js";
import { logger } from "../utils/logger.js";

export class Watcher {
  private activeLocks = new Set<string>();
  private intervals: NodeJS.Timeout[] = [];
  private isRunning = false;

  async processProject(project: ProjectConfig): Promise<boolean> {
    if (!project.enabled) {
      return false;
    }

    const lockKey = project.name.toLowerCase();
    if (this.activeLocks.has(lockKey)) {
      logger.warn(`El proyecto ya tiene una comprobación o build en curso. Omitiendo tick.`, project.name);
      return false;
    }

    this.activeLocks.add(lockKey);

    try {
      // 1. Validar existencia de la carpeta y repositorio
      const validation = await gitService.validateRepository(project);
      if (!validation.valid) {
        logger.warn(`Configuración inválida: ${validation.reason}`, project.name);
        return false;
      }

      // 2. Comprobar si hay novedades en el repositorio remoto
      const updateStatus = await gitService.checkForUpdates(project);

      if (!updateStatus.hasUpdates) {
        // Todo al día
        logger.info(
          `Al día (rama '${updateStatus.branch}', commit ${updateStatus.currentCommit.substring(0, 7)})`,
          project.name
        );
        return false;
      }

      logger.git(
        `Novedad detectada: ${updateStatus.commitsBehind} commit(s) pendientes en '${updateStatus.branch}'. Procediendo con actualización...`,
        project.name
      );

      // 3. Hacer pull de los cambios
      const pullResult = await gitService.pullUpdates(project);
      logger.success(
        `Pull completado (${pullResult.commitBefore.substring(0, 7)} -> ${pullResult.commitAfter.substring(0, 7)}). Archivos modificados: ${pullResult.changedFiles.length}`,
        project.name
      );

      // 4. Instalar dependencias si hubo cambios en los ficheros de dependencias
      if (project.installDepsOnPull && pullResult.dependencyFilesChanged) {
        const installCmd = project.installCommand || "pnpm install";
        logger.build(`Se detectaron cambios en archivos de dependencias. Ejecutando: ${installCmd}`, project.name);
        await buildService.executeCommand(installCmd, project.path, project.name);
      }

      // 5. Ejecutar Build si está configurado
      if (project.buildCommand && project.buildCommand.trim() !== "") {
        logger.build(`Iniciando build: "${project.buildCommand}"`, project.name);
        await buildService.executeCommand(project.buildCommand, project.path, project.name);
      }

      // 6. Reiniciar PM2 si está configurado y encendido
      if (project.pm2) {
        await pm2Service.handlePm2Restart(project.pm2, project.name);
      }

      logger.success(`Pipeline de actualización completado exitosamente.`, project.name);
      return true;
    } catch (error) {
      logger.error(`Error en ciclo de actualización:`, error, project.name);
      return false;
    } finally {
      this.activeLocks.delete(lockKey);
    }
  }

  async checkAll(config: GitMasterConfig): Promise<void> {
    const enabledProjects = config.projects.filter((p) => p.enabled);
    if (enabledProjects.length === 0) {
      logger.warn("No hay proyectos habilitados en la configuración.");
      return;
    }

    logger.info(`Comprobando ${enabledProjects.length} proyecto(s)...`);

    for (const project of enabledProjects) {
      await this.processProject(project);
    }
  }

  start(config: GitMasterConfig): void {
    if (this.isRunning) {
      logger.warn("El watcher ya se encuentra en ejecución.");
      return;
    }

    this.isRunning = true;
    logger.info(`Iniciando GitMaster con ${config.projects.length} proyecto(s) configurado(s).`);

    // Comprobación inicial inmediata de todos los proyectos
    this.checkAll(config);

    // Programar intervalo específico para cada proyecto
    for (const project of config.projects) {
      if (!project.enabled) {
        logger.info(`Proyecto deshabilitado (no se vigilará): ${project.name}`);
        continue;
      }

      const seconds = project.intervalSeconds || config.defaultIntervalSeconds || 60;
      logger.info(
        `Vigilando cada ${seconds}s (rama: ${project.branch || "detectada"}, ruta: ${project.path})`,
        project.name
      );

      const timer = setInterval(() => {
        this.processProject(project).catch((err) => {
          logger.error("Error no controlado en el temporizador:", err, project.name);
        });
      }, seconds * 1000);

      this.intervals.push(timer);
    }

    logger.success("GitMaster está activo y vigilando los repositorios.");
  }

  stop(): void {
    for (const timer of this.intervals) {
      clearInterval(timer);
    }
    this.intervals = [];
    this.isRunning = false;
    logger.info("GitMaster detenido.");
  }
}

export const watcher = new Watcher();
