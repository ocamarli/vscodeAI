# Copyright (c) 2024 MIA Project
# Licensed under the MIT License.
"""
MIA AI Engine - Capa de abstracción para múltiples proveedores LLM.
Soporta Azure OpenAI, OpenAI, Anthropic Claude, y Ollama.
"""
from __future__ import annotations

import os
import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, AsyncGenerator, Any
import json
import logging

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mia.engine")


class Provider(Enum):
    """Proveedores de IA soportados."""
    AZURE = "azure"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    OLLAMA = "ollama"


@dataclass
class MIAConfig:
    """Configuración para MIA AI Engine."""
    provider: Provider = Provider.AZURE
    
    # Configuración Azure OpenAI
    azure_endpoint: str = ""
    azure_deployment_name: str = ""
    azure_api_key: str = ""
    azure_api_version: str = "2024-02-15-preview"
    
    # Configuración OpenAI
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"
    
    # Configuración Anthropic
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-20250514"
    
    # Configuración Ollama
    ollama_endpoint: str = "http://localhost:11434"
    ollama_model: str = "codellama"
    
    # Límites de tokens
    completion_max_tokens: int = 256
    hover_max_tokens: int = 512
    chat_max_tokens: int = 2048
    
    # Flags de características
    completion_enabled: bool = True
    hover_enabled: bool = True
    chat_enabled: bool = True
    
    @classmethod
    def from_settings(cls, settings: dict) -> "MIAConfig":
        """Crear configuración desde settings de VS Code."""
        provider_str = settings.get("provider", "azure")
        provider = Provider(provider_str)
        
        return cls(
            provider=provider,
            azure_endpoint=settings.get("azure", {}).get("endpoint", "") or os.getenv("MIA_AZURE_ENDPOINT", ""),
            azure_deployment_name=settings.get("azure", {}).get("deploymentName", "") or os.getenv("MIA_AZURE_DEPLOYMENT", ""),
            azure_api_key=settings.get("azure", {}).get("apiKey", "") or os.getenv("MIA_AZURE_API_KEY", ""),
            azure_api_version=settings.get("azure", {}).get("apiVersion", "2024-02-15-preview"),
            openai_api_key=settings.get("openai", {}).get("apiKey", "") or os.getenv("MIA_OPENAI_API_KEY", ""),
            openai_model=settings.get("openai", {}).get("model", "gpt-4o"),
            anthropic_api_key=settings.get("anthropic", {}).get("apiKey", "") or os.getenv("MIA_ANTHROPIC_API_KEY", ""),
            anthropic_model=settings.get("anthropic", {}).get("model", "claude-sonnet-4-20250514"),
            ollama_endpoint=settings.get("ollama", {}).get("endpoint", "http://localhost:11434"),
            ollama_model=settings.get("ollama", {}).get("model", "codellama"),
            completion_max_tokens=settings.get("completion", {}).get("maxTokens", 256),
            hover_max_tokens=settings.get("hover", {}).get("maxTokens", 512),
            chat_max_tokens=settings.get("chat", {}).get("maxTokens", 2048),
            completion_enabled=settings.get("features", {}).get("completion", True),
            hover_enabled=settings.get("features", {}).get("hover", True),
            chat_enabled=settings.get("features", {}).get("chat", True),
        )


@dataclass
class CodeContext:
    """Información de contexto para asistencia de código."""
    code: str
    language: str
    file_path: str = ""
    line_number: int = 0
    cursor_position: int = 0
    surrounding_code: str = ""
    # Contexto RAG (para uso futuro)
    rag_context: list[str] = field(default_factory=list)


@dataclass 
class AIResponse:
    """Respuesta del motor de IA."""
    content: str
    tokens_used: int = 0
    provider: str = ""
    model: str = ""
    success: bool = True
    error: Optional[str] = None


