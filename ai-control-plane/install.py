#!/usr/bin/env python3
"""Install the AI Control Plane plugin into OpenRCT2 and print the MCP setup for your AI agent.

    python3 install.py                 copy the plugin into the OpenRCT2 user folder
    python3 install.py --symlink       link it instead (handy while editing the plugin)
    python3 install.py --user-dir DIR  use a custom OpenRCT2 user folder
    python3 install.py --uninstall     remove the plugin
"""

import argparse
import json
import os
import platform
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_SRC = os.path.join(HERE, "plugin", "ai-control-plane.js")
MCP_SERVER = os.path.join(HERE, "mcp", "openrct2_mcp.py")
PLUGIN_NAME = "ai-control-plane.js"


def candidate_user_dirs():
    home = os.path.expanduser("~")
    system = platform.system()
    if system == "Windows":
        yield os.path.join(home, "Documents", "OpenRCT2")
        yield os.path.join(home, "OneDrive", "Documents", "OpenRCT2")
    elif system == "Darwin":
        yield os.path.join(home, "Library", "Application Support", "OpenRCT2")
    else:
        xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        yield os.path.join(xdg, "OpenRCT2")
        yield os.path.join(home, ".var", "app", "io.openrct2.OpenRCT2", "config", "OpenRCT2")  # Flatpak


def find_user_dir():
    candidates = list(candidate_user_dirs())
    for path in candidates:
        if os.path.isdir(path):
            return path
    return candidates[0]


def python_command():
    return "py" if platform.system() == "Windows" else "python3"


def print_mcp_instructions():
    py = python_command()
    print()
    print("Next, connect your AI agent to the game:")
    print()
    print("  Claude Code:")
    print(f'    claude mcp add --scope user openrct2 -- {py} "{MCP_SERVER}"')
    print()
    print("  Claude Desktop (Settings > Developer > Edit Config), add to claude_desktop_config.json:")
    config = {"mcpServers": {"openrct2": {"command": py, "args": [MCP_SERVER]}}}
    print("    " + json.dumps(config, indent=2).replace("\n", "\n    "))
    print()
    print("Then start OpenRCT2, load a park, and ask e.g.:")
    print('  "Build a path from the roller coaster exit to the main path and give it an entrance queue."')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--user-dir", help="OpenRCT2 user folder (the one containing config.ini)")
    ap.add_argument("--symlink", action="store_true", help="symlink the plugin instead of copying it")
    ap.add_argument("--uninstall", action="store_true", help="remove the plugin")
    args = ap.parse_args()

    user_dir = args.user_dir or find_user_dir()
    plugin_dir = os.path.join(user_dir, "plugin")
    target = os.path.join(plugin_dir, PLUGIN_NAME)

    if args.uninstall:
        if os.path.lexists(target):
            os.remove(target)
            print(f"Removed {target}")
        else:
            print(f"Nothing to remove at {target}")
        return 0

    if not os.path.isdir(user_dir):
        print(f"Note: {user_dir} does not exist yet (has OpenRCT2 been started once?). Creating it.")
    os.makedirs(plugin_dir, exist_ok=True)
    if os.path.lexists(target):
        os.remove(target)
    if args.symlink:
        os.symlink(PLUGIN_SRC, target)
        print(f"Linked {target} -> {PLUGIN_SRC}")
    else:
        shutil.copyfile(PLUGIN_SRC, target)
        print(f"Installed plugin to {target}")
    print("Restart OpenRCT2 if it is running; the plugin listens on 127.0.0.1:8765 once the game starts.")
    print_mcp_instructions()
    return 0


if __name__ == "__main__":
    sys.exit(main())
