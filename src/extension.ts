// Copyright (c) 2024 MIA Project
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { registerLogger, traceError, traceLog, traceVerbose } from './common/log/logging';
import {
    checkVersion,
    getInterpreterDetails,
    initializePython,
    onDidChangePythonInterpreter,
    resolveInterpreter,
} from './common/python';
import { restartServer } from './common/server';
import { checkIfConfigurationChanged, getInterpreterFromSetting } from './common/settings';
import { loadServerDefaults } from './common/setup';
import { getLSClientTraceLevel } from './common/utilities';
import { createOutputChannel, onDidChangeConfiguration, registerCommand } from './common/vscodeapi';

let lsClient: LanguageClient | undefined;
let chatViewProvider: MIAChatViewProvider | undefined;
let diffPreviewPanel: vscode.WebviewPanel | undefined;

interface ActiveFileInfo {
    fileName: string;
    filePath: string;
    language: string;
    content: string;
    selectedText: string;
    lineCount: number;
    cursorLine: number;
}

interface CodeChange {
    id: string;
    originalCode: string;
    newCode: string;
    language: string;
    fileName: string;
    filePath: string;
}

function getActiveFileInfo(): ActiveFileInfo | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const document = editor.document;
    const selection = editor.selection;
    const fileName = document.fileName.split(/[/\\]/).pop() || 'unknown';

    return {
        fileName,
        filePath: document.uri.fsPath,
        language: document.languageId,
        content: document.getText(),
        selectedText: document.getText(selection),
        lineCount: document.lineCount,
        cursorLine: selection.active.line + 1,
    };
}

function showDiffPreviewPanel(
    _extensionUri: vscode.Uri,
    originalCode: string,
    newCode: string,
    fileName: string,
    _language: string,
): vscode.WebviewPanel {
    if (diffPreviewPanel) {
        diffPreviewPanel.dispose();
    }

    diffPreviewPanel = vscode.window.createWebviewPanel(
        'miaDiffPreview',
        `🔄 MIA - Cambios para ${fileName}`,
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
        },
    );

    diffPreviewPanel.webview.html = getDiffPreviewHtml(originalCode, newCode, fileName);

    diffPreviewPanel.webview.onDidReceiveMessage(async (message) => {
        switch (message.type) {
            case 'applyChanges':
                await applyFinalCode(message.finalCode);
                diffPreviewPanel?.dispose();
                break;
            case 'cancel':
                diffPreviewPanel?.dispose();
                vscode.window.showInformationMessage('Cambios descartados');
                break;
        }
    });

    diffPreviewPanel.onDidDispose(() => {
        diffPreviewPanel = undefined;
    });

    return diffPreviewPanel;
}

async function applyFinalCode(finalCode: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No hay editor activo');
        return;
    }

    const document = editor.document;
    const selection = editor.selection;

    await editor.edit((editBuilder) => {
        if (!selection.isEmpty) {
            editBuilder.replace(selection, finalCode);
        } else {
            const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
            editBuilder.replace(fullRange, finalCode);
        }
    });

    vscode.window.showInformationMessage('✅ Cambios aplicados correctamente');
}