class BaseLLMProvider(ABC):
    """Clase base abstracta para proveedores LLM."""
    
    @abstractmethod
    async def complete(self, context: CodeContext, max_tokens: int) -> AIResponse:
        """Generar completado de código."""
        pass
    
    @abstractmethod
    async def explain(self, context: CodeContext, max_tokens: int) -> AIResponse:
        """Explicar código (para hover)."""
        pass
    
    @abstractmethod
    async def chat(self, messages: list[dict], context: Optional[CodeContext], max_tokens: int) -> AIResponse:
        """Conversación de chat."""
        pass
    
    @abstractmethod
    async def is_available(self) -> bool:
        """Verificar si el proveedor está disponible y configurado."""
        pass


# =============================================================================
# PROMPTS EN ESPAÑOL
# =============================================================================

COMPLETION_SYSTEM_PROMPT = """Eres MIA, un asistente experto en programación {language}.
Tu tarea es completar el código que el usuario está escribiendo.

Instrucciones:
- Solo proporciona el código que completa lo que falta, sin explicaciones
- Mantén el estilo de código existente
- Sé conciso y preciso
- Si el código ya está completo, devuelve una respuesta vacía
- No incluyas marcadores de código (```) en tu respuesta"""

EXPLAIN_SYSTEM_PROMPT = """Eres MIA, un asistente experto en programación {language}.
Tu tarea es explicar código de forma clara y concisa en español.

Instrucciones:
- Explica qué hace el código, no cómo escribirlo
- Menciona patrones o algoritmos importantes si los hay
- Mantén las explicaciones breves pero informativas
- Usa formato markdown para mejor legibilidad
- Responde siempre en español"""

CHAT_SYSTEM_PROMPT = """Eres MIA (Mi Inteligencia de Asistencia), un asistente de código inteligente especializado en {language}.
Ayudas a los desarrolladores a escribir, entender, depurar y mejorar su código.

Instrucciones:
- Sé útil y conciso
- Proporciona ejemplos de código cuando sea apropiado
- Usa formato markdown
- Si no estás seguro de algo, dilo
- Responde siempre en español
- Cuando muestres código, usa bloques de código con el lenguaje apropiado
- Cuando el usuario te proporcione código de su archivo, analízalo y responde basándote en él
- Si sugieres cambios de código, muéstralos en bloques de código para que el usuario pueda aplicarlos"""

CHAT_CONTEXT_TEMPLATE = """
El usuario está trabajando en el archivo: {file_name}
Lenguaje: {language}

Código actual del archivo:
```{language}
{code}
```

"""


