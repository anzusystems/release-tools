// @ts-check
import { spawn } from 'node:child_process'

export class ExecError extends Error {
  /**
   * @param {string} command
   * @param {number | null} code
   * @param {string} stdout
   * @param {string} stderr
   */
  constructor(command, code, stdout, stderr) {
    const tail = (stderr || stdout).trim().split('\n').slice(-20).join('\n')
    super(`${command} failed (exit ${code})${tail ? `:\n${tail}` : ''}`)
    this.name = 'ExecError'
    this.command = command
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

/**
 * @typedef {object} RunOptions
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env] full environment (default: process.env)
 * @property {Record<string, string>} [extraEnv] added to the environment
 * @property {string | Buffer} [input]
 * @property {boolean} [allowFail] resolve instead of throwing on a non-zero exit
 * @property {boolean} [inherit] stream output to this process (long-running installs, builds, checks)
 * @property {'buffer' | 'utf8'} [encoding]
 */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunOptions} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, stdoutBuffer: Buffer }>}
 */
export function run(cmd, args, options = {}) {
  const env = { ...(options.env ?? process.env), ...(options.extraEnv ?? {}) }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', options.inherit ? 'inherit' : 'pipe', options.inherit ? 'inherit' : 'pipe'],
    })
    /** @type {Buffer[]} */
    const out = []
    /** @type {Buffer[]} */
    const err = []
    child.stdout?.on('data', (d) => out.push(d))
    child.stderr?.on('data', (d) => err.push(d))
    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      const stdoutBuffer = Buffer.concat(out)
      const stdout = stdoutBuffer.toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      const result = { code: code ?? 1, stdout, stderr, stdoutBuffer }
      if (code !== 0 && !options.allowFail) {
        reject(new ExecError([cmd, ...args].join(' '), code, stdout, stderr))
      } else {
        resolve(result)
      }
    })
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(options.input)
    }
  })
}

/**
 * Runs a command line from the project configuration through the shell.
 * @param {string} command
 * @param {RunOptions} [options]
 */
export function sh(command, options = {}) {
  return run('sh', ['-c', command], options)
}
