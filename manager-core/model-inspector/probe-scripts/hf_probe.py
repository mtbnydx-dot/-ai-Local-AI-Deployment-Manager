"""Registry probe executed inside a runtime image (docs/overhaul/02-models.md section 12.1).

Standard library plus whatever the image already ships (transformers, vllm,
sglang). It runs with no network, a read-only root file system and the model
folder mounted read-only, prints exactly one line

    @@PROBE@@ <json>

and exits 0 even when a lookup failed: every registry lookup is wrapped on its
own, so a moved internal module yields null (unknown) and one entry in
"errors", never a failed probe. The manager (probe.js) reads that line.

    python3 -I hf_probe.py --model /probe/model --engine vllm [--trust-remote-code]

Remote code is only executed with --trust-remote-code, which the manager passes
on explicit per-request consent.
"""

import argparse
import importlib
import importlib.metadata
import importlib.util
import json
import os
import sys

MARKER = "@@PROBE@@"
MAX_ITEMS = 4000
MAX_ERRORS = 24
MAX_ERROR_CHARS = 300

ERRORS = []


def note(where, error):
    if len(ERRORS) >= MAX_ERRORS:
        return
    text = "%s: %s: %s" % (where, type(error).__name__, error)
    ERRORS.append(text.replace("\n", " ")[:MAX_ERROR_CHARS])


def attempt(where, function):
    """Run one lookup; a failure is recorded and answers None."""
    try:
        return function()
    except Exception as error:  # noqa: BLE001 - a lookup must never end the probe
        note(where, error)
        return None


def names(value):
    """A registry (mapping, set or list) -> a sorted list of its string keys, or None."""
    if value is None:
        return None
    try:
        items = list(value.keys()) if hasattr(value, "keys") else list(value)
    except TypeError:
        return None
    result = sorted({str(item) for item in items})
    return result[:MAX_ITEMS]


def first_import(where, candidates):
    """The first (module, attribute) pair that imports, or None."""
    last = None
    for module_name, attribute in candidates:
        try:
            module = importlib.import_module(module_name)
            return getattr(module, attribute)
        except Exception as error:  # noqa: BLE001
            last = error
    if last is not None:
        note(where, last)
    return None


def package_version(*candidates):
    for candidate in candidates:
        try:
            return importlib.metadata.version(candidate)
        except importlib.metadata.PackageNotFoundError:
            continue
        except Exception as error:  # noqa: BLE001
            note("version:" + candidate, error)
    return None


def has_module(name):
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:  # noqa: BLE001
        return None


def read_config_json(model_dir):
    path = os.path.join(model_dir, "config.json")
    if not os.path.isfile(path):
        return None, "config.json is missing"
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as error:
        return None, "config.json is unreadable: %s" % type(error).__name__
    if not isinstance(data, dict):
        return None, "config.json is not an object"
    return data, None


def probe_config(model_dir, trust_remote_code):
    """config: {ok, modelType, architectures, error}, plus needsRemoteCode."""
    raw, read_error = read_config_json(model_dir)
    config = {"ok": False, "modelType": None, "architectures": [], "error": None}
    needs_remote_code = False
    if raw is not None:
        model_type = raw.get("model_type")
        config["modelType"] = model_type if isinstance(model_type, str) else None
        architectures = raw.get("architectures")
        if isinstance(architectures, list):
            config["architectures"] = [str(item) for item in architectures if isinstance(item, str)][:16]
        if isinstance(raw.get("auto_map"), dict) and raw["auto_map"]:
            needs_remote_code = True
    else:
        config["error"] = read_error

    # AutoConfig answers whether this Transformers version can build the
    # configuration; remote code stays off unless the manager asked for it.
    try:
        from transformers import AutoConfig

        AutoConfig.from_pretrained(model_dir, trust_remote_code=bool(trust_remote_code), local_files_only=True)
        config["ok"] = raw is not None
        if raw is None:
            config["error"] = read_error
    except Exception as error:  # noqa: BLE001
        message = str(error)
        if "trust_remote_code" in message or "trust-remote-code" in message:
            needs_remote_code = True
        if raw is not None:
            config["error"] = ("%s: %s" % (type(error).__name__, message)).replace("\n", " ")[:MAX_ERROR_CHARS]
    return config, needs_remote_code


