"""Run-time lookups that static analysis cannot see."""

import importlib


def load_plugin(name: str):
    module = importlib.import_module("app.plugins." + name)
    return getattr(module, "Plugin")


def run(name: str):
    plugin = load_plugin(name)
    return plugin().run()