function getDiffPreviewHtml(originalCode: string, newCode: string, fileName: string): string {
    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MIA - Vista Previa de Cambios</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            padding: 12px 20px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header-title {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 14px;
            font-weight: 600;
        }
        .header-actions {
            display: flex;
            gap: 8px;
        }
        .btn {
            padding: 6px 14px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .btn-accept-all {
            background-color: #28a745;
            color: white;
        }
        .btn-accept-all:hover { background-color: #218838; }
        .btn-reject-all {
            background-color: transparent;
            color: #dc3545;
            border: 1px solid #dc3545;
        }
        .btn-reject-all:hover { background-color: rgba(220, 53, 69, 0.1); }
        
        .legend {
            padding: 8px 20px;
            display: flex;
            gap: 20px;
            font-size: 11px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .legend-item { display: flex; align-items: center; gap: 6px; }
        .legend-color { width: 12px; height: 12px; border-radius: 2px; }
        .legend-color.removed { background-color: rgba(220, 53, 69, 0.4); }
        .legend-color.added { background-color: rgba(40, 167, 69, 0.4); }
        .legend-color.context { background-color: transparent; border: 1px dashed var(--vscode-panel-border); }
        
        .diff-container {
            flex: 1;
            overflow-y: auto;
            padding: 10px 0;
        }
        
        .hunk {
            margin: 10px 15px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            overflow: hidden;
        }
        .hunk.accepted { border-color: #28a745; }
        .hunk.rejected { border-color: #dc3545; opacity: 0.5; }
        
        .hunk-header {
            padding: 8px 12px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
        }
        .hunk-info {
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
        }
        .hunk-actions { display: flex; gap: 6px; }
        .hunk-btn {
            padding: 4px 10px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 500;
        }
        .hunk-btn.accept {
            background-color: #28a745;
            color: white;
        }
        .hunk-btn.accept:hover { background-color: #218838; }
        .hunk-btn.reject {
            background-color: #dc3545;
            color: white;
        }
        .hunk-btn.reject:hover { background-color: #c82333; }
        .hunk-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .hunk-status {
            padding: 4px 10px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 500;
        }
        .hunk-status.accepted { background-color: #28a745; color: white; }
        .hunk-status.rejected { background-color: #dc3545; color: white; }
        
        .hunk-content {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .diff-line {
            display: flex;
            padding: 1px 0;
            min-height: 20px;
        }
        .diff-line.removed { background-color: rgba(220, 53, 69, 0.15); }
        .diff-line.added { background-color: rgba(40, 167, 69, 0.15); }
        .diff-line.context { background-color: transparent; }
        
        .line-number {
            min-width: 40px;
            padding: 0 8px;
            text-align: right;
            color: var(--vscode-editorLineNumber-foreground);
            user-select: none;
            font-size: 11px;
            border-right: 1px solid var(--vscode-panel-border);
        }
        .line-number.old { background-color: rgba(220, 53, 69, 0.1); }
        .line-number.new { background-color: rgba(40, 167, 69, 0.1); }
        
        .line-indicator {
            min-width: 20px;
            text-align: center;
            font-weight: bold;
            user-select: none;
        }
        .line-indicator.removed { color: #dc3545; }
        .line-indicator.added { color: #28a745; }
        
        .line-content {
            flex: 1;
            white-space: pre;
            padding-left: 8px;
            overflow-x: auto;
        }
        
        .footer {
            padding: 12px 20px;
            border-top: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .footer-info { font-size: 12px; color: var(--vscode-descriptionForeground); }
        .footer-actions { display: flex; gap: 10px; }
        .btn-cancel {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-cancel:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .btn-apply {
            background-color: #28a745;
            color: white;
        }
        .btn-apply:hover { background-color: #218838; }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-title">
            <span>🔄</span>
            <span>Vista Previa de Cambios - ${fileName}</span>
        </div>
        <div class="header-actions">
            <button class="btn btn-accept-all" onclick="acceptAllHunks()">✓ Aceptar todos</button>
            <button class="btn btn-reject-all" onclick="rejectAllHunks()">✗ Rechazar todos</button>
        </div>
    </div>
    
    <div class="legend">
        <div class="legend-item">
            <div class="legend-color removed"></div>
            <span>Código a eliminar</span>
        </div>
        <div class="legend-item">
            <div class="legend-color added"></div>
            <span>Código nuevo</span>
        </div>
        <div class="legend-item">
            <div class="legend-color context"></div>
            <span>Contexto (sin cambios)</span>
        </div>
    </div>
    
    <div class="diff-container" id="diffContainer"></div>
    
    <div class="footer">
        <div class="footer-info" id="footerInfo">Cargando...</div>
        <div class="footer-actions">
            <button class="btn btn-cancel" onclick="cancel()">✗ Cancelar</button>
            <button class="btn btn-apply" onclick="applyChanges()">💾 Aplicar cambios</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const originalCode = ${JSON.stringify(originalCode)};
        const newCode = ${JSON.stringify(newCode)};
        
        let hunks = [];
        
        function computeLCS(a, b) {
            const m = a.length;
            const n = b.length;
            const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
            
            for (let i = 1; i <= m; i++) {
                for (let j = 1; j <= n; j++) {
                    if (a[i - 1] === b[j - 1]) {
                        dp[i][j] = dp[i - 1][j - 1] + 1;
                    } else {
                        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                    }
                }
            }
            return dp;
        }
        
        function backtrackLCS(dp, a, b, i, j) {
            const diff = [];
            while (i > 0 || j > 0) {
                if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
                    diff.unshift({ type: 'context', content: a[i - 1], oldLine: i, newLine: j });
                    i--; j--;
                } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                    diff.unshift({ type: 'added', content: b[j - 1], newLine: j });
                    j--;
                } else {
                    diff.unshift({ type: 'removed', content: a[i - 1], oldLine: i });
                    i--;
                }
            }
            return diff;
        }
        
        function computeDiff(oldText, newText) {
            const oldLines = oldText.split('\\n');
            const newLines = newText.split('\\n');
            const dp = computeLCS(oldLines, newLines);
            return backtrackLCS(dp, oldLines, newLines, oldLines.length, newLines.length);
        }
        
        function groupIntoHunks(diff, contextLines = 3) {
            const hunks = [];
            let currentHunk = null;
            let contextBuffer = [];
            
            for (let i = 0; i < diff.length; i++) {
                const line = diff[i];
                
                if (line.type === 'context') {
                    if (currentHunk) {
                        currentHunk.lines.push(line);
                        
                        let hasMoreChanges = false;
                        for (let j = i + 1; j < Math.min(i + contextLines + 1, diff.length); j++) {
                            if (diff[j].type !== 'context') {
                                hasMoreChanges = true;
                                break;
                            }
                        }
                        
                        if (!hasMoreChanges && currentHunk.lines.filter(l => l.type !== 'context').length > 0) {
                            const contextCount = currentHunk.lines.filter(l => l.type === 'context').length;
                            if (contextCount >= contextLines * 2) {
                                hunks.push(currentHunk);
                                currentHunk = null;
                                contextBuffer = [line];
                            }
                        }
                    } else {
                        contextBuffer.push(line);
                        if (contextBuffer.length > contextLines) {
                            contextBuffer.shift();
                        }
                    }
                } else {
                    if (!currentHunk) {
                        currentHunk = {
                            id: 'hunk-' + hunks.length,
                            lines: [...contextBuffer],
                            status: 'pending',
                            startOld: line.oldLine || (contextBuffer[0]?.oldLine || 1),
                            startNew: line.newLine || (contextBuffer[0]?.newLine || 1)
                        };
                        contextBuffer = [];
                    }
                    currentHunk.lines.push(line);
                }
            }
            
            if (currentHunk && currentHunk.lines.filter(l => l.type !== 'context').length > 0) {
                hunks.push(currentHunk);
            }
            
            return hunks;
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function renderHunks() {
            const container = document.getElementById('diffContainer');
            container.innerHTML = '';
            
            if (hunks.length === 0) {
                container.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--vscode-descriptionForeground);">No hay diferencias entre los archivos</div>';
                updateFooterInfo();
                return;
            }
            
            hunks.forEach((hunk, hunkIndex) => {
                const hunkDiv = document.createElement('div');
                hunkDiv.className = 'hunk' + (hunk.status !== 'pending' ? ' ' + hunk.status : '');
                hunkDiv.id = hunk.id;
                
                const addedCount = hunk.lines.filter(l => l.type === 'added').length;
                const removedCount = hunk.lines.filter(l => l.type === 'removed').length;
                
                let hunkInfo = '';
                if (removedCount > 0) hunkInfo += '-' + removedCount + ' ';
                if (addedCount > 0) hunkInfo += '+' + addedCount;
                
                let actionsHtml = '';
                if (hunk.status === 'pending') {
                    actionsHtml = \`
                        <button class="hunk-btn accept" onclick="acceptHunk(\${hunkIndex})">✓ Aceptar</button>
                        <button class="hunk-btn reject" onclick="rejectHunk(\${hunkIndex})">✗ Rechazar</button>
                    \`;
                } else {
                    const statusText = hunk.status === 'accepted' ? '✓ Aceptado' : '✗ Rechazado';
                    actionsHtml = \`<span class="hunk-status \${hunk.status}">\${statusText}</span>\`;
                }
                
                const headerHtml = \`
                    <div class="hunk-header">
                        <span class="hunk-info">@@ Cambio \${hunkIndex + 1} (\${hunkInfo.trim()}) @@</span>
                        <div class="hunk-actions">\${actionsHtml}</div>
                    </div>
                \`;
                
                let contentHtml = '<div class="hunk-content">';
                hunk.lines.forEach(line => {
                    const lineClass = 'diff-line ' + line.type;
                    let indicator = '';
                    let lineNumOld = '';
                    let lineNumNew = '';
                    
                    if (line.type === 'removed') {
                        indicator = '<span class="line-indicator removed">−</span>';
                        lineNumOld = line.oldLine || '';
                    } else if (line.type === 'added') {
                        indicator = '<span class="line-indicator added">+</span>';
                        lineNumNew = line.newLine || '';
                    } else {
                        indicator = '<span class="line-indicator"></span>';
                        lineNumOld = line.oldLine || '';
                        lineNumNew = line.newLine || '';
                    }
                    
                    contentHtml += \`
                        <div class="\${lineClass}">
                            <span class="line-number old">\${lineNumOld}</span>
                            <span class="line-number new">\${lineNumNew}</span>
                            \${indicator}
                            <span class="line-content">\${escapeHtml(line.content)}</span>
                        </div>
                    \`;
                });
                contentHtml += '</div>';
                
                hunkDiv.innerHTML = headerHtml + contentHtml;
                container.appendChild(hunkDiv);
            });
            
            updateFooterInfo();
        }
        
        function acceptHunk(index) {
            hunks[index].status = 'accepted';
            renderHunks();
        }
        
        function rejectHunk(index) {
            hunks[index].status = 'rejected';
            renderHunks();
        }
        
        function acceptAllHunks() {
            hunks.forEach(h => { if (h.status === 'pending') h.status = 'accepted'; });
            renderHunks();
        }
        
        function rejectAllHunks() {
            hunks.forEach(h => { if (h.status === 'pending') h.status = 'rejected'; });
            renderHunks();
        }
        
        function updateFooterInfo() {
            const pending = hunks.filter(h => h.status === 'pending').length;
            const accepted = hunks.filter(h => h.status === 'accepted').length;
            const rejected = hunks.filter(h => h.status === 'rejected').length;
            
            const info = document.getElementById('footerInfo');
            if (hunks.length === 0) {
                info.textContent = 'No hay cambios';
            } else if (pending > 0) {
                info.textContent = pending + ' cambio(s) pendiente(s) de revisión';
            } else {
                info.textContent = accepted + ' aceptado(s), ' + rejected + ' rechazado(s)';
            }
        }
        
        function buildFinalCode() {
            const oldLines = originalCode.split('\\n');
            const newLines = newCode.split('\\n');
            
            const allAccepted = hunks.every(h => h.status === 'accepted');
            if (allAccepted) {
                return newCode;
            }
            
            const allRejected = hunks.every(h => h.status === 'rejected');
            if (allRejected) {
                return originalCode;
            }
            
            const diff = computeDiff(originalCode, newCode);
            const result = [];
            
            const lineHunkMap = new Map();
            hunks.forEach(hunk => {
                hunk.lines.forEach(line => {
                    if (line.type !== 'context') {
                        const key = line.type + '-' + (line.oldLine || line.newLine);
                        lineHunkMap.set(key, hunk.status);
                    }
                });
            });
            
            diff.forEach(line => {
                if (line.type === 'context') {
                    result.push(line.content);
                } else if (line.type === 'removed') {
                    const key = 'removed-' + line.oldLine;
                    const status = lineHunkMap.get(key) || 'accepted';
                    if (status === 'rejected') {
                        result.push(line.content);
                    }
                } else if (line.type === 'added') {
                    const key = 'added-' + line.newLine;
                    const status = lineHunkMap.get(key) || 'accepted';
                    if (status === 'accepted') {
                        result.push(line.content);
                    }
                }
            });
            
            return result.join('\\n');
        }
        
        function applyChanges() {
            const pending = hunks.filter(h => h.status === 'pending').length;
            if (pending > 0) {
                if (!confirm('Hay ' + pending + ' cambio(s) sin revisar. ¿Aceptarlos automáticamente y aplicar?')) {
                    return;
                }
                hunks.forEach(h => { if (h.status === 'pending') h.status = 'accepted'; });
            }
            
            const finalCode = buildFinalCode();
            vscode.postMessage({ type: 'applyChanges', finalCode });
        }
        
        function cancel() {
            vscode.postMessage({ type: 'cancel' });
        }
        
        const diff = computeDiff(originalCode, newCode);
        hunks = groupIntoHunks(diff);
        renderHunks();
    </script>
</body>
</html>`;
}

class MIAChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mia.chatView';
    private _view?: vscode.WebviewView;
    private _messages: Array<{ role: string; content: string }> = [];
    private _currentFileInfo: ActiveFileInfo | null = null;
    private _pendingChanges: Map<string, CodeChange> = new Map();
    private _changeCounter: number = 0;

    // ✅ Estado de fuentes de conocimiento
    private _knowledgeSources: Array<any> = [];
    private _selectedSourceIds: Set<string> = new Set();
    private _showSourcesPanel: boolean = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _getClient: () => LanguageClient | undefined,
    ) {
        vscode.window.onDidChangeActiveTextEditor(() => this._updateFileContext());
        vscode.workspace.onDidChangeTextDocument(() => this._updateFileContext());
        vscode.window.onDidChangeTextEditorSelection(() => this._updateFileContext());
    }

    private _updateFileContext() {
        this._currentFileInfo = getActiveFileInfo();
        if (this._view && this._currentFileInfo) {
            this._view.webview.postMessage({
                type: 'updateFileContext',
                fileName: this._currentFileInfo.fileName,
                language: this._currentFileInfo.language,
                lineCount: this._currentFileInfo.lineCount,
                hasSelection: this._currentFileInfo.selectedText.length > 0,
                selectedLines: this._currentFileInfo.selectedText.split('\n').length,
            });
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this._getHtmlForWebview();
        setTimeout(() => {
            this._updateFileContext();
            this._loadKnowledgeSources();
        }, 100);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    await this._handleChatMessage(data.message, data.includeFile);
                    break;
                case 'clearChat':
                    this._messages = [];
                    this._pendingChanges.clear();
                    this._updateChat();
                    break;
                case 'viewChanges':
                    this._showDiffPreview(data.changeId);
                    break;
                case 'copyCode':
                    await this._copyCode(data.code);
                    break;
                case 'requestFileContext':
                    this._updateFileContext();
                    break;
                case 'toggleSourcesPanel':
                    this._showSourcesPanel = !this._showSourcesPanel;
                    this._view?.webview.postMessage({
                        type: 'updateSourcesPanel',
                        show: this._showSourcesPanel,
                    });
                    break;
                case 'toggleSource':
                    this._toggleSource(data.sourceId);
                    break;
                case 'refreshSources':
                    await this._loadKnowledgeSources();
                    break;
            }
        });
    }

    // ✅ Cargar fuentes desde el servidor
    private async _loadKnowledgeSources() {
        const client = this._getClient();
        if (!client) {
            return;
        }

        try {
            const result = (await client.sendRequest('workspace/executeCommand', {
                command: 'mia.getKnowledgeSources',
                arguments: [],
            })) as any;

            if (result.success) {
                this._knowledgeSources = result.sources;
                this._view?.webview.postMessage({
                    type: 'updateKnowledgeSources',
                    sources: this._knowledgeSources,
                    selectedIds: Array.from(this._selectedSourceIds),
                });
            }
        } catch (error) {
            console.error('Error loading knowledge sources:', error);
        }
    }

    // ✅ Toggle selección de fuente
    private _toggleSource(sourceId: string) {
        if (this._selectedSourceIds.has(sourceId)) {
            this._selectedSourceIds.delete(sourceId);
        } else {
            this._selectedSourceIds.add(sourceId);
        }

        this._view?.webview.postMessage({
            type: 'updateSelection',
            selectedIds: Array.from(this._selectedSourceIds),
        });
    }

    // ✅ Separar source_ids y project_ids antes de enviar
    private async _handleChatMessage(message: string, includeFile: boolean = true) {
        const client = this._getClient();
        if (!client) {
            this._addMessage('system', 'Error: El servidor MIA no está corriendo.');
            return;
        }

        this._currentFileInfo = getActiveFileInfo();
        let context = null;

        // Construir contexto de archivo si está habilitado
        if (includeFile && this._currentFileInfo) {
            const fileInfo = this._currentFileInfo;
            const codeToInclude = fileInfo.selectedText || fileInfo.content;
            const isSelection = fileInfo.selectedText.length > 0;

            context = {
                code: codeToInclude,
                language: fileInfo.language,
                filePath: fileInfo.filePath,
                fileName: fileInfo.fileName,
                lineNumber: fileInfo.cursorLine,
                cursorPosition: 0,
                isSelection: isSelection,
                fullFileContent: fileInfo.content,
            };

            const contextIndicator = isSelection
                ? `📎 [Código seleccionado de ${fileInfo.fileName}]`
                : `📄 [Archivo: ${fileInfo.fileName}]`;

            const sourcesIndicator =
                this._selectedSourceIds.size > 0
                    ? `\n📚 [Consultando ${this._selectedSourceIds.size} fuente(s) de conocimiento]`
                    : '';

            this._addMessage('user', `${message}\n\n${contextIndicator}${sourcesIndicator}`);
        } else {
            const sourcesIndicator =
                this._selectedSourceIds.size > 0
                    ? `\n\n📚 [Consultando ${this._selectedSourceIds.size} fuente(s) de conocimiento]`
                    : '';
            this._addMessage('user', `${message}${sourcesIndicator}`);
        }

        this._messages.push({ role: 'user', content: message });

        try {
            // ✅ SEPARAR por tipo (source vs project)
    console.log('🔍 [DEBUG] _selectedSourceIds:', Array.from(this._selectedSourceIds));
    console.log('🔍 [DEBUG] _knowledgeSources:', this._knowledgeSources);
                
            const sourceIds: string[] = [];
            const projectIds: string[] = [];

            Array.from(this._selectedSourceIds).forEach((id) => {
                const item = this._knowledgeSources.find((s) => s.id === id);
                if (item?.itemType === 'project') {
                    projectIds.push(id);
                } else {
                    sourceIds.push(id);
                }
            });
            console.log('📊 [EXTENSION] Enviando al servidor:');
            console.log('   - sourceIds:', sourceIds);
            console.log('   - projectIds:', projectIds);
            console.log('   - selectedSourceIds:', Array.from(this._selectedSourceIds));
            console.log('   - knowledgeSources:', this._knowledgeSources);
            // ✅ Enviar ambos arrays separados
            const response = (await client.sendRequest('workspace/executeCommand', {
                command: 'mia.chat',
                arguments: [
                    this._messages,
                    context,
                    sourceIds, // Fuentes de documentación
                    projectIds, // Proyectos de código
                ],
            })) as any;

            if (response.success) {
                let responseContent = response.content;
                if (response.sources && response.sources.length > 0) {
                    const metadata = `\n\n---\n📊 **Fuentes consultadas:** ${response.sources.join(
                        ', ',
                    )}\n📦 **Chunks analizados:** ${response.chunksAnalyzed || 0} | 🎯 **Tokens:** ${
                        response.tokensUsed || 0
                    }`;
                    responseContent += metadata;
                }

                this._processResponseForChanges(responseContent);
                this._messages.push({ role: 'assistant', content: response.content });
            } else {
                this._addMessage('system', `Error: ${response.error || 'Error desconocido'}`);
            }
        } catch (error) {
            this._addMessage('system', `Error: ${error}`);
        }
    }

    private _processResponseForChanges(content: string) {
        const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
        let match;
        const changes: CodeChange[] = [];

        while ((match = codeBlockRegex.exec(content)) !== null) {
            const language = match[1] || this._currentFileInfo?.language || 'text';
            const code = match[2].trim();

            const changeId = `change-${++this._changeCounter}`;
            const originalCode = this._currentFileInfo?.selectedText || this._currentFileInfo?.content || '';

            const change: CodeChange = {
                id: changeId,
                originalCode: originalCode,
                newCode: code,
                language: language,
                fileName: this._currentFileInfo?.fileName || 'archivo',
                filePath: this._currentFileInfo?.filePath || '',
            };

            this._pendingChanges.set(changeId, change);
            changes.push(change);
        }

        if (this._view) {
            this._view.webview.postMessage({
                type: 'addMessageWithChangeLink',
                role: 'assistant',
                content: content,
                changes: changes,
                hasChanges: changes.length > 0,
            });
        }
    }

    private _addMessage(role: string, content: string) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'addMessage', role, content });
        }
    }

    private _showDiffPreview(changeId: string) {
        const change = this._pendingChanges.get(changeId);
        if (!change) {
            vscode.window.showWarningMessage('Cambio no encontrado');
            return;
        }
        showDiffPreviewPanel(this._extensionUri, change.originalCode, change.newCode, change.fileName, change.language);
    }

    private async _copyCode(code: string) {
        await vscode.env.clipboard.writeText(code);
        vscode.window.showInformationMessage('📋 Código copiado');
    }

    private _updateChat() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'updateChat', messages: this._messages });
        }
    }

    public addCodeContext(code: string, language: string) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'addCodeContext', code, language });
        }
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MIA Chat</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
            font-family: var(--vscode-font-family); 
            font-size: var(--vscode-font-size); 
            color: var(--vscode-foreground); 
            background-color: var(--vscode-editor-background); 
            height: 100vh; 
            display: flex; 
            flex-direction: column; 
        }
        
        .header { 
            padding: 10px; 
            border-bottom: 1px solid var(--vscode-panel-border); 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
        }
        .header h3 { display: flex; align-items: center; gap: 8px; font-size: 14px; }
        .header h3::before { content: "✨"; }
        
        .header-actions {
            display: flex;
            gap: 5px;
        }
        
        .clear-btn, .knowledge-btn { 
            background: var(--vscode-button-secondaryBackground); 
            color: var(--vscode-button-secondaryForeground); 
            border: none; 
            padding: 4px 8px; 
            cursor: pointer; 
            border-radius: 3px; 
            font-size: 12px; 
        }
        
        .knowledge-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .sources-panel {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s ease;
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        
        .sources-panel.expanded {
            max-height: 300px;
            overflow-y: auto;
        }
        
        .sources-header {
            padding: 8px 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editor-background);
        }
        
        .sources-header h4 {
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .sources-stats {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        
        .refresh-btn {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 14px;
            padding: 2px 6px;
        }
        
        .sources-list {
            padding: 8px;
        }
        
        .source-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 8px;
            margin-bottom: 4px;
            border-radius: 4px;
            cursor: pointer;
            transition: background-color 0.2s;
        }
        
        .source-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .source-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
        }
        
        .source-checkbox {
            width: 14px;
            height: 14px;
        }
        
        .source-icon {
            font-size: 16px;
        }
        
        .source-title {
            flex: 1;
            font-size: 12px;
        }
        
        .source-chunks {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        
        .sources-empty {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        
        .file-context { 
            padding: 8px 10px; 
            background-color: var(--vscode-editor-inactiveSelectionBackground); 
            border-bottom: 1px solid var(--vscode-panel-border); 
            font-size: 11px; 
            display: flex; 
            align-items: center; 
            gap: 8px; 
            flex-wrap: wrap; 
        }
        .file-context .file-name { font-weight: bold; color: var(--vscode-textLink-foreground); }
        .file-context .file-info { color: var(--vscode-descriptionForeground); }
        .file-context .selection-badge { 
            background-color: var(--vscode-badge-background); 
            color: var(--vscode-badge-foreground); 
            padding: 2px 6px; 
            border-radius: 10px; 
            font-size: 10px; 
        }
        .file-context.no-file { color: var(--vscode-descriptionForeground); font-style: italic; }
        
        .chat-container { flex: 1; overflow-y: auto; padding: 10px; }
        .message { margin-bottom: 12px; padding: 8px 12px; border-radius: 8px; max-width: 95%; }
        .message.user { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); margin-left: auto; }
        .message.assistant { background-color: var(--vscode-editor-inactiveSelectionBackground); }
        .message.system { 
            background-color: var(--vscode-inputValidation-warningBackground); 
            color: var(--vscode-inputValidation-warningForeground); 
            font-style: italic; 
            text-align: center; 
            max-width: 100%; 
        }
        
        .changes-link { 
            display: flex; 
            flex-direction: column; 
            gap: 8px; 
            margin-top: 10px; 
            padding: 10px; 
            background-color: var(--vscode-editor-inactiveSelectionBackground); 
            border-radius: 6px; 
            border-left: 3px solid var(--vscode-textLink-foreground); 
        }
        .changes-link-header { display: flex; align-items: center; gap: 8px; font-weight: bold; color: var(--vscode-textLink-foreground); }
        .changes-link-info { font-size: 11px; color: var(--vscode-descriptionForeground); }
        .changes-buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 5px; }
        .change-btn { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 5px; }
        .change-btn.view { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .change-btn.copy { background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        
        .input-container { 
            padding: 10px; 
            border-top: 1px solid var(--vscode-panel-border); 
            display: flex; 
            flex-direction: column; 
            gap: 8px; 
        }
        .input-options { display: flex; align-items: center; gap: 8px; font-size: 11px; }
        .input-options label { display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--vscode-descriptionForeground); }
        .input-row { display: flex; gap: 8px; }
        
        #messageInput { 
            flex: 1; 
            padding: 8px; 
            border: 1px solid var(--vscode-input-border); 
            background-color: var(--vscode-input-background); 
            color: var(--vscode-input-foreground); 
            border-radius: 4px; 
            resize: none; 
            min-height: 36px; 
            max-height: 120px; 
        }
        
        #sendBtn { 
            background-color: var(--vscode-button-background); 
            color: var(--vscode-button-foreground); 
            border: none; 
            padding: 8px 16px; 
            cursor: pointer; 
            border-radius: 4px; 
        }
        #sendBtn:disabled { opacity: 0.5; cursor: not-allowed; }
        
        .typing-indicator { display: none; padding: 8px 12px; color: var(--vscode-descriptionForeground); }
        .typing-indicator.visible { display: block; }
        
        .welcome { text-align: center; padding: 20px; color: var(--vscode-descriptionForeground); }
        .welcome h4 { margin-bottom: 10px; }
        .welcome p { font-size: 12px; margin-bottom: 8px; }
    </style>
</head>
<body>
    <div class="header">
        <h3>MIA Chat</h3>
        <div class="header-actions">
            <button class="knowledge-btn" id="knowledgeBtn" onclick="toggleSourcesPanel()">📚 Fuentes</button>
            <button class="clear-btn" onclick="clearChat()">Limpiar</button>
        </div>
    </div>
    
    <div class="sources-panel" id="sourcesPanel">
        <div class="sources-header">
            <h4>📚 Base de Conocimiento</h4>
            <div style="display: flex; align-items: center; gap: 10px;">
                <span class="sources-stats" id="sourcesStats">0 seleccionadas</span>
                <button class="refresh-btn" onclick="refreshSources()" title="Recargar">↻</button>
            </div>
        </div>
        <div class="sources-list" id="sourcesList">
            <div class="sources-empty">Cargando fuentes...</div>
        </div>
    </div>
    
    <div class="file-context no-file" id="fileContext">
        <span>📄</span>
        <span>No hay archivo abierto</span>
    </div>
    
    <div class="chat-container" id="chatContainer">
        <div class="welcome">
            <h4>👋 ¡Bienvenido a MIA!</h4>
            <p>Pídeme que mejore, corrija o refactorice tu código.</p>
            <p>O consulta tu base de conocimiento usando el botón 📚 Fuentes</p>
        </div>
    </div>
    
    <div class="typing-indicator" id="typingIndicator">MIA está pensando...</div>
    
    <div class="input-container">
        <div class="input-options">
            <label>
                <input type="checkbox" id="includeFileCheckbox" checked> 
                Incluir archivo activo
            </label>
        </div>
        <div class="input-row">
            <textarea id="messageInput" placeholder="Escribe tu mensaje..." rows="1"></textarea>
            <button id="sendBtn" onclick="sendMessage()">Enviar</button>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chatContainer');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        const typingIndicator = document.getElementById('typingIndicator');
        const fileContext = document.getElementById('fileContext');
        const includeFileCheckbox = document.getElementById('includeFileCheckbox');
        const sourcesPanel = document.getElementById('sourcesPanel');
        const sourcesList = document.getElementById('sourcesList');
        const knowledgeBtn = document.getElementById('knowledgeBtn');
        const sourcesStats = document.getElementById('sourcesStats');
        
        let isWaiting = false;
        let pendingChanges = {};
        let knowledgeSources = [];
        let selectedSourceIds = new Set();
        let sourcesExpanded = false;

        messageInput.addEventListener('input', function() { 
            this.style.height = 'auto'; 
            this.style.height = Math.min(this.scrollHeight, 120) + 'px'; 
        });
        
        messageInput.addEventListener('keydown', function(e) { 
            if (e.key === 'Enter' && !e.shiftKey) { 
                e.preventDefault(); 
                sendMessage(); 
            } 
        });

        function toggleSourcesPanel() {
            sourcesExpanded = !sourcesExpanded;
            vscode.postMessage({ type: 'toggleSourcesPanel' });
            
            if (sourcesExpanded) {
                sourcesPanel.classList.add('expanded');
                knowledgeBtn.classList.add('active');
            } else {
                sourcesPanel.classList.remove('expanded');
                knowledgeBtn.classList.remove('active');
            }
        }

        function renderSources() {
            if (knowledgeSources.length === 0) {
                sourcesList.innerHTML = '<div class="sources-empty">No hay fuentes disponibles.<br>Agrégalas desde tu interfaz web.</div>';
                return;
            }

            let html = '';
            knowledgeSources.forEach(source => {
                const isSelected = selectedSourceIds.has(source.id);
                const selectedClass = isSelected ? 'selected' : '';
                const checkedAttr = isSelected ? 'checked' : '';
                
                html += '<div class="source-item ' + selectedClass + '" onclick="toggleSource(\\'' + source.id + '\\')">';
                html += '  <input type="checkbox" class="source-checkbox" ' + checkedAttr + ' onclick="event.stopPropagation(); toggleSource(\\'' + source.id + '\\')">';
                html += '  <span class="source-icon">' + getSourceIcon(source.type) + '</span>';
                html += '  <span class="source-title">' + escapeHtml(source.title) + '</span>';
                html += '  <span class="source-chunks">' + source.chunks + ' chunks</span>';
                html += '</div>';
            });

            sourcesList.innerHTML = html;
            updateSourcesStats();
        }

        function getSourceIcon(type) {
            const icons = {
                'documentation': '📚',
                'api': '🔌',
                'tutorial': '🎓',
                'troubleshooting': '🔧',
                'best_practices': '⭐',
                'code': '💻'
            };
            return icons[type] || '📄';
        }

        function toggleSource(sourceId) {
            vscode.postMessage({ type: 'toggleSource', sourceId });
        }

        function updateSourcesStats() {
            const count = selectedSourceIds.size;
            const totalChunks = knowledgeSources
                .filter(s => selectedSourceIds.has(s.id))
                .reduce((sum, s) => sum + s.chunks, 0);
            
            sourcesStats.textContent = count + ' seleccionadas (' + totalChunks + ' chunks)';
        }

        function refreshSources() {
            vscode.postMessage({ type: 'refreshSources' });
        }

        function sendMessage() {
            const message = messageInput.value.trim();
            if (!message || isWaiting) return;
            
            const welcome = chatContainer.querySelector('.welcome');
            if (welcome) welcome.remove();
            
            // ✅ SIEMPRE usar 'sendMessage', el backend decide
            vscode.postMessage({ 
                type: 'sendMessage', 
                message, 
                includeFile: includeFileCheckbox.checked 
            });
            
            messageInput.value = '';
            messageInput.style.height = 'auto';
            isWaiting = true;
            sendBtn.disabled = true;
            typingIndicator.classList.add('visible');
        }

        function clearChat() {
            vscode.postMessage({ type: 'clearChat' });
            pendingChanges = {};
            chatContainer.innerHTML = '<div class="welcome"><h4>👋 ¡Bienvenido a MIA!</h4><p>Pídeme que mejore tu código o consulta tu base de conocimiento.</p></div>';
        }

        function updateFileContext(data) {
            if (data && data.fileName) {
                fileContext.className = 'file-context';
                fileContext.innerHTML = '<span>📄</span><span class="file-name">' + data.fileName + '</span><span class="file-info">(' + data.language + ', ' + data.lineCount + ' líneas)</span>' + (data.hasSelection ? '<span class="selection-badge">📎 ' + data.selectedLines + ' líneas</span>' : '');
            } else {
                fileContext.className = 'file-context no-file';
                fileContext.innerHTML = '<span>📄</span><span>No hay archivo abierto</span>';
            }
        }

        function escapeHtml(text) { 
            const div = document.createElement('div'); 
            div.textContent = text; 
            return div.innerHTML; 
        }

        function addMessage(role, content) {
            const welcome = chatContainer.querySelector('.welcome');
            if (welcome) welcome.remove();
            
            const div = document.createElement('div');
            div.className = 'message ' + role;
            div.innerHTML = content
                .replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>')
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
                .replace(/\\n/g, '<br>');
            
            chatContainer.appendChild(div);
            chatContainer.scrollTop = chatContainer.scrollHeight;
            
            if (role !== 'user') { 
                isWaiting = false; 
                sendBtn.disabled = false; 
                typingIndicator.classList.remove('visible'); 
            }
        }

        function addMessageWithChangeLink(role, content, changes, hasChanges) {
            const welcome = chatContainer.querySelector('.welcome');
            if (welcome) welcome.remove();
            
            const div = document.createElement('div');
            div.className = 'message ' + role;
            
            let html = content
                .replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(m, lang, code) {
                    return '<div style="background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:4px;margin:5px 0;font-size:11px;">📝 Código sugerido (' + code.trim().split('\\n').length + ' líneas)</div>';
                })
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
                .replace(/\\n/g, '<br>');
            
            div.innerHTML = html;
            
            if (hasChanges && changes.length > 0) {
                changes.forEach(c => { pendingChanges[c.id] = c; });
                
                const link = document.createElement('div');
                link.className = 'changes-link';
                
                let buttonsHtml = '';
                changes.forEach((c, i) => {
                    buttonsHtml += '<button class="change-btn view" onclick="viewChanges(\\'' + c.id + '\\')">👁 Ver cambios' + (changes.length > 1 ? ' ' + (i+1) : '') + '</button>';
                });
                
                link.innerHTML = '<div class="changes-link-header"><span>🔀</span><span>' + changes.length + ' cambio(s) sugerido(s)</span></div><div class="changes-link-info">Abre la vista previa para revisar y aceptar/rechazar cada cambio.</div><div class="changes-buttons">' + buttonsHtml + '<button class="change-btn copy" onclick="copyAllCode()">📋 Copiar</button></div>';
                div.appendChild(link);
            }
            
            chatContainer.appendChild(div);
            chatContainer.scrollTop = chatContainer.scrollHeight;
            isWaiting = false;
            sendBtn.disabled = false;
            typingIndicator.classList.remove('visible');
        }

        function viewChanges(id) { 
            vscode.postMessage({ type: 'viewChanges', changeId: id }); 
        }
        
        function copyAllCode() { 
            vscode.postMessage({ 
                type: 'copyCode', 
                code: Object.values(pendingChanges).map(c => c.newCode).join('\\n\\n') 
            }); 
        }

        window.addEventListener('message', e => {
            const d = e.data;
            
            if (d.type === 'addMessage') {
                addMessage(d.role, d.content);
            } else if (d.type === 'addMessageWithChangeLink') {
                addMessageWithChangeLink(d.role, d.content, d.changes || [], d.hasChanges);
            } else if (d.type === 'updateChat') { 
                chatContainer.innerHTML = ''; 
                d.messages.forEach(m => addMessage(m.role, m.content)); 
            } else if (d.type === 'updateFileContext') {
                updateFileContext(d);
            } else if (d.type === 'updateKnowledgeSources') {
                knowledgeSources = d.sources;
                selectedSourceIds = new Set(d.selectedIds);
                renderSources();
            } else if (d.type === 'updateSelection') {
                selectedSourceIds = new Set(d.selectedIds);
                renderSources();
            }
        });

        vscode.postMessage({ type: 'requestFileContext' });
    </script>
