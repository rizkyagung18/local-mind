import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Command, RefreshCw } from 'lucide-react';
import { DEFAULT_MODEL_PROFILES, type Chat, type Message, type Availability, type HealthResponse, type ModelProfile, type ModelsResponse, type ProfileId } from '@localmind/contracts';
import { Button } from '@/components/ui/button';
import { ApiError, createApiClient } from '@/lib/api';

const api = createApiClient();
const statuses: Record<Availability, string> = { ready: 'Ready', missing: 'Not installed', unconfigured: 'Not configured', incompatible: 'Incompatible', model_changed: 'Confirmation needed', unreachable: 'Ollama unavailable' };
const fallback: ModelProfile[] = DEFAULT_MODEL_PROFILES.map(p => ({ ...p, boundDigest: null, version: 1, availability: 'unreachable', reasonCode: null, reason: 'Checking this Mac…' }));
type Theme = 'system' | 'light' | 'dark';
function initialTheme(): Theme {
  try { const value = localStorage.getItem('localmind-theme'); return value === 'light' || value === 'dark' ? value : 'system'; } catch { return 'system'; }
}

export function App() {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [selected, setSelected] = useState<ProfileId>('general');
  const [chatList, setChatList] = useState<Chat[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [beforeSeq, setBeforeSeq] = useState<number | null>(null);
  const [chatError, setChatError] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatDialogMode, setChatDialogMode] = useState<'rename' | 'delete'>('rename');
  const [draftTitle, setDraftTitle] = useState('');
  const chatDialog = useRef<HTMLDialogElement>(null);
  const dialogOpener = useRef<HTMLElement | null>(null);
  const chatId = useRef<string | null>(null);
  const chatSequence = useRef(0);
  const listSequence = useRef(0);
  const chatOperation = useRef(false);
  const transcript = useRef<HTMLElement>(null);
  const scrollRestore = useRef<{ top: number; height: number } | null>(null);
  const showChatError = (failure: unknown) => setChatError(failure instanceof ApiError ? failure.message : 'Could not load saved chats. Try again.');
  const openChat = useCallback(async (id: string | null) => {
    const current = ++chatSequence.current;
    chatId.current = id; scrollRestore.current = null;
    setChat(null); setHistory([]); setBeforeSeq(null); setChatError(''); setChatLoading(!!id);
    if (!id) { setSelected('general'); return; }
    try {
      const [result, page] = await Promise.all([api.chat(id), api.messages(id)]);
      if (current !== chatSequence.current) return;
      setChat(result.data); setSelected(result.data.profileId); setHistory(page.data.items); setBeforeSeq(page.data.nextBeforeSeq);
      if (transcript.current) transcript.current.scrollTop = 0;
    } catch (failure) {
      if (current === chatSequence.current) showChatError(failure);
    } finally { if (current === chatSequence.current) setChatLoading(false); }
  }, []);
  const loadChats = useCallback(async (cursor?: string) => {
    const current = ++listSequence.current;
    setListLoading(true);
    try {
      const result = await api.chats(cursor ? { cursor } : {});
      if (current !== listSequence.current) return result.data.items;
      setChatList(previous => cursor ? [...new Map([...previous, ...result.data.items].map(item => [item.id, item])).values()] : result.data.items);
      setNextCursor(result.data.nextCursor);
      return result.data.items;
    } finally { if (current === listSequence.current) setListLoading(false); }
  }, []);
  useEffect(() => {
    let live = true;
    void loadChats().then(items => { if (live) void openChat(items[0]?.id ?? null); }).catch(failure => { if (live) showChatError(failure); });
    return () => { live = false; chatSequence.current++; listSequence.current++; };
  }, [loadChats, openChat]);
  useLayoutEffect(() => {
    if (scrollRestore.current && transcript.current) {
      transcript.current.scrollTop = scrollRestore.current.top + transcript.current.scrollHeight - scrollRestore.current.height;
      scrollRestore.current = null;
    }
  }, [history]);
  async function olderMessages() {
    if (!chat || beforeSeq === null || chatLoading) return;
    const current = chatSequence.current, id = chat.id;
    setChatLoading(true); setChatError('');
    try {
      const page = await api.messages(id, { beforeSeq });
      if (current !== chatSequence.current || id !== chatId.current) return;
      if (transcript.current) scrollRestore.current = { top: transcript.current.scrollTop, height: transcript.current.scrollHeight };
      setHistory(previous => [...new Map([...page.data.items, ...previous].map(item => [item.id, item])).values()].sort((a, b) => a.seq - b.seq));
      setBeforeSeq(page.data.nextBeforeSeq);
    } catch (failure) { if (current === chatSequence.current) showChatError(failure); }
    finally { if (current === chatSequence.current) setChatLoading(false); }
  }
  function closeChatDialog() { chatDialog.current?.close(); dialogOpener.current?.focus(); }
  function editChat(mode: 'rename' | 'delete', opener: HTMLElement) {
    if (!chat) return;
    dialogOpener.current = opener; setChatDialogMode(mode); setDraftTitle(chat.title); setChatError(''); chatDialog.current?.showModal();
  }
  async function changeChat(kind: 'create' | 'rename' | 'delete' | 'profile', profileId?: ProfileId) {
    if (chatOperation.current || (kind !== 'create' && !chat)) return;
    chatOperation.current = true; setChatBusy(true); setChatError('');
    const target = chat;
    try {
      let selectedId: string | null;
      if (kind === 'create') selectedId = (await api.createChat()).data.id;
      else if (kind === 'delete') { await api.deleteChat(target!.id, target!.version); selectedId = null; }
      else {
        const body = kind === 'rename' ? { expectedVersion: target!.version, title: draftTitle } : { expectedVersion: target!.version, profileId: profileId! };
        selectedId = (await api.updateChat(target!.id, body)).data.id;
      }
      closeChatDialog();
      const items = await loadChats();
      await openChat(selectedId ?? items[0]?.id ?? null);
    } catch (failure) {
      try {
        const items = await loadChats();
        await openChat(failure instanceof ApiError && failure.code === 'NOT_FOUND' ? items[0]?.id ?? null : target?.id ?? null);
      } catch { /* Keep safe error text and allow an explicit retry. */ }
      showChatError(failure);
    } finally { chatOperation.current = false; setChatBusy(false); }
  }
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('Checking local models…');
  const [choice, setChoice] = useState<string | null>(null);
  const operation = useRef(false);
  const sequence = useRef(0);
  const settings = useRef<HTMLDialogElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    const [inventory, server] = await Promise.allSettled([api.models(), api.health()]);
    if (current !== sequence.current) return;
    if (inventory.status === 'fulfilled') setModels(inventory.value);
    if (server.status === 'fulfilled') setHealth(server.value); else setHealth(null);
    if (inventory.status === 'rejected' || server.status === 'rejected') throw new ApiError('REQUEST_FAILED');
  }, []);
  useEffect(() => {
    let live = true;
    void reload().then(() => { if (live) setNotice('Model information is up to date.'); })
      .catch(() => { if (live) setError('Could not connect. Start the local server and try again.'); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; sequence.current++; };
  }, [reload]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  function changeTheme(value: Theme) {
    setTheme(value);
    try { localStorage.setItem('localmind-theme', value); } catch { /* Theme still works in memory. */ }
  }
  async function act(work: () => Promise<unknown>, success: string) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try { await work(); await reload(); setChoice(null); setNotice(success); }
    catch (failure) {
      try { await reload(); } catch { /* Retain last-known display data. */ }
      setError(failure instanceof ApiError ? failure.message : 'Could not connect. Start the local server and try again.');
    } finally { operation.current = false; setBusy(false); }
  }
  const profiles = models?.data.profiles ?? fallback;
  const current = profiles.find(p => p.id === selected)!;
  const community = profiles.find(p => p.id === 'abliterated')!;
  const eligible = models?.data.installed.filter(m => m.eligible) ?? [];
  const idle = health?.data.brokerState === 'idle';
  const canChange = !!models && !models.data.stale && idle && !busy && !error;
  const communityChoice = choice ?? community.modelName ?? '';
  const candidate = eligible.find(m => m.name === communityChoice);
  function bind(profile: ModelProfile, name: string | null, digest: string | null) {
    if ((name === null) !== (digest === null)) return;
    const body = name !== null && digest !== null
      ? { modelName: name, expectedDigest: digest, expectedVersion: profile.version }
      : { modelName: null, expectedDigest: null, expectedVersion: profile.version };
    void act(() => api.bindProfile(profile.id, body), `${profile.label} model updated.`);
  }
  function closeSettings() { settings.current?.close(); settingsButton.current?.focus(); }

  return (
    <div className="workspace">
      <a className="skip-link" href="#conversation">Skip to conversation</a>
      <aside className="sidebar" aria-label="Workspace sidebar">
        <div className="brand"><Command aria-hidden="true" size={23} /><span>LocalMind</span></div>
        <div className="sidebar-section"><h2>Conversations</h2>
          <Button onClick={() => { void changeChat('create'); }} disabled={chatBusy || listLoading}>New chat</Button>
          <nav className="chat-list" aria-label="Saved chats">{chatList.map(item => <button key={item.id} type="button" disabled={chatBusy} aria-current={chat?.id === item.id ? 'page' : undefined} onClick={() => { void openChat(item.id); }}>{item.title}</button>)}</nav>
          {listLoading && <p role="status">Loading chats…</p>}
          {!listLoading && chatList.length === 0 && <p>No saved chats yet.</p>}
          {nextCursor && <Button variant="outline" disabled={listLoading || chatBusy} onClick={() => { void loadChats(nextCursor).catch(showChatError); }}>More chats</Button>}
        </div>
        <fieldset className="mode-picker"><legend>Chat mode</legend>
          {profiles.map(profile => <label key={profile.id} className={`mode-row ${selected === profile.id ? 'selected' : ''}`}>
            <input type="radio" name="mode" value={profile.id} checked={selected === profile.id}
              disabled={!canChange || profile.availability !== 'ready' || chatBusy || chatLoading || !!chat?.activeRunId} onChange={() => { if (chat) void changeChat('profile', profile.id); else setSelected(profile.id); }} />
            <span><strong>{profile.label}</strong><small>{!models ? 'Checking availability' : statuses[profile.availability]}</small></span>
          </label>)}
        </fieldset>
        <Button ref={settingsButton} variant="outline" onClick={() => settings.current?.showModal()}>Model settings</Button>
        <div className="sidebar-bottom"><label htmlFor="theme">Appearance</label><select id="theme" value={theme} onChange={e => changeTheme(e.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select><p>Runs on this Mac.<br />No cloud connection by default.</p></div>
      </aside>
      <main id="conversation" className="conversation" tabIndex={-1}>
        <header className="conversation-header"><div><h1>{chat?.title ?? 'Conversation'}</h1><p>{current.label} · {selected === 'general' ? 'Official Qwen' : 'Community model'}</p></div><div className="chat-actions">{chat && <><Button variant="outline" disabled={chatBusy || chatLoading || !!chat.activeRunId} onClick={e => editChat('rename', e.currentTarget)}>Rename chat</Button><Button variant="outline" disabled={chatBusy || chatLoading || !!chat.activeRunId} onClick={e => editChat('delete', e.currentTarget)}>Delete chat</Button></>}<span className="local-label">Local workspace</span></div></header>
        <div className="connection-strip"><div role="status" aria-live="polite">{busy ? 'Checking local models…' : notice}</div><Button ref={refreshButton} variant="outline" onClick={() => { void act(() => api.refreshModels(), 'Model information is up to date.'); }} aria-disabled={busy} disabled={busy}><RefreshCw aria-hidden="true" />Refresh models</Button></div>
        {error && <p className="alert" role="alert">{error}</p>}
        {models?.data.stale && <p className="alert">Model information is out of date. Start Ollama and refresh before choosing or changing a model.</p>}
        {health && !idle && <p className="alert">The local runtime is busy or awaiting recovery. Model changes are unavailable.</p>}
        {chatError && <div className="alert" role="alert"><p>{chatError}</p><Button variant="outline" disabled={chatBusy || chatLoading || listLoading} onClick={() => { setChatError(''); void loadChats().then(items => openChat(chatId.current ?? items[0]?.id ?? null)).catch(showChatError); }}>Retry chats</Button></div>}
        {chat?.activeRunId && <p className="alert">This chat has an active run or pending cleanup. Renaming, switching its mode, and deleting are unavailable.</p>}
        <section ref={transcript} className={`transcript ${history.length ? 'has-history' : ''}`} aria-label="Conversation transcript" aria-busy={chatLoading}>
          {beforeSeq !== null && <Button variant="outline" disabled={chatLoading} onClick={() => { void olderMessages(); }}>Load older</Button>}
          {chatLoading && <p role="status">Loading messages…</p>}
          {history.map(message => <article key={message.id} className="saved-message" aria-label={`${message.role === 'user' ? 'You' : 'Assistant'} message ${message.seq}`}><header><strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong><span>{message.status}</span></header><p className="message-text">{message.content || 'No saved answer text.'}</p>{message.role === 'assistant' && <small>{message.profileId === 'general' ? 'General' : 'Abliterated'} · {message.modelName}</small>}</article>)}
          {!chatLoading && !history.length && <div className="empty-state"><Command aria-hidden="true" size={32} /><h2>{chat ? 'No messages yet' : 'Your local workspace'}</h2><p>{chat ? 'This chat is saved on this Mac. Messaging is coming next.' : 'Create a chat or reopen one from the sidebar.'}</p><p className="mode-explanation">Both modes use the same local privacy controls. They select different model weights.</p></div>}
        </section>
        <section className="composer" aria-label="Message composer"><label htmlFor="message">Message</label><textarea id="message" disabled placeholder="Messaging is not available yet" aria-describedby="composer-note" rows={2} /><p id="composer-note">Chat is not available yet. No message will be sent.</p></section>
      </main>
      <dialog ref={chatDialog} className="model-dialog" aria-labelledby="chat-dialog-title" onCancel={event => { if (chatBusy) event.preventDefault(); }} onClose={() => dialogOpener.current?.focus()}>
        <h2 id="chat-dialog-title">{chatDialogMode === 'rename' ? 'Rename chat' : 'Delete this chat?'}</h2>
        {chatError && <p className="alert" role="alert">{chatError}</p>}
        <form onSubmit={event => { event.preventDefault(); if (chat && !chat.activeRunId && !chatBusy && (chatDialogMode === 'delete' || (draftTitle.trim() && [...draftTitle].length <= 120))) void changeChat(chatDialogMode); }}>
          {chatDialogMode === 'rename' ? <><label htmlFor="chat-title">Chat title</label><input id="chat-title" value={draftTitle} onChange={event => setDraftTitle(event.target.value)} disabled={chatBusy} /></> : <p>This removes “{chat?.title}”, all its messages, and its run records from LocalMind. Installed models and their settings are kept. This cannot be undone and does not guarantee physical erasure from disk or backups.</p>}
          <div className="dialog-actions"><Button type="button" variant="outline" disabled={chatBusy} onClick={closeChatDialog}>Cancel</Button><Button type="submit" disabled={chatBusy || !chat || !!chat.activeRunId || (chatDialogMode === 'rename' && (!draftTitle.trim() || [...draftTitle].length > 120))}>{chatDialogMode === 'rename' ? 'Save title' : 'Delete permanently'}</Button></div>
        </form>
      </dialog>
      <dialog ref={settings} className="model-dialog" aria-labelledby="model-settings-title" onCancel={() => { settingsButton.current?.focus(); }}>
        <header><div><h2 id="model-settings-title">Model settings</h2><p>Only models already installed on this Mac.</p></div><Button variant="outline" onClick={closeSettings}>Close</Button></header>
        {error && <p role="alert" className="alert">{error}</p>}
        {models?.data.stale && <p className="alert">Inventory is stale. Refresh models before binding.</p>}
        {profiles.map(profile => {
          const installed = models?.data.installed.find(model => model.name === profile.modelName);
          return <section className="profile-detail" key={profile.id} aria-label={`${profile.label} model`}>
            <div className="profile-heading"><h3>{profile.label}</h3><span>{models ? statuses[profile.availability] : 'Checking availability'}</span></div>
            <p className="model-tag">{profile.modelName ?? 'No model selected'}</p>
            <p>{profile.reason ?? (profile.id === 'general' ? 'Official Qwen for general chat.' : 'A separately installed community variant.')}</p>
            {profile.availability === 'missing' && <p>Install the model in Ollama separately, then refresh. LocalMind does not download models.</p>}
            {profile.availability === 'model_changed' && installed?.eligible && <Button disabled={!canChange} onClick={() => bind(profile, installed.name, installed.digest)}>Confirm updated {profile.label} model</Button>}
          </section>;
        })}
        <form onSubmit={event => { event.preventDefault(); if (candidate && canChange) bind(community, candidate.name, candidate.digest); }}>
          <label htmlFor="community-model">Installed model for Abliterated</label>
          <select id="community-model" value={communityChoice} onChange={e => setChoice(e.target.value)} disabled={!canChange}>
            <option value="">Choose an installed model</option>
            {communityChoice && !candidate && <option value={communityChoice} disabled>{communityChoice} — unavailable</option>}
            {eligible.map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
          </select>
          <p>Binding changes this mode’s model. Existing conversation history stays unchanged.</p>
          <div className="dialog-actions"><Button type="submit" disabled={!canChange || !candidate}>Bind selected model</Button><Button type="button" variant="outline" disabled={busy || !idle || !models || community.modelName === null} onClick={() => bind(community, null, null)}>Clear community mapping</Button></div>
        </form>
        <Button variant="outline" disabled={busy} onClick={() => { void act(() => api.refreshModels(), 'Model information is up to date.'); }}>Refresh installed models</Button>
      </dialog>
    </div>
  );
}
