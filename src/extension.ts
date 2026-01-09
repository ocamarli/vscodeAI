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
 * MIA Chat View Provider
 * Provides the webview for the chat panel in the sidebar
 */
class MIAChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mia.chatView';
    private _view?: vscode.WebviewView;
    private _messages: Array<{ role: string; content: string }> = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _getClient: () => LanguageClient | undefined,
    ) {}

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

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    await this._handleChatMessage(data.message);
                    break;
                case 'clearChat':
                    this._messages = [];
                    this._updateChat();
                    break;
            }
        });
    }

    private async _handleChatMessage(message: string) {
        const client = this._getClient();
        if (!client) {
            this._addMessage('system', 'Error: MIA server is not running. Please restart the extension.');
            return;
        }

        // Add user message
        this._addMessage('user', message);
        this._messages.push({ role: 'user', content: message });

        try {
            // Get current editor context if available
            const editor = vscode.window.activeTextEditor;
            let context = null;

            if (editor) {
                const document = editor.document;
                const selection = editor.selection;
                const selectedText = document.getText(selection);

                context = {
                    code: selectedText || document.getText(),
                    language: document.languageId,
                    filePath: document.uri.fsPath,
                    lineNumber: selection.start.line,
                    cursorPosition: selection.start.character,
                };
            }

            // Send to server
            const response = (await client.sendRequest('workspace/executeCommand', {
                command: 'mia.chat',
                arguments: [this._messages, context],
            })) as any;

            if (response.success) {
                this._addMessage('assistant', response.content);
                this._messages.push({ role: 'assistant', content: response.content });
            } else {
                this._addMessage('system', `Error: ${response.error || 'Unknown error'}`);
            }
        } catch (error) {
            this._addMessage('system', `Error: ${error}`);
        }
    }

    private _addMessage(role: string, content: string) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'addMessage',
                role,
                content,
            });
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
        }
        .clear-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
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
            max-width: 90%;
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
        }
        .message code {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }
        .input-container {
            padding: 10px;
            border-top: 1px solid var(--vscode-panel-border);
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
    </style>
</head>
<body>
    <div class="header">
        <h3>MIA Chat</h3>
        <button class="clear-btn" onclick="clearChat()">Limpiar</button>
    </div>
    
    <div class="chat-container" id="chatContainer">
        <div class="welcome">
            <h4>👋 ¡Bienvenido a MIA!</h4>
            <p>Soy tu asistente de código con IA.</p>
            <p>Pregúntame lo que quieras sobre tu código, o selecciona código y pídeme que lo explique.</p>
            <p><strong>Consejo:</strong> Usa Ctrl+Shift+E para explicar código seleccionado.</p>
        </div>
    </div>
    
    <div class="typing-indicator" id="typingIndicator">
        MIA está pensando...
    </div>
    
    <div class="input-container">
        <textarea 
            id="messageInput" 
            placeholder="Pregúntale algo a MIA..."
            rows="1"
        ></textarea>
        <button id="sendBtn" onclick="sendMessage()">Enviar</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chatContainer');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        const typingIndicator = document.getElementById('typingIndicator');
        
        let isWaiting = false;

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

            vscode.postMessage({ type: 'sendMessage', message });
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
                    <p>¡Pregúntame lo que quieras sobre tu código!</p>
                </div>
            \`;
        }

        function addMessage(role, content) {
            // Remove welcome message if present
            const welcome = chatContainer.querySelector('.welcome');
            if (welcome) {
                welcome.remove();
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ' + role;
            
            // Simple markdown-like formatting
            let formatted = content
                .replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code class="language-$1">$2</code></pre>')
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                .replace(/\\n/g, '<br>');
            
            messageDiv.innerHTML = formatted;
            chatContainer.appendChild(messageDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;

            if (role === 'assistant' || role === 'system') {
                isWaiting = false;
                sendBtn.disabled = false;
                typingIndicator.classList.remove('visible');
            }
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const data = event.data;
            switch (data.type) {
                case 'addMessage':
                    addMessage(data.role, data.content);
                    break;
                case 'updateChat':
                    chatContainer.innerHTML = '';
                    data.messages.forEach(msg => addMessage(msg.role, msg.content));
                    break;
                case 'addCodeContext':
                    messageInput.value = \`Sobre este código \${data.language}:\\n\\\`\\\`\\\`\${data.language}\\n\${data.code}\\n\\\`\\\`\\\`\\n\\n\`;
                    messageInput.focus();
                    break;
            }
        });
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
            vscode.window.showInformationMessage('MIA server restarted');
        }),

        // Open chat command
        registerCommand(`${serverId}.openChat`, async () => {
            await vscode.commands.executeCommand('mia.chatView.focus');
        }),

        // Explain selection command
        registerCommand(`${serverId}.explainSelection`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            if (!selectedText) {
                vscode.window.showWarningMessage('No text selected');
                return;
            }

            if (!lsClient) {
                vscode.window.showErrorMessage('MIA server is not running');
                return;
            }

            try {
                // Show progress
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'MIA is analyzing your code...',
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
                                'MIA Explanation',
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
                                <h2>✨ MIA Explanation</h2>
                                <div>${response.content.replace(/\n/g, '<br>')}</div>
                            </body>
                            </html>
                        `;
                        } else {
                            vscode.window.showErrorMessage(`MIA Error: ${response.error}`);
                        }
                    },
                );
            } catch (error) {
                vscode.window.showErrorMessage(`MIA Error: ${error}`);
            }
        }),

        // Generate code command
        registerCommand(`${serverId}.generateCode`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            // Get the current line (assuming it's a comment describing what to generate)
            const line = editor.document.lineAt(editor.selection.active.line);
            const comment = line.text.trim();

            if (!comment) {
                vscode.window.showWarningMessage('Place cursor on a comment describing what to generate');
                return;
            }

            if (!lsClient) {
                vscode.window.showErrorMessage('MIA server is not running');
                return;
            }

            // TODO: Implement code generation
            vscode.window.showInformationMessage('Code generation coming soon!');
        }),

        // Refactor selection command
        registerCommand(`${serverId}.refactorSelection`, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            if (!selectedText) {
                vscode.window.showWarningMessage('No text selected');
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
                '✨ MIA is ready! Open the chat panel (Ctrl+Shift+M) or hover over code for explanations.',
                'Open Chat',
            )
            .then((selection) => {
                if (selection === 'Open Chat') {
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
