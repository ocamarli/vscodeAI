// Copyright (c) 2024 MIA Project
// Licensed under the MIT License.

import * as fsapi from 'fs-extra';
import { Disposable, env, LogOutputChannel } from 'vscode';
import { State } from 'vscode-languageclient';
import {
    LanguageClient,
    LanguageClientOptions,
    RevealOutputChannelOn,
    ServerOptions,
} from 'vscode-languageclient/node';
import { DEBUG_SERVER_SCRIPT_PATH, SERVER_SCRIPT_PATH } from './constants';
import { traceError, traceInfo, traceVerbose } from './log/logging';
import { getDebuggerPath } from './python';
import { getExtensionSettings, getGlobalSettings, getMIASettings, getWorkspaceSettings, ISettings } from './settings';
import { getLSClientTraceLevel, getProjectRoot } from './utilities';
import { isVirtualWorkspace } from './vscodeapi';

export type IInitOptions = { settings: ISettings[]; globalSettings: ISettings };

/**
 * Supported languages for MIA
 */
const SUPPORTED_LANGUAGES = [
    'c',
    'cpp',
    'java',
    'python',
    'javascript',
    'typescript',
    'javascriptreact',
    'typescriptreact',
];

/**
 * Create document selectors for all supported languages
 */
function createDocumentSelector() {
    if (isVirtualWorkspace()) {
        return SUPPORTED_LANGUAGES.map((lang) => ({ language: lang }));
    }

    const selectors: Array<{ scheme: string; language: string }> = [];

    for (const lang of SUPPORTED_LANGUAGES) {
        selectors.push({ scheme: 'file', language: lang }, { scheme: 'untitled', language: lang });
    }

    // Also add notebook support for Python
    selectors.push(
        { scheme: 'vscode-notebook', language: 'python' },
        { scheme: 'vscode-notebook-cell', language: 'python' },
    );

    return selectors;
}

async function createServer(
    settings: ISettings,
    serverId: string,
    serverName: string,
    outputChannel: LogOutputChannel,
    initializationOptions: IInitOptions,
): Promise<LanguageClient> {
    const command = settings.interpreter[0];
    const cwd = settings.cwd;

    // Set debugger path needed for debugging python code.
    const newEnv = { ...process.env };
    const debuggerPath = await getDebuggerPath();
    const isDebugScript = await fsapi.pathExists(DEBUG_SERVER_SCRIPT_PATH);

    if (newEnv.USE_DEBUGPY && debuggerPath) {
        newEnv.DEBUGPY_PATH = debuggerPath;
    } else {
        newEnv.USE_DEBUGPY = 'False';
    }

    // Set import strategy
    newEnv.LS_IMPORT_STRATEGY = settings.importStrategy;

    // Set notification type
    newEnv.LS_SHOW_NOTIFICATION = settings.showNotifications;

    // Get MIA-specific settings and add them to environment
    const miaSettings = getMIASettings();

    // Pass API keys through environment (more secure than command line)
    if (miaSettings.azure?.apiKey) {
        newEnv.MIA_AZURE_API_KEY = miaSettings.azure.apiKey;
    }
    if (miaSettings.azure?.endpoint) {
        newEnv.MIA_AZURE_ENDPOINT = miaSettings.azure.endpoint;
    }
    if (miaSettings.azure?.deploymentName) {
        newEnv.MIA_AZURE_DEPLOYMENT = miaSettings.azure.deploymentName;
    }
    if (miaSettings.openai?.apiKey) {
        newEnv.MIA_OPENAI_API_KEY = miaSettings.openai.apiKey;
    }
    if (miaSettings.anthropic?.apiKey) {
        newEnv.MIA_ANTHROPIC_API_KEY = miaSettings.anthropic.apiKey;
    }

    const args =
        newEnv.USE_DEBUGPY === 'False' || !isDebugScript
            ? settings.interpreter.slice(1).concat([SERVER_SCRIPT_PATH])
            : settings.interpreter.slice(1).concat([DEBUG_SERVER_SCRIPT_PATH]);

    traceInfo(`Server run command: ${[command, ...args].join(' ')}`);

    const serverOptions: ServerOptions = {
        command,
        args,
        options: { cwd, env: newEnv },
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        // Register the server for all supported languages
        documentSelector: createDocumentSelector(),
        outputChannel: outputChannel,
        traceOutputChannel: outputChannel,
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        initializationOptions: {
            ...initializationOptions,
            // Include MIA-specific settings
            miaSettings: miaSettings,
        },
    };

    return new LanguageClient(serverId, serverName, serverOptions, clientOptions);
}

let _disposables: Disposable[] = [];

export async function restartServer(
    serverId: string,
    serverName: string,
    outputChannel: LogOutputChannel,
    lsClient?: LanguageClient,
): Promise<LanguageClient | undefined> {
    if (lsClient) {
        traceInfo(`Server: Stop requested`);
        await lsClient.stop();
        _disposables.forEach((d) => d.dispose());
        _disposables = [];
    }

    const projectRoot = await getProjectRoot();
    const workspaceSetting = await getWorkspaceSettings(serverId, projectRoot, true);

    const newLSClient = await createServer(workspaceSetting, serverId, serverName, outputChannel, {
        settings: await getExtensionSettings(serverId, true),
        globalSettings: await getGlobalSettings(serverId, true),
    });

    traceInfo(`Server: Start requested.`);

    _disposables.push(
        newLSClient.onDidChangeState((e) => {
            switch (e.newState) {
                case State.Stopped:
                    traceVerbose(`Server State: Stopped`);
                    break;
                case State.Starting:
                    traceVerbose(`Server State: Starting`);
                    break;
                case State.Running:
                    traceVerbose(`Server State: Running`);
                    break;
            }
        }),
    );

    try {
        await newLSClient.start();
    } catch (ex) {
        traceError(`Server: Start failed: ${ex}`);
        return undefined;
    }

    const level = getLSClientTraceLevel(outputChannel.logLevel, env.logLevel);
    await newLSClient.setTrace(level);

    return newLSClient;
}
