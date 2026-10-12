import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import JSZip from 'jszip';

type Chapter = { name: string; startIndex: number };
type HistoryEntry = { id: string; name: string; chapters: Chapter[]; currentIndex: number; lastOpened: string; content?: string[] };

const section = 'novelReader';
let decorations: vscode.TextEditorDecorationType[] = [];
let status: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let currentContent: string[] = [];
let historyEntries: HistoryEntry[] = [];
const lastRender = new WeakMap<vscode.TextEditor, string>();
let readerView: NovelReaderViewProvider | undefined;

function config() { return vscode.workspace.getConfiguration(section, vscode.window.activeTextEditor?.document.uri); }
function read<T>(key: string, fallback: T): T {
  if (key === 'content') return currentContent as T;
  if (key === 'history') return historyEntries as T;
  return config().get<T>(key, fallback);
}
async function save(key: string, value: unknown) {
  if (key === 'content') {
    currentContent = value as string[];
    return;
  }
  if (key === 'history') {
    historyEntries = value as HistoryEntry[];
    await extensionContext.globalState.update('history', historyEntries);
    return;
  }
  const settings = config();
  const inspected = settings.inspect(key);
  const target = inspected?.workspaceFolderValue !== undefined
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : inspected?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await settings.update(key, value, target);
}

function newBookId() { return `book-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
function bookUri(id: string) { return vscode.Uri.joinPath(extensionContext.globalStorageUri, `${id}.json`); }
async function writeBook(id: string, content: string[]) {
  await vscode.workspace.fs.createDirectory(extensionContext.globalStorageUri);
  await vscode.workspace.fs.writeFile(bookUri(id), Buffer.from(JSON.stringify(content), 'utf8'));
}
async function readBook(id: string) {
  try {
    return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(bookUri(id))).toString('utf8')) as string[];
  } catch {
    return [];
  }
}

async function initializeStorage() {
  historyEntries = extensionContext.globalState.get<HistoryEntry[]>('history', []);
  const activeId = extensionContext.globalState.get<string>('activeBookId');
  if (activeId) currentContent = await readBook(activeId);

  const legacyContent = config().get<string[]>('content', []);
  const legacyHistory = config().get<Array<Omit<HistoryEntry, 'id'> & { content: string[] }>>('history', []);
  if (!historyEntries.length && legacyHistory.length) {
    for (const oldBook of legacyHistory) {
      const id = newBookId();
      await writeBook(id, oldBook.content || []);
      historyEntries.push({ id, name: oldBook.name, chapters: oldBook.chapters, currentIndex: oldBook.currentIndex, lastOpened: oldBook.lastOpened });
    }
  }
  if (!currentContent.length && legacyContent.length) {
    let current = historyEntries.find(item => item.name === config().get('bookName', '未命名小说'));
    if (!current) {
      const id = newBookId();
      current = { id, name: config().get('bookName', '未命名小说'), chapters: config().get('chapters', chaptersFor(legacyContent)), currentIndex: config().get('currentIndex', 0), lastOpened: config().get('lastOpened', '') };
      historyEntries.unshift(current);
      await writeBook(id, legacyContent);
    }
    currentContent = legacyContent;
    await extensionContext.globalState.update('activeBookId', current.id);
  }
  if (currentContent.length && activeId) {
    const active = historyEntries.find(item => item.id === activeId);
    if (active) {
      active.chapters = chaptersFor(currentContent);
      await config().update('chapters', active.chapters, vscode.ConfigurationTarget.Global);
    }
  }
  await extensionContext.globalState.update('history', historyEntries);
  if (legacyHistory.length) await config().update('history', undefined, vscode.ConfigurationTarget.Global);
  if (legacyContent.length) await config().update('content', undefined, vscode.ConfigurationTarget.Global);
}

function chaptersFor(content: string[]): Chapter[] {
  const pattern = /^(?:卷[一二三四五六七八九十百千万]+\s+)?(?:第[一二三四五六七八九十百千万0-9]+章|Chapter\s+[0-9]+)/i;
  const unique = new Map<string, Chapter>();
  content.forEach((text, i) => {
    const name = text.trim();
    if (pattern.test(name)) unique.set(name.toLocaleLowerCase(), { name, startIndex: i });
  });
  const result = [...unique.values()].sort((a, b) => a.startIndex - b.startIndex);
  return result.length ? result : [{ name: '全文', startIndex: 0 }];
}

function commentText(languageId: string, text: string) {
  const htmlComments = new Set(['html', 'xml', 'xsl', 'markdown', 'vue', 'svelte']);
  const hashComments = new Set(['python', 'ruby', 'shellscript', 'yaml', 'dockerfile', 'makefile', 'perl', 'r', 'powershell', 'toml', 'ini', 'properties']);
  const dashComments = new Set(['sql', 'lua', 'haskell']);
  const percentComments = new Set(['matlab', 'latex', 'tex']);
  const semicolonComments = new Set(['clojure', 'lisp', 'scheme']);
  if (htmlComments.has(languageId)) return `<!-- ${text} -->`;
  if (hashComments.has(languageId)) return `# ${text}`;
  if (dashComments.has(languageId)) return `-- ${text}`;
  if (percentComments.has(languageId)) return `% ${text}`;
  if (semicolonComments.has(languageId)) return `; ${text}`;
  if (languageId === 'css' || languageId === 'scss' || languageId === 'less') return `/* ${text} */`;
  if (languageId === 'bat') return `REM ${text}`;
  if (languageId === 'visual-basic' || languageId === 'vb') return `' ${text}`;
  return `// ${text}`;
}

