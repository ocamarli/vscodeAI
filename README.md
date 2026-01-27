# MIA - Asistente de Código con IA

Asistente de código inteligente impulsado por IA con autocompletado, explicaciones hover y chat. Soporta Python, JavaScript, TypeScript, Java, C, C++ y más lenguajes.

## ✨ Características

- **🤖 Autocompletado Inteligente**: Sugerencias de código contextual impulsadas por IA
- **💡 Explicaciones Hover**: Pasa el mouse sobre el código para obtener explicaciones instantáneas
- **💬 Chat Integrado**: Conversa con IA sobre tu código, solicita refactorizaciones o mejoras
- **📚 Base de Conocimiento**: Consulta documentación y proyectos indexados
- **🔀 Vista Previa de Cambios**: Revisa y aplica cambios sugeridos con diff interactivo
- **🌐 Multi-lenguaje**: Soporta Python, JavaScript, TypeScript, Java, C, C++

## 📦 Requisitos

- **VS Code** 1.80.0 o superior
- **Python** 3.10 o superior
- **Proveedor de IA**: Azure OpenAI, OpenAI, Anthropic Claude u Ollama
- **Flask API** (opcional, solo para base de conocimiento)

## 🚀 Instalación

### Opción 1: Desde archivo .vsix
```bash
code --install-extension mia-0.1.0.vsix
```

### Opción 2: Desde VS Code

1. Abre VS Code
2. Ve a Extensiones (`Ctrl+Shift+X`)
3. Click en `...` (más opciones) → `Install from VSIX...`
4. Selecciona el archivo `mia-0.1.0.vsix`

## ⚙️ Configuración

### Configuración Mínima

Abre la configuración de VS Code (`Ctrl+,`) o edita `settings.json`:

#### Azure OpenAI
```json
{
  "mia.provider": "azure",
  "mia.azure.endpoint": "https://tu-recurso.openai.azure.com/",
  "mia.azure.deploymentName": "gpt-4",
  "mia.azure.apiKey": "tu-api-key"
}
```

#### OpenAI
```json
{
  "mia.provider": "openai",
  "mia.openai.apiKey": "sk-...",
  "mia.openai.model": "gpt-4o"
}
```

#### Anthropic Claude
```json
{
  "mia.provider": "anthropic",
  "mia.anthropic.apiKey": "sk-ant-...",
  "mia.anthropic.model": "claude-sonnet-4-20250514"
}
```

#### Ollama (Local)
```json
{
  "mia.provider": "ollama",
  "mia.ollama.endpoint": "http://localhost:11434",
  "mia.ollama.model": "codellama"
}
```

### Configuración Opcional
```json
{
  "mia.features.completion": true,
  "mia.features.hover": true,
  "mia.features.chat": true,
  "mia.completion.maxTokens": 256,
  "mia.hover.maxTokens": 512,
  "mia.chat.maxTokens": 2048,
  "mia.knowledgeBase.endpoint": "http://localhost:5000"
}
```

## 🎯 Uso

### Chat con IA

1. Abre el panel de chat:
   - `Ctrl+Shift+P` → `MIA: Open Chat`
   - O click en el ícono de MIA en la barra lateral

2. Escribe tu pregunta o solicitud

3. **Opcional**: Activa "Incluir archivo activo" para contexto

4. **Opcional**: Click en "📚 Fuentes" para consultar base de conocimiento

### Explicar Código

1. Selecciona el código que deseas entender
2. Click derecho → `MIA: Explicar selección`
3. O usa hover: pasa el mouse sobre el código

### Refactorizar Código

1. Selecciona el código a refactorizar
2. Click derecho → `MIA: Refactorizar selección`
3. En el chat, describe los cambios deseados
4. Revisa cambios en la vista previa interactiva
5. Acepta o rechaza cada cambio individualmente

### Autocompletado

