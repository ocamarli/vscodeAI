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

/**
 * Información del archivo activo
 */
interface ActiveFileInfo {
    fileName: string;
    filePath: string;
    language: string;
    content: string;
    selectedText: string;
    lineCount: number;
    cursorLine: number;
}

/**
 * Obtener información del archivo activo
 */
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

/**
 * MIA Chat View Provider
 * Provides the webview for the chat panel in the sidebar
 */
class MIAChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mia.chatView';
    private _view?: vscode.WebviewView;
    private _messages: Array<{ role: string; content: string }> = [];
    private _currentFileInfo: ActiveFileInfo | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _getClient: () => LanguageClient | undefined,
    ) {
        // Escuchar cambios en el editor activo
        vscode.window.onDidChangeActiveTextEditor(() => {
            this._updateFileContext();
        });

        // Escuchar cambios en el documento
        vscode.workspace.onDidChangeTextDocument(() => {
            this._updateFileContext();
        });

        // Escuchar cambios en la selección
        vscode.window.onDidChangeTextEditorSelection(() => {
            this._updateFileContext();
        });
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

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Actualizar contexto inicial
        setTimeout(() => this._updateFileContext(), 100);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    await this._handleChatMessage(data.message, data.includeFile);
                    break;
                case 'clearChat':
                    this._messages = [];
                    this._updateChat();
                    break;
                case 'applyDiff':
                    await this._applyDiff(data.originalCode, data.newCode);
                    break;
                case 'requestFileContext':
                    this._updateFileContext();
                    break;
            }
        });
    }

    private async _handleChatMessage(message: string, includeFile: boolean = true) {
        const client = this._getClient();
        if (!client) {
            this._addMessage('system', 'Error: El servidor MIA no está corriendo. Por favor reinicia la extensión.');
            return;
        }

        // Obtener contexto actualizado
        this._currentFileInfo = getActiveFileInfo();

        // Construir mensaje con contexto
        let fullMessage = message;
        let context = null;

        if (includeFile && this._currentFileInfo) {
            const fileInfo = this._currentFileInfo;

            // Si hay texto seleccionado, usar solo eso; sino, incluir el archivo completo
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

            // Agregar indicador visual de qué se está enviando
            const contextIndicator = isSelection
                ? `📎 [Código seleccionado de ${fileInfo.fileName}]`
                : `📄 [Archivo: ${fileInfo.fileName}]`;

            this._addMessage('user', `${message}\n\n${contextIndicator}`);
        } else {
            this._addMessage('user', message);
        }

        this._messages.push({ role: 'user', content: fullMessage });

        try {
            // Send to server
            const response = (await client.sendRequest('workspace/executeCommand', {
                command: 'mia.chat',
                arguments: [this._messages, context],
            })) as any;

            if (response.success) {
                // Detectar si la respuesta contiene código para diff
                const hasDiff = this._detectCodeBlock(response.content);

                if (hasDiff) {
                    this._addMessageWithDiff('assistant', response.content);
                } else {
                    this._addMessage('assistant', response.content);
                }
                this._messages.push({ role: 'assistant', content: response.content });
            } else {
                this._addMessage('system', `Error: ${response.error || 'Error desconocido'}`);
            }
        } catch (error) {
            this._addMessage('system', `Error: ${error}`);
        }
    }

    private _detectCodeBlock(content: string): boolean {
        // Detectar si hay bloques de código que podrían ser sugerencias
        const codeBlockRegex = /```[\w]*\n[\s\S]*?```/g;
        return codeBlockRegex.test(content);
    }

    private _addMessage(role: string, content: string) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'addMessage',
                role,
                content,
                hasDiff: false,
            });
        }
    }

    private _addMessageWithDiff(role: string, content: string) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'addMessage',
                role,
                content,
                hasDiff: true,
            });
        }
    }

    private async _applyDiff(_originalCode: string, newCode: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No hay editor activo');
            return;
        }

        // Aplicar el cambio con confirmación
        const result = await vscode.window.showInformationMessage(
            '¿Aplicar los cambios sugeridos por MIA?',
            'Aplicar',
            'Cancelar',
        );

        if (result === 'Aplicar') {
            const document = editor.document;
            const selection = editor.selection;

            await editor.edit((editBuilder) => {
                // Si hay una selección, reemplazar solo eso
                if (!selection.isEmpty) {
                    editBuilder.replace(selection, newCode);
                } else {
                    // Reemplazar todo el documento
                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length),
                    );
                    editBuilder.replace(fullRange, newCode);
                }
            });

            vscode.window.showInformationMessage('✅ Cambios aplicados');
        }
    }

    private _updateChat() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateChat',
                messages: this._messages,
            });
        }
    }

    public addCodeContext(code: string, language: string) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'addCodeContext',
                code,
                language,
            });
        }
    }

    private _getHtmlForWebview(_webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MIA Chat</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
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
        .header h3 {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
        }
        .header h3::before {
            content: "✨";
        }
        .clear-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 8px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 12px;
        }
        .clear-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        /* Indicador de archivo activo */
        .file-context {
            padding: 8px 10px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .file-context .file-icon {
            font-size: 14px;
        }
        .file-context .file-name {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }
        .file-context .file-info {
            color: var(--vscode-descriptionForeground);
        }
        .file-context .selection-badge {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 10px;
        }
        .file-context.no-file {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        
        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
        }
        .message {
            margin-bottom: 12px;
            padding: 8px 12px;
            border-radius: 8px;
            max-width: 95%;
        }
        .message.user {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            margin-left: auto;
        }
        .message.assistant {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        .message.system {
            background-color: var(--vscode-inputValidation-warningBackground);
            color: var(--vscode-inputValidation-warningForeground);
            font-style: italic;
            text-align: center;
            max-width: 100%;
        }
        .message pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
            position: relative;
        }
        .message code {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }
        
        /* Botones de acción para código */
        .code-actions {
            display: flex;
            gap: 8px;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .code-action-btn {
            padding: 4px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .code-action-btn.apply {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .code-action-btn.apply:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .code-action-btn.copy {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .code-action-btn.copy:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .code-action-btn.reject {
            background-color: transparent;
            color: var(--vscode-errorForeground);
            border: 1px solid var(--vscode-errorForeground);
        }
        
        .input-container {
            padding: 10px;
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .input-options {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 11px;
        }
        .input-options label {
            display: flex;
            align-items: center;
            gap: 4px;
            cursor: pointer;
            color: var(--vscode-descriptionForeground);
        }
        .input-options input[type="checkbox"] {
            cursor: pointer;
        }
        .input-row {
            display: flex;
            gap: 8px;
        }
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
        #messageInput:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        #sendBtn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            border-radius: 4px;
        }
        #sendBtn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        #sendBtn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .typing-indicator {
            display: none;
            padding: 8px 12px;
            color: var(--vscode-descriptionForeground);
        }
        .typing-indicator.visible {
            display: block;
        }
        .welcome {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
        }
        .welcome h4 {
            margin-bottom: 10px;
        }
        .welcome p {
            font-size: 12px;
            margin-bottom: 8px;
        }
        .welcome .commands {
            text-align: left;
            background: var(--vscode-textCodeBlock-background);
            padding: 10px;
            border-radius: 4px;
            margin-top: 10px;
        }
        .welcome .commands code {
            color: var(--vscode-textLink-foreground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h3>MIA Chat</h3>
        <button class="clear-btn" onclick="clearChat()">Limpiar</button>
    </div>
    
    <!-- Indicador de archivo activo -->
    <div class="file-context no-file" id="fileContext">
        <span class="file-icon">📄</span>
        <span>No hay archivo abierto</span>
    </div>
    
    <div class="chat-container" id="chatContainer">
        <div class="welcome">
            <h4>👋 ¡Bienvenido a MIA!</h4>
            <p>Soy tu asistente de código con IA.</p>
            <p>Puedo ver automáticamente el archivo que tienes abierto.</p>
            <div class="commands">
                <p><strong>Comandos útiles:</strong></p>
                <p>• <code>Ctrl+Shift+M</code> - Abrir chat</p>
                <p>• <code>Ctrl+Shift+E</code> - Explicar selección</p>
                <p>• Selecciona código para preguntas específicas</p>
            </div>
        </div>
    </div>
    
    <div class="typing-indicator" id="typingIndicator">
        MIA está pensando...
    </div>
    
    <div class="input-container">
        <div class="input-options">
            <label>
                <input type="checkbox" id="includeFileCheckbox" checked>
                Incluir archivo activo
            </label>
        </div>
        <div class="input-row">
            <textarea 
                id="messageInput" 
                placeholder="Pregúntale algo a MIA..."
                rows="1"
            ></textarea>
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
        
        let isWaiting = false;
        let currentFileInfo = null;

        // Auto-resize textarea
        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });

        // Send on Enter (Shift+Enter for new line)
        messageInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        function sendMessage() {
            const message = messageInput.value.trim();
            if (!message || isWaiting) return;

            // Clear welcome message on first send
            const welcome = chatContainer.querySelector('.welcome');
            if (welcome) {
                welcome.remove();
            }

            const includeFile = includeFileCheckbox.checked;
            vscode.postMessage({ type: 'sendMessage', message, includeFile });
            messageInput.value = '';
            messageInput.style.height = 'auto';
            
            isWaiting = true;
            sendBtn.disabled = true;
            typingIndicator.classList.add('visible');
        }

        function clearChat() {
            vscode.postMessage({ type: 'clearChat' });
            chatContainer.innerHTML = \`
                <div class="welcome">
                    <h4>👋 ¡Bienvenido a MIA!</h4>
                    <p>Soy tu asistente de código con IA.</p>
                    <p>Puedo ver automáticamente el archivo que tienes abierto.</p>
                </div>
            \`;
        }

        function updateFileContext(data) {
            currentFileInfo = data;
            if (data && data.fileName) {
                fileContext.className = 'file-context';
                let html = '<span class="file-icon">📄</span>';
                html += '<span class="file-name">' + escapeHtml(data.fileName) + '</span>';
                html += '<span class="file-info">(' + data.language + ', ' + data.lineCount + ' líneas)</span>';
                if (data.hasSelection) {
                    html += '<span class="selection-badge">Selección: ' + data.selectedLines + ' líneas</span>';
                }
                fileContext.innerHTML = html;
            } else {
                fileContext.className = 'file-context no-file';
                fileContext.innerHTML = '<span class="file-icon">📄</span><span>No hay archivo abierto</span>';
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function addMessage(role, content, hasDiff = false) {
            // Remove welcome message if present
            const welcome = chatContainer.querySelector('.welcome');
            if (welcome) {
                welcome.remove();
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ' + role;
            
            // Process markdown-like formatting
            let formatted = processMarkdown(content);
            
            messageDiv.innerHTML = formatted;
            
            // Si tiene código y es del asistente, agregar botones de acción
            if (hasDiff && role === 'assistant') {
                const codeBlocks = messageDiv.querySelectorAll('pre code');
                codeBlocks.forEach((codeBlock, index) => {
                    const pre = codeBlock.parentElement;
                    const actionsDiv = document.createElement('div');
                    actionsDiv.className = 'code-actions';
                    actionsDiv.innerHTML = \`
                        <button class="code-action-btn apply" onclick="applyCode(this)" data-index="\${index}">
                            ✓ Aplicar
                        </button>
                        <button class="code-action-btn copy" onclick="copyCode(this)">
                            📋 Copiar
                        </button>
                    \`;
                    pre.appendChild(actionsDiv);
                });
            }
            
            chatContainer.appendChild(messageDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;

            if (role === 'assistant' || role === 'system') {
                isWaiting = false;
                sendBtn.disabled = false;
                typingIndicator.classList.remove('visible');
            }
        }

        function processMarkdown(content) {
            return content
                .replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code class="language-$1">$2</code></pre>')
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
                .replace(/\\n/g, '<br>');
        }

        function applyCode(button) {
            const pre = button.closest('pre');
            const code = pre.querySelector('code').textContent;
            vscode.postMessage({ 
                type: 'applyDiff', 
                originalCode: '', // Se determinará en el lado de TypeScript
                newCode: code 
            });
        }

        function copyCode(button) {
            const pre = button.closest('pre');
            const code = pre.querySelector('code').textContent;
            navigator.clipboard.writeText(code).then(() => {
                button.textContent = '✓ Copiado';
                setTimeout(() => {
                    button.innerHTML = '📋 Copiar';
                }, 2000);
            });
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const data = event.data;
            switch (data.type) {
                case 'addMessage':
                    addMessage(data.role, data.content, data.hasDiff);
                    break;
                case 'updateChat':
                    chatContainer.innerHTML = '';
                    data.messages.forEach(msg => addMessage(msg.role, msg.content));
                    break;
                case 'addCodeContext':
                    messageInput.value = \`Sobre este código \${data.language}:\\n\\\`\\\`\\\`\${data.language}\\n\${data.code}\\n\\\`\\\`\\\`\\n\\n\`;
                    messageInput.focus();
                    break;
                case 'updateFileContext':
                    updateFileContext(data);
                    break;
            }
        });

        // Request initial file context
        vscode.postMessage({ type: 'requestFileContext' });
    </script>
</body>
</html>`;
    }
}

/**
 * Activate the MIA extension
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Load server configuration
    const serverInfo = loadServerDefaults();
    const serverName = serverInfo.name;
    const serverId = serverInfo.module;

    // Setup logging
    const outputChannel = createOutputChannel(serverName);
    context.subscriptions.push(outputChannel, registerLogger(outputChannel));

    const changeLogLevel = async (c: vscode.LogLevel, g: vscode.LogLevel) => {
        const level = getLSClientTraceLevel(c, g);
        await lsClient?.setTrace(level);
    };

    context.subscriptions.push(
        outputChannel.onDidChangeLogLevel(async (e) => {
            await changeLogLevel(e, vscode.env.logLevel);
        }),
        vscode.env.onDidChangeLogLevel(async (e) => {
            await changeLogLevel(outputChannel.logLevel, e);
        }),
    );

    // Log Server information
    traceLog(`Name: ${serverInfo.name}`);
    traceLog(`Module: ${serverInfo.module}`);
    traceVerbose(`Full Server Info: ${JSON.stringify(serverInfo)}`);

    // Register Chat View Provider
    chatViewProvider = new MIAChatViewProvider(context.extensionUri, () => lsClient);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MIAChatViewProvider.viewType, chatViewProvider),
    );

    // Function to run/restart the server
    const runServer = async () => {
        const interpreter = getInterpreterFromSetting(serverId);
        if (interpreter && interpreter.length > 0) {
            if (checkVersion(await resolveInterpreter(interpreter))) {
                traceVerbose(`Using interpreter from ${serverInfo.module}.interpreter: ${interpreter.join(' ')}`);
                lsClient = await restartServer(serverId, serverName, outputChannel, lsClient);
            }
            return;
        }

        const interpreterDetails = await getInterpreterDetails();
        if (interpreterDetails.path) {
            traceVerbose(`Using interpreter from Python extension: ${interpreterDetails.path.join(' ')}`);
            lsClient = await restartServer(serverId, serverName, outputChannel, lsClient);
            return;
        }

        traceError(
            'Python interpreter missing:\r\n' +
                '[Option 1] Select python interpreter using the ms-python.python.\r\n' +
                `[Option 2] Set an interpreter using "${serverId}.interpreter" setting.\r\n` +
                'Please use Python 3.9 or greater.',
        );
    };

    // Register commands
    context.subscriptions.push(
        // Restart server command
        registerCommand(`${serverId}.restart`, async () => {
            traceLog('Restarting MIA server...');
            await runServer();
            vscode.window.showInformationMessage('Servidor MIA reiniciado');
        }),

        // Open chat command
        registerCommand(`${serverId}.openChat`, async () => {
            await vscode.commands.executeCommand('mia.chatView.focus');
        }),

        // Explain selection command
        registerCommand(`${serverId}.explainSelection`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No hay editor activo');
                return;
            }

            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            if (!selectedText) {
                vscode.window.showWarningMessage('No hay texto seleccionado');
                return;
            }

            if (!lsClient) {
                vscode.window.showErrorMessage('El servidor MIA no está corriendo');
                return;
            }

            try {
                // Show progress
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'MIA está analizando tu código...',
                        cancellable: false,
                    },
                    async () => {
                        const response = (await lsClient!.sendRequest('workspace/executeCommand', {
                            command: 'mia.explain',
                            arguments: [selectedText, editor.document.languageId],
                        })) as any;

                        if (response.success) {
                            // Show in a new panel
                            const panel = vscode.window.createWebviewPanel(
                                'miaExplanation',
                                'Explicación MIA',
                                vscode.ViewColumn.Beside,
                                { enableScripts: false },
                            );

                            panel.webview.html = `
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <style>
                                    body {
                                        font-family: var(--vscode-font-family);
                                        padding: 20px;
                                        line-height: 1.6;
                                    }
                                    pre {
                                        background-color: var(--vscode-textCodeBlock-background);
                                        padding: 10px;
                                        border-radius: 4px;
                                        overflow-x: auto;
                                    }
                                    h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
                                </style>
                            </head>
                            <body>
                                <h2>✨ Explicación de MIA</h2>
                                <div>${response.content.replace(/\n/g, '<br>')}</div>
                            </body>
                            </html>
                        `;
                        } else {
                            vscode.window.showErrorMessage(`Error MIA: ${response.error}`);
                        }
                    },
                );
            } catch (error) {
                vscode.window.showErrorMessage(`Error MIA: ${error}`);
            }
        }),

        // Generate code command
        registerCommand(`${serverId}.generateCode`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No hay editor activo');
                return;
            }

            // Get the current line (assuming it's a comment describing what to generate)
            const line = editor.document.lineAt(editor.selection.active.line);
            const comment = line.text.trim();

            if (!comment) {
                vscode.window.showWarningMessage('Coloca el cursor en un comentario que describa qué generar');
                return;
            }

            if (!lsClient) {
                vscode.window.showErrorMessage('El servidor MIA no está corriendo');
                return;
            }

            // TODO: Implement code generation
            vscode.window.showInformationMessage('¡Generación de código próximamente!');
        }),

        // Refactor selection command
        registerCommand(`${serverId}.refactorSelection`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No hay editor activo');
                return;
            }

            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            if (!selectedText) {
                vscode.window.showWarningMessage('No hay texto seleccionado');
                return;
            }

            // Open chat with the selected code for refactoring discussion
            if (chatViewProvider) {
                await vscode.commands.executeCommand('mia.chatView.focus');
                chatViewProvider.addCodeContext(selectedText, editor.document.languageId);
            }
        }),
    );

    // Watch for configuration changes
    context.subscriptions.push(
        onDidChangePythonInterpreter(async () => {
            await runServer();
        }),
        onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
            if (checkIfConfigurationChanged(e, serverId)) {
                await runServer();
            }
        }),
    );

    // Initialize
    setImmediate(async () => {
        const interpreter = getInterpreterFromSetting(serverId);
        if (interpreter === undefined || interpreter.length === 0) {
            traceLog(`Python extension loading`);
            await initializePython(context.subscriptions);
            traceLog(`Python extension loaded`);
        } else {
            await runServer();
        }
    });

    // Show welcome message on first activation
    const hasShownWelcome = context.globalState.get('mia.hasShownWelcome');
    if (!hasShownWelcome) {
        vscode.window
            .showInformationMessage(
                '✨ ¡MIA está lista! Abre el chat (Ctrl+Shift+M) o pasa el mouse sobre el código para explicaciones.',
                'Abrir Chat',
            )
            .then((selection) => {
                if (selection === 'Abrir Chat') {
                    vscode.commands.executeCommand('mia.chatView.focus');
                }
            });
        context.globalState.update('mia.hasShownWelcome', true);
    }
}

/**
 * Deactivate the extension
 */
export async function deactivate(): Promise<void> {
    if (lsClient) {
        await lsClient.stop();
    }
}