function createDecorations() {
  const color = read('textColor', '');
  const opacity = Math.max(0.1, Math.min(1, read('textOpacity', 1)));
  // 顶层 opacity 只会作用于装饰范围自身，而这里显示的是空范围上的 before 文本，所以必须通过 before 下发；
  // 扩展宿主只透传 before 的既有属性（不含 opacity），因此与 display 一样并入 textDecoration 注入。
  return Array.from({ length: 4 }, () => vscode.window.createTextEditorDecorationType({
    before: { color: color || undefined, textDecoration: `none; display: block; opacity: ${opacity};` }
  }));
}

function rebuildDecoration() {
  const editors = vscode.window.visibleTextEditors;
  for (const editor of editors) {
    for (const decoration of decorations) editor.setDecorations(decoration, []);
  }
  for (const decoration of decorations) decoration.dispose();
  decorations = createDecorations();
  for (const editor of editors) {
    lastRender.delete(editor);
    apply(editor);
  }
}

function apply(editor?: vscode.TextEditor) {
  if (!editor) return;
  if (!read('enabled', false) || read('hidden', false)) {
    clear(editor);
    return;
  }
  const content = read<string[]>('content', []);
  const index = Math.max(0, Math.min(read('currentIndex', 0), Math.max(0, content.length - 1)));
  const lines = [content[index] || '', content[index + 1] || ''];
  const visibleRanges = editor.visibleRanges;
  const firstVisibleLine = visibleRanges[0]?.start.line ?? 0;
  const lastVisibleLine = visibleRanges[visibleRanges.length - 1]?.end.line ?? firstVisibleLine;
  const centerLine = Math.min(editor.document.lineCount - 1, Math.floor((firstVisibleLine + lastVisibleLine) / 2));
  const renderKey = `${centerLine}:${index}:${editor.document.languageId}:${read('bookName', '')}:${lines.join('\n')}`;
  if (lastRender.get(editor) === renderKey) return;
  lastRender.set(editor, renderKey);
  const range = new vscode.Range(centerLine, 0, centerLine, 0);
  const virtualLines = [' ', ...lines.map(line => commentText(editor.document.languageId, line)), ' '];
  decorations.forEach((decoration, slot) => {
    editor.setDecorations(decoration, [{ range, renderOptions: { before: { contentText: virtualLines[slot] } } }]);
  });
}

function clear(editor?: vscode.TextEditor) {
  if (!editor) return;
  lastRender.delete(editor);
  for (const decoration of decorations) editor.setDecorations(decoration, []);
}

