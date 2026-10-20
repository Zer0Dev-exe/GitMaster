import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig, addProjectToConfig, removeProjectFromConfig, getConfigFilePath } from "./config.js";
import { watcher } from "./core/watcher.js";
import { pm2Service } from "./core/pm2Service.js";
import { logger } from "./utils/logger.js";
import { ProjectConfig } from "./types.js";
import { runTui } from "./tui.js";
import { runPushAll } from "./push.js";

const program = new Command();

program
  .name("gitmaster")
  .description("Gestor de actualización continua, build y control PM2 para múltiples repositorios Git")
  .version("1.0.0");

// Comando: Iniciar vigilancia
program
  .command("start")
  .description("Inicia el servicio de monitorización y vigilancia de repositorios en tiempo real")
  .action(() => {
    try {
      const config = loadConfig();
      watcher.start(config);

      // Manejo de salida limpia (Ctrl+C)
      const handleShutdown = () => {
        console.log("\n");
        logger.info("Recibida señal de detención. Cerrando temporizadores...");
        watcher.stop().finally(() => process.exit(0));
      };

      process.on("SIGINT", handleShutdown);
      process.on("SIGTERM", handleShutdown);
    } catch (err) {
      logger.error("Error al iniciar GitMaster:", err);
      process.exit(1);
    }
  });

// Comando: Commit + push de todos los proyectos con trabajo pendiente
program
  .command("push-all [projects...]")
  .description("Hace commit de los cambios locales y push de todos los proyectos con trabajo pendiente de subir")
  .option("-m, --message <msg>", "Mensaje de commit", "chore: sync changes")
  .option("-y, --yes", "No pedir confirmación")
  .option("--dry-run", "Solo mostrar el plan, sin commitear ni subir nada")
  .action(async (projects: string[], options: { message: string; yes?: boolean; dryRun?: boolean }) => {
    try {
      process.exit(await runPushAll(loadConfig(), projects, options));
    } catch (err) {
      logger.error("Error en push-all:", err);
      process.exit(1);
    }
  });

// Comando: Interfaz interactiva
program
  .command("tui")
  .alias("ui")
  .description("Abre el panel interactivo (TUI) con el estado de todos los proyectos y procesos PM2")
  .action(async () => {
    try {
      await runTui(loadConfig());
    } catch (err) {
      logger.error("Error en el TUI:", err);
      process.exit(1);
    }
  });

// Comando: Comprobación inmediata única
program
  .command("check-now [projectName]")
  .description("Realiza una comprobación inmediata de todos los proyectos o de uno específico")
  .action(async (projectName?: string) => {
    try {
      const config = loadConfig();

      if (projectName) {
        const project = config.projects.find((p) => p.name.toLowerCase() === projectName.toLowerCase());
        if (!project) {
          logger.error(`No se encontró el proyecto '${projectName}' en la configuración.`);
          process.exit(1);
        }
        logger.info(`Ejecutando comprobación forzada para '${project.name}'...`);
        await watcher.processProject(project);
      } else {
        logger.info("Ejecutando comprobación forzada para todos los proyectos habilitados...");
        await watcher.checkAll(config);
      }
      process.exit(0);
    } catch (err) {
      logger.error("Error en comprobación forzada:", err);
      process.exit(1);
    }
  });

