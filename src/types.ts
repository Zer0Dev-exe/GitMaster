import { z } from "zod";

// Soporta tanto claves en español como en inglés
export const Pm2ConfigSchema = z.preprocess(
  (val: any) => {
    if (val && typeof val === "object") {
      return {
        processName: val.nombreProceso ?? val.processName,
        action: val.accion ?? val.action ?? "restart",
        startIfNotRunning: val.iniciarSiEstaApagado ?? val.startIfNotRunning ?? false,
      };
    }
    return val;
  },
  z.object({
    processName: z.string().min(1, "El nombre del proceso PM2 no puede estar vacío"),
    action: z.enum(["restart", "reload"]).default("restart"),
    startIfNotRunning: z.boolean().default(false),
  })
);

export type Pm2Config = z.infer<typeof Pm2ConfigSchema>;

export const ProjectConfigSchema = z.preprocess(
  (val: any) => {
    if (val && typeof val === "object") {
      return {
        name: val.nombre ?? val.name,
        path: val.ruta ?? val.path,
        branch: val.rama ?? val.branch,
        remote: val.remoto ?? val.remote ?? "origin",
        intervalSeconds: val.intervaloSegundos ?? val.intervalSeconds,
        installDepsOnPull:
          val.instalarDependencias ??
          val.instalarDependenciasTrasPull ??
          val.installDepsOnPull ??
          true,
        installCommand: val.comandoInstalar ?? val.installCommand ?? "pnpm install",
        buildCommand: val.comandoBuild ?? val.buildCommand,
        pm2: val.pm2,
        autoStash: val.guardarCambiosLocalesAuto ?? val.autoStash ?? false,
        enabled: val.activado ?? val.habilitado ?? val.enabled ?? true,
      };
    }
    return val;
  },
  z.object({
    name: z.string().min(1, "El nombre del proyecto no puede estar vacío"),
    path: z.string().min(1, "La ruta del proyecto no puede estar vacía"),
    branch: z.string().optional(),
    remote: z.string().default("origin"),
    intervalSeconds: z.number().int().positive().optional(),
    installDepsOnPull: z.boolean().default(true),
    installCommand: z.string().default("pnpm install"),
    buildCommand: z.string().optional(),
    pm2: Pm2ConfigSchema.optional(),
    autoStash: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
);

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const GitMasterConfigSchema = z.preprocess(
  (val: any) => {
    if (val && typeof val === "object") {
      return {
        defaultIntervalSeconds:
          val.intervaloPorDefectoSegundos ??
          val.intervaloGlobalSegundos ??
          val.defaultIntervalSeconds ??
          60,
        concurrency: val.concurrencia ?? val.concurrency ?? 2,
        projects: val.proyectos ?? val.projects ?? [],
      };
    }
    return val;
  },
  z.object({
    defaultIntervalSeconds: z.number().int().positive().default(60),
    concurrency: z.number().int().positive().default(2),
    projects: z.array(ProjectConfigSchema).default([]),
  })
);

export type GitMasterConfig = z.infer<typeof GitMasterConfigSchema>;

export interface UpdateCheckResult {
  hasUpdates: boolean;
  commitsBehind: number;
  currentCommit: string;
  remoteCommit?: string;
  branch: string;
}

export interface PullResult {
  success: boolean;
  commitBefore: string;
  commitAfter: string;
  changedFiles: string[];
  dependencyFilesChanged: boolean;
}

export interface PushPlan {
  branch: string;
  files: string[];
  ahead: number;
  behind: number;
  /** Motivo por el que este proyecto no se debe subir; si existe, se omite */
  skip?: string;
}