class AzureOpenAIProvider(BaseLLMProvider):
    """Implementación del proveedor Azure OpenAI."""
    
    def __init__(self, config: MIAConfig):
        self.config = config
        self._client = None
    
    async def _get_client(self):
        """Inicialización lazy del cliente Azure OpenAI."""
        if self._client is None:
            try:
                from openai import AsyncAzureOpenAI
                self._client = AsyncAzureOpenAI(
                    api_key=self.config.azure_api_key,
                    api_version=self.config.azure_api_version,
                    azure_endpoint=self.config.azure_endpoint
                )
            except Exception as e:
                logger.error(f"Error al inicializar cliente Azure OpenAI: {e}")
                raise
        return self._client
    
    async def is_available(self) -> bool:
        """Verificar si Azure OpenAI está configurado."""
        return bool(
            self.config.azure_endpoint and 
            self.config.azure_api_key and 
            self.config.azure_deployment_name
        )
    
    async def complete(self, context: CodeContext, max_tokens: int) -> AIResponse:
        """Generar completado de código usando Azure OpenAI."""
        try:
            client = await self._get_client()
            
            system_prompt = COMPLETION_SYSTEM_PROMPT.format(language=context.language)
            user_prompt = self._build_completion_prompt(context)
            
            response = await client.chat.completions.create(
                model=self.config.azure_deployment_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                max_tokens=max_tokens,
                temperature=0.2,
                stop=["\n\n", "```"]
            )
            
            return AIResponse(
                content=response.choices[0].message.content or "",
                tokens_used=response.usage.total_tokens if response.usage else 0,
                provider="azure",
                model=self.config.azure_deployment_name,
                success=True
            )
        except Exception as e:
            logger.error(f"Error de completado Azure: {e}")
            return AIResponse(content="", success=False, error=str(e), provider="azure")
    
    async def explain(self, context: CodeContext, max_tokens: int) -> AIResponse:
        """Explicar código usando Azure OpenAI."""
        try:
            client = await self._get_client()
            
            system_prompt = EXPLAIN_SYSTEM_PROMPT.format(language=context.language)
            user_prompt = f"Explica el siguiente código {context.language}:\n\n```{context.language}\n{context.code}\n```"
            
            response = await client.chat.completions.create(
                model=self.config.azure_deployment_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                max_tokens=max_tokens,
                temperature=0.3
            )
            
            return AIResponse(
                content=response.choices[0].message.content or "",
                tokens_used=response.usage.total_tokens if response.usage else 0,
                provider="azure",
                model=self.config.azure_deployment_name,
                success=True
            )
        except Exception as e:
            logger.error(f"Error de explicación Azure: {e}")
            return AIResponse(content="", success=False, error=str(e), provider="azure")
    
    async def chat(self, messages: list[dict], context: Optional[CodeContext], max_tokens: int) -> AIResponse:
        """Chat usando Azure OpenAI."""
        try:
            client = await self._get_client()
            
            language = context.language if context else "programación general"
            system_content = CHAT_SYSTEM_PROMPT.format(language=language)
            
            # Si hay contexto de código, incluirlo en el system prompt
            if context and context.code:
                file_name = context.file_path.split('/')[-1].split('\\')[-1] if context.file_path else "archivo"
                context_info = CHAT_CONTEXT_TEMPLATE.format(
                    file_name=file_name,
                    language=context.language,
                    code=context.code[:8000]  # Limitar para no exceder tokens
                )
                system_content = system_content + "\n" + context_info
            
            system_message = {
                "role": "system",
                "content": system_content
            }
            
            all_messages = [system_message] + messages
            
            response = await client.chat.completions.create(
                model=self.config.azure_deployment_name,
                messages=all_messages,
                max_tokens=max_tokens,
                temperature=0.7
            )
            
            return AIResponse(
                content=response.choices[0].message.content or "",
                tokens_used=response.usage.total_tokens if response.usage else 0,
                provider="azure",
                model=self.config.azure_deployment_name,
                success=True
            )
        except Exception as e:
            logger.error(f"Error de chat Azure: {e}")
            return AIResponse(content="", success=False, error=str(e), provider="azure")

    def _build_completion_prompt(self, context: CodeContext) -> str:
        prompt = f"Completa el siguiente código {context.language}:\n\n"
        if context.surrounding_code:
            prompt += f"Contexto:\n```{context.language}\n{context.surrounding_code}\n```\n\n"
        prompt += f"Código a completar:\n```{context.language}\n{context.code}"
        return prompt


