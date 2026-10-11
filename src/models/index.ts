import type { Api, Model } from '@earendil-works/pi-ai'

export {
  getAllModels,
  createModelsForCwd,
  getConfiguredModel,
  getCurrentModel,
  setCurrentModel,
  findModel,
  resolveApiKey,
  getModelConfig,
  getModels,
  getCustomModelDefs,
  resetCustomModelCache,
  type ModelConfig,
} from './registry.ts'

export {
  loadCustomModels,
  customModelToModel,
  type CustomModelDef,
  type CustomModelsConfig,
} from './custom.ts'

export function modelSupportsImages(model: Model<Api>): boolean {
  return model.input.includes('image')
}

export { EncryptedCredentialStore } from './EncryptedCredentialStore.ts'