def vllm_registries():
    result = {}
    registry = first_import("vllm.ModelRegistry", [
        ("vllm.model_executor.models", "ModelRegistry"),
        ("vllm.model_executor.models.registry", "ModelRegistry"),
    ])
    if registry is not None:
        result["architectures"] = attempt("vllm.get_supported_archs", lambda: names(registry.get_supported_archs()))
    tool = first_import("vllm.ToolParserManager", [
        ("vllm.entrypoints.openai.tool_parsers", "ToolParserManager"),
        ("vllm.entrypoints.openai.tool_parsers.abstract_tool_parser", "ToolParserManager"),
    ])
    if tool is not None:
        result["toolParsers"] = attempt("vllm.tool_parsers", lambda: names(
            tool.tool_parsers if hasattr(tool, "tool_parsers") else tool.list_registered()))
    reasoning = first_import("vllm.ReasoningParserManager", [
        ("vllm.reasoning", "ReasoningParserManager"),
        ("vllm.entrypoints.openai.reasoning_parsers", "ReasoningParserManager"),
    ])
    if reasoning is not None:
        result["reasoningParsers"] = attempt("vllm.reasoning_parsers", lambda: names(
            reasoning.reasoning_parsers if hasattr(reasoning, "reasoning_parsers") else reasoning.list_registered()))
    methods = first_import("vllm.QUANTIZATION_METHODS", [
        ("vllm.model_executor.layers.quantization", "QUANTIZATION_METHODS"),
    ])
    if methods is not None:
        result["quantMethods"] = attempt("vllm.quantization", lambda: names(methods))
    cache_dtype = first_import("vllm.CacheDType", [("vllm.config", "CacheDType"), ("vllm.config.cache", "CacheDType")])
    if cache_dtype is not None:
        import typing

        result["kvCacheDtypes"] = attempt("vllm.cache_dtype", lambda: names(typing.get_args(cache_dtype)))
    return result


def sglang_registries():
    result = {}
    registry = first_import("sglang.ModelRegistry", [
        ("sglang.srt.models.registry", "ModelRegistry"),
        ("sglang.srt.model_loader.loader", "ModelRegistry"),
    ])
    if registry is not None:
        def archs():
            if hasattr(registry, "get_supported_archs"):
                return names(registry.get_supported_archs())
            return names(registry.models)
        result["architectures"] = attempt("sglang.get_supported_archs", archs)
    tool = first_import("sglang.FunctionCallParser", [
        ("sglang.srt.function_call.function_call_parser", "FunctionCallParser"),
    ])
    if tool is not None:
        result["toolParsers"] = attempt("sglang.tool_parsers", lambda: names(tool.ToolCallParserEnum))
    reasoning = first_import("sglang.ReasoningParser", [("sglang.srt.reasoning_parser", "ReasoningParser")])
    if reasoning is not None:
        result["reasoningParsers"] = attempt("sglang.reasoning_parsers", lambda: names(reasoning.DetectorMap))
    methods = first_import("sglang.QUANTIZATION_METHODS", [
        ("sglang.srt.layers.quantization", "QUANTIZATION_METHODS"),
    ])
    if methods is not None:
        result["quantMethods"] = attempt("sglang.quantization", lambda: names(methods))
    return result


def transformers_model_types():
    mapping = first_import("transformers.CONFIG_MAPPING", [
        ("transformers.models.auto.configuration_auto", "CONFIG_MAPPING"),
    ])
    return attempt("transformers.CONFIG_MAPPING", lambda: names(mapping)) if mapping is not None else None


def main(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model", required=True)
    parser.add_argument("--engine", default="")
    parser.add_argument("--trust-remote-code", action="store_true", dest="trust_remote_code")
    args, _unknown = parser.parse_known_args(argv)

    # Library imports print banners and warnings; only the marker line may
    # reach stdout.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        engine = args.engine
        config, needs_remote_code = probe_config(args.model, args.trust_remote_code)
        registries = {}
        if engine == "vllm":
            registries = attempt("vllm", vllm_registries) or {}
        elif engine == "sglang":
            registries = attempt("sglang", sglang_registries) or {}
        registry_architectures = registries.get("architectures")
        arch_supported = None
        if registry_architectures is not None and config["architectures"]:
            known = {item.lower() for item in registry_architectures}
            arch_supported = any(item.lower() in known for item in config["architectures"])
        result = {
            "engineVersion": package_version(engine) if engine else None,
            "transformersVersion": package_version("transformers"),
            "python": sys.version.split()[0],
            "config": config,
            "archSupported": arch_supported,
            "needsRemoteCode": bool(needs_remote_code),
            "registryArchitectures": registry_architectures,
            "modelTypes": transformers_model_types(),
            "toolParsers": registries.get("toolParsers"),
            "reasoningParsers": registries.get("reasoningParsers"),
            "quantMethods": registries.get("quantMethods"),
            "kvCacheDtypes": registries.get("kvCacheDtypes"),
            "plugins": {"gguf": has_module("gguf"), "bnb": has_module("bitsandbytes")},
            "errors": ERRORS,
        }
    except Exception as error:  # noqa: BLE001 - the marker line is always printed
        note("probe", error)
        result = {
            "engineVersion": None, "transformersVersion": None, "python": sys.version.split()[0],
            "config": {"ok": False, "modelType": None, "architectures": [], "error": "probe failed"},
            "archSupported": None, "needsRemoteCode": False, "registryArchitectures": None, "modelTypes": None,
            "toolParsers": None, "reasoningParsers": None, "quantMethods": None, "kvCacheDtypes": None,
            "plugins": {"gguf": None, "bnb": None}, "errors": ERRORS,
        }
    finally:
        sys.stdout = real_stdout
    sys.stdout.write("\n%s %s\n" % (MARKER, json.dumps(result, sort_keys=True, separators=(",", ":"))))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
