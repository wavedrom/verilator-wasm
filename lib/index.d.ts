/** Verilator compiled to wasm32-wasip1, driven through an in-memory filesystem. */

export interface CreateVerilatorOptions {
  /** Module bytes. Skips the default file/fetch lookup. */
  wasmBinary?: Uint8Array | ArrayBuffer;
  /** Already-compiled module; skips compilation entirely. */
  wasmModule?: WebAssembly.Module;
  /** Where to load verilator.wasm from, if not next to this bundle. */
  wasmUrl?: string | URL;
}

export interface RunOptions {
  /** Verilator arguments, without argv[0]. E.g. ['--json-only', '-O0', 'top.sv']. */
  args?: string[];
  /** Input files, keyed relative to `cwd`. */
  files?: Record<string, string | Uint8Array>;
  /**
   * Directory the run happens in, default '/'. wasi-libc's cwd is hardwired to
   * '/', so this is implemented as a mount: the single preopen named '/' is
   * backed by the VFS node at `cwd`.
   */
  cwd?: string;
  /** Extra environment variables. VERILATOR_ROOT is set for you. */
  env?: Record<string, string>;
  /** Called per write to stdout, in addition to the captured string. */
  onStdout?: (chunk: string) => void;
  /** Called per write to stderr, in addition to the captured string. */
  onStderr?: (chunk: string) => void;
  /** Clock source in milliseconds, for reproducible runs. Default Date.now. */
  now?: () => number;
  /** Fills the given buffer with random bytes. Default crypto.getRandomValues. */
  random?: (target: Uint8Array) => void;
}

export interface RunResult {
  /** 0 on success. A v3fatal arrives here as a non-zero code, not as a throw. */
  exitCode: number;
  stdout: string;
  /** Diagnostics live here. */
  stderr: string;
  /** Files created or modified by the run, decoded as UTF-8, keyed relative to `cwd`. */
  files: Record<string, string>;
  /** The same files, undecoded. */
  filesBytes: Record<string, Uint8Array>;
}

export interface Verilator {
  /**
   * Runs verilator on a fresh instance and a fresh VFS. main() is not
   * re-entrant — v3Global is global state and the run ends in exit() — so every
   * call gets a new instance of the once-compiled module.
   */
  run (options?: RunOptions): Promise<RunResult>;
  module: WebAssembly.Module;
}

export function createVerilator (options?: CreateVerilatorOptions): Promise<Verilator>;

export default createVerilator;
