type SpawnResult = never

export function spawn(): SpawnResult {
  throw new Error('child_process.spawn is not available in the browser build')
}

const childProcess = { spawn }

export default childProcess
