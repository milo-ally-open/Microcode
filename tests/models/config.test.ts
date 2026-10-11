import { describe, expect, test } from 'bun:test'
import { customModelToModel, loadCustomModels, type CustomModelDef } from '../../src/models/custom.ts'
import { findModel, getAllModels, getModelConfig, getModels, resolveApiKey, setCurrentModel } from '../../src/models/registry.ts'

describe('models and config modules', () => {
  test('exposes built-in model ids through the model registry', () => {
    const modelIds = getAllModels().map((model) => model.id)
    expect(modelIds).toContain('deepseek-v4-pro')
    expect(modelIds).toContain('gemini-2.5-flash')
  })

  test('resolves models by provider and model id, retaining API compatibility lookup', () => {
    const deepseek = findModel('deepseek-v4-pro', undefined, 'deepseek')
    const qualified = findModel('deepseek/deepseek-v4-pro')

    expect(deepseek?.provider).toBe('deepseek')
    expect(qualified?.provider).toBe('deepseek')
    expect(deepseek?.api).toBe('openai-completions')
  })

  test('setCurrentModel updates the active model config', () => {
    const selectedModel = findModel('gemini-2.5-flash', 'google-generative-ai')
    expect(selectedModel).toBeDefined()
    setCurrentModel(selectedModel!)
    const current = getModelConfig()

    expect(current.model.id).toBe('gemini-2.5-flash')
    expect(current.model.provider).toBe('google')
  })

  test('custom model conversion preserves capabilities and explicit key env', () => {
    const def: CustomModelDef = {
      id: 'local-test',
      name: 'Local Test',
      api: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
      apiKeyEnv: 'LOCAL_TEST_KEY',
      reasoning: true,
      thinkingFormat: 'deepseek',
      input: ['text', 'image'],
      contextWindow: 8192,
      maxTokens: 2048,
    }
    process.env.LOCAL_TEST_KEY = 'secret'
    const model = customModelToModel(def)

    expect(model.provider).toBe('custom')
    expect(model.input).toEqual(['text', 'image'])
    expect(model.compat?.thinkingFormat).toBe('deepseek')
    expect(resolveApiKey(model)).toBe('secret')
    delete process.env.LOCAL_TEST_KEY
  })

  test('loads valid custom models from project config and ignores invalid entries', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const cwd = await mkdtemp(join(tmpdir(), 'microcode-models-'))
    try {
      await mkdir(join(cwd, '.microcode'), { recursive: true })
      await writeFile(join(cwd, '.microcode', 'config.json'), JSON.stringify({
        models: [
          {
            id: 'project-model',
            name: 'Project Model',
            api: 'openai-completions',
            baseUrl: 'http://localhost/v1',
            contextWindow: 128000,
            maxTokens: 4096,
          },
          { id: 'invalid' },
        ],
      }))

      expect(loadCustomModels(cwd).map((model) => model.id)).toEqual(['project-model'])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('registry returns a non-empty model list', () => {
    expect(getAllModels().length).toBeGreaterThan(0)
  })

  test('registers Anthropic and Codex subscription OAuth alongside API-key providers', () => {
    const models = getModels()
    const anthropic = models.getProvider('anthropic')
    const codex = models.getProvider('openai-codex')

    expect(anthropic?.auth.oauth?.isSubscription).toBe(true)
    expect(anthropic?.auth.oauth?.name).toContain('Claude Pro/Max')
    expect(codex?.auth.oauth?.isSubscription).toBe(true)
    expect(codex?.auth.oauth?.name).toContain('ChatGPT Plus/Pro')
    expect(typeof anthropic?.auth.oauth?.login).toBe('function')
    expect(typeof codex?.auth.oauth?.refresh).toBe('function')
    expect(getAllModels().some((model) => model.provider === 'openai-codex')).toBe(true)
  })
})