</body>
</html>`;
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const serverInfo = loadServerDefaults();
    const serverName = serverInfo.name;
    const serverId = serverInfo.module;

    const outputChannel = createOutputChannel(serverName);
    context.subscriptions.push(outputChannel, registerLogger(outputChannel));

    const changeLogLevel = async (c: vscode.LogLevel, g: vscode.LogLevel) => {
        const level = getLSClientTraceLevel(c, g);
        await lsClient?.setTrace(level);
    };

    context.subscriptions.push(
        outputChannel.onDidChangeLogLevel(async (e) => await changeLogLevel(e, vscode.env.logLevel)),
        vscode.env.onDidChangeLogLevel(async (e) => await changeLogLevel(outputChannel.logLevel, e)),
    );

    traceLog(`Name: ${serverInfo.name}`);
    traceLog(`Module: ${serverInfo.module}`);
    traceVerbose(`Full Server Info: ${JSON.stringify(serverInfo)}`);

    chatViewProvider = new MIAChatViewProvider(context.extensionUri, () => lsClient);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MIAChatViewProvider.viewType, chatViewProvider),
    );

    const runServer = async () => {
        const interpreter = getInterpreterFromSetting(serverId);
        if (interpreter && interpreter.length > 0 && checkVersion(await resolveInterpreter(interpreter))) {
            lsClient = await restartServer(serverId, serverName, outputChannel, lsClient);
            return;
        }
        const interpreterDetails = await getInterpreterDetails();
        if (interpreterDetails.path) {
            lsClient = await restartServer(serverId, serverName, outputChannel, lsClient);
            return;
        }
        traceError('Python interpreter missing');
    };

    context.subscriptions.push(
        registerCommand(`${serverId}.restart`, async () => {
            await runServer();
            vscode.window.showInformationMessage('MIA reiniciado');
        }),
        registerCommand(`${serverId}.openChat`, async () => await vscode.commands.executeCommand('mia.chatView.focus')),
        registerCommand(`${serverId}.explainSelection`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const text = editor.document.getText(editor.selection);
            if (!text || !lsClient) return;
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'MIA analizando...' },
                async () => {
                    const res = (await lsClient!.sendRequest('workspace/executeCommand', {
                        command: 'mia.explain',
                        arguments: [text, editor.document.languageId],
                    })) as any;
                    if (res.success) {
                        const panel = vscode.window.createWebviewPanel(
                            'miaExplanation',
                            'Explicación MIA',
                            vscode.ViewColumn.Beside,
                            {},
                        );
                        panel.webview.html = `<html><body style="font-family:var(--vscode-font-family);padding:20px;"><h2>✨ Explicación</h2><div>${res.content.replace(
                            /\n/g,
                            '<br>',
                        )}</div></body></html>`;
                    }
                },
            );
        }),
        registerCommand(`${serverId}.refactorSelection`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const text = editor.document.getText(editor.selection);
            if (!text) return;
            if (chatViewProvider) {
                await vscode.commands.executeCommand('mia.chatView.focus');
                chatViewProvider.addCodeContext(text, editor.document.languageId);
            }
        }),
    );

    context.subscriptions.push(
        onDidChangePythonInterpreter(async () => await runServer()),
        onDidChangeConfiguration(async (e) => {
            if (checkIfConfigurationChanged(e, serverId)) await runServer();
        }),
    );

    setImmediate(async () => {
        const interpreter = getInterpreterFromSetting(serverId);
        if (!interpreter || interpreter.length === 0) {
            await initializePython(context.subscriptions);
        } else {
            await runServer();
        }
    });
}
export async function deactivate(): Promise<void> {
    if (lsClient) await lsClient.stop();
}