- Simplemente escribe código
- MIA sugerirá completaciones automáticamente
- Presiona `Tab` o `Enter` para aceptar

## 📚 Base de Conocimiento (Opcional)

Para usar la base de conocimiento, necesitas el servidor Flask corriendo:

### Iniciar Servidor Flask
```bash
cd backend
python app.py
```

El servidor correrá en `http://localhost:5000` por defecto.

### Agregar Documentación

1. Accede a la interfaz web: `http://localhost:5000`
2. Sube documentos (PDF, Markdown, etc.)
3. Los documentos serán indexados automáticamente
4. Usa el botón "📚 Fuentes" en el chat para consultarlos

## 🎨 Personalización

### Cambiar Proveedor de IA
```
Ctrl+Shift+P → "MIA: Set Provider"
```

Selecciona entre: Azure, OpenAI, Anthropic, Ollama

### Habilitar/Deshabilitar Features

En `settings.json`:
```json
{
  "mia.features.completion": true,   // Autocompletado
  "mia.features.hover": false,       // Explicaciones hover
  "mia.features.chat": true          // Chat
}
```

### Ajustar Tokens
```json
{
  "mia.completion.maxTokens": 256,   // Tokens para completado
  "mia.hover.maxTokens": 512,        // Tokens para hover
  "mia.chat.maxTokens": 2048         // Tokens para chat
}
```

## 🔧 Comandos

- `MIA: Open Chat` - Abre el panel de chat
- `MIA: Explicar selección` - Explica código seleccionado
- `MIA: Refactorizar selección` - Refactoriza código
- `MIA: Restart` - Reinicia el servidor LSP
- `MIA: Set Provider` - Cambia proveedor de IA

## 🐛 Solución de Problemas

### El servidor no inicia

1. Verifica que Python 3.10+ esté instalado:
```bash
   python --version
```

2. Revisa los logs:
   - `Ctrl+Shift+P` → `Output`
   - Selecciona "MIA" en el dropdown

3. Reinicia el servidor:
   - `Ctrl+Shift+P` → `MIA: Restart`

### No aparecen sugerencias

1. Verifica que la configuración de API esté correcta
2. Verifica que `mia.features.completion` esté en `true`
3. Revisa los logs para errores de API

### Base de conocimiento no funciona

1. Verifica que Flask esté corriendo:
```bash
   curl http://localhost:5000/health
```

2. Verifica la configuración:
```json
   {
     "mia.knowledgeBase.endpoint": "http://localhost:5000"
   }
```

### Error de importación de módulos Python

El LSP incluye todas las dependencias necesarias. Si hay errores:

1. Desinstala y reinstala la extensión
2. Verifica que no haya conflictos con otras extensiones Python

## 📄 Licencia

MIT License - Ver archivo [LICENSE](LICENSE) para más detalles.

## 🤝 Soporte

¿Encontraste un bug? ¿Tienes una sugerencia?

- Reporta issues en el repositorio
- Contacta al equipo de desarrollo

## 🔒 Privacidad

- Tus API keys se almacenan localmente en VS Code
- El código se envía a los proveedores de IA configurados
- La base de conocimiento es local y privada
- No se recopila telemetría

## 📊 Lenguajes Soportados

- Python (`.py`)
- JavaScript (`.js`, `.jsx`, `.mjs`)
- TypeScript (`.ts`, `.tsx`)
- Java (`.java`)
- C (`.c`, `.h`)
- C++ (`.cpp`, `.hpp`, `.cc`, `.cxx`)

## 🎓 Recursos

- [Documentación del Protocolo LSP](https://microsoft.github.io/language-server-protocol/)
- [Guía de Azure OpenAI](https://learn.microsoft.com/azure/ai-services/openai/)
- [API de OpenAI](https://platform.openai.com/docs)
- [API de Anthropic](https://docs.anthropic.com/)

---

**Desarrollado con ❤️ usando pygls y VS Code Extension API**