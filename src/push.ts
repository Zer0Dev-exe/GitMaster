import readline from "node:readline/promises";
import chalk from "chalk";
import { GitMasterConfig, ProjectConfig, PushPlan } from "./types.js";
import { gitService } from "./core/gitService.js";
import { logger } from "./utils/logger.js";

interface PushOptions {
  message: string;
  yes?: boolean;
  dryRun?: boolean;
}

interface Entry {
  project: ProjectConfig;
  plan?: PushPlan;
  error?: string;
}

const needsWork = (e: Entry) => !!e.plan && !e.plan.skip && (e.plan.files.length > 0 || e.plan.ahead > 0);

/** Devuelve el código de salida del proceso. */
export async function runPushAll(config: GitMasterConfig, names: string[], options: PushOptions): Promise<number> {
  const wanted = names.map((n) => n.toLowerCase());
  const unknown = wanted.filter((n) => !config.projects.some((p) => p.name.toLowerCase() === n));
  if (unknown.length > 0) {
    logger.error(`Proyecto(s) no encontrado(s) en la configuración: ${unknown.join(", ")}`);
    return 1;
  }

  const projects = config.projects.filter(
    (p) => p.enabled && (wanted.length === 0 || wanted.includes(p.name.toLowerCase()))
  );
  console.log(chalk.gray(`Analizando ${projects.length} proyecto(s)...`));

  const entries: Entry[] = await Promise.all(
    projects.map(async (project): Promise<Entry> => {
      try {
        const validation = await gitService.validateRepository(project);
        if (!validation.valid) return { project, error: validation.reason };
        return { project, plan: await gitService.getPushPlan(project) };
      } catch (err) {
        return { project, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  const nameW = Math.max(...entries.map((e) => e.project.name.length), 8);
  console.log(chalk.bold.cyan("\n=== Plan de subida ===\n"));
  for (const e of entries) {
    const name = chalk.bold.white(e.project.name.padEnd(nameW));
    if (e.error) {
      console.log(`${chalk.red("✖")} ${name} ${chalk.red(e.error)}`);
    } else if (e.plan!.skip) {
      console.log(`${chalk.yellow("⚠")} ${name} ${chalk.yellow("omitido: " + e.plan!.skip)}`);
    } else if (!needsWork(e)) {
      console.log(`${chalk.green("✔")} ${name} ${chalk.gray("nada que subir")}`);
    } else {
      const { files, ahead, branch } = e.plan!;
      const parts = [
        files.length > 0 ? chalk.yellow(`${files.length} fichero(s) a commitear`) : "",
        ahead > 0 ? chalk.blue(`${ahead} commit(s) sin subir`) : "",
      ].filter(Boolean);
      console.log(`${chalk.cyan("↑")} ${name} ${chalk.gray(branch)}  ${parts.join(chalk.gray(" · "))}`);
      for (const f of files.slice(0, 6)) console.log(`    ${chalk.gray(f)}`);
      if (files.length > 6) console.log(chalk.gray(`    … y ${files.length - 6} más`));
    }
  }

  const todo = entries.filter(needsWork);
  if (todo.length === 0) {
    console.log(chalk.green("\nNo hay nada pendiente de subir.\n"));
    return entries.some((e) => e.error) ? 1 : 0;
  }
  if (options.dryRun) {
    console.log(chalk.gray(`\n(--dry-run) Se subirían ${todo.length} proyecto(s). No se ha cambiado nada.\n`));
    return 0;
  }

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      logger.error("Se necesita una terminal interactiva para confirmar. Usa --yes para omitir la confirmación.");
      return 1;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\nSe hará commit ("${options.message}") y push de ${chalk.bold(todo.length)} proyecto(s) a su remoto. ¿Continuar? (s/N) `
    );
    rl.close();
    if (!/^(s|si|sí|y|yes)$/i.test(answer.trim())) {
      console.log(chalk.gray("Cancelado. No se ha cambiado nada.\n"));
      return 0;
    }
  }

  console.log("");
  let failed = 0;
  for (const e of todo) {
    try {
      const { committed } = await gitService.commitAndPush(e.project, e.plan!, options.message);
      logger.success(committed ? "Commit y push completados." : "Push completado.", e.project.name);
    } catch (err) {
      failed++;
      logger.error("No se pudo subir:", err, e.project.name);
    }
  }

  console.log(
    failed === 0
      ? chalk.green(`\n✔ ${todo.length} proyecto(s) subidos.\n`)
      : chalk.red(`\n${todo.length - failed} subidos, ${failed} con error.\n`)
  );
  return failed === 0 ? 0 : 1;
}
