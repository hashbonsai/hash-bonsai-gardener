import { loadConfig } from './config'
import { decide } from './decision'
import { fileStateStore, initialState } from './state'

// npm run redo -- <epoch> [--note "how to write it this time"] [--config <file>]
try {
  const argv = process.argv.slice(2)
  const configIndex = argv.indexOf('--config')
  const config = loadConfig(configIndex === -1 ? (process.env.GARDENER_CONFIG ?? 'config.json') : argv[configIndex + 1])
  console.log(decide(argv, 'redo', fileStateStore(config.stateFile, () => initialState(config.firstEpoch - 1))))
} catch (e) {
  console.error('FAILED:', e instanceof Error ? e.message : String(e))
  process.exitCode = 1
}