class OpenAIProvider(BaseLLMProvider):
    """Implementación del proveedor OpenAI."""
    
    def __init__(self, config: MIAConfig):
        self.config = config
        self._client = None
    
    async def _get_client(self):
        if self._client is None:
            from openai import AsyncOpenAI
            self._client = AsyncOpenAI(api_key=self.config.openai_api_key)
        return self._client
    
    async def is_available(self) -> bool:
        return bool(self.config.openai_api_key)
    
    async def complete(self, context: CodeContext, max_tokens: int) -> AIResponse:
        try:
            client = await self._get_client()
            system_prompt = COMPLETION_SYSTEM_PROMPT.format(language=context.language)
            
            response = await client.chat.completions.create(
                model=self.config.openai_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"Completa este código {context.language}:\n{context.code}"}
                ],
                max_tokens=max_tokens,
                temperature=0.2
            )
            return AIResponse(
                content=response.choices[0].message.content or "",
                tokens_used=response.usage.total_tokens if response.usage else 0,
                provider="openai",
                model=self.config.openai_model,
                success=True
            )
        except Exception as e:
            return AIResponse(content="", success=False, error=str(e), provider="openai")
    
    async def explain(self, context: CodeContext, max_tokens: int) -> AIResponse:
        try:
            client = await self._get_client()
            system_prompt = EXPLAIN_SYSTEM_PROMPT.format(language=context.language)
            
            response = await client.chat.completions.create(
                model=self.config.openai_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"Explica este código {context.language}:\n```{context.language}\n{context.code}\n```"}
                ],
                max_tokens=max_tokens,
                temperature=0.3
            )
            return AIResponse(
                content=response.choices[0].message.content or "",
                tokens_used=response.usage.total_tokens if response.usage else 0,
                provider="openai",
                model=self.config.openai_model,
                success=True
            )
        except Exception as e:
            return AIResponse(content="", success=False, error=str(e), provider="openai")
    
    async def chat(self, messages: list[dict], context: Optional[CodeContext], max_tokens: int) -> AIResponse:
        try:
            client = await self._get_client()
            language = context.language if context else "programación general"
            system_content = CHAT_SYSTEM_PROMPT.format(language=language)
            
            # Si hay contexto de código, incluirlo en el system prompt
            if context and context.code:
                file_name = context.file_path.split('/')[-1].split('\\')[-1] if context.file_path else "archivo"
                context_info = CHAT_CONTEXT_TEMPLATE.format(
                    file_name=file_name,
                    language=context.language,
                    code=context.code[:8000]
                )
                system_content = system_content + "\n" + context_info
            
            system_msg = {"role": "system", "content": system_content}
            
            response = await client.chat.completions.create(
                model=self.config.openai_model,
                messages=[system_msg] + messages,
                max_tokens=max_tokens,
                temperature=0.7
            )
            return AIResponse(
                content=response.choices[0].message.content or "",
                tokens_used=response.usage.total_tokens if response.usage else 0,
                provider="openai",
                model=self.config.openai_model,
                success=True
            )
        except Exception as e:
            return AIResponse(content="", success=False, error=str(e), provider="openai")


class AnthropicProvider(BaseLLMProvider):
    """Implementación del proveedor Anthropic Claude."""
    
    def __init__(self, config: MIAConfig):
        self.config = config
        self._client = None
    
    async def _get_client(self):
        if self._client is None:
            from anthropic import AsyncAnthropic
            self._client = AsyncAnthropic(api_key=self.config.anthropic_api_key)
        return self._client
    
    async def is_available(self) -> bool:
        return bool(self.config.anthropic_api_key)
    
    async def complete(self, context: CodeContext, max_tokens: int) -> AIResponse:
        try:
            client = await self._get_client()
            system_prompt = COMPLETION_SYSTEM_PROMPT.format(language=context.language)
            
            response = await client.messages.create(
                model=self.config.anthropic_model,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": f"Completa este código:\n{context.code}"}]
            )
            return AIResponse(
                content=response.content[0].text if response.content else "",
                tokens_used=response.usage.input_tokens + response.usage.output_tokens,
                provider="anthropic",
                model=self.config.anthropic_model,
                success=True
            )
        except Exception as e:
            return AIResponse(content="", success=False, error=str(e), provider="anthropic")
    
    async def explain(self, context: CodeContext, max_tokens: int) -> AIResponse:
        try:
            client = await self._get_client()
            system_prompt = EXPLAIN_SYSTEM_PROMPT.format(language=context.language)
            
            response = await client.messages.create(
                model=self.config.anthropic_model,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": f"Explica este código {context.language}:\n```{context.language}\n{context.code}\n```"}]
            )
            return AIResponse(
                content=response.content[0].text if response.content else "",
                tokens_used=response.usage.input_tokens + response.usage.output_tokens,
                provider="anthropic",
                model=self.config.anthropic_model,
                success=True
            )
        except Exception as e:
            return AIResponse(content="", success=False, error=str(e), provider="anthropic")
    
    async def chat(self, messages: list[dict], context: Optional[CodeContext], max_tokens: int) -> AIResponse:
        try:
            client = await self._get_client()
            language = context.language if context else "programación general"
            system_content = CHAT_SYSTEM_PROMPT.format(language=language)
            
            # Si hay contexto de código, incluirlo en el system prompt
            if context and context.code:
                file_name = context.file_path.split('/')[-1].split('\\')[-1] if context.file_path else "archivo"
                context_info = CHAT_CONTEXT_TEMPLATE.format(
                    file_name=file_name,
                    language=context.language,
                    code=context.code[:8000]
                )
                system_content = system_content + "\n" + context_info
            
            response = await client.messages.create(
                model=self.config.anthropic_model,
                max_tokens=max_tokens,
                system=system_content,
                messages=messages
            )
            return AIResponse(
                content=response.content[0].text if response.content else "",
                tokens_used=response.usage.input_tokens + response.usage.output_tokens,
                provider="anthropic",
                model=self.config.anthropic_model,
                success=True
            )
        except Exception as e:
            return AIResponse(content="", success=False, error=str(e), provider="anthropic")


