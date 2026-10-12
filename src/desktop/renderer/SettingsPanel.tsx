import React, { useEffect, useMemo, useState } from 'react'
import type { AuthType } from '@earendil-works/pi-ai'
import type { DesktopBackendSnapshot, DesktopBridge, DesktopModelOption, DesktopSettingsSnapshot } from '../protocol.ts'
import { redactDisplayText } from '../security.ts'
import { applySettingsAction } from './settingsActions.ts'

const h = React.createElement
const Fragment = React.Fragment

type SettingsTab = 'models' | 'providers' | 'mcp' | 'plugins' | 'skills'

function modelKey(model: Pick<DesktopModelOption, 'id' | 'provider' | 'api'>): string {
  return `${model.provider}/${model.id}::${model.api}`
}

function statusLabel(status: DesktopSettingsSnapshot['mcpServers'][number]['status']): string {
  switch (status) {
    case 'connected': return 'Connected'
    case 'pending': return 'Starting'
    case 'failed': return 'Connection failed'
    case 'disabled': return 'Disabled'
    default: return 'Disconnected'
  }
}

function authLabel(provider: DesktopSettingsSnapshot['providers'][number]): string {
  if (provider.statusError) return 'Status unavailable'
  if (!provider.configured) return 'Not configured'
  return `${provider.authType || 'Configured'}${provider.source ? ` · ${provider.source}` : ''}`
}