// Comando: Listar proyectos
program
  .command("list")
  .description("Muestra la lista de proyectos registrados y sus configuraciones")
  .action(() => {
    try {
      const config = loadConfig();
      console.log(chalk.bold.cyan("\n=== Proyectos Registrados en GitMaster ==="));
      console.log(`Intervalo por defecto: ${chalk.yellow(config.defaultIntervalSeconds + "s")}\n`);

      if (config.projects.length === 0) {
        console.log(chalk.gray("No hay proyectos configurados en config.jsonc o config.json.\n"));
        return;
      }

      for (const [index, p] of config.projects.entries()) {
        const statusBadge = p.enabled ? chalk.green("[ACTIVO]") : chalk.red("[DESACTIVADO]");
        console.log(`${index + 1}. ${chalk.bold.magenta(p.name)} ${statusBadge}`);
        console.log(`   Ruta:     ${chalk.white(p.path)}`);
        console.log(`   Rama:     ${chalk.blue(p.branch || "Auto-detectar")}`);
        console.log(`   Tiempo:   ${chalk.yellow((p.intervalSeconds || config.defaultIntervalSeconds) + "s")}`);
        console.log(`   Build:    ${chalk.gray(p.buildCommand || "Ninguno")}`);
        console.log(
          `   PM2:      ${p.pm2 ? chalk.magenta(`${p.pm2.processName} (${p.pm2.action})`) : chalk.gray("Ninguno")}`
        );
        console.log("");
      }
    } catch (err) {
      logger.error("Error al listar proyectos:", err);
    }
  });

// Comando: Añadir proyecto
program
  .command("add")
  .description("Registra un nuevo proyecto en GitMaster")
  .requiredOption("-n, --name <name>", "Nombre identificador del proyecto")
  .requiredOption("-p, --path <path>", "Ruta local a la carpeta del repositorio")
  .option("-b, --branch <branch>", "Rama a monitorizar (por defecto detecta la actual)")
  .option("-i, --interval <seconds>", "Intervalo en segundos para este proyecto", (val) => parseInt(val, 10))
  .option("--build <command>", "Comando de compilación (ej. 'pnpm run build')")
  .option("--pm2 <processName>", "Nombre del proceso en PM2 a reiniciar si está encendido")
  .option("--no-deps", "Desactivar instalación automática de dependencias si cambian")
  .action((options) => {
    try {
      const newProject: ProjectConfig = {
        name: options.name,
        path: options.path,
        branch: options.branch,
        remote: "origin",
        intervalSeconds: options.interval,
        installDepsOnPull: options.deps !== false,
        installCommand: "pnpm install",
        buildCommand: options.build,
        pm2: options.pm2
          ? {
              processName: options.pm2,
              action: "restart",
              startIfNotRunning: false
            }
          : undefined,
        autoStash: false,
        enabled: true
      };

      addProjectToConfig(newProject);
      console.log(chalk.green(`\n✔ Proyecto '${newProject.name}' guardado en ${path.basename(getConfigFilePath())}.\n`));
    } catch (err) {
      logger.error("Error al añadir proyecto:", err);
    }
  });

// Comando: Eliminar proyecto
program
  .command("remove <name>")
  .description("Elimina un proyecto de la configuración")
  .action((name: string) => {
    try {
      removeProjectFromConfig(name);
    } catch (err) {
      logger.error("Error al eliminar proyecto:", err);
    }
  });

// Comando: Ver procesos PM2
program
  .command("pm2-status")
  .description("Comprueba qué procesos de PM2 están detectados en el sistema y su estado")
  .action(async () => {
    try {
      const list = await pm2Service.getProcessList();
      console.log(chalk.bold.magenta("\n=== Procesos PM2 detectados ==="));
      if (list.length === 0) {
        console.log(chalk.gray("No se encontraron procesos activos o PM2 no está en ejecución.\n"));
        return;
      }
      for (const p of list) {
        const isOnline = p.status === "online";
        const badge = isOnline ? chalk.green(p.status) : chalk.yellow(p.status);
        console.log(`• ID: ${chalk.cyan(p.pm_id)} | Nombre: ${chalk.bold.white(p.name)} | Estado: ${badge}`);
      }
      console.log("");
    } catch (err) {
      logger.error("Error al consultar PM2:", err);
    }
  });

export function runCli(): void {
  // Si se ejecuta sin argumentos adicionales, iniciar por defecto el comando start
  if (process.argv.length <= 2) {
    process.argv.push("start");
  }
  program.parse(process.argv);
}
