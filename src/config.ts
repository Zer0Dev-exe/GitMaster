import fs from "node:fs";
import path from "node:path";
import { GitMasterConfig, GitMasterConfigSchema, ProjectConfig } from "./types.js";
import { logger } from "./utils/logger.js";

const CONFIG_FILES = ["config.jsonc", "config.json"];

export function getConfigFilePath(): string {
  for (const filename of CONFIG_FILES) {
    const candidatePath = path.resolve(process.cwd(), filename);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  // Si aún no existe ninguno, se creará preferentemente como config.jsonc
  return path.resolve(process.cwd(), "config.jsonc");
}

function stripComments(jsonString: string): string {
  return jsonString.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? "" : m));
}

export function formatToSpanishConfig(config: GitMasterConfig): any {
  return {
    intervaloPorDefectoSegundos: config.defaultIntervalSeconds,
    concurrencia: config.concurrency,
    proyectos: config.projects.map((p) => ({
      nombre: p.name,
      ruta: p.path,
      rama: p.branch || "main",
      intervaloSegundos: p.intervalSeconds || config.defaultIntervalSeconds,
      instalarDependencias: p.installDepsOnPull,
      comandoInstalar: p.installCommand || "pnpm install",
      comandoBuild: p.buildCommand || "pnpm run build",
      pm2: p.pm2
        ? {
            nombreProceso: p.pm2.processName,
            accion: p.pm2.action,
            iniciarSiEstaApagado: p.pm2.startIfNotRunning,
          }
        : null,
      guardarCambiosLocalesAuto: p.autoStash,
      activado: p.enabled,
    })),
  };
}

export function getDefaultConfig(): GitMasterConfig {
  return {
    defaultIntervalSeconds: 60,
    concurrency: 2,
    projects: [
      {
        name: "ejemplo-proyecto",
        path: "C:/mis-proyectos/mi-proyecto",
        branch: "main",
        remote: "origin",
        intervalSeconds: 60,
        installDepsOnPull: true,
        installCommand: "pnpm install",
        buildCommand: "pnpm run build",
        pm2: {
          processName: "mi-app",
          action: "restart",
          startIfNotRunning: false,
        },
        autoStash: false,
        enabled: false,
      },
    ],
  };
}

export function loadConfig(): GitMasterConfig {
  const filePath = getConfigFilePath();

  if (!fs.existsSync(filePath)) {
    const baseName = path.basename(filePath);
    logger.warn(`No se encontró ${baseName}. Creando plantilla de configuración en español...`);
    const defaultConfig = getDefaultConfig();
    saveConfig(defaultConfig);
    return defaultConfig;
  }

  try {
    const rawData = fs.readFileSync(filePath, "utf8");
    const cleanedJson = stripComments(rawData);
    const json = JSON.parse(cleanedJson);
    const parsed = GitMasterConfigSchema.parse(json);
    return parsed;
  } catch (error) {
    const baseName = path.basename(filePath);
    logger.error(`Error al leer o validar ${baseName}:`, error);
    throw error;
  }
}

export function saveConfig(config: GitMasterConfig): void {
  const filePath = getConfigFilePath();
  const valid = GitMasterConfigSchema.parse(config);
  const spanishFormatted = formatToSpanishConfig(valid);
  fs.writeFileSync(filePath, JSON.stringify(spanishFormatted, null, 2), "utf8");
}

export function addProjectToConfig(project: ProjectConfig): void {
  const config = loadConfig();
  const existingIndex = config.projects.findIndex((p) => p.name.toLowerCase() === project.name.toLowerCase());

  if (existingIndex >= 0) {
    config.projects[existingIndex] = project;
    logger.info(`Proyecto '${project.name}' actualizado.`);
  } else {
    config.projects.push(project);
    logger.info(`Proyecto '${project.name}' añadido a la configuración.`);
  }

  saveConfig(config);
}

export function removeProjectFromConfig(projectName: string): boolean {
  const config = loadConfig();
  const initialLength = config.projects.length;
  config.projects = config.projects.filter((p) => p.name.toLowerCase() !== projectName.toLowerCase());

  if (config.projects.length < initialLength) {
    saveConfig(config);
    logger.info(`Proyecto '${projectName}' eliminado.`);
    return true;
  }

  logger.warn(`No se encontró el proyecto '${projectName}' en la configuración.`);
  return false;
}
