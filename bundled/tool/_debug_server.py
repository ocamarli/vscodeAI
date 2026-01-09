"""
Debug server script for MIA LSP server.
"""
import os
import sys

# Add the tool directory to path
TOOL_DIR = os.path.dirname(os.path.abspath(__file__))
if TOOL_DIR not in sys.path:
    sys.path.insert(0, TOOL_DIR)

# Add bundled libs to path
BUNDLED_LIBS = os.path.join(os.path.dirname(TOOL_DIR), "libs")
if os.path.exists(BUNDLED_LIBS) and BUNDLED_LIBS not in sys.path:
    sys.path.insert(0, BUNDLED_LIBS)

if os.environ.get("USE_DEBUGPY", "False").lower() in ("true", "1", "yes"):
    try:
        import debugpy
        DEBUG_PORT = int(os.environ.get("DEBUGPY_PORT", "5678"))
        debugpy.listen(("localhost", DEBUG_PORT))
        print(f"Waiting for debugger on port {DEBUG_PORT}...")
        debugpy.wait_for_client()
        print("Debugger attached!")
    except ImportError:
        print("debugpy not installed")
    except Exception as e:
        print(f"Debugger error: {e}")

# Import and run server
from lsp_server import LSP_SERVER

if __name__ == "__main__":
    LSP_SERVER.start_io()