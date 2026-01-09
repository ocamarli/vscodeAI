// Copyright (c) 2024 MIA Project
// Licensed under the MIT License.

import { ConfigurationChangeEvent, ConfigurationScope, WorkspaceConfiguration, WorkspaceFolder } from 'vscode';
import { getInterpreterDetails } from './python';
import { getConfiguration, getWorkspaceFolders } from './vscodeapi';

export interface ISettings {
    cwd: string;
    workspace: string;
    args: string[];
    path: string[];
    interpreter: string[];
    importStrategy: string;
    showNotifications: string;
}

/**
 * MIA-specific settings interface
 */
export interface IMIASettings {
    provider: string;
    azure: {
        endpoint: string;
        deploymentName: string;
        apiKey: string;
        apiVersion: string;
    };
    openai: {
        apiKey: string;
        model: string;
    };
    anthropic: {
        apiKey: string;
        model: string;
    };
    ollama: {
        endpoint: string;
        model: string;
    };
    features: {
        completion: boolean;
        hover: boolean;
        chat: boolean;
    };
    completion: {
        maxTokens: number;
    };
    hover: {
        maxTokens: number;
    };
    chat: {
        maxTokens: number;
    };
    languages: string[];
}

export function getExtensionSettings(namespace: string, includeInterpreter?: boolean): Promise<ISettings[]> {
    return Promise.all(getWorkspaceFolders().map((w) => getWorkspaceSettings(namespace, w, includeInterpreter)));
}

function resolveVariables(value: string[], workspace?: WorkspaceFolder): string[] {
    const substitutions = new Map<string, string>();
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
        substitutions.set('${userHome}', home);
    }
    if (workspace) {
        substitutions.set('${workspaceFolder}', workspace.uri.fsPath);
    }
    substitutions.set('${cwd}', process.cwd());
    getWorkspaceFolders().forEach((w) => {
        substitutions.set('${workspaceFolder:' + w.name + '}', w.uri.fsPath);
    });

    return value.map((s) => {
        for (const [key, value] of substitutions) {
            s = s.replace(key, value);
        }
        return s;
    });
}

export function getInterpreterFromSetting(namespace: string, scope?: ConfigurationScope) {
    const config = getConfiguration(namespace, scope);
    return config.get<string[]>('interpreter');
}

export async function getWorkspaceSettings(
    namespace: string,
    workspace: WorkspaceFolder,
    includeInterpreter?: boolean,
): Promise<ISettings> {
    const config = getConfiguration(namespace, workspace.uri);

    let interpreter: string[] = [];
    if (includeInterpreter) {
        interpreter = getInterpreterFromSetting(namespace, workspace) ?? [];
        if (interpreter.length === 0) {
            interpreter = (await getInterpreterDetails(workspace.uri)).path ?? [];
        }
    }

    const workspaceSetting = {
        cwd: workspace.uri.fsPath,
        workspace: workspace.uri.toString(),
        args: resolveVariables(config.get<string[]>(`args`) ?? [], workspace),
        path: resolveVariables(config.get<string[]>(`path`) ?? [], workspace),
        interpreter: resolveVariables(interpreter, workspace),
        importStrategy: config.get<string>(`importStrategy`) ?? 'useBundled',
        showNotifications: config.get<string>(`showNotifications`) ?? 'off',
    };
    return workspaceSetting;
}

function getGlobalValue<T>(config: WorkspaceConfiguration, key: string, defaultValue: T): T {
    const inspect = config.inspect<T>(key);
    return inspect?.globalValue ?? inspect?.defaultValue ?? defaultValue;
}

export async function getGlobalSettings(namespace: string, includeInterpreter?: boolean): Promise<ISettings> {
    const config = getConfiguration(namespace);

    let interpreter: string[] = [];
    if (includeInterpreter) {
        interpreter = getGlobalValue<string[]>(config, 'interpreter', []);
        if (interpreter === undefined || interpreter.length === 0) {
            interpreter = (await getInterpreterDetails()).path ?? [];
        }
    }

    const setting = {
        cwd: process.cwd(),
        workspace: process.cwd(),
        args: getGlobalValue<string[]>(config, 'args', []),
        path: getGlobalValue<string[]>(config, 'path', []),
        interpreter: interpreter,
        importStrategy: getGlobalValue<string>(config, 'importStrategy', 'useBundled'),
        showNotifications: getGlobalValue<string>(config, 'showNotifications', 'off'),
    };
    return setting;
}

/**
 * Get MIA-specific settings
 */
export function getMIASettings(): IMIASettings {
    const config = getConfiguration('mia');

    return {
        provider: config.get<string>('provider', 'azure'),
        azure: {
            endpoint: config.get<string>('azure.endpoint', ''),
            deploymentName: config.get<string>('azure.deploymentName', ''),
            apiKey: config.get<string>('azure.apiKey', ''),
            apiVersion: config.get<string>('azure.apiVersion', '2024-02-15-preview'),
        },
        openai: {
            apiKey: config.get<string>('openai.apiKey', ''),
            model: config.get<string>('openai.model', 'gpt-4o'),
        },
        anthropic: {
            apiKey: config.get<string>('anthropic.apiKey', ''),
            model: config.get<string>('anthropic.model', 'claude-sonnet-4-20250514'),
        },
        ollama: {
            endpoint: config.get<string>('ollama.endpoint', 'http://localhost:11434'),
            model: config.get<string>('ollama.model', 'codellama'),
        },
        features: {
            completion: config.get<boolean>('features.completion', true),
            hover: config.get<boolean>('features.hover', true),
            chat: config.get<boolean>('features.chat', true),
        },
        completion: {
            maxTokens: config.get<number>('completion.maxTokens', 256),
        },
        hover: {
            maxTokens: config.get<number>('hover.maxTokens', 512),
        },
        chat: {
            maxTokens: config.get<number>('chat.maxTokens', 2048),
        },
        languages: config.get<string[]>('languages', ['c', 'cpp', 'java', 'python', 'javascript', 'typescript']),
    };
}

/**
 * Check if any MIA configuration changed
 */
export function checkIfConfigurationChanged(e: ConfigurationChangeEvent, namespace: string): boolean {
    const settings = [
        `${namespace}.args`,
        `${namespace}.path`,
        `${namespace}.interpreter`,
        `${namespace}.importStrategy`,
        `${namespace}.showNotifications`,
        // MIA-specific settings
        'mia.provider',
        'mia.azure.endpoint',
        'mia.azure.deploymentName',
        'mia.azure.apiKey',
        'mia.azure.apiVersion',
        'mia.openai.apiKey',
        'mia.openai.model',
        'mia.anthropic.apiKey',
        'mia.anthropic.model',
        'mia.ollama.endpoint',
        'mia.ollama.model',
        'mia.features.completion',
        'mia.features.hover',
        'mia.features.chat',
        'mia.completion.maxTokens',
        'mia.hover.maxTokens',
        'mia.chat.maxTokens',
        'mia.languages',
    ];
    const changed = settings.map((s) => e.affectsConfiguration(s));
    return changed.includes(true);
}
