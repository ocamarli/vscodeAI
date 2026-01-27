// src/knowledgeSourcesPanel.ts

import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node'; // ✅ AGREGAR ESTA LÍNEA

interface KnowledgeSource {
    id: string;
    title: string;
    type: string;
    chunks: number;
    description: string;
}

export class KnowledgeSourcesPanel {
    private static currentPanel: KnowledgeSourcesPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private selectedSources: Set<string> = new Set();
    private allSources: KnowledgeSource[] = [];

    // ✅ CORRECTO
    public static createOrShow(extensionUri: vscode.Uri, getClient: () => LanguageClient | undefined) {
        const column = vscode.ViewColumn.Beside;

        // Si ya existe, mostrarlo
        if (KnowledgeSourcesPanel.currentPanel) {
            KnowledgeSourcesPanel.currentPanel._panel.reveal(column);
            return;
        }

        const client = getClient();
        if (!client) {
            vscode.window.showErrorMessage('MIA server is not running');
            return;
        }

        // Crear nuevo panel
        const panel = vscode.window.createWebviewPanel('miaKnowledgeSources', '📚 MIA - Knowledge Sources', column, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });

        KnowledgeSourcesPanel.currentPanel = new KnowledgeSourcesPanel(panel, extensionUri, client);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        _extensionUri: vscode.Uri,
        private client: any,
    ) {
        this._panel = panel;

        // Cargar contenido HTML
        this._update();

        // Cargar fuentes del backend
        this.loadSources();

        // Manejar mensajes desde el webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'toggleSource':
                        this.toggleSource(message.sourceId);
                        break;
                    case 'selectAll':
                        this.selectAll();
                        break;
                    case 'clearAll':
                        this.clearAll();
                        break;
                    case 'refresh':
                        await this.loadSources();
                        break;
                    case 'askQuestion':
                        await this.askQuestion(message.question);
                        break;
                }
            },
            null,
            this._disposables,
        );

        // Cleanup
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    private async loadSources() {
        try {
            // Llamar al comando del LSP Server
            const result = await this.client.sendRequest('workspace/executeCommand', {
                command: 'mia.getKnowledgeSources',
                arguments: [],
            });

            if (result.success) {
                this.allSources = result.sources;
                this._panel.webview.postMessage({
                    type: 'updateSources',
                    sources: this.allSources,
                    selectedIds: Array.from(this.selectedSources),
                });
            } else {
                vscode.window.showErrorMessage(`Error loading sources: ${result.error}`);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to load sources: ${error.message}`);
        }
    }

    private toggleSource(sourceId: string) {
        if (this.selectedSources.has(sourceId)) {
            this.selectedSources.delete(sourceId);
        } else {
            this.selectedSources.add(sourceId);
        }

        this._panel.webview.postMessage({
            type: 'updateSelection',
            selectedIds: Array.from(this.selectedSources),
        });
    }

    private selectAll() {
        this.allSources.forEach((source) => this.selectedSources.add(source.id));
        this._panel.webview.postMessage({
            type: 'updateSelection',
            selectedIds: Array.from(this.selectedSources),
        });
    }

    private clearAll() {
        this.selectedSources.clear();
        this._panel.webview.postMessage({
            type: 'updateSelection',
            selectedIds: [],
        });
    }

    private async askQuestion(question: string) {
        if (this.selectedSources.size === 0) {
            vscode.window.showWarningMessage('Please select at least one knowledge source');
            return;
        }

        try {
            this._panel.webview.postMessage({ type: 'loading', value: true });

            const result = await this.client.sendRequest('workspace/executeCommand', {
                command: 'mia.chatWithKnowledge',
                arguments: [question, Array.from(this.selectedSources)],
            });

            if (result.success) {
                this._panel.webview.postMessage({
                    type: 'response',
                    content: result.content,
                    sources: result.sources,
                    tokensUsed: result.tokensUsed,
                    chunksAnalyzed: result.chunksAnalyzed,
                });
            } else {
                vscode.window.showErrorMessage(`Error: ${result.error}`);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to get response: ${error.message}`);
        } finally {
            this._panel.webview.postMessage({ type: 'loading', value: false });
        }
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MIA Knowledge Sources</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            margin: 0;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        
        .header h2 {
            margin: 0;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .actions {
            display: flex;
            gap: 10px;
        }
        
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 14px;
            cursor: pointer;
            border-radius: 2px;
            font-size: 13px;
        }
        
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        
        .stats {
            background-color: var(--vscode-textBlockQuote-background);
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 20px;
            border-left: 3px solid var(--vscode-textLink-foreground);
        }
        
        .sources-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
            max-height: 40vh;
            overflow-y: auto;
        }
        
        .source-item {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            padding: 12px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .source-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .source-item.selected {
            border-color: var(--vscode-focusBorder);
            background-color: var(--vscode-list-activeSelectionBackground);
        }
        
        .source-item-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 5px;
        }
        
        .source-checkbox {
            width: 18px;
            height: 18px;
            cursor: pointer;
        }
        
        .source-icon {
            font-size: 20px;
        }
        
        .source-title {
            font-weight: 600;
            flex: 1;
        }
        
        .source-type {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        
        .source-description {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin: 5px 0 5px 28px;
        }
        
        .source-meta {
            display: flex;
            gap: 15px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-left: 28px;
        }
        
        .chat-section {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-widget-border);
        }
        
        .chat-input-container {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }
        
        #questionInput {
            flex: 1;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            font-family: inherit;
            font-size: 13px;
            border-radius: 2px;
        }
        
        #questionInput:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        .response-container {
            background-color: var(--vscode-textBlockQuote-background);
            padding: 15px;
            border-radius: 4px;
            border-left: 3px solid var(--vscode-textLink-foreground);
            margin-top: 20px;
            white-space: pre-wrap;
            font-size: 13px;
            line-height: 1.6;
            max-height: 30vh;
            overflow-y: auto;
        }
        
        .loading {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .response-meta {
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid var(--vscode-widget-border);
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        
        .error-message {
            background-color: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
            padding: 10px;
            border-radius: 4px;
            margin-top: 10px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h2>
            <span>📚</span>
            <span>Knowledge Sources</span>
        </h2>
        <div class="actions">
            <button class="secondary" onclick="refresh()">↻ Refresh</button>
            <button class="secondary" onclick="selectAll()">Select All</button>
            <button class="secondary" onclick="clearAll()">Clear</button>
        </div>
    </div>
    
    <div class="stats" id="stats">
        <strong>Selected:</strong> <span id="selectedCount">0</span> sources | 
        <strong>Total Chunks:</strong> <span id="totalChunks">0</span>
    </div>
    
    <div class="sources-list" id="sourcesList">
        <div class="loading">Loading sources...</div>
    </div>
    
    <div class="chat-section">
        <h3>Ask a Question</h3>
        <div class="chat-input-container">
            <input 
                type="text" 
                id="questionInput" 
                placeholder="Type your question here..." 
                onkeypress="handleKeyPress(event)"
            />
            <button onclick="askQuestion()" id="askBtn">Send</button>
        </div>
        <div id="responseContainer"></div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let sources = [];
        let selectedIds = new Set();
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'updateSources':
                    sources = message.sources;
                    selectedIds = new Set(message.selectedIds);
                    renderSources();
                    updateStats();
                    break;
                    
                case 'updateSelection':
                    selectedIds = new Set(message.selectedIds);
                    renderSources();
                    updateStats();
                    break;
                    
                case 'loading':
                    if (message.value) {
                        document.getElementById('sourcesList').innerHTML = 
                            '<div class="loading">⏳ Loading sources...</div>';
                    }
                    break;
                    
                case 'loadingQuestion':
                    const askBtn = document.getElementById('askBtn');
                    askBtn.disabled = message.value;
                    askBtn.textContent = message.value ? 'Thinking...' : 'Send';
                    
                    if (message.value) {
                        document.getElementById('responseContainer').innerHTML = 
                            '<div class="loading">⏳ Processing your question...</div>';
                    }
                    break;
                    
                case 'response':
                    displayResponse(message);
                    break;
                    
                case 'error':
                    document.getElementById('responseContainer').innerHTML = 
                        '<div class="error-message">❌ ' + message.message + '</div>';
                    break;
            }
        });
        
        function renderSources() {
            const container = document.getElementById('sourcesList');
            
            if (sources.length === 0) {
                container.innerHTML = '<div class="empty-state">⚠️ No sources available.<br><br>Add sources from your web interface at<br>http://127.0.0.1:5000</div>';
                return;
            }
            
            const sourcesHtml = sources.map(source => {
                const isSelected = selectedIds.has(source.id);
                const selectedClass = isSelected ? 'selected' : '';
                const checkedAttr = isSelected ? 'checked' : '';
                
                return '<div class="source-item ' + selectedClass + '" onclick="toggleSource(\\''+source.id+'\\')">'+
                    '<div class="source-item-header">'+
                        '<input type="checkbox" class="source-checkbox" '+checkedAttr+' onclick="event.stopPropagation(); toggleSource(\\''+source.id+'\\')">'+
                        '<span class="source-icon">'+getSourceIcon(source.type)+'</span>'+
                        '<span class="source-title">'+escapeHtml(source.title)+'</span>'+
                        '<span class="source-type">'+source.type+'</span>'+
                    '</div>'+
                    '<div class="source-description">'+escapeHtml(source.description)+'</div>'+
                    '<div class="source-meta">'+
                        '<span>📦 '+source.chunks+' chunks</span>'+
                    '</div>'+
                '</div>';
            }).join('');
            
            container.innerHTML = sourcesHtml;
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
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function updateStats() {
            document.getElementById('selectedCount').textContent = selectedIds.size;
            const totalChunks = sources
                .filter(s => selectedIds.has(s.id))
                .reduce((sum, s) => sum + s.chunks, 0);
            document.getElementById('totalChunks').textContent = totalChunks;
        }
        
        function toggleSource(sourceId) {
            vscode.postMessage({ type: 'toggleSource', sourceId });
        }
        
        function selectAll() {
            vscode.postMessage({ type: 'selectAll' });
        }
        
        function clearAll() {
            vscode.postMessage({ type: 'clearAll' });
        }
        
        function refresh() {
            vscode.postMessage({ type: 'refresh' });
        }
        
        function askQuestion() {
            const input = document.getElementById('questionInput');
            const question = input.value.trim();
            
            if (!question) {
                return;
            }
            
            if (selectedIds.size === 0) {
                alert('Please select at least one source');
                return;
            }
            
            vscode.postMessage({ type: 'askQuestion', question });
            input.value = '';
        }
        
        function handleKeyPress(event) {
            if (event.key === 'Enter') {
                askQuestion();
            }
        }
        
        function displayResponse(data) {
            const container = document.getElementById('responseContainer');
            
            const sourcesText = data.sources.join(', ') || 'None';
            
            container.innerHTML = 
                '<div class="response-container">'+
                    '<div>'+escapeHtml(data.content)+'</div>'+
                    '<div class="response-meta">'+
                        '<strong>Sources:</strong> '+sourcesText+' | '+
                        '<strong>Chunks:</strong> '+data.chunksAnalyzed+' | '+
                        '<strong>Tokens:</strong> '+data.tokensUsed+' | '+
                        '<strong>Model:</strong> '+data.model+
                    '</div>'+
                '</div>';
        }
    </script>
</body>
</html>`;
    }

    public dispose() {
        KnowledgeSourcesPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