function updateStatus() {
  const enabled = read('enabled', false);
  if (!enabled) {
    status.hide();
    return;
  }
  const chapters = read<Chapter[]>('chapters', []);
  const currentChapter = findChapter(chapters, read('currentIndex', 0));
  const chapterCount = Math.max(1, chapters.length);
  status.text = `${read('hidden', false) ? '$(book) ' : '$(book) '}${read('bookName', '未命名小说')} ${read('hidden', false) ? '(已隐藏)' : `(第 ${Math.min(currentChapter + 1, chapterCount)}/${chapterCount} 章)`}`;
  status.tooltip = enabled ? '点击打开小说阅读菜单' : '';
  status.color = read('hidden', false) ? new vscode.ThemeColor('descriptionForeground') : new vscode.ThemeColor('statusBarItem.prominentForeground');
  status.show();
}

function refreshUi() {
  updateStatus();
  readerView?.refresh();
}

function inputText(): Promise<string | undefined> {
  const panel = vscode.window.createWebviewPanel('novelReaderInput', '输入小说文本', vscode.ViewColumn.Active, { enableScripts: true });
  const nonce = Math.random().toString(36).slice(2);
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>body{padding:20px;font-family:var(--vscode-font-family)}textarea{box-sizing:border-box;width:100%;height:calc(100vh - 90px);resize:none;padding:10px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}button{float:right;margin-top:10px;padding:5px 14px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0}button:hover{background:var(--vscode-button-hoverBackground)}</style></head><body><textarea autofocus placeholder="在此粘贴或输入小说内容，每行作为一个段落"></textarea><button>导入</button><script nonce="${nonce}">const vscode=acquireVsCodeApi();const text=document.querySelector('textarea');document.querySelector('button').onclick=()=>vscode.postMessage(text.value);</script></body></html>`;
  return new Promise(resolve => {
    let settled = false;
    panel.webview.onDidReceiveMessage((value: string) => {
      settled = true;
      resolve(value);
      panel.dispose();
    }, undefined, extensionContext.subscriptions);
    panel.onDidDispose(() => {
      if (!settled) resolve(undefined);
    }, undefined, extensionContext.subscriptions);
  });
}

async function move(delta: number) {
  const content = read<string[]>('content', []);
  if (!content.length) return vscode.window.showInformationMessage('请先打开一本小说');
  let next = read('currentIndex', 0) + delta;
  if (next >= content.length || next < 0) {
    const loop = read('loopAtEnd', true);
    if (!loop) return vscode.window.showInformationMessage(next < 0 ? '已到达首页' : '已到达末页');
    next = next < 0 ? content.length - 1 : 0;
    vscode.window.showInformationMessage(next === 0 ? '已到达末页，已回到开头' : '已回到末页');
  }
  await save('currentIndex', next);
  await save('chapterIndex', findChapter(read('chapters', []), next));
  await save('lastOpened', new Date().toISOString());
  await updateHistoryPosition(next);
  apply(vscode.window.activeTextEditor); refreshUi();
}

function findChapter(list: Chapter[], index: number) { let found = 0; list.forEach((c, i) => { if (c.startIndex <= index) found = i; }); return found; }

async function updateHistoryPosition(index: number) {
  const name = read('bookName', '未命名小说');
  const history = read<HistoryEntry[]>('history', []);
  const activeId = extensionContext.globalState.get<string>('activeBookId');
  const item = history.find(entry => entry.id === activeId) || history.find(entry => entry.name === name);
  if (!item) return;
  item.currentIndex = index;
  item.lastOpened = new Date().toISOString();
  await save('history', history);
}

async function moveChapter(delta: number) {
  const list = read<Chapter[]>('chapters', []);
  if (!list.length) return vscode.window.showInformationMessage('当前小说没有章节信息');
  const current = findChapter(list, read('currentIndex', 0));
  const target = current + delta;
  if (target < 0) return vscode.window.showInformationMessage('已是第一章');
  if (target >= list.length) return vscode.window.showInformationMessage('已是最后一章');
  await save('chapterIndex', target); await save('currentIndex', list[target].startIndex); await save('lastOpened', new Date().toISOString());
  await updateHistoryPosition(list[target].startIndex);
  apply(vscode.window.activeTextEditor); refreshUi();
}

function textFromHtml(input: string) { return input.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'); }

async function epubText(file: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const container = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error('EPUB 缺少目录信息');
  const opf = await zip.file(opfPath)?.async('string');
  if (!opf) throw new Error('EPUB 缺少书籍内容');
  const manifest = new Map<string, string>();
  for (const match of opf.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"[^>]*>/g)) manifest.set(match[1], path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), match[2])));
  const ids = [...opf.matchAll(/<itemref[^>]+idref="([^"]+)"/g)].map(m => m[1]);
  const text = (await Promise.all(ids.map(async id => textFromHtml(await zip.file(manifest.get(id) || '')?.async('string') || '')))).join('\n');
  return text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

async function openNovelImpl() {
  const choice = await vscode.window.showQuickPick(['输入文本', '从文件导入', '打开历史记录'], { placeHolder: '选择小说来源' });
  if (!choice) return;
  let content: string[] = []; let name = '未命名小说';
  if (choice === '输入文本') {
    const value = await inputText();
    if (value === undefined) return; content = value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    name = await vscode.window.showInputBox({ prompt: '输入小说名称', value: '未命名小说' }) || '未命名小说';
  } else if (choice === '从文件导入') {
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 小说: ['txt', 'epub'] } });
    if (!files?.[0]) return; name = path.basename(files[0].fsPath, path.extname(files[0].fsPath));
    content = path.extname(files[0].fsPath).toLowerCase() === '.epub' ? await epubText(files[0].fsPath) : (await fs.readFile(files[0].fsPath, 'utf8')).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  } else {
    const history = read<HistoryEntry[]>('history', []);
    const selected = await vscode.window.showQuickPick(history.map((h, i) => ({ label: h.name, description: h.lastOpened, index: i })), { placeHolder: '选择历史小说' });
    if (!selected) return;
    const item = history[selected.index];
    name = item.name;
    content = item.content || await readBook(item.id);
    item.chapters = chaptersFor(content);
    await extensionContext.globalState.update('activeBookId', item.id);
    await save('chapters', item.chapters);
    await save('currentIndex', item.currentIndex);
    await save('history', history);
  }
  if (choice !== '打开历史记录') {
    const chapters = chaptersFor(content);
    const existing = read<HistoryEntry[]>('history', []).find(h => h.name === name);
    const id = existing?.id || newBookId();
    await writeBook(id, content);
    await extensionContext.globalState.update('activeBookId', id);
    await save('chapters', chapters); await save('currentIndex', 0); await save('chapterIndex', 0);
    const history = read<HistoryEntry[]>('history', []).filter(h => h.name !== name);
    history.unshift({ id, name, chapters, currentIndex: 0, lastOpened: new Date().toISOString() });
    await save('history', history.slice(0, 20));
  }
  await save('content', content); await save('bookName', name); await save('enabled', true); await save('hidden', false); await save('lastOpened', new Date().toISOString()); apply(vscode.window.activeTextEditor); refreshUi();
}

async function openNovel() {
  try {
    await openNovelImpl();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`小说导入失败: ${message}`);
  }
}

async function jump() {
  const value = await vscode.window.showInputBox({
    prompt: '输入章节号、段落号或百分比，例如 351、p351、50%',
    validateInput: input => /^(?:\d+%?|p\d+)$/i.test(input.trim()) ? undefined : '请输入章节号、p加段落号或百分比'
  });
  if (!value) return;
  const normalized = value.trim().toLowerCase();
  const content = read<string[]>('content', []);
  const chapters = read<Chapter[]>('chapters', []);
  let index: number;
  if (normalized.endsWith('%')) {
    index = Math.round((Number(normalized.slice(0, -1)) / 100) * Math.max(0, content.length - 1));
  } else if (normalized.startsWith('p')) {
    index = Number(normalized.slice(1)) - 1;
  } else {
    const chapterNumber = Number(normalized);
    const exactMatches = chapters.filter(chapter => {
      const match = chapter.name.match(/第\s*0*(\d+)\s*章/i) || chapter.name.match(/Chapter\s+0*(\d+)/i);
      return match ? Number(match[1]) === chapterNumber : false;
    });
    const target = exactMatches.at(-1) || chapters[chapterNumber - 1];
    if (!target || target.name === '全文') {
      vscode.window.showInformationMessage(`未找到第 ${chapterNumber} 章`);
      return;
    }
    index = Math.min(target.startIndex + 1, Math.max(0, content.length - 1));
  }
  index = Math.max(0, Math.min(index, Math.max(0, content.length - 1)));
  await save('currentIndex', index);
  await save('chapterIndex', findChapter(chapters, index));
  await updateHistoryPosition(index);
  apply(vscode.window.activeTextEditor);
  refreshUi();
}

class NovelReaderViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(message => this.handleMessage(message), undefined, extensionContext.subscriptions);
    view.onDidChangeVisibility(() => this.refresh(), undefined, extensionContext.subscriptions);
    this.refresh();
  }

  refresh() {
    if (!this.view) return;
    const chapters = read<Chapter[]>('chapters', []);
    const currentChapter = findChapter(chapters, read('currentIndex', 0));
    this.view.webview.postMessage({
      type: 'state',
      state: {
        bookName: read('bookName', '未命名小说'),
        enabled: read('enabled', false),
        hidden: read('hidden', false),
        currentChapter,
        chapterCount: Math.max(1, chapters.length),
        chapters: chapters.map(chapter => chapter.name),
        textOpacity: read('textOpacity', 1),
        textColor: read('textColor', ''),
        loopAtEnd: read('loopAtEnd', true)
      }
    });
  }

  private async handleMessage(message: { type: string; command?: string; key?: string; value?: unknown; index?: number }) {
    if (message.type === 'ready') {
      this.refresh();
      return;
    }
    if (message.type === 'command' && message.command) {
      await vscode.commands.executeCommand(message.command);
      return;
    }
    if (message.type === 'shortcuts') {
      await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'novel-reader.');
      return;
    }
    if (message.type === 'setting' && message.key && ['textOpacity', 'textColor', 'loopAtEnd'].includes(message.key)) {
      let value = message.value;
      if (message.key === 'textOpacity') value = Math.max(0.1, Math.min(1, Number(value) || 1));
      if (message.key === 'textColor') {
        const colorValue = String(value || '').trim();
        if (colorValue && !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(colorValue)) {
          vscode.window.showErrorMessage('颜色格式无效，请输入 #RGB 或 #RRGGBB');
          this.refresh();
          return;
        }
        value = colorValue;
      }
      await save(message.key, value);
      if (message.key === 'textOpacity' || message.key === 'textColor') rebuildDecoration();
      refreshUi();
      return;
    }
    if (message.type === 'chapter' && typeof message.index === 'number') {
      const chapters = read<Chapter[]>('chapters', []);
      const target = chapters[message.index];
      if (!target) return;
      const index = Math.min(target.startIndex + (target.name === '全文' ? 0 : 1), Math.max(0, currentContent.length - 1));
      await save('currentIndex', index);
      await save('chapterIndex', message.index);
      await updateHistoryPosition(index);
      apply(vscode.window.activeTextEditor);
      refreshUi();
    }
  }

  private html() {
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
      *{box-sizing:border-box}body{padding:0 12px 20px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}header{padding:14px 0 12px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border)}h2{margin:0 0 4px;font-size:14px;font-weight:600}h3{margin:18px 0 9px;font-size:11px;text-transform:uppercase;color:var(--vscode-descriptionForeground)}.muted{color:var(--vscode-descriptionForeground)}.actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:12px}button,select,input{font:inherit}button{min-height:28px;padding:4px 8px;border:1px solid var(--vscode-button-border,transparent);color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground)}button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}select,input[type=text]{width:100%;height:28px;padding:3px 6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}.row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:32px}.row>label:first-child{flex:1}.row input[type=text]{width:78px;text-align:right;font-variant-numeric:tabular-nums}.switch{display:flex;align-items:center;gap:7px}.color-entry{display:grid;grid-template-columns:auto 1fr auto;gap:6px;width:100%;margin:5px 0}input[type=color]{width:34px;height:28px;padding:1px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);cursor:pointer}input[type=color]::-webkit-color-swatch-wrapper{padding:2px}input[type=color]::-webkit-color-swatch{border:0}.full{width:100%;margin-top:8px}.progress{font-variant-numeric:tabular-nums}
    </style></head><body>
      <header><h2 id="book">未命名小说</h2><div id="progress" class="muted progress">第 1/1 章</div><div class="actions"><button data-command="novel-reader.prev">上一段</button><button data-command="novel-reader.next">下一段</button><button class="secondary" data-command="novel-reader.open">打开小说</button><button class="secondary" data-command="novel-reader.toggleHide" id="visibility">隐藏内容</button></div></header>
      <section><h3>章节</h3><select id="chapters" aria-label="章节跳转"></select><div class="actions"><button class="secondary" data-command="novel-reader.prevChapter">上一章</button><button class="secondary" data-command="novel-reader.nextChapter">下一章</button></div></section>
      <section><h3>显示</h3><div class="row"><label for="opacity">文字透明度</label><input id="opacity" type="text" inputmode="numeric" maxlength="4" placeholder="100%" title="输入 10-100 的百分比，回车或失焦生效"></div><label for="color">文字颜色</label><div class="color-entry"><input id="colorPicker" type="color" title="打开颜色选择器，拖动时实时预览"><input id="color" type="text" maxlength="7" placeholder="#RRGGBB，留空自动"><button id="applyColor">应用</button></div><div class="row"><label class="switch"><input id="loop" type="checkbox"> 末页循环</label></div></section>
      <section><h3>快捷键</h3><div class="row"><span>下一段</span><code>Alt+Q</code></div><div class="row"><span>隐藏/显示</span><code>Ctrl+Alt+Q</code></div><button id="shortcuts" class="secondary full">编辑全部快捷键</button></section>
      <script nonce="${nonce}">const vscode=acquireVsCodeApi();const $=id=>document.getElementById(id);const colorInput=$('color');const colorPicker=$('colorPicker');const toHex=value=>{const m=String(value||'').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);if(!m)return '';return (m[1].length===3?'#'+m[1].replace(/./g,c=>c+c):'#'+m[1]).toLowerCase()};const themeColor=()=>{const probe=document.createElement('span');probe.style.color='var(--vscode-editor-foreground)';document.body.append(probe);const parts=getComputedStyle(probe).color.match(/\d+/g);probe.remove();return parts&&parts.length>2?'#'+parts.slice(0,3).map(v=>Number(v).toString(16).padStart(2,'0')).join(''):'#d4d4d4'};let colorTimer;const applyColor=()=>vscode.postMessage({type:'setting',key:'textColor',value:colorInput.value});let textOpacity=1;const opacityInput=$('opacity');const applyOpacity=()=>{const raw=opacityInput.value.trim().replace(/%/g,'');const percent=Math.round(Number(raw));if(!raw||!isFinite(percent)){opacityInput.value=Math.round(textOpacity*100)+'%';return}const next=Math.min(100,Math.max(10,percent));opacityInput.value=next+'%';vscode.postMessage({type:'setting',key:'textOpacity',value:next/100})};document.querySelectorAll('[data-command]').forEach(button=>button.onclick=()=>vscode.postMessage({type:'command',command:button.dataset.command}));$('shortcuts').onclick=()=>vscode.postMessage({type:'shortcuts'});$('chapters').onchange=event=>vscode.postMessage({type:'chapter',index:Number(event.target.value)});opacityInput.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();applyOpacity()}};opacityInput.onblur=applyOpacity;$('loop').onchange=event=>vscode.postMessage({type:'setting',key:'loopAtEnd',value:event.target.checked});$('applyColor').onclick=applyColor;colorPicker.oninput=()=>{colorInput.value=colorPicker.value;clearTimeout(colorTimer);colorTimer=setTimeout(()=>vscode.postMessage({type:'setting',key:'textColor',value:colorPicker.value}),120)};colorPicker.onchange=()=>{colorInput.value=colorPicker.value;clearTimeout(colorTimer);applyColor()};colorInput.oninput=()=>{const hex=toHex(colorInput.value);if(hex)colorPicker.value=hex};colorInput.onkeydown=event=>{if(event.key==='Enter')applyColor()};window.addEventListener('message',event=>{const s=event.data.state;if(!s)return;$('book').textContent=s.bookName;$('progress').textContent='第 '+(s.currentChapter+1)+'/'+s.chapterCount+' 章';$('visibility').textContent=!s.enabled?'开始阅读':s.hidden?'显示内容':'隐藏内容';textOpacity=Number(s.textOpacity)||1;if(document.activeElement!==opacityInput)opacityInput.value=Math.round(textOpacity*100)+'%';$('loop').checked=s.loopAtEnd;if(document.activeElement!==colorInput)colorInput.value=s.textColor||'';if(document.activeElement!==colorPicker)colorPicker.value=toHex(s.textColor)||themeColor();const select=$('chapters');select.replaceChildren();s.chapters.forEach((name,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=name;option.selected=index===s.currentChapter;select.append(option)});});vscode.postMessage({type:'ready'});</script>
    </body></html>`;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  decorations = createDecorations();
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100); status.command = 'novel-reader.statusMenu'; context.subscriptions.push(status, ...decorations);
  readerView = new NovelReaderViewProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('novelReader.sidebar', readerView));
  const commands: [string, (...args: any[]) => any][] = [
    ['novel-reader.open', openNovel],
    ['novel-reader.next', () => move(2)],
    ['novel-reader.prev', () => move(-2)],
    ['novel-reader.nextChapter', () => moveChapter(1)],
    ['novel-reader.prevChapter', () => moveChapter(-1)],
    ['novel-reader.jumpTo', jump],
    ['novel-reader.toggleHide', async () => {
      if (!read('enabled', false)) return vscode.commands.executeCommand('novel-reader.open');
      await save('hidden', !read('hidden', false));
      apply(vscode.window.activeTextEditor);
      if (read('hidden', false)) clear(vscode.window.activeTextEditor);
      refreshUi();
    }],
    ['novel-reader.close', async () => {
      await save('enabled', false);
      clear(vscode.window.activeTextEditor);
      refreshUi();
    }],
    ['novel-reader.statusMenu', async () => {
      const choice = await vscode.window.showQuickPick(['下一段', '上一段', '下一章', '上一章', '快速跳转', read('hidden', false) ? '显示小说' : '隐藏小说', '关闭显示']);
      const commandMap: Record<string, string> = { '下一段': 'novel-reader.next', '上一段': 'novel-reader.prev', '下一章': 'novel-reader.nextChapter', '上一章': 'novel-reader.prevChapter', '快速跳转': 'novel-reader.jumpTo', '显示小说': 'novel-reader.toggleHide', '隐藏小说': 'novel-reader.toggleHide', '关闭显示': 'novel-reader.close' };
      if (choice) await vscode.commands.executeCommand(commandMap[choice]);
    }]
  ];
  commands.forEach(([id, fn]) => context.subscriptions.push(vscode.commands.registerCommand(id, fn)));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => apply(editor)));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorVisibleRanges(event => apply(event.textEditor)));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration(section)) return;
    if (event.affectsConfiguration(`${section}.textOpacity`) || event.affectsConfiguration(`${section}.textColor`)) rebuildDecoration();
    else {
      clear(vscode.window.activeTextEditor);
      apply(vscode.window.activeTextEditor);
    }
    refreshUi();
  }));
  try {
    await initializeStorage();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`小说数据加载失败: ${message}`);
  }
  refreshUi(); apply(vscode.window.activeTextEditor);
}

export function deactivate() { decorations.forEach(decoration => decoration.dispose()); status?.dispose(); }