class OllamaProvider(BaseLLMProvider):
    """Implementación del proveedor local Ollama."""
    
    def __init__(self, config: MIAConfig):
        self.config = config
    
    async def is_available(self) -> bool:
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                response = await client.get(f"{self.config.ollama_endpoint}/api/tags", timeout=5.0)
                return response.status_code == 200
        except:
            return False
    
    async def _generate(self, prompt: str, system: str, max_tokens: int) -> AIResponse:
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.config.ollama_endpoint}/api/generate",
                    json={
                        "model": self.config.ollama_model,
                        "prompt": prompt,
                        "system": system,
                        "stream": False,
                        "options": {"num_predict": max_tokens}
                    },
                    timeout=60.0
                )
                data = response.json()
                return AIResponse(
                    content=data.get("response", ""),
                    provider="ollama",
                    model=self.config.ollama_model,
                    success=True
                )
        except Exception as e:
            return AIResponse(content="", success=False, error=str(e), provider="ollama")
    
    async def complete(self, context: CodeContext, max_tokens: int) -> AIResponse:
        system = COMPLETION_SYSTEM_PROMPT.format(language=context.language)
        return await self._generate(f"Completa este código:\n{context.code}", system, max_tokens)
    
    async def explain(self, context: CodeContext, max_tokens: int) -> AIResponse:
        system = EXPLAIN_SYSTEM_PROMPT.format(language=context.language)
        prompt = f"Explica este código {context.language}:\n```{context.language}\n{context.code}\n```"
        return await self._generate(prompt, system, max_tokens)
    
    async def chat(self, messages: list[dict], context: Optional[CodeContext], max_tokens: int) -> AIResponse:
        # Convertir mensajes a un solo prompt para Ollama
        prompt = "\n".join([f"{m['role']}: {m['content']}" for m in messages])
        language = context.language if context else "programación general"
        system_content = CHAT_SYSTEM_PROMPT.format(language=language)
        
        # Si hay contexto de código, incluirlo
        if context and context.code:
            file_name = context.file_path.split('/')[-1].split('\\')[-1] if context.file_path else "archivo"
            context_info = CHAT_CONTEXT_TEMPLATE.format(
                file_name=file_name,
                language=context.language,
                code=context.code[:8000]
            )
            system_content = system_content + "\n" + context_info
        
        return await self._generate(prompt, system_content, max_tokens)


