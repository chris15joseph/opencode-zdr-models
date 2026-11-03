/**
 * Minimal ESM loader for the repository's TypeScript tests on Node versions
 * that cannot strip types themselves (Node 20/22/24).
 *
 * The plugin ships raw TypeScript and the tests import `../src/*.ts`. Instead
 * of adding a runtime transpiler dependency, this loader reuses the pinned
 * `typescript` devDependency and `transpileModule`, which only removes types
 * and does not typecheck (`npm run typecheck` remains the strict gate).
 *
 * Usage: node --loader ./scripts/ts-loader.mjs --test test/*.test.ts
 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import ts from "typescript"

/** @param {string} url @param {unknown} context @param {(url: string, context: unknown) => Promise<unknown>} nextLoad */
export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".ts") && !url.endsWith(".d.ts")) {
    const source = await readFile(fileURLToPath(url), "utf8")
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        sourceMap: false,
        inlineSourceMap: false,
      },
      fileName: fileURLToPath(url),
    }).outputText
    return { format: "module", source: output, shortCircuit: true }
  }
  return nextLoad(url, context)
}