export function SettingsPanel({
  bridge,
  snapshot,
  busy,
  onClose,
  onError,
  onSnapshotChange,
}: {
  bridge: DesktopBridge
  snapshot: DesktopBackendSnapshot | null
  busy: boolean
  onClose(): void
  onError(message: string): void
  onSnapshotChange(snapshot: DesktopBackendSnapshot): void
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('models')
  const [settings, setSettings] = useState<DesktopSettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [modelFilter, setModelFilter] = useState('')
  const [pendingAction, setPendingAction] = useState('')
  const [notice, setNotice] = useState('')
  const currentModel = snapshot?.runtime?.agent.model
  const models = settings?.models ?? []
  const providers = settings?.providers ?? []
  const filteredModels = useMemo(() => {
    const query = modelFilter.trim().toLowerCase()
    return query ? models.filter((model) => `${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(query)) : models
  }, [modelFilter, models])

  const refresh = async () => {
    setLoading(true)
    try { setSettings(await bridge.getSettingsSnapshot()) }
    catch (error) { onError(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void refresh() }, [])

  const apply = async (action: string, operation: () => Promise<DesktopSettingsSnapshot>, successNotice?: string): Promise<boolean> => {
    setPendingAction(action)
    setNotice('')
    try {
      return await applySettingsAction(operation, (nextSettings) => {
        setSettings(nextSettings)
        if (successNotice) setNotice(successNotice)
      }, (error) => onError(error instanceof Error ? error.message : String(error)))
    } finally {
      setPendingAction('')
    }
  }

  const switchModel = async (model: DesktopModelOption) => {
    setPendingAction(`model:${modelKey(model)}`)
    setNotice('')
    try { onSnapshotChange(await bridge.switchModel(model)) }
    catch (error) { onError(error instanceof Error ? error.message : String(error)) }
    finally { setPendingAction('') }
  }

  const login = async (providerId: string, authType: AuthType) => {
    setPendingAction(`auth:${providerId}`)
    setNotice('')
    try {
      const result = await bridge.loginProvider(providerId, authType)
      setSettings(result.settings)
      setNotice(result.status === 'cancelled' ? 'Sign-in cancelled. Provider status was left unchanged.' : 'Provider sign-in completed and was confirmed by the runtime.')
    } catch (error) { onError(error instanceof Error ? error.message : String(error)) }
    finally { setPendingAction('') }
  }

  const logout = async (providerId: string) => apply(`auth:${providerId}`, () => bridge.logoutProvider(providerId))

  const toggleMcp = async (server: DesktopSettingsSnapshot['mcpServers'][number]) => {
    const enabled = !server.enabled
    const confirmed = !enabled || !server.confirmationRequired || window.confirm(
      `Enable ${server.name}? This will run the configured command:\n\n${server.summary}\n\nThe server configuration stays in its existing file.`,
    )
    if (!confirmed) return
    await apply(`mcp:${server.name}`, () => bridge.setMcpEnabled(server.name, enabled, confirmed), `MCP state for ${server.name} was applied to this workspace runtime.`)
  }

  const togglePlugin = async (plugin: NonNullable<DesktopSettingsSnapshot['plugins']>['plugins'][number]) => {
    const enabled = !plugin.enabled
    const commands = plugin.servers.filter((server) => server.transport === 'stdio')
    const confirmed = !enabled || commands.length === 0 || window.confirm(
      `Enable ${plugin.name}? It can start these MCP commands:\n\n${commands.map((server) => server.safeCommandSummary).join('\n')}\n\nPlugin skills and servers will be applied to this runtime.`,
    )
    if (!confirmed) return
    await apply(`plugin:${plugin.name}`, () => bridge.setPluginEnabled(plugin.scope, plugin.name, enabled, confirmed), `${plugin.scope === 'user' ? 'User' : 'Workspace'} plugin preference for ${plugin.name} was confirmed and applied.`)
  }

  const toggleSkill = async (skill: DesktopSettingsSnapshot['skills'][number]) => {
    await apply(`skill:${skill.name}`, () => bridge.setSkillLoaded(skill.name, !skill.loaded), `Skill ${skill.name} was ${skill.loaded ? 'unloaded from' : 'loaded into'} the current runtime prompt.`)
  }

  const cancelLogin = async () => {
    try { await bridge.cancelProviderLogin() }
    catch (error) { onError(error instanceof Error ? error.message : String(error)) }
  }

  return (
    <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header">
          <div><p className="eyebrow">MICROCODE WORKSPACE</p><h2 id="settings-title">Settings</h2><p>Models, provider access, and runtime integrations.</p></div>
          <div className="settings-header-actions">
            <button className="button-quiet" disabled={loading} onClick={() => void refresh()} type="button">{loading ? 'Refreshing…' : 'Refresh status'}</button>
            <button className="settings-close" aria-label="Close settings" onClick={onClose} type="button">×</button>
          </div>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings sections">
            {([
              ['models', 'Models'], ['providers', 'Providers & auth'], ['mcp', 'MCP servers'], ['plugins', 'Plugins'], ['skills', 'Skills'],
            ] as const).map(([id, label]) => (
              <button className={activeTab === id ? 'selected' : ''} key={id} onClick={() => setActiveTab(id)} type="button">{label}</button>
            ))}
          </nav>
          <main className="settings-content">
            {notice && <p className="settings-notice" role="status">{notice}</p>}
            {loading && !settings ? <p className="settings-empty">Reading settings from the runtime…</p> : null}
            {activeTab === 'models' && settings && (
              <>
                <section className="settings-section">
                  <div className="settings-section-heading"><div><h3>Model catalog</h3><p>Choices come from the model providers available to this runtime.</p></div><span className="settings-count">{models.length}</span></div>
                  <div className="model-current"><span className="settings-status-dot ready" /><div><strong>Current model</strong><span>{currentModel?.name || 'No model selected'}{currentModel ? ` · ${currentModel.provider}/${currentModel.id}` : ''}</span></div></div>
                  <label className="settings-search"><span>⌕</span><input aria-label="Filter models" placeholder="Filter by model or provider" value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} /></label>
                  <div className="settings-row-list model-list">
                    {filteredModels.map((model) => {
                      const selected = currentModel?.id === model.id && currentModel.provider === model.provider && currentModel.api === model.api
                      const pending = pendingAction === `model:${modelKey(model)}`
                      return (
                        <article className="settings-row model-row" key={modelKey(model)}>
                          <span className={`settings-status-dot ${model.authentication === 'configured' ? 'ready' : model.authentication === 'error' ? 'error' : 'muted'}`} />
                          <div className="settings-row-main"><strong>{redactDisplayText(model.name)}</strong><span>{redactDisplayText(model.provider)} · {model.api}{model.authentication === 'missing' ? ' · credentials needed' : model.authentication === 'error' ? ' · auth status unavailable' : ''}</span></div>
                          {selected ? <span className="settings-selected">Current</span> : <button className="button-quiet" disabled={pending || busy} onClick={() => void switchModel(model)} type="button">{pending ? 'Applying…' : 'Use model'}</button>}
                          {model.authentication !== 'configured' && <button className="settings-link" onClick={() => setActiveTab('providers')} type="button">Provider settings</button>}
                        </article>
                      )
                    })}
                    {filteredModels.length === 0 && <p className="settings-empty">No models match this filter.</p>}
                  </div>
                  <p className="settings-footnote">A model is selected only after the runtime confirms the switch. Missing credentials are checked before changing the current model.</p>
                </section>
              </>
            )}
            {activeTab === 'providers' && settings && (
              <section className="settings-section">
                <div className="settings-section-heading"><div><h3>Provider access</h3><p>Authentication state comes from Microcode’s existing provider and credential store.</p></div><span className="settings-count">{providers.length}</span></div>
                <p className="settings-footnote">Secrets stay in the trusted backend and OS sign-in dialog. They are never shown in this page or sent in a status event.</p>
                <div className="settings-row-list">
                  {providers.map((provider) => {
                    const actionPending = pendingAction === `auth:${provider.id}`
                    return (
                      <article className="provider-card" key={provider.id}>
                        <div className="provider-card-heading"><span className={`settings-status-dot ${provider.statusError ? 'error' : provider.configured ? 'ready' : 'muted'}`} /><div><strong>{redactDisplayText(provider.name)}</strong><span>{redactDisplayText(provider.id)} · {authLabel(provider)}</span></div>{provider.savedCredential && <button className="button-quiet" disabled={busy || actionPending} onClick={() => void logout(provider.id)} type="button">Remove saved sign-in</button>}</div>
                        <div className="provider-actions">
                          {provider.choices.map((choice) => <button className="button-primary" key={choice.type} disabled={busy || actionPending || Boolean(pendingAction && pendingAction.startsWith('auth:'))} onClick={() => void login(provider.id, choice.type)} type="button">{actionPending ? 'Waiting for sign-in…' : choice.label}</button>)}
                          {actionPending && <button className="button-quiet" onClick={() => void cancelLogin()} type="button">Cancel sign-in</button>}
                          {provider.choices.length === 0 && <span className="settings-footnote">This provider uses ambient credentials. Configure its existing environment or system login, then refresh status.</span>}
                        </div>
                      </article>
                    )
                  })}
                  {providers.length === 0 && <p className="settings-empty">This runtime did not report any providers.</p>}
                </div>
              </section>
            )}
            {activeTab === 'mcp' && settings && (
              <section className="settings-section">
                <div className="settings-section-heading"><div><h3>MCP servers</h3><p>Each row reports the connection state confirmed by the runtime.</p></div><span className="settings-count">{settings.mcpServers.length}</span></div>
                <p className="settings-footnote">Enable or disable applies to this workspace runtime. The server definition remains in its existing MCP or plugin configuration.</p>
                {settings.mcpDiagnostics.length > 0 && <div className="settings-diagnostics"><strong>Configuration diagnostics</strong>{settings.mcpDiagnostics.map((diagnostic, index) => <p key={`${index}-${diagnostic}`}>{redactDisplayText(diagnostic)}</p>)}</div>}
                <div className="settings-row-list">
                  {settings.mcpServers.map((server) => {
                    const pending = pendingAction === `mcp:${server.name}`
                    return (
                      <article className="settings-row integration-row" key={server.name}>
                        <span className={`settings-status-dot ${server.status === 'connected' ? 'ready' : server.status === 'failed' ? 'error' : 'muted'}`} />
                        <div className="settings-row-main"><strong>{redactDisplayText(server.name)} <small>{server.scope}</small></strong><span>{statusLabel(server.status)} · {server.tools.length} tools · {server.transport}</span><code>{redactDisplayText(server.summary)}</code>{server.error && <p className="settings-error">{redactDisplayText(server.error)}</p>}</div>
                        <button className={server.enabled ? 'button-quiet' : 'button-primary'} disabled={busy || pending} onClick={() => void toggleMcp(server)} type="button">{pending ? 'Applying…' : server.enabled ? 'Disable' : 'Enable'}</button>
                      </article>
                    )
                  })}
                  {settings.mcpServers.length === 0 && settings.mcpDiagnostics.length === 0 && <p className="settings-empty">No MCP servers are configured for this workspace.</p>}
                </div>
              </section>
            )}
            {activeTab === 'plugins' && settings && (
              <section className="settings-section">
                <div className="settings-section-heading"><div><h3>Plugin packages</h3><p>Invalid packages remain off. Valid toggles are persisted by their user or workspace scope.</p></div><span className="settings-count">{settings.plugins?.plugins.length ?? 0}</span></div>
                {settings.plugins?.diagnostics.length ? <div className="settings-diagnostics"><strong>Discovery diagnostics</strong>{settings.plugins.diagnostics.map((diagnostic, index) => <p key={`${index}-${diagnostic}`}>{redactDisplayText(diagnostic)}</p>)}</div> : null}
                <div className="settings-row-list">
                  {(settings.plugins?.plugins ?? []).map((plugin) => {
                    const pending = pendingAction === `plugin:${plugin.name}`
                    const blocked = !plugin.valid || plugin.health === 'incompatible'
                    return (
                      <article className="provider-card" key={`${plugin.scope}:${plugin.name}`}>
                        <div className="provider-card-heading"><span className={`settings-status-dot ${plugin.health === 'invalid' || plugin.health === 'incompatible' ? 'error' : plugin.enabled ? 'ready' : 'muted'}`} /><div><strong>{redactDisplayText(plugin.name)} <small>v{plugin.version}</small></strong><span>{plugin.scope === 'user' ? 'User scope' : 'Workspace scope'} · {plugin.health} · {plugin.skills.length} skills · {plugin.servers.length} MCP servers</span></div><button className={plugin.enabled ? 'button-quiet' : 'button-primary'} disabled={busy || pending || blocked} onClick={() => void togglePlugin(plugin)} type="button">{pending ? 'Applying…' : plugin.enabled ? 'Disable' : 'Enable'}</button></div>
                        {plugin.servers.length > 0 && <div className="plugin-server-list">{plugin.servers.map((server) => <code key={server.qualifiedName}>{redactDisplayText(server.safeCommandSummary)}</code>)}</div>}
                        {plugin.diagnostics.length > 0 && <div className="settings-diagnostics compact">{plugin.diagnostics.map((diagnostic, index) => <p key={`${index}-${diagnostic}`}>{redactDisplayText(diagnostic)}</p>)}</div>}
                      </article>
                    )
                  })}
                  {!settings.plugins?.plugins.length && <p className="settings-empty">No plugin packages were discovered.</p>}
                </div>
              </section>
            )}
            {activeTab === 'skills' && settings && (
              <section className="settings-section">
                <div className="settings-section-heading"><div><h3>Skills</h3><p>Choose which available skill guidance is loaded into the current runtime prompt.</p></div><span className="settings-count">{settings.skills.length}</span></div>
                <p className="settings-footnote">Skill loading is runtime state. It applies to the current conversation and does not write another copy of skill content.</p>
                {settings.skillDiagnostics.length > 0 && <div className="settings-diagnostics"><strong>Discovery diagnostics</strong>{settings.skillDiagnostics.map((diagnostic, index) => <p key={`${index}-${diagnostic}`}>{redactDisplayText(diagnostic)}</p>)}</div>}
                <div className="settings-row-list">
                  {settings.skills.map((skill) => {
                    const pending = pendingAction === `skill:${skill.name}`
                    return <article className="settings-row integration-row" key={skill.name}><span className={`settings-status-dot ${skill.loaded ? 'ready' : 'muted'}`} /><div className="settings-row-main"><strong>{redactDisplayText(skill.name)} {skill.scope && <small>{skill.scope}</small>}</strong><span>{redactDisplayText(skill.description)}</span></div><button className={skill.loaded ? 'button-quiet' : 'button-primary'} disabled={busy || pending} onClick={() => void toggleSkill(skill)} type="button">{pending ? 'Applying…' : skill.loaded ? 'Unload' : 'Load'}</button></article>
                  })}
                  {settings.skills.length === 0 && <p className="settings-empty">No skills were discovered for this runtime.</p>}
                </div>
              </section>
            )}
          </main>
        </div>
        <footer className="settings-footer"><span>{snapshot?.workspace ? redactDisplayText(snapshot.workspace) : 'No project opened'}</span><button className="button-quiet" onClick={onClose} type="button">Done</button></footer>
      </section>
    </div>
  )
}
