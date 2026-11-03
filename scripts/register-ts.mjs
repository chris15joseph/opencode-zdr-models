/** Register the TypeScript test loader without the deprecated --loader flag. */
import { register } from "node:module"

register("./ts-loader.mjs", import.meta.url)