class MIAEngine:
    """
    Motor principal de MIA AI - gestiona proveedores y maneja solicitudes.
    Este es el punto de entrada principal para todas las operaciones de IA.
    """
    
    def __init__(self, config: Optional[MIAConfig] = None):
        self.config = config or MIAConfig()
        self._providers: dict[Provider, BaseLLMProvider] = {}
        self._current_provider: Optional[BaseLLMProvider] = None
        self._initialize_providers()
    
    def _initialize_providers(self):
        """Inicializar todos los proveedores disponibles."""
        self._providers = {
            Provider.AZURE: AzureOpenAIProvider(self.config),
            Provider.OPENAI: OpenAIProvider(self.config),
            Provider.ANTHROPIC: AnthropicProvider(self.config),
            Provider.OLLAMA: OllamaProvider(self.config),
        }
        self._current_provider = self._providers.get(self.config.provider)
    
    def update_config(self, settings: dict):
        """Actualizar configuración desde settings de VS Code."""
        self.config = MIAConfig.from_settings(settings)
        self._initialize_providers()
        logger.info(f"Motor MIA configurado con proveedor: {self.config.provider.value}")
    
    def set_provider(self, provider: Provider):
        """Cambiar a un proveedor diferente."""
        if provider in self._providers:
            self.config.provider = provider
            self._current_provider = self._providers[provider]
            logger.info(f"Cambiado a proveedor: {provider.value}")
    
    async def get_available_providers(self) -> list[Provider]:
        """Obtener lista de proveedores disponibles (configurados)."""
        available = []
        for provider, impl in self._providers.items():
            if await impl.is_available():
                available.append(provider)
        return available
    
    async def complete(self, context: CodeContext) -> AIResponse:
        """Generar completado de código."""
        if not self.config.completion_enabled:
            return AIResponse(content="", success=False, error="Completado deshabilitado")
        
        if not self._current_provider:
            return AIResponse(content="", success=False, error="Ningún proveedor configurado")
        
        return await self._current_provider.complete(
            context, 
            self.config.completion_max_tokens
        )
    
    async def explain(self, context: CodeContext) -> AIResponse:
        """Explicar código (para hover)."""
        if not self.config.hover_enabled:
            return AIResponse(content="", success=False, error="Hover deshabilitado")
        
        if not self._current_provider:
            return AIResponse(content="", success=False, error="Ningún proveedor configurado")
        
        return await self._current_provider.explain(
            context,
            self.config.hover_max_tokens
        )
    
    async def chat(self, messages: list[dict], context: Optional[CodeContext] = None) -> AIResponse:
        """Conversación de chat."""
        if not self.config.chat_enabled:
            return AIResponse(content="", success=False, error="Chat deshabilitado")
        
        if not self._current_provider:
            return AIResponse(content="", success=False, error="Ningún proveedor configurado")
        
        return await self._current_provider.chat(
            messages,
            context,
            self.config.chat_max_tokens
        )


# Interfaz RAG (preparada para uso futuro)
class RAGInterface:
    """
    Interfaz para RAG (Retrieval Augmented Generation).
    Lista para integración futura con LlamaIndex o similar.
    """
    
    def __init__(self):
        self._index = None
        self._enabled = False
    
    async def initialize(self, knowledge_base_path: str):
        """Inicializar RAG con una base de conocimiento."""
        # TODO: Implementar con LlamaIndex
        pass
    
    async def query(self, query: str, top_k: int = 3) -> list[str]:
        """Consultar la base de conocimiento."""
        if not self._enabled:
            return []
        return []
    
    def is_enabled(self) -> bool:
        return self._enabled


# Instancia singleton
_engine_instance: Optional[MIAEngine] = None


def get_engine() -> MIAEngine:
    """Obtener la instancia singleton del motor MIA."""
    global _engine_instance
    if _engine_instance is None:
        _engine_instance = MIAEngine()
    return _engine_instance


def configure_engine(settings: dict) -> MIAEngine:
    """Configurar y retornar el motor MIA."""
    engine = get_engine()
    engine.update_config(settings)
    return engine