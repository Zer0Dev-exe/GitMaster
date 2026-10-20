import { simpleGit, SimpleGit } from "simple-git";
import fs from "node:fs";
import path from "node:path";
import { ProjectConfig, UpdateCheckResult, PullResult, PushPlan } from "../types.js";
import { logger } from "../utils/logger.js";

const DEPENDENCY_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "pnpm-workspace.yaml"
]);

// Ficheros que nunca se deben subir automáticamente
const SENSITIVE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$).*)?|id_rsa|id_ed25519|credentials(\.json)?|.*\.(pem|key|p12|pfx))$/i;

export class GitService {
  private getGit(projectPath: string): SimpleGit {
    return simpleGit({
      baseDir: projectPath,
      binary: "git",
      maxConcurrentProcesses: 4,
      trimmed: true,
      timeout: { block: 120_000 }
    });
  }

  async validateRepository(project: ProjectConfig): Promise<{ valid: boolean; reason?: string }> {
    const resolvedPath = path.resolve(project.path);
    if (!fs.existsSync(resolvedPath)) {
      return { valid: false, reason: `La carpeta no existe: ${resolvedPath}` };
    }

    try {
      const git = this.getGit(resolvedPath);
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return { valid: false, reason: `El directorio no es un repositorio Git: ${resolvedPath}` };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: `Error comprobando repositorio: ${String(err)}` };
    }
  }

  async hasLocalChanges(project: ProjectConfig): Promise<boolean> {
    const status = await this.getGit(project.path).status();
    return status.modified.length > 0 || status.staged.length > 0 || status.deleted.length > 0;
  }

  async getPushPlan(project: ProjectConfig): Promise<PushPlan> {
    const git = this.getGit(project.path);
    const remote = project.remote || "origin";
    const status = await git.status();
    const branch = status.current && status.current !== "HEAD" ? status.current : "";
    const files = status.files.map((f) => f.path);
    const plan: PushPlan = { branch, files, ahead: 0, behind: 0 };

    if (!branch) return { ...plan, skip: "HEAD desacoplado (sin rama)" };
    if (project.branch && project.branch !== branch) {
      return { ...plan, skip: `está en '${branch}', se esperaba '${project.branch}'` };
    }
    const sensitive = files.filter((f) => SENSITIVE.test(f));
    if (sensitive.length > 0) {
      return { ...plan, skip: `contiene ficheros sensibles sin ignorar: ${sensitive.join(", ")}` };
    }

    try {
      await git.fetch(remote, branch);
    } catch (err) {
      return { ...plan, skip: `sin acceso al remoto '${remote}': ${String(err).split("\n")[0]}` };
    }

    try {
      const raw = await git.raw(["rev-list", "--left-right", "--count", `HEAD...${remote}/${branch}`]);
      const [ahead, behind] = raw.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
      plan.ahead = ahead;
      plan.behind = behind;
    } catch {
      // La rama aún no existe en el remoto: todos sus commits son nuevos
      plan.ahead = parseInt((await git.raw(["rev-list", "--count", "HEAD"])).trim(), 10) || 0;
    }

    if (plan.behind > 0) plan.skip = `va ${plan.behind} commit(s) por detrás del remoto: haz pull antes`;
    return plan;
  }

  async commitAndPush(project: ProjectConfig, plan: PushPlan, message: string): Promise<{ committed: boolean }> {
    const git = this.getGit(project.path);
    const remote = project.remote || "origin";
    let committed = false;
    if (plan.files.length > 0) {
      await git.add(["-A"]);
      await git.commit(message);
      committed = true;
    }
    await git.push(remote, plan.branch);
    return { committed };
  }

  async getActiveBranch(project: ProjectConfig): Promise<string> {
    if (project.branch && project.branch.trim() !== "") {
      return project.branch.trim();
    }
    const git = this.getGit(project.path);
    const branchSummary = await git.branch();
    return branchSummary.current || "main";
  }

  async checkForUpdates(project: ProjectConfig): Promise<UpdateCheckResult> {
    const git = this.getGit(project.path);
    const branch = await this.getActiveBranch(project);
    const remote = project.remote || "origin";

    // 1. Fetch silencioso de la rama remota
    try {
      await git.fetch(remote, branch);
    } catch (fetchError) {
      throw new Error(`Fallo al hacer git fetch ${remote} ${branch}: ${String(fetchError)}`);
    }

    // 2. Obtener hashes locales y remotos
    const currentCommit = await git.revparse(["HEAD"]);
    const remoteRef = `${remote}/${branch}`;
    let remoteCommit: string;

    try {
      remoteCommit = await git.revparse([remoteRef]);
    } catch {
      // Fallback a upstream genérico
      remoteCommit = await git.revparse(["@{u}"]);
    }

    // 3. Contar commits pendientes de descargar
    let commitsBehind = 0;
    try {
      const countRaw = await git.raw(["rev-list", "--count", `HEAD..${remoteRef}`]);
      commitsBehind = parseInt(countRaw.trim(), 10) || 0;
    } catch {
      // Si la comparación directa falla, comprobar simplemente si los hashes difieren
      if (currentCommit !== remoteCommit) {
        commitsBehind = 1;
      }
    }

    return {
      hasUpdates: commitsBehind > 0,
      commitsBehind,
      currentCommit,
      remoteCommit,
      branch
    };
  }

  async pullUpdates(project: ProjectConfig): Promise<PullResult> {
    const git = this.getGit(project.path);
    const branch = await this.getActiveBranch(project);
    const remote = project.remote || "origin";

    const commitBefore = await git.revparse(["HEAD"]);
    const status = await git.status();

    // Solo se consideran cambios conflictivos los archivos rastreados modificados, staged o eliminados
    const hasConflictingChanges =
      status.modified.length > 0 ||
      status.staged.length > 0 ||
      status.deleted.length > 0;

    let didStash = false;
    if (hasConflictingChanges) {
      if (project.autoStash) {
        logger.git(`Cambios locales en archivos rastreados detectados. Aplicando stash temporal...`, project.name);
        await git.stash(["push", "-m", "gitmaster-auto-stash"]);
        didStash = true;
      } else {
        throw new Error(
          `El repositorio tiene cambios locales modificados sin commitear y 'autoStash' está deshabilitado. Se omite pull para no sobreescribir trabajo.`
        );
      }
    }

    try {
      logger.git(`Ejecutando git pull ${remote} ${branch}...`, project.name);
      const pullResult = await git.pull(remote, branch, { "--ff-only": null });
      const commitAfter = await git.revparse(["HEAD"]);

      const changedFiles = pullResult.files || [];
      const dependencyFilesChanged = changedFiles.some((f) => {
        const baseName = path.basename(f);
        return DEPENDENCY_FILES.has(baseName);
      });

      if (didStash) {
        try {
          await git.stash(["pop"]);
          logger.git(`Stash restaurado correctamente.`, project.name);
        } catch (stashPopError) {
          logger.warn(`Atención: Fallo al restaurar el stash: ${String(stashPopError)}`, project.name);
        }
      }

      return {
        success: true,
        commitBefore,
        commitAfter,
        changedFiles,
        dependencyFilesChanged
      };
    } catch (pullError) {
      if (didStash) {
        try {
          await git.stash(["pop"]);
        } catch {
          // Ignorar
        }
      }
      throw pullError;
    }
  }
}

export const gitService = new GitService();
