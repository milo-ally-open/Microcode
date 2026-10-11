import { describe, expect, test } from 'bun:test'
import { formatCliHelp } from '../../src/main.tsx'

describe('CLI help', () => {
  test('root help lists every top-level command and current global options', () => {
    const help = formatCliHelp()

    expect(help).toContain('microcode [OPTIONS]')
    expect(help).toContain('gateway [COMMAND]')
    expect(help).toContain('mcp list')
    expect(help).toContain('model list')
    expect(help).toContain('--no-daemon')
    expect(help).toContain('--gateway-port <PORT>')
    expect(help).toContain('--gateway-host <HOST>')
    expect(help).toContain('--thinking <LEVEL>')
    expect(help).toContain("microcode gateway --help")
  })

  test('gateway help documents lifecycle, port precedence, endpoints, and token security', () => {
    const help = formatCliHelp('gateway')

    expect(help).toContain('microcode gateway [COMMAND] [OPTIONS]')
    expect(help).toContain('start')
    expect(help).toContain('status')
    expect(help).toContain('stop')
    expect(help).toContain('token --rotate')
    expect(help).toContain('MICROCODE_GATEWAY_PORT')
    expect(help).toContain('MICROCODE_GATEWAY_HOST')
    expect(help).toContain('127.0.0.1')
    expect(help).toContain('/v1/chat/completions')
    expect(help).toContain('/v1/responses')
    expect(help).toContain('/v1/messages')
    expect(help).toContain('sensitive credential')
  })

  test('mcp and model help match the available subcommands and options', () => {
    const mcpHelp = formatCliHelp('mcp')
    expect(mcpHelp).toContain('microcode mcp list [OPTIONS]')
    expect(mcpHelp).toContain('user, project, or all')

    const modelHelp = formatCliHelp('model')
    expect(modelHelp).toContain('microcode model list [OPTIONS]')
    expect(modelHelp).toContain('--no-daemon')
    expect(modelHelp).toContain('--gateway-port <PORT>')
  })
})
