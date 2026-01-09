# Copyright (c) 2024 MIA Project
# Licensed under the MIT License.
"""
MIA LSP Server - Language Server Protocol implementation for AI code assistance.
Supports: Code completion, Hover explanations, Chat, and custom commands.
Compatible with pygls 2.0
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import pathlib
import sys
import traceback
from typing import Any, Optional, Sequence

# **********************************************************
# Update sys.path before importing any bundled libraries.
# **********************************************************
def update_sys_path(path_to_add: str, strategy: str) -> None:
    """Add given path to `sys.path`."""
    if path_to_add not in sys.path and os.path.isdir(path_to_add):
        if strategy == "useBundled":
            sys.path.insert(0, path_to_add)
        elif strategy == "fromEnvironment":
            sys.path.append(path_to_add)


# Ensure that we can import LSP libraries, and other bundled libraries.
BUNDLE_DIR = pathlib.Path(__file__).parent.parent / "libs"
update_sys_path(
    os.fspath(BUNDLE_DIR),
    os.getenv("LS_IMPORT_STRATEGY", "useBundled"),
)

# **********************************************************
# Imports needed for the language server (pygls 2.0 compatible)
# **********************************************************
import lsprotocol.types as lsp
from pygls.lsp.server import LanguageServer
from pygls import uris

# Import MIA engine
from mia_engine import (
    MIAEngine, 
    MIAConfig, 
    CodeContext, 
    AIResponse,
    Provider,
    get_engine,
    configure_engine
)

# **********************************************************
# Server Configuration
# **********************************************************
WORKSPACE_SETTINGS = {}
GLOBAL_SETTINGS = {}

MAX_WORKERS = 5
LSP_SERVER = LanguageServer(
    name="MIA", 
    version="0.1.0", 
    max_workers=MAX_WORKERS
)

# Supported languages
SUPPORTED_LANGUAGES = {"c", "cpp", "java", "python", "javascript", "typescript"}

# Language ID to file extension mapping
LANGUAGE_MAP = {
    "c": [".c", ".h"],
    "cpp": [".cpp", ".hpp", ".cc", ".cxx", ".hxx"],
    "java": [".java"],
    "python": [".py", ".pyw"],
    "javascript": [".js", ".jsx", ".mjs"],
    "typescript": [".ts", ".tsx"],
}


# **********************************************************
# Helper Functions
# **********************************************************

def get_language_from_uri(uri: str) -> str:
    """Extract language from file URI based on extension."""
    ext = pathlib.Path(uri).suffix.lower()
    for lang, extensions in LANGUAGE_MAP.items():
        if ext in extensions:
            return lang
    return "unknown"


def get_language_from_document(document) -> str:
    """Get language ID from document."""
    # Try to get from document's language_id first
    if hasattr(document, 'language_id') and document.language_id:
        return document.language_id
    return get_language_from_uri(document.uri)


def get_document_source(document) -> str:
    """Get document source text, compatible with pygls 2.0."""
    if hasattr(document, 'source'):
        return document.source
    elif hasattr(document, 'text'):
        return document.text
    return ""


def extract_code_at_position(
    document, 
    position: lsp.Position,
    context_lines: int = 10
) -> tuple[str, str]:
    """
    Extract code at cursor position and surrounding context.
    Returns (code_before_cursor, surrounding_context)
    """
    source = get_document_source(document)
    lines = source.split('\n')
    current_line = position.line
    current_char = position.character
    
    # Get code before cursor (current line up to cursor)
    if current_line < len(lines):
        code_before = lines[current_line][:current_char]
    else:
        code_before = ""
    
    # Get surrounding context
    start_line = max(0, current_line - context_lines)
    end_line = min(len(lines), current_line + context_lines)
    context = '\n'.join(lines[start_line:end_line])
    
    return code_before, context


def extract_hover_code(
    document,
    position: lsp.Position,
    context_lines: int = 5
) -> str:
    """Extract code around the hover position for explanation."""
    source = get_document_source(document)
    lines = source.split('\n')
    current_line = position.line
    
    # Try to get meaningful code block (function, class, etc.)
    start_line = max(0, current_line - context_lines)
    end_line = min(len(lines), current_line + context_lines + 1)
    
    # Get the lines
    code_lines = lines[start_line:end_line]
    
    # Highlight the current line
    relative_current = current_line - start_line
    if 0 <= relative_current < len(code_lines):
        code_lines[relative_current] = f">>> {code_lines[relative_current]}"
    
    return '\n'.join(code_lines)


# **********************************************************
# LSP Feature Handlers
# **********************************************************

@LSP_SERVER.feature(lsp.TEXT_DOCUMENT_COMPLETION)
async def completion(params: lsp.CompletionParams) -> lsp.CompletionList:
    """
    LSP handler for textDocument/completion request.
    Provides AI-powered code completions.
    """
    document = LSP_SERVER.workspace.get_text_document(params.text_document.uri)
    language = get_language_from_document(document)
    
    # Check if language is supported
    if language not in SUPPORTED_LANGUAGES:
        return lsp.CompletionList(is_incomplete=False, items=[])
    
    # Extract code context
    code_before, surrounding = extract_code_at_position(
        document, 
        params.position,
        context_lines=15
    )
    
    # Skip if line is empty or just whitespace
    if not code_before.strip():
        return lsp.CompletionList(is_incomplete=False, items=[])
    
    try:
        # Get MIA engine
        engine = get_engine()
        
        # Check if completion is enabled
        if not engine.config.completion_enabled:
            return lsp.CompletionList(is_incomplete=False, items=[])
        
        # Create code context
        context = CodeContext(
            code=code_before,
            language=language,
            file_path=uris.to_fs_path(params.text_document.uri),
            line_number=params.position.line,
            cursor_position=params.position.character,
            surrounding_code=surrounding
        )
        
        # Get AI completion
        response = await engine.complete(context)
        
        if not response.success or not response.content:
            return lsp.CompletionList(is_incomplete=False, items=[])
        
        # Clean up the response (remove code fences if present)
        completion_text = response.content.strip()
        if completion_text.startswith("```"):
            lines = completion_text.split("\n")
            # Remove first and last lines (code fences)
            lines = lines[1:-1] if lines[-1].strip() == "```" else lines[1:]
            completion_text = "\n".join(lines)
        
        # Create completion item
        item = lsp.CompletionItem(
            label=f"✨ MIA: {completion_text[:50]}..." if len(completion_text) > 50 else f"✨ MIA: {completion_text}",
            kind=lsp.CompletionItemKind.Snippet,
            insert_text=completion_text,
            insert_text_format=lsp.InsertTextFormat.PlainText,
            detail=f"MIA AI Suggestion ({response.provider})",
            documentation=lsp.MarkupContent(
                kind=lsp.MarkupKind.Markdown,
                value=f"**AI Completion**\n\n```{language}\n{completion_text}\n```"
            ),
            sort_text="0000",  # Sort first
        )
        
        return lsp.CompletionList(is_incomplete=False, items=[item])
        
    except Exception as e:
        log_error(f"Completion error: {str(e)}\n{traceback.format_exc()}")
        return lsp.CompletionList(is_incomplete=False, items=[])


@LSP_SERVER.feature(lsp.TEXT_DOCUMENT_HOVER)
async def hover(params: lsp.HoverParams) -> Optional[lsp.Hover]:
    """
    LSP handler for textDocument/hover request.
    Provides AI-powered code explanations on hover.
    """
    document = LSP_SERVER.workspace.get_text_document(params.text_document.uri)
    language = get_language_from_document(document)
    
    # Check if language is supported
    if language not in SUPPORTED_LANGUAGES:
        return None
    
    try:
        # Get MIA engine
        engine = get_engine()
        
        # Check if hover is enabled
        if not engine.config.hover_enabled:
            return None
        
        # Extract code around hover position
        code = extract_hover_code(document, params.position)
        
        # Skip if code is too short
        if len(code.strip()) < 3:
            return None
        
        # Create code context
        context = CodeContext(
            code=code,
            language=language,
            file_path=uris.to_fs_path(params.text_document.uri),
            line_number=params.position.line,
            cursor_position=params.position.character,
            surrounding_code=""
        )
        
        # Get AI explanation
        response = await engine.explain(context)
        
        if not response.success or not response.content:
            return None
        
        # Create hover content
        content = f"**🤖 MIA Explanation**\n\n{response.content}"
        
        return lsp.Hover(
            contents=lsp.MarkupContent(
                kind=lsp.MarkupKind.Markdown,
                value=content
            )
        )
        
    except Exception as e:
        log_error(f"Hover error: {str(e)}\n{traceback.format_exc()}")
        return None


# **********************************************************
# Custom Commands
# **********************************************************

@LSP_SERVER.command("mia.chat")
async def cmd_chat(*args) -> dict:
    """
    Handle chat command from the extension.
    Args: [messages: list[dict], context_data: dict | None]
    """
    try:
        # Flatten args if needed
        if len(args) == 1 and isinstance(args[0], list):
            args = args[0]
        args = list(args)
        
        messages = args[0] if len(args) > 0 else []
        context_data = args[1] if len(args) > 1 else None
        
        engine = get_engine()
        
        # Check if chat is enabled
        if not engine.config.chat_enabled:
            return {
                "success": False,
                "error": "Chat deshabilitado",
                "content": None
            }
        
        # Create code context if provided
        context = None
        if context_data:
            context = CodeContext(
                code=context_data.get("code", ""),
                language=context_data.get("language", "unknown"),
                file_path=context_data.get("filePath", ""),
                line_number=context_data.get("lineNumber", 0),
                cursor_position=context_data.get("cursorPosition", 0),
                surrounding_code=""
            )
        
        # Convert messages to expected format
        chat_messages = [
            {"role": msg.get("role", "user"), "content": msg.get("content", "")}
            for msg in messages
        ]
        
        # Get AI response
        response = await engine.chat(chat_messages, context)
        
        return {
            "success": response.success,
            "content": response.content,
            "error": response.error,
            "provider": response.provider,
            "model": response.model,
            "tokensUsed": response.tokens_used
        }
        
    except Exception as e:
        log_error(f"Chat error: {str(e)}\n{traceback.format_exc()}")
        return {
            "success": False,
            "error": str(e),
            "content": None
        }

@LSP_SERVER.command("mia.explain")
async def cmd_explain(*args) -> dict:
    # Flatten args if needed
    if len(args) == 1 and isinstance(args[0], list):
        args = args[0]
    args = list(args)
    """
    Handle explain command from the extension.
    Args: [code: str, language: str]
    """
    try:
        code = args[0] if len(args) > 0 else ""
        language = args[1] if len(args) > 1 else "unknown"
        
        engine = get_engine()
        
        # Create code context
        context = CodeContext(
            code=code,
            language=language,
            file_path="",
            line_number=0,
            cursor_position=0,
            surrounding_code=""
        )
        
        # Get AI explanation
        response = await engine.explain(context)
        
        return {
            "success": response.success,
            "content": response.content,
            "error": response.error
        }
        
    except Exception as e:
        log_error(f"Explain error: {str(e)}\n{traceback.format_exc()}")
        return {
            "success": False,
            "error": str(e),
            "content": None
        }


@LSP_SERVER.command("mia.getProviders")
async def cmd_get_providers(*args) -> dict:
    """Get available AI providers."""
    try:
        engine = get_engine()
        available = await engine.get_available_providers()
        
        return {
            "success": True,
            "providers": [p.value for p in available],
            "current": engine.config.provider.value
        }
        
    except Exception as e:
        log_error(f"GetProviders error: {str(e)}")
        return {
            "success": False,
            "error": str(e),
            "providers": [],
            "current": None
        }

@LSP_SERVER.command("mia.setProvider")
async def cmd_set_provider(*args) -> dict:
    if len(args) == 1 and isinstance(args[0], list):
        args = args[0]
    args = list(args)
    """Set the active AI provider."""
    try:
        provider_name = args[0] if len(args) > 0 else None
        
        if not provider_name:
            return {
                "success": False,
                "error": "Provider name required"
            }
        
        engine = get_engine()
        provider = Provider(provider_name)
        engine.set_provider(provider)
        
        return {
            "success": True,
            "provider": provider.value
        }
        
    except Exception as e:
        log_error(f"SetProvider error: {str(e)}")
        return {
            "success": False,
            "error": str(e)
        }


# **********************************************************
# Document Events
# **********************************************************

@LSP_SERVER.feature(lsp.TEXT_DOCUMENT_DID_OPEN)
def did_open(params: lsp.DidOpenTextDocumentParams) -> None:
    """Handle document open event."""
    document = LSP_SERVER.workspace.get_text_document(params.text_document.uri)
    language = get_language_from_document(document)
    log_to_output(f"Document opened: {params.text_document.uri} (language: {language})")


@LSP_SERVER.feature(lsp.TEXT_DOCUMENT_DID_SAVE)
def did_save(params: lsp.DidSaveTextDocumentParams) -> None:
    """Handle document save event."""
    log_to_output(f"Document saved: {params.text_document.uri}")


@LSP_SERVER.feature(lsp.TEXT_DOCUMENT_DID_CLOSE)
def did_close(params: lsp.DidCloseTextDocumentParams) -> None:
    """Handle document close event."""
    log_to_output(f"Document closed: {params.text_document.uri}")


# **********************************************************
# Initialization
# **********************************************************

@LSP_SERVER.feature(lsp.INITIALIZE)
def initialize(params: lsp.InitializeParams) -> None:
    """Handle LSP initialize request."""
    log_to_output(f"MIA LSP Server initializing...")
    
    # Extract settings from initialization options
    if params.initialization_options:
        _update_global_settings(params.initialization_options)
    
    # Extract workspace folders
    workspace_folders = params.workspace_folders
    if workspace_folders:
        for folder in workspace_folders:
            log_to_output(f"Workspace folder: {folder.uri}")
    
    # Configure MIA engine with settings
    try:
        mia_settings = _extract_mia_settings(GLOBAL_SETTINGS)
        configure_engine(mia_settings)
        engine = get_engine()
        log_to_output(f"MIA Engine configured with provider: {engine.config.provider.value}")
    except Exception as e:
        log_error(f"Failed to configure MIA engine: {str(e)}")
    
    log_to_output(f"MIA LSP Server initialized. Supported languages: {SUPPORTED_LANGUAGES}")


def _update_global_settings(options: dict) -> None:
    """Update global settings from initialization options."""
    global GLOBAL_SETTINGS
    
    if "globalSettings" in options:
        GLOBAL_SETTINGS = options["globalSettings"]
    
    if "settings" in options:
        for setting in options["settings"]:
            workspace_key = setting.get("workspaceFS", setting.get("cwd", "default"))
            WORKSPACE_SETTINGS[workspace_key] = setting
    
    # Also check for miaSettings directly
    if "miaSettings" in options:
        GLOBAL_SETTINGS["miaSettings"] = options["miaSettings"]


def _extract_mia_settings(global_settings: dict) -> dict:
    """Extract MIA-specific settings from global settings."""
    # Check if miaSettings is directly available
    if "miaSettings" in global_settings:
        return global_settings["miaSettings"]
    
    # Build settings from individual keys
    settings = {
        "provider": global_settings.get("mia.provider", os.getenv("MIA_PROVIDER", "azure")),
        "azure": {
            "endpoint": global_settings.get("mia.azure.endpoint", os.getenv("MIA_AZURE_ENDPOINT", "")),
            "deploymentName": global_settings.get("mia.azure.deploymentName", os.getenv("MIA_AZURE_DEPLOYMENT", "")),
            "apiKey": global_settings.get("mia.azure.apiKey", os.getenv("MIA_AZURE_API_KEY", "")),
            "apiVersion": global_settings.get("mia.azure.apiVersion", "2024-02-15-preview"),
        },
        "openai": {
            "apiKey": global_settings.get("mia.openai.apiKey", os.getenv("MIA_OPENAI_API_KEY", "")),
            "model": global_settings.get("mia.openai.model", "gpt-4o"),
        },
        "anthropic": {
            "apiKey": global_settings.get("mia.anthropic.apiKey", os.getenv("MIA_ANTHROPIC_API_KEY", "")),
            "model": global_settings.get("mia.anthropic.model", "claude-sonnet-4-20250514"),
        },
        "ollama": {
            "endpoint": global_settings.get("mia.ollama.endpoint", os.getenv("MIA_OLLAMA_ENDPOINT", "http://localhost:11434")),
            "model": global_settings.get("mia.ollama.model", "codellama"),
        },
        "features": {
            "completion": global_settings.get("mia.features.completion", True),
            "hover": global_settings.get("mia.features.hover", True),
            "chat": global_settings.get("mia.features.chat", True),
        },
        "completion": {
            "maxTokens": global_settings.get("mia.completion.maxTokens", 256),
        },
        "hover": {
            "maxTokens": global_settings.get("mia.hover.maxTokens", 512),
        },
        "chat": {
            "maxTokens": global_settings.get("mia.chat.maxTokens", 2048),
        },
    }
    
    return settings


def _get_global_defaults():
    """Get global default settings."""
    return {
        "interpreter": GLOBAL_SETTINGS.get("interpreter", [sys.executable]),
        "args": GLOBAL_SETTINGS.get("args", []),
        "path": GLOBAL_SETTINGS.get("path", []),
        "importStrategy": GLOBAL_SETTINGS.get("importStrategy", "useBundled"),
        "showNotifications": GLOBAL_SETTINGS.get("showNotifications", "off"),
    }


def _get_settings_by_document(document) -> dict:
    """Get settings for a specific document."""
    if document is None:
        return list(WORKSPACE_SETTINGS.values())[0] if WORKSPACE_SETTINGS else {}
    
    doc_path = None
    if hasattr(document, 'path'):
        doc_path = document.path
    elif hasattr(document, 'uri'):
        doc_path = uris.to_fs_path(document.uri)
    
    if doc_path is None:
        return list(WORKSPACE_SETTINGS.values())[0] if WORKSPACE_SETTINGS else {}

    document_workspace = pathlib.Path(doc_path)
    workspaces = {s["workspaceFS"] for s in WORKSPACE_SETTINGS.values()}

    while document_workspace != document_workspace.parent:
        if str(document_workspace) in workspaces:
            return WORKSPACE_SETTINGS[str(document_workspace)]
        document_workspace = document_workspace.parent

    key = os.fspath(pathlib.Path(doc_path).parent)
    return {
        "cwd": key,
        "workspaceFS": key,
        "workspace": uris.from_fs_path(key),
        **_get_global_defaults(),
    }

# **********************************************************
# Logging
# **********************************************************
import logging
logger = logging.getLogger(__name__)

def log_to_output(message: str, msg_type: lsp.MessageType = lsp.MessageType.Log) -> None:
    """Log message to output channel."""
    logger.info(message)


def log_error(message: str) -> None:
    """Log error message."""
    logger.error(message)


def log_warning(message: str) -> None:
    """Log warning message."""
    logger.warning(message)


def log_info(message: str) -> None:
    """Log info message."""
    logger.info(message)


# **********************************************************
# Start the server
# **********************************************************
if __name__ == "__main__":
    LSP_SERVER.start_io()